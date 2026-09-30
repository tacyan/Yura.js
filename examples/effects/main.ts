import { treatments, treatmentStyles, treatmentLive, backdrops, backdropMarkup, backdropFrame, screenFx, fxFrame, FX_SVG_DEFS, kineticLyrics, motions } from 'yura'
import type { KineticRun } from 'yura'

// A live catalogue of the four layers. Every tile is drawn by the same pure
// functions the lyric stage, films and homepages use.

const grid = document.querySelector('#grid') as HTMLElement
document.body.insertAdjacentHTML('beforeend', FX_SVG_DEFS)
const SAMPLE = '夜明けの色'
let tickers: ((t: number) => void)[] = []
let runs: KineticRun[] = []

const tile = (name: string, ja: string, desc: string, light = false): { el: HTMLElement; stage: HTMLElement } => {
  const el = document.createElement('div')
  el.className = `tile${light ? ' light' : ''}`
  el.title = desc
  el.innerHTML = `<div class="stage"></div><div class="label"><b>${name}</b>${ja}</div>`
  el.onclick = () => void navigator.clipboard?.writeText(name)
  grid.appendChild(el)
  return { el, stage: el.querySelector('.stage') as HTMLElement }
}

const glyphHTML = (name: string, text: string): { html: string; spans: () => HTMLElement[] } => {
  const chars = Array.from(text)
  const st = treatmentStyles(name, chars, 3)
  const css = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/^webkit-/, '-webkit-')}:${v.replace(/"/g, '&quot;')}`).join(';')
  const inner = chars.map((c, i) => `<span style="display:inline-block;${css(st.glyphs[i])}">${c}</span>`).join('')
  return { html: `<div style="position:relative;${css(st.block)}">${st.wrap ? st.wrap[0] : ''}${inner}${st.wrap ? st.wrap[1] : ''}</div>`, spans: () => [] }
}

const show = (tab: string): void => {
  for (const r of runs) r.stop()
  runs = []
  tickers = []
  grid.innerHTML = ''
  if (tab === 'treat') {
    for (const [name, r] of Object.entries(treatments)) {
      const { stage } = tile(name, r.ja, r.desc, /gold|chrome|keycap|genkou|marker|redact|ransom/.test(name))
      stage.innerHTML = glyphHTML(name, SAMPLE).html
      if ((r as { live?: unknown }).live) {
        const spans = Array.from(stage.querySelectorAll('span')) as HTMLElement[]
        tickers.push((t) => treatmentLive(name, t % 4, Array.from(SAMPLE), 3)?.forEach((s, i) => Object.assign(spans[i].style, s)))
      }
    }
  } else if (tab === 'bg') {
    for (const [name, r] of Object.entries(backdrops)) {
      const { stage } = tile(name, r.ja, r.desc)
      stage.innerHTML = backdropMarkup(name, 7)
      const els = Array.from(stage.querySelectorAll('[data-bd]')) as HTMLElement[]
      tickers.push((t) => {
        const f = backdropFrame(name, t, 7)
        for (const e of els) { const s = f[e.getAttribute('data-bd') ?? '']; if (s) Object.assign(e.style, s) }
      })
    }
  } else if (tab === 'fx') {
    for (const [name, r] of Object.entries(screenFx)) {
      const { el, stage } = tile(name, r.ja, r.desc)
      stage.innerHTML = `${backdropMarkup('mesh', 2)}<div style="position:relative">${SAMPLE}</div>`
      const o = document.createElement('div')
      o.className = 'fxo'
      el.insertBefore(o, el.querySelector('.label'))
      tickers.push((t) => {
        const cycle = r.dur + 0.8
        const f = fxFrame(name, (t % cycle) / r.dur, 5)
        stage.style.filter = f.root.filter ?? 'none'
        stage.style.transform = f.root.transform ?? 'none'
        o.removeAttribute('style')
        Object.assign(o.style, f.overlay)
      })
    }
  } else {
    const names = Object.keys(motions.layout)
    for (const name of names) {
      const r = motions.layout[name as keyof typeof motions.layout]
      const { stage } = tile(name, r.ja, r.desc)
      stage.style.fontSize = '14px'
      runs.push(kineticLyrics(stage, [{ text: SAMPLE, at: 0 }], { layout: name as never, enter: 'fade', hold: 'still', loop: false, size: '1.6em' }))
    }
  }
}

for (const b of Array.from(document.querySelectorAll('nav button')) as HTMLButtonElement[]) {
  b.onclick = () => {
    for (const x of Array.from(document.querySelectorAll('nav button'))) x.setAttribute('aria-pressed', String(x === b))
    show(b.dataset.tab ?? 'treat')
  }
}
show('treat')
const t0 = performance.now()
const loop = (): void => {
  const t = (performance.now() - t0) / 1000
  for (const f of tickers) f(t)
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)
