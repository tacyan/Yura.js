/**
 * YURA showcase — the flagship demo. One million GPU-simulated particles,
 * live look switching, and a prompt that morphs the swarm into any word.
 * Zero image assets; everything on screen is generated.
 */
import { yura, shapes, lyrics, type YuraApp, type LyricsRun } from 'yura'

type LookId = 'neon-galaxy' | 'aurora' | 'cinematic' | 'cyberpunk'

const LOOKS: Array<{ id: LookId; label: string }> = [
  { id: 'neon-galaxy', label: 'Neon Galaxy' },
  { id: 'aurora', label: 'Aurora' },
  { id: 'cinematic', label: 'Cinematic' },
  { id: 'cyberpunk', label: 'Cyberpunk' },
]
const COUNTS = [
  { n: 250_000, label: '250k' },
  { n: 500_000, label: '500k' },
  { n: 1_000_000, label: '1M' },
  { n: 2_000_000, label: '2M · ludicrous' },
]
const MORPHS: Array<{ label: string; make: () => ReturnType<typeof shapes.galaxy> }> = [
  { label: 'galaxy', make: () => shapes.galaxy() },
  { label: 'vortex', make: () => shapes.vortex() },
  { label: 'ring', make: () => shapes.ring() },
  { label: 'sphere', make: () => shapes.sphere() },
  { label: 'flow', make: () => shapes.flow() },
]

const stage = document.getElementById('stage')!
const cover = document.getElementById('cover')!
const coverNote = document.getElementById('coverNote')!
const fpsEl = document.getElementById('fps')!
const particlesEl = document.getElementById('particles')!
const resEl = document.getElementById('res')!
const backendEl = document.getElementById('backend')!
const promptEl = document.getElementById('prompt') as HTMLInputElement
const lookRow = document.getElementById('lookRow')!
const countRow = document.getElementById('countRow')!
const spark = document.getElementById('spark') as HTMLCanvasElement
const sparkCtx = spark.getContext('2d')!

let app: YuraApp | null = null
let currentLook: LookId = 'neon-galaxy'
let currentCount = 1_000_000
let booting = false

/** ?backend=webgl2 forces the fallback renderer — same page, same UI. */
const forcedBackend = new URLSearchParams(location.search).get('backend')
const backendOpt = forcedBackend === 'webgl2' || forcedBackend === 'webgpu' ? forcedBackend : 'auto'

// ------------------------------------------------------------------ boot

async function boot(): Promise<void> {
  if (booting) return
  booting = true
  setLyricChipEnabled(false) // no silent click-swallowing while booting
  stopLyrics() // a rebooted app invalidates the running lyric timeline
  coverNote.textContent = `summoning ${currentCount.toLocaleString('en-US')} particles`
  cover.classList.remove('hidden')
  await new Promise((r) => setTimeout(r, 250)) // let the cover paint
  app?.dispose()
  app = yura(stage, { quality: 'auto', backend: backendOpt })
    .preset(currentLook)
    .particles(currentCount)
    .interactive()
  await app.run()
  ;(window as unknown as { __yura: unknown }).__yura = app
  cover.classList.add('hidden')
  booting = false
  setLyricChipEnabled(true)
  syncChips()
}

// ------------------------------------------------------------------ chips

function chip(label: string, cls = ''): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = `chip ${cls}`.trim()
  b.textContent = label
  return b
}

const lookChips = new Map<LookId, HTMLButtonElement>()
for (const l of LOOKS) {
  const b = chip(l.label)
  b.addEventListener('click', () => {
    currentLook = l.id
    void boot()
  })
  lookRow.appendChild(b)
  lookChips.set(l.id, b)
}
lookRow.appendChild(Object.assign(document.createElement('div'), { className: 'sep' }))
for (const m of MORPHS) {
  const b = chip(m.label, 'ghost')
  b.addEventListener('click', () => {
    promptEl.value = ''
    stopLyrics()
    void app?.morphNow(m.make())
  })
  lookRow.appendChild(b)
}

// ------------------------------------------------------------- lyric motion

/**
 * LYRIC MOTION — kinetic typography act. Two Japanese lines plus the brand
 * word, each swept in glyph by glyph (char-by-char sweep) by lyrics(),
 * looping until toggled off or interrupted by any other morph.
 */
const LYRIC_LINES = [
  { text: 'ゆらめく光', at: 0 },
  { text: '百万の粒子が', at: 3.4 },
  { text: '波のように踊る', at: 6.8 },
  { text: 'YURA', at: 10.2, direction: 'center' as const },
]

let lyricRun: LyricsRun | null = null
const lyricChip = chip('lyric motion', 'ghost')

/**
 * The lyric act needs a live app: during boot the click used to be silently
 * swallowed by the `booting` guard. Disable the chip visibly instead
 * (native disabled + class for styling), re-enabling once boot completes.
 */
function setLyricChipEnabled(enabled: boolean): void {
  lyricChip.disabled = !enabled
  lyricChip.classList.toggle('disabled', !enabled)
}

function stopLyrics(): void {
  if (!lyricRun) return
  lyricRun.stop()
  lyricRun = null
  lyricChip.classList.remove('on')
}

lyricChip.addEventListener('click', () => {
  if (!app || booting) return
  if (lyricRun) {
    stopLyrics()
    void app.morphNow(shapes.galaxy())
    return
  }
  promptEl.value = ''
  // sweep 0.8 → strong per-character stagger: each glyph condenses in turn.
  lyricRun = lyrics(app, LYRIC_LINES, { sweep: 0.8, loop: true, loopTail: 3 })
  lyricChip.classList.add('on')
})
lookRow.appendChild(Object.assign(document.createElement('div'), { className: 'sep' }))
lookRow.appendChild(lyricChip)

const countChips = new Map<number, HTMLButtonElement>()
for (const c of COUNTS) {
  const b = chip(c.label, 'ghost')
  b.addEventListener('click', () => {
    currentCount = c.n
    void boot()
  })
  countRow.appendChild(b)
  countChips.set(c.n, b)
}

function syncChips(): void {
  for (const [id, b] of lookChips) b.classList.toggle('on', id === currentLook)
  for (const [n, b] of countChips) b.classList.toggle('on', n === currentCount)
}

// ------------------------------------------------------------------ prompt

promptEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !app) return
  stopLyrics()
  const word = promptEl.value.trim()
  void app.morphNow(word ? word.toUpperCase() : shapes.galaxy())
  promptEl.blur()
})

window.addEventListener('keydown', (e) => {
  if (document.activeElement === promptEl || !e.isTrusted || e.metaKey || e.ctrlKey || e.altKey) return
  const idx = Number(e.key) - 1
  if (idx >= 0 && idx < LOOKS.length) {
    currentLook = LOOKS[idx].id
    void boot()
  }
})

// ------------------------------------------------------------------ HUD

const frameMs: number[] = []
let fpsEma = 60
let last = performance.now()
function hudTick(now: number): void {
  const dt = now - last
  last = now
  fpsEma = fpsEma * 0.92 + (1000 / Math.max(dt, 0.1)) * 0.08
  frameMs.push(dt)
  if (frameMs.length > 88) frameMs.shift()
  requestAnimationFrame(hudTick)
}
requestAnimationFrame(hudTick)

function drawSpark(): void {
  const w = spark.width
  const h = spark.height
  sparkCtx.clearRect(0, 0, w, h)
  const bw = w / 88
  for (let i = 0; i < frameMs.length; i++) {
    const ms = frameMs[i]
    const t = Math.min(ms / 40, 1)
    const bh = Math.max(t * h, 2)
    sparkCtx.fillStyle = ms < 9 ? '#34d399' : ms < 17.5 ? '#67e8f9' : ms < 34 ? '#fbbf24' : '#fb7185'
    sparkCtx.fillRect(i * bw, h - bh, bw - 1.2, bh)
  }
}

setInterval(() => {
  if (!app) return
  const s = app.stats
  fpsEl.textContent = String(Math.round(fpsEma))
  particlesEl.textContent = s.particles.toLocaleString('en-US')
  resEl.textContent = `×${s.resolutionScale.toFixed(2).replace(/0$/, '')}`
  backendEl.textContent = s.backend.toUpperCase()
  drawSpark()
}, 250)

// ------------------------------------------------------------------ calm mode

let calmTimer = 0
function wake(): void {
  document.body.classList.remove('calm')
  clearTimeout(calmTimer)
  calmTimer = window.setTimeout(() => {
    if (document.activeElement !== promptEl) document.body.classList.add('calm')
  }, 4000) as unknown as number
}
window.addEventListener('pointermove', wake)
window.addEventListener('pointerdown', wake)
window.addEventListener('keydown', wake)
wake()

void boot()
