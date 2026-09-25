import { kineticLyrics, kineticCatalog, kineticMoods, motions, wrapTime, kineticDuration } from 'yura'
import type { KineticRun, KineticInput, KineticOptions, MotionEntry, KineticMoodName } from 'yura'

// Every web typography motion in the vocabulary, playable by name. Pick a
// mood to hear a whole verse planned from a seed, or click any recipe on
// the right to loop it on its own — its description is shown under the stage.

const VERSE: KineticInput[] = [
  { text: '夜明けの色を', at: 0 },
  '覚えてる',
  'ことばより先に',
  { text: 'ひかりが走る', accent: true },
  '遠く\nとおく',
  'また会えるまで',
]
const SECONDS_PER_LINE = 2.8

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T
const stage = $<HTMLDivElement>('#stage')
const moodSelect = $<HTMLSelectElement>('#mood')
const bpmInput = $<HTMLInputElement>('#bpm')
const names = $<HTMLDivElement>('#caption .names')
const desc = $<HTMLDivElement>('#caption .desc')
const catalogEl = $<HTMLElement>('#catalog')

const catalog = kineticCatalog()
const describe = (phase: MotionEntry['phase'], name: string) => catalog.find((e) => e.phase === phase && e.name === name)

let run: KineticRun | null = null
let seed = 1
let solo: MotionEntry | null = null
let t0 = performance.now()

function play(): void {
  run?.stop()
  t0 = performance.now()
  const bpm = Number(bpmInput.value) || undefined
  const common: KineticOptions = { seed, bpm, loop: true, loopTail: SECONDS_PER_LINE, every: SECONDS_PER_LINE, clock: () => (performance.now() - t0) / 1000 }
  if (solo) {
    // Loop two plain lines with only the chosen phase forced; the rest stay quiet so it reads clearly.
    const lines: KineticInput[] = [{ text: '夜明けの色を', at: 0 }, 'ひかりが走る']
    const quiet = { enter: 'fade', hold: 'still', exit: 'fade', layout: 'center' } as const
    run = kineticLyrics(stage, lines, { ...common, ...quiet, [solo.phase]: solo.name })
  } else {
    run = kineticLyrics(stage, VERSE, { ...common, mood: moodSelect.value as KineticMoodName | 'mix' })
  }
}

function caption(): void {
  if (run) {
    const duration = kineticDuration(run.plan)
    const t = wrapTime((performance.now() - t0) / 1000, duration)
    const line = run.plan.find((l) => t >= l.start && t < l.end)
    if (line) {
      const parts = (['layout', 'enter', 'hold', 'exit'] as const).map((phase) => {
        const e = describe(phase, line[phase])
        return { phase, e }
      })
      const text = parts.map(({ phase, e }) => `${phase} ${e?.ja} (${line[phase]})`).join('  ·  ')
      if (names.textContent !== text) {
        names.textContent = text
        desc.textContent = solo ? solo.desc : parts.map(({ e }) => e?.desc).join(' ')
      }
    }
  }
  requestAnimationFrame(caption)
}

// Mood picker.
for (const [key, m] of Object.entries(kineticMoods)) moodSelect.add(new Option(`${m.ja} — ${key}`, key))
moodSelect.add(new Option('ミックス — mix', 'mix'))
moodSelect.onchange = () => {
  solo = null
  markSolo()
  play()
}
bpmInput.onchange = play

// Omakase: new seed (and a new mood) each press.
const shuffle = (): void => {
  seed = 1 + Math.floor(Math.random() * 1e6)
  const keys = [...Object.keys(kineticMoods), 'mix']
  moodSelect.value = keys[Math.floor(Math.random() * keys.length)]
  solo = null
  markSolo()
  play()
}
$<HTMLButtonElement>('#shuffle').onclick = shuffle
addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'r' || e.key === 'R') shuffle()
})

// Catalog: every recipe, grouped by phase.
const titles = { enter: '登場 ENTER', hold: '保持 HOLD', exit: '退場 EXIT', layout: '配置 LAYOUT' } as const
const buttons: HTMLButtonElement[] = []
function markSolo(): void {
  for (const b of buttons) b.setAttribute('aria-pressed', String(!!solo && b.dataset.key === `${solo.phase}:${solo.name}`))
}
for (const phase of Object.keys(motions) as (keyof typeof titles)[]) {
  const h = document.createElement('h2')
  h.textContent = `${titles[phase]} · ${Object.keys(motions[phase]).length}`
  catalogEl.append(h)
  for (const e of catalog.filter((c) => c.phase === phase)) {
    const b = document.createElement('button')
    b.dataset.key = `${e.phase}:${e.name}`
    b.title = e.desc
    b.innerHTML = `<b></b><code></code>`
    b.querySelector('b')!.textContent = e.ja
    b.querySelector('code')!.textContent = e.name
    b.onclick = () => {
      solo = solo && solo.phase === e.phase && solo.name === e.name ? null : e
      markSolo()
      play()
    }
    buttons.push(b)
    catalogEl.append(b)
  }
}

play()
requestAnimationFrame(caption)
