import { test, expect, describe, afterEach } from 'bun:test'
import { Window } from 'happy-dom'
import { treatments, treatmentStyles, treatmentLive, cssText, cssProp } from '../src/treatments'
import { backdrops, backdropMarkup, backdropFrame } from '../src/backdrops'
import { screenFx, fxFrame, combineFx, FX_SVG_DEFS } from '../src/screen-fx'
import { planFilm, filmFrame, filmMarkup, filmTransitions, filmCameras, filmLooks, sceneEnvelope, type FilmScene, type FilmLookName } from '../src/film'
import { planKinetic, kineticLyrics, type KineticElement, type KineticScheduler } from '../src/kinetic'

const BAD = /NaN|Infinity|undefined|\[object/
const GLYPHS = Array.from('ゆらゆら Yura!')

let happy: Window | null = null
afterEach(async () => {
  await happy?.happyDOM.close()
  happy = null
})
/** Parses markup and returns its visible text (leaked attributes would show up here). */
function visibleText(html: string): string {
  happy = happy ?? new Window()
  const d = happy.document.createElement('div')
  d.innerHTML = html
  return (d.textContent ?? '').replace(/\s+/g, ' ')
}
const LEAKS = ['url(', 'data:image', 'opacity:', 'style=', '">', 'mask-', 'gradient(']

describe('text treatments', () => {
  test('every treatment is described and yields finite, string-only styles for any line', () => {
    for (const [name, r] of Object.entries(treatments)) {
      expect({ name, ok: r.ja.length > 0 && r.desc.length > 10 }).toEqual({ name, ok: true })
      for (const glyphs of [GLYPHS, [], ['あ']]) {
        const st = treatmentStyles(name, glyphs, 7)
        const all = [st.block, ...st.glyphs]
        for (const css of all) for (const v of Object.values(css)) expect({ name, bad: typeof v !== 'string' || BAD.test(v) }).toEqual({ name, bad: false })
        expect(st.glyphs).toHaveLength(glyphs.length)
        for (const t of [0, 0.4, 3, NaN, -1, 1e6]) {
          const live = treatmentLive(name, t, glyphs, 7)
          if (live) for (const css of live) for (const v of Object.values(css)) expect({ name, t, bad: BAD.test(v) }).toEqual({ name, t, bad: false })
        }
      }
    }
    expect(treatmentStyles('nope', GLYPHS)).toEqual({ block: {}, glyphs: GLYPHS.map(() => ({})), wrap: null })
  })

  test('treatments never write the channels motions own per frame (transform, opacity, filter on glyphs, clip-path)', () => {
    for (const name of Object.keys(treatments)) {
      for (const css of treatmentStyles(name, GLYPHS, 3).glyphs) {
        for (const k of ['transform', 'opacity', 'filter', 'clipPath', 'textShadow']) expect({ name, k, owned: k in css }).toEqual({ name, k, owned: false })
      }
    }
  })

  test('inline serialisation is attribute-safe', () => {
    expect(cssProp('WebkitTextStroke')).toBe('-webkit-text-stroke')
    expect(cssText({ backgroundImage: 'url("x")' })).toBe('background-image:url(&quot;x&quot;)')
    for (const name of Object.keys(treatments)) {
      const st = treatmentStyles(name, GLYPHS, 3)
      const html = `<div style="${cssText(st.block)}">${st.glyphs.map((g, i) => `<span style="${cssText(g)}">${GLYPHS[i]}</span>`).join('')}</div>`
      const text = visibleText(html)
      expect({ name, text }).toEqual({ name, text: GLYPHS.join('').replace(/\s+/g, ' ') })
    }
  })

  test('kinetic lines take a treatment (planned per line from a pool), and unknown names throw YURA-019', () => {
    const plan = planKinetic(['a', 'b', 'c', 'd'], { treats: ['outline', 'extrude'], seed: 2 })
    for (const l of plan) expect(['outline', 'extrude']).toContain(l.treat)
    expect(planKinetic(['a'], {})[0].treat).toBe('none')
    expect(planKinetic([{ text: 'a', treat: 'marker' }], { treat: 'glow' })[0].treat).toBe('marker')
    expect(() => planKinetic(['a'], { treat: 'nope' as never })).toThrow('YURA-019')
  })

  test('kineticLyrics applies block and glyph styles, brackets, and live styles', () => {
    const made: (KineticElement & { children: KineticElement[]; firstChild?: unknown; lastChild?: unknown })[] = []
    const el = (): KineticElement & { children: KineticElement[] } => {
      const e = {
        style: {} as Record<string, string>,
        children: [] as KineticElement[],
        textContent: '' as string | null,
        get firstChild() { return this.children[0] },
        get lastChild() { return this.children[this.children.length - 1] },
        appendChild(c: KineticElement) { this.children.push(c) },
        insertBefore(c: KineticElement, ref: KineticElement) { const i = this.children.indexOf(ref); this.children.splice(i < 0 ? 0 : i, 0, c) },
        remove() {},
        setAttribute() {},
      }
      made.push(e as never)
      return e
    }
    const host = el()
    const frames: (() => void)[] = []
    const scheduler: KineticScheduler = { request: (cb) => (frames.push(cb), frames.length), cancel: () => {} }
    const run = kineticLyrics(host, [{ text: 'あい', at: 0, treat: 'brackets' }, { text: 'う', at: 1, treat: 'karaoke' }, { text: 'え', at: 2, treat: 'extrude' }], { document: { createElement: el } as never, scheduler, reducedMotion: true })
    run.render(0.5)
    const texts = made.map((m) => m.textContent).filter(Boolean)
    expect(texts).toContain('「')
    expect(texts).toContain('」')
    run.render(1.5)
    expect(made.some((m) => (m.style as Record<string, string>).backgroundPosition !== undefined)).toBe(true)
    run.render(2.5)
    expect(made.some((m) => ((m.style as Record<string, string>).textShadow ?? '').includes('em'))).toBe(true)
    run.stop()
  })
})

describe('backdrops', () => {
  test('every backdrop renders well-formed markup and finite animated styles whose keys exist', () => {
    for (const [name, r] of Object.entries(backdrops)) {
      expect({ name, ok: r.ja.length > 0 && r.desc.length > 10 }).toEqual({ name, ok: true })
      const html = backdropMarkup(name, 5)
      const text = visibleText(html)
      const leaks = LEAKS.filter((l) => text.includes(l))
      expect({ name, leaks }).toEqual({ name, leaks: [] })
      const keys = new Set(Array.from(html.matchAll(/data-bd="([^"]+)"/g), (m) => m[1]))
      for (const t of [0, 0.7, 13.3, 120, NaN, -5]) {
        const f = backdropFrame(name, t, 5)
        for (const [k, css] of Object.entries(f)) {
          expect({ name, k, exists: keys.has(k) }).toEqual({ name, k, exists: true })
          for (const v of Object.values(css)) expect({ name, k, t, bad: BAD.test(v) }).toEqual({ name, k, t, bad: false })
        }
      }
    }
    expect(backdropMarkup('nope')).toBe('')
    expect(backdropFrame('nope', 1)).toEqual({})
  })

  test('same seed, same backdrop; key prefixes keep several backdrops apart', () => {
    expect(backdropMarkup('stars', 3)).toBe(backdropMarkup('stars', 3))
    expect(backdropMarkup('stars', 3)).not.toBe(backdropMarkup('stars', 4))
    expect(Object.keys(backdropFrame('mesh', 1, 1, 'x:'))[0].startsWith('x:')).toBe(true)
  })
})

describe('screen effects', () => {
  test('every effect is described and finite over its whole run; invisible outside it', () => {
    for (const [name, r] of Object.entries(screenFx)) {
      expect({ name, ok: r.ja.length > 0 && r.desc.length > 10 && r.dur > 0 }).toEqual({ name, ok: true })
      for (let k = 0; k <= 40; k++) {
        const f = fxFrame(name, k / 40, 9)
        for (const v of [...Object.values(f.root), ...Object.values(f.overlay)]) expect({ name, k, bad: BAD.test(v) }).toEqual({ name, k, bad: false })
      }
      for (const p of [-0.1, 1.1, NaN]) expect(fxFrame(name, p).overlay.opacity).toBe('0')
    }
  })

  test('effects that use SVG filters reference ids that exist', () => {
    const ids = new Set(Array.from(FX_SVG_DEFS.matchAll(/id="([^"]+)"/g), (m) => m[1]))
    for (const name of Object.keys(screenFx)) {
      for (let k = 0; k <= 20; k++) {
        const f = fxFrame(name, k / 20, 1)
        for (const m of (f.root.filter ?? '').matchAll(/url\(#([^)]+)\)/g)) expect({ name, id: m[1], ok: ids.has(m[1]) }).toEqual({ name, id: m[1], ok: true })
      }
    }
  })

  test('combining chains filters and transforms; the last visible overlay wins', () => {
    const c = combineFx([fxFrame('chroma', 0.1), fxFrame('zoom-punch', 0.1), fxFrame('flash', 0.1), fxFrame('invert', 0.9)])
    expect(c.root.filter).toContain('drop-shadow')
    expect(c.root.transform).toContain('scale')
    expect(c.overlay.background).toContain('#ffffff')
    expect(combineFx([])).toEqual({ root: { filter: 'none', transform: 'none' }, overlay: { opacity: '0' } })
  })
})

describe('film: every transition, camera, backdrop, treatment and effect', () => {
  const transitions = Object.keys(filmTransitions)
  const cameras = Object.keys(filmCameras)
  const bgs = Object.keys(backdrops)
  const treats = Object.keys(treatments)
  const fxs = Object.keys(screenFx)
  const n = Math.max(transitions.length, cameras.length, bgs.length, treats.length, fxs.length)
  const scenes: FilmScene[] = Array.from({ length: n }, (_, i) => ({
    kind: 'statement',
    text: i % 2 ? 'ゆらゆら*光*る' : 'Every _frame_ counts',
    duration: 1.2,
    transition: transitions[i % transitions.length] as never,
    camera: cameras[i % cameras.length] as never,
    bg: bgs[i % bgs.length] as never,
    treat: treats[i % treats.length] as never,
    fx: [fxs[i % fxs.length] as never, { name: fxs[(i + 7) % fxs.length] as never, at: 0.4, dur: 0.5 }],
  }))

  test('finite styles at every frame, for every look', () => {
    for (const look of Object.keys(filmLooks) as FilmLookName[]) {
      const plan = planFilm({ look, bpm: 120, scenes })
      for (let k = 0; k <= 240; k++) {
        const f = filmFrame(plan, (k / 240) * plan.duration)
        const bad = Object.entries(f).filter(([, st]) => Object.values(st).some((v) => BAD.test(v)))
        expect({ look, k, bad: bad.map(([key]) => key) }).toEqual({ look, k, bad: [] })
      }
    }
  })

  test('every styled key exists in the markup, and the markup never leaks', () => {
    const plan = planFilm({ look: 'brand', scenes })
    const html = filmMarkup(plan)
    const keys = new Set(Array.from(html.matchAll(/data-f="([^"]+)"/g), (m) => m[1]))
    const missing = new Set<string>()
    for (let k = 0; k <= 300; k++) for (const key of Object.keys(filmFrame(plan, (k / 300) * plan.duration))) if (!keys.has(key) && !key.startsWith('bg:') && !key.startsWith('tl:') && key !== 'rh:n') missing.add(key)
    expect([...missing]).toEqual([])
    const text = visibleText(html)
    expect(LEAKS.filter((l) => text.includes(l))).toEqual([])
  })

  test('mid-transition both scenes are on screen for soft transitions, one for hard ones', () => {
    const plan = planFilm({ scenes })
    for (let i = 1; i < plan.scenes.length; i++) {
      const b = plan.scenes[i].start
      const both = sceneEnvelope(plan, i - 1, b + 0.01).visible && sceneEnvelope(plan, i, b + 0.01).visible
      const hard = ['cut', 'block', 'flash', 'ink'].includes(plan.scenes[i].transition)
      expect({ i, t: plan.scenes[i].transition, both }).toEqual({ i, t: plan.scenes[i].transition, both: !hard })
    }
  })
})
