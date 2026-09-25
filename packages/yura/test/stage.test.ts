import { test, expect, describe, spyOn } from 'bun:test'
import { YuraError, CODES } from '@yura/core'
import { stageThemes, type StageThemeName } from '../src/stage-themes'
import { cameraMoves, cameraAt, stageTransitions, transitionAt, shakeAt, accentFlash, grainOffset, beatPhase, CAMERA_FOV, CAMERA_DISTANCE } from '../src/stage-motion'
import { stageDecor, decorMarkup, decorLive, formatTimecode, escapeHtml } from '../src/stage-decor'
import { stageWorlds, createStageWorld, monolithLayout, shardLayout, dustLayout, petalLayout, petalAt, glyphStarLayout, tunnelRingZ, PETAL_SPAN, TUNNEL_SPACING, TUNNEL_RINGS } from '../src/stage-world'
import { planStage, activeLine, transitionState, schemeVars, fitScale, lyricStage, readLyricNodes, stageOptionsFromAttributes } from '../src/stage'
import { motions, kineticMoods } from '../src/motions'

/** Seeded LCG — fuzz stays deterministic and failures print their seed. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

const themeNames = Object.keys(stageThemes) as StageThemeName[]
const HEX = /^#[0-9a-f]{6}$/i

/** WCAG relative luminance contrast between two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

describe('themes', () => {
  test('every theme references only real recipes and a real world', () => {
    for (const name of themeNames) {
      const t = stageThemes[name]
      expect(t.schemes.length).toBeGreaterThan(0)
      expect(t.world in stageWorlds).toBe(true)
      for (const m of t.moods) expect(m in kineticMoods).toBe(true)
      for (const d of t.decor) expect({ name, d, ok: d in stageDecor }).toEqual({ name, d, ok: true })
      for (const c of t.cameras) expect({ name, c, ok: c in cameraMoves }).toEqual({ name, c, ok: true })
      for (const tr of t.transitions) expect({ name, tr, ok: tr in stageTransitions }).toEqual({ name, tr, ok: true })
      expect(t.ja.length).toBeGreaterThan(0)
      expect(t.desc.length).toBeGreaterThan(10)
    }
  })

  test('every scheme is valid hex and the lyric colour reads against its background (contrast ≥ 4.5)', () => {
    for (const name of themeNames) {
      stageThemes[name].schemes.forEach((s, i) => {
        for (const v of Object.values(s)) expect(v).toMatch(HEX)
        expect({ name, i, ok: contrast(s.fg, s.bg) >= 4.5 }).toEqual({ name, i, ok: true })
      })
    }
  })

  test('schemeVars exposes every colour role as a CSS variable', () => {
    const t = stageThemes.noir
    const v = schemeVars(t.schemes[0], t)
    for (const k of ['--yura-bg', '--yura-fg', '--yura-sub', '--yura-accent', '--yura-accent2', '--yura-dim', '--yura-split-a', '--yura-split-b', '--yura-mono']) expect(v[k]).toBeTruthy()
  })
})

describe('camera', () => {
  test('every move stays finite over any progress, time and beat', () => {
    const rand = lcg(9)
    for (const move of Object.keys(cameraMoves) as (keyof typeof cameraMoves)[]) {
      for (let k = 0; k < 150; k++) {
        const pose = cameraAt(move, rand() * 1.4 - 0.2, rand() * 30, { beat: rand(), seed: k, accent: k % 3 === 0 })
        for (const v of Object.values(pose)) expect({ move, k, ok: Number.isFinite(v) }).toEqual({ move, k, ok: true })
        expect(pose.fov).toBeGreaterThan(10)
        expect(pose.fov).toBeLessThan(120)
      }
    }
  })

  test('non-finite inputs and unknown moves fall back instead of poisoning the camera', () => {
    // 1e308 is finite, but a recipe multiplying it overflows to Infinity and sin() turns that into NaN.
    const extreme = (Object.keys(cameraMoves) as (keyof typeof cameraMoves)[]).map((m) => cameraAt(m, 0.5, 1e308, { seed: 1e308 }))
    for (const pose of [cameraAt('orbit', NaN, NaN, { beat: NaN, seed: NaN }), cameraAt('nope' as never, 0.5, 1), ...extreme]) {
      for (const v of Object.values(pose)) expect(Number.isFinite(v)).toBe(true)
    }
  })

  test('reduced motion rests the camera; accents crash-zoom and decay', () => {
    expect(cameraAt('whip', 0.1, 0.2, { reducedMotion: true, accent: true })).toEqual({ x: 0, y: 0, z: CAMERA_DISTANCE, tx: 0, ty: 0, tz: 0, roll: 0, fov: CAMERA_FOV })
    const hit = cameraAt('float', 0, 0, { accent: true }).fov
    const later = cameraAt('float', 0.5, 2, { accent: true }).fov
    expect(hit).toBeLessThan(CAMERA_FOV - 10)
    expect(later).toBeCloseTo(CAMERA_FOV, 0)
  })

  test('dolly-in approaches and pull-back retreats', () => {
    expect(cameraAt('dolly-in', 1, 3).z).toBeLessThan(cameraAt('dolly-in', 0, 0).z)
    expect(cameraAt('pull-back', 1, 3).z).toBeGreaterThan(cameraAt('pull-back', 0, 0).z)
  })

  test('beat phase wraps per beat and survives bad tempos', () => {
    expect(beatPhase(0.25, 120)).toBeCloseTo(0.5)
    for (const bpm of [0, -1, NaN, Infinity]) expect(Number.isFinite(beatPhase(3.3, bpm))).toBe(true)
    expect(beatPhase(NaN, 120)).toBe(0)
  })
})

describe('transitions and screen fx', () => {
  test('outside the cut every transition is invisible; at the cut every real one covers', () => {
    for (const name of Object.keys(stageTransitions) as (keyof typeof stageTransitions)[]) {
      for (const p of [0, 1, -1, 2, NaN]) expect(transitionAt(name, p).opacity).toBe(0)
      const mid = transitionAt(name, 0.5, 3)
      if (name === 'cut') expect(mid.opacity).toBe(0)
      else expect({ name, covered: mid.opacity > 0.5 }).toEqual({ name, covered: true })
      for (let k = 1; k < 20; k++) {
        const f = transitionAt(name, k / 20, k)
        expect({ name, k, bad: /NaN|Infinity|undefined/.test(Object.values(f).join(' ')) }).toEqual({ name, k, bad: false })
      }
    }
  })

  test('shake and flash decay to nothing; grain offsets stay in 0..100', () => {
    expect(Math.abs(shakeAt(0, 1).x) + Math.abs(shakeAt(0, 1).y)).toBeGreaterThan(0)
    expect(shakeAt(3, 1)).toEqual({ x: 0, y: 0, rotate: 0 })
    expect(shakeAt(-1, 1)).toEqual({ x: 0, y: 0, rotate: 0 })
    expect(shakeAt(NaN, 1)).toEqual({ x: 0, y: 0, rotate: 0 })
    expect(accentFlash(0)).toBeGreaterThan(0.3)
    expect(accentFlash(2)).toBeLessThan(0.001)
    expect(accentFlash(NaN)).toBe(0)
    for (let t = 0; t < 5; t += 0.07) for (const v of grainOffset(t)) expect(v >= 0 && v <= 100).toBe(true)
    expect(grainOffset(NaN)).toHaveLength(2)
  })
})

describe('decor', () => {
  const ctx = { index: 3, total: 12, text: '<夜>を\n照らす', title: '<script>alert(1)</script>', artist: 'A & B', seed: 5 }

  test('every decor renders, and user text is escaped', () => {
    for (const name of Object.keys(stageDecor) as (keyof typeof stageDecor)[]) {
      const m = decorMarkup([name], ctx)
      expect({ name, has: (m.back + m.front).length > 0 }).toEqual({ name, has: true })
      expect(m.back + m.front).not.toContain('<script>')
    }
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;')
    expect(decorMarkup(['nope' as never], ctx)).toEqual({ back: '', front: '' })
  })

  test('timecode formats hh:mm:ss:ff and never shows garbage', () => {
    expect(formatTimecode(0)).toBe('00:00:00:00')
    expect(formatTimecode(3661.5)).toBe('01:01:01:15')
    expect(formatTimecode(NaN)).toBe('00:00:00:00')
    expect(formatTimecode(-4)).toBe('00:00:00:00')
    expect(formatTimecode(1, 0)).toBe('00:00:01:00')
  })

  test('live decor frames stay in range for any input', () => {
    const rand = lcg(3)
    for (const kind of ['timecode', 'rec', 'progress', 'beat', 'ticker', 'unknown']) {
      for (let k = 0; k < 80; k++) {
        const f = decorLive(kind, (rand() - 0.2) * 500, rand() * 3 - 1, rand() * 2 - 0.5)
        expect({ kind, k, bad: /NaN|Infinity|undefined/.test(JSON.stringify(f)) }).toEqual({ kind, k, bad: false })
      }
      const bad = decorLive(kind, NaN, NaN, NaN)
      expect(/NaN/.test(JSON.stringify(bad))).toBe(false)
    }
    expect(decorLive('progress', 0, 2, 0).transform).toBe('scaleX(1)')
  })
})

describe('world layouts (pure)', () => {
  test('layouts are deterministic in the seed', () => {
    expect(monolithLayout(4)).toEqual(monolithLayout(4))
    expect(monolithLayout(4)).not.toEqual(monolithLayout(5))
    expect(shardLayout(2)).toEqual(shardLayout(2))
    expect(dustLayout(1, 10)).toEqual(dustLayout(1, 10))
  })

  test('nothing solid is placed in the reading area in front of the words', () => {
    for (const seed of [1, 2, 3, 99]) {
      for (const p of [...monolithLayout(seed), ...shardLayout(seed)]) {
        if (p.z > -8) expect({ seed, p, clear: Math.abs(p.x) >= 6 }).toEqual({ seed, p, clear: true })
      }
    }
  })

  test('tunnel rings wrap into a fixed band; petals wrap vertically', () => {
    const len = TUNNEL_SPACING * TUNNEL_RINGS
    for (const travel of [0, 5, 123.4, 1e6, NaN]) {
      for (let i = 0; i < TUNNEL_RINGS; i++) {
        const z = tunnelRingZ(i, travel)
        expect(z).toBeLessThan(14.0001)
        expect(z).toBeGreaterThanOrEqual(14 - len - 1e-6)
      }
    }
    for (const p of petalLayout(3, 30)) for (const t of [0, 7, 1000]) {
      const s = petalAt(p, t)
      expect(Math.abs(s.y)).toBeLessThanOrEqual(PETAL_SPAN / 2 + 1e-9)
    }
  })

  test('glyph stars come from the lyrics, skip spaces, and respect the cap', () => {
    const stars = glyphStarLayout(['あい う', 'えお'], 1)
    expect(stars.map((s) => s.char)).toEqual(['あ', 'い', 'う', 'え', 'お'])
    expect(stars.map((s) => s.line)).toEqual([0, 0, 0, 1, 1])
    expect(glyphStarLayout(['あ'.repeat(500)], 1, 50)).toHaveLength(50)
  })
})

// ------------------------------------------------------------------ fake THREE

interface FakeThree {
  ns: Record<string, unknown>
  built: Record<string, number>
  renders: number
  disposed: number
  colours: string[]
}

function fakeThree(opts: { failRenderer?: boolean } = {}): FakeThree {
  const state: FakeThree = { ns: {}, built: {}, renders: 0, disposed: 0, colours: [] }
  const vec = () => ({ x: 0, y: 0, z: 0, set(x: number, y: number, z: number) { Object.assign(this, { x, y, z }) }, setScalar(v: number) { Object.assign(this, { x: v, y: v, z: v }) } })
  const make = (name: string) =>
    class {
      position = vec()
      rotation = vec()
      scale = vec()
      up = vec()
      matrix = {}
      instanceMatrix = { needsUpdate: false }
      color = { set: (v: string) => state.colours.push(v) }
      opacity = 1
      fov = 50
      fog: unknown = null
      children: unknown[] = []
      constructor(..._args: unknown[]) {
        state.built[name] = (state.built[name] ?? 0) + 1
        if (name === 'WebGLRenderer' && opts.failRenderer) throw new Error('WebGL unavailable')
      }
      add(c: unknown) { this.children.push(c) }
      setAttribute() {}
      dispose() { state.disposed++ }
      setClearColor(c: string) { state.colours.push(c) }
      setPixelRatio() {}
      setSize() {}
      render() { state.renders++ }
      lookAt() {}
      updateProjectionMatrix() {}
      updateMatrix() {}
      setMatrixAt() {}
    }
  state.ns = new Proxy({ SRGBColorSpace: 'srgb', DoubleSide: 2 } as Record<string, unknown>, {
    get(t, k: string) {
      if (!(k in t)) t[k] = make(k)
      return t[k]
    },
  })
  return state
}

function fakeCanvas(): HTMLCanvasElement {
  const ctx = new Proxy({}, { get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : () => ({ addColorStop() {} })), set: (t, k: string, v) => ((t[k] = v), true) })
  return { width: 0, height: 0, getContext: () => ctx, style: {} } as unknown as HTMLCanvasElement
}

describe('createStageWorld (fake THREE)', () => {
  const fonts = stageThemes.noir.fonts
  for (const name of Object.keys(stageWorlds) as (keyof typeof stageWorlds)[]) {
    test(`${name}: builds, runs frames, recolours, disposes`, () => {
      const three = fakeThree()
      const w = createStageWorld(three.ns, fakeCanvas(), { name, seed: 3, lines: ['夜明けの', '色を'], fonts, createCanvas: fakeCanvas })
      w.resize(1280, 720, 2)
      w.resize(0, 0, 1) // ignored, not a crash
      w.setScheme(stageThemes.noir.schemes[0])
      w.setLine(0, '夜明けの')
      const cam = cameraAt('orbit', 0.3, 1)
      for (let k = 0; k < 30; k++) w.frame({ t: k / 30, dt: 1 / 30, pulse: (k % 10) / 10, camera: cam })
      expect(three.renders).toBe(30)
      expect(three.colours).toContain(stageThemes.noir.schemes[0].bg)
      expect(three.colours).toContain(stageThemes.noir.schemes[0].accent)
      w.dispose()
      expect(three.disposed).toBeGreaterThan(2)
    })
  }
})

// ------------------------------------------------------------------ plan

describe('planStage', () => {
  const song = ['夜明けの色を', '覚えてる', { text: 'ひかりが走る', accent: true }, 'ことばより先に', '遠く', 'また会えるまで']

  test('deterministic in the seed; every cut swaps the colour scheme', () => {
    expect(planStage(song, { seed: 4 })).toEqual(planStage(song, { seed: 4 }))
    for (const theme of themeNames) {
      for (let seed = 1; seed < 8; seed++) {
        const plan = planStage(song, { theme, seed })
        for (let i = 1; i < plan.cuts.length; i++) {
          if (plan.theme.schemes.length > 1) expect({ theme, seed, i, same: plan.cuts[i].scheme === plan.cuts[i - 1].scheme }).toEqual({ theme, seed, i, same: false })
          expect(plan.cuts[i].camera === plan.cuts[i - 1].camera && plan.theme.cameras.length > 1).toBe(false)
        }
      }
    }
  })

  test('accent lines flash; the opening cut is a plain cut unless looping', () => {
    const plan = planStage(song, { seed: 2 })
    expect(plan.cuts[0].transition).toBe('cut')
    expect(plan.cuts[2].transition).toBe('flash')
    expect(plan.cuts[2].accent).toBe(true)
    const looped = planStage(song, { seed: 2, loop: true, transition: 'iris' })
    expect(looped.cuts[0].transition).toBe('iris')
  })

  test('draws lines from the theme moods and honours overrides', () => {
    const plan = planStage(song, { theme: 'crimson', seed: 5 })
    const pool = stageThemes.crimson.moods.flatMap((m) => kineticMoods[m].enter as readonly string[])
    for (const l of plan.lines) if (!l.accent) expect(pool).toContain(l.enter)
    const forced = planStage(song, { world: 'tunnel', camera: 'whip', decor: false })
    expect(forced.world).toBe('tunnel')
    expect(forced.decor).toEqual([])
    expect(forced.cuts.every((c) => c.camera === 'whip')).toBe(true)
  })

  test('reduced motion removes transitions', () => {
    for (const c of planStage(song, { reducedMotion: true, seed: 3 }).cuts) expect(c.transition).toBe('cut')
  })

  test('unknown theme / world / camera / transition / decor names throw YURA-019', () => {
    const bad = [{ theme: 'x' }, { world: 'x' }, { camera: 'x' }, { transition: 'x' }, { decor: ['x'] }, { theme: 'constructor' }]
    for (const opts of bad) {
      try {
        planStage(['a'], opts as never)
        throw new Error('expected a throw')
      } catch (e) {
        expect(e).toBeInstanceOf(YuraError)
        expect((e as YuraError).code).toBe(CODES.UNKNOWN_MOTION)
      }
    }
  })

  test('activeLine and transitionState follow the timeline, including the loop wrap', () => {
    const plan = planStage(['a', 'b', 'c'], { every: 2, loop: true, loopTail: 2, transition: 'wipe' })
    expect(activeLine(plan, 1)).toBe(-1)
    expect(activeLine(plan, 2.1)).toBe(0)
    expect(activeLine(plan, 4)).toBe(1)
    expect(transitionState(plan, 4)?.p).toBeCloseTo(0.5)
    expect(transitionState(plan, 5)).toBeNull()
    expect(transitionState(plan, plan.duration - 0.1)?.name).toBe('wipe')
    const once = planStage(['a', 'b'], { every: 2 })
    expect(transitionState(once, 2)).toBeNull() // opening cut, not looping
  })

  test('fitScale shrinks long rows to the stage, never grows, and leaves crops alone', () => {
    const [long] = planStage([{ text: 'あ'.repeat(30), layout: 'center' }]).lines
    expect(fitScale(long, 400, 800)).toBeLessThan(1)
    const [short] = planStage([{ text: 'あ', layout: 'center' }]).lines
    expect(fitScale(short, 1920, 1080)).toBe(1)
    const [giant] = planStage([{ text: 'あ'.repeat(30), layout: 'giant' }]).lines
    expect(fitScale(giant, 400, 800)).toBe(1)
    const [vert] = planStage([{ text: 'あ'.repeat(20), layout: 'vertical' }]).lines
    expect(fitScale(vert, 2000, 300)).toBeLessThan(fitScale(vert, 300, 2000))
    expect(fitScale(long, 0, 0)).toBe(1)
  })
})

// ------------------------------------------------------------------ DOM shell

interface El {
  tag: string
  style: Record<string, string>
  attrs: Record<string, string>
  children: El[]
  parent: El | null
  textContent: string | null
  _html: string
  innerHTML: string
  appendChild(c: El): El
  remove(): void
  setAttribute(k: string, v: string): void
  getAttribute(k: string): string | null
  querySelectorAll(sel: string): El[]
  width?: number
  height?: number
  getContext?: () => unknown
}

function fakeDoc() {
  const make = (tag: string): El => {
    const el: El = {
      tag,
      style: {},
      attrs: {},
      children: [],
      parent: null,
      textContent: null,
      _html: '',
      get innerHTML() {
        return el._html
      },
      set innerHTML(v: string) {
        el._html = v
      },
      appendChild(c) {
        c.parent = el
        el.children.push(c)
        return c
      },
      remove() {
        if (el.parent) el.parent.children = el.parent.children.filter((x) => x !== el)
        el.parent = null
      },
      setAttribute(k, v) {
        el.attrs[k] = v
      },
      getAttribute(k) {
        return el.attrs[k] ?? null
      },
      querySelectorAll(sel) {
        if (sel !== '[data-yura-live]') return []
        return [...el._html.matchAll(/data-yura-live="([a-z]+)"/g)].map((m) => {
          const live = make('span')
          live.attrs['data-yura-live'] = m[1]
          return live
        })
      },
    }
    if (tag === 'canvas') Object.assign(el, fakeCanvas(), { style: {} })
    return el
  }
  const body = make('body')
  return { body, doc: { createElement: make, querySelector: (s: string) => (s === '#hero' ? body : null) } }
}

const noFrames = () => ({ request: () => 1, cancel: () => {} })

describe('lyricStage (DOM shell)', () => {
  test('builds the layer stack, swaps schemes per line, and removes itself on stop', () => {
    const { body, doc } = fakeDoc()
    const run = lyricStage('#hero', [{ text: '夜明けの色を', at: 0 }, { text: 'ひかり', at: 2, accent: true }], {
      document: doc as never,
      scheduler: noFrames(),
      theme: 'noir',
      seed: 3,
      title: 'Song',
      reducedMotion: false,
    })
    expect(run.has3D).toBe(false)
    const root = body.children[0]
    expect(root.attrs.class).toBe('yura-stage')
    expect(root.children.length).toBeGreaterThanOrEqual(4)
    run.render(0.5)
    const bg0 = root.style['--yura-bg']
    run.render(2.05)
    expect(root.style['--yura-bg']).not.toBe(bg0)
    const flash = root.children[root.children.length - 1]
    expect(Number(flash.style.opacity)).toBeGreaterThan(0) // accent hit
    run.render(2.9)
    run.stop()
    expect(body.children).toHaveLength(0)
    run.stop() // idempotent
  })

  test('with THREE it renders a world; a failing WebGL falls back with YURA-021', () => {
    const three = fakeThree()
    const a = fakeDoc()
    const run = lyricStage('#hero', ['あ', 'い'], { document: a.doc as never, scheduler: noFrames(), three: three.ns })
    expect(run.has3D).toBe(true)
    run.render(4)
    expect(three.renders).toBeGreaterThan(0)
    run.stop()
    expect(three.disposed).toBeGreaterThan(0)

    const info = spyOn(console, 'info').mockImplementation(() => {})
    const b = fakeDoc()
    const fallback = lyricStage('#hero', ['あ'], { document: b.doc as never, scheduler: noFrames(), three: fakeThree({ failRenderer: true }).ns })
    expect(fallback.has3D).toBe(false)
    expect(info.mock.calls.some((c) => String(c[0]).includes(CODES.STAGE_3D_FALLBACK))).toBe(true)
    info.mockRestore()
    fallback.stop()
  })

  test('fuzz: any seed, theme and time renders without NaN reaching styles', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const rand = lcg(seed)
      const { body, doc } = fakeDoc()
      const run = lyricStage('#hero', ['一行目', { text: '二行目!', accent: true }, 'three'], {
        document: doc as never,
        scheduler: noFrames(),
        three: fakeThree().ns,
        theme: themeNames[seed % themeNames.length],
        seed,
        bpm: [NaN, 0, 90, 174][seed % 4],
        every: 0.3 + rand() * 2,
        reducedMotion: seed % 5 === 0,
      })
      for (let k = 0; k < 40; k++) run.render(rand() * 12)
      const dump = JSON.stringify(body, (key, v) => (key === 'parent' ? undefined : v))
      expect({ seed, bad: /NaN|Infinity/.test(dump) }).toEqual({ seed, bad: false })
      run.stop()
    }
  })

  test('decorative mode hides the stage from assistive tech; a missing target throws YURA-003', () => {
    const { body, doc } = fakeDoc()
    const run = lyricStage('#hero', ['a'], { document: doc as never, scheduler: noFrames(), a11y: 'hidden' })
    expect(body.children[0].attrs['aria-hidden']).toBe('true')
    run.stop()
    expect(() => lyricStage('#nope', ['a'], { document: doc as never, scheduler: noFrames() })).toThrow(YuraError)
  })
})

describe('custom element helpers', () => {
  const node = (text: string, attrs: Record<string, string> = {}) => ({
    textContent: text,
    getAttribute: (n: string) => attrs[n] ?? null,
    hasAttribute: (n: string) => n in attrs,
  })

  test('reads lines from child elements with data attributes', () => {
    const lines = readLyricNodes([node(' 夜明け '), node(''), node('ひかり', { 'data-accent': '', 'data-at': '4.5', 'data-enter': 'rise' })], '')
    expect(lines).toEqual([{ text: '夜明け' }, { text: 'ひかり', at: 4.5, accent: true, enter: 'rise' }])
  })

  test('falls back to one line per text line', () => {
    expect(readLyricNodes([], '\n  君の声が\n\n  夜を照らす \n')).toEqual([{ text: '君の声が' }, { text: '夜を照らす' }])
  })

  test('maps attributes to options (numbers parsed, loop="false" disables)', () => {
    const attrs: Record<string, string> = { theme: 'sakura', bpm: '128', seed: 'x', loop: 'false', song: 'S', artist: 'A' }
    const o = stageOptionsFromAttributes((n) => attrs[n] ?? null)
    expect(o).toMatchObject({ theme: 'sakura', bpm: 128, loop: false, title: 'S', artist: 'A' })
    expect(o.seed).toBeUndefined()
    expect(stageOptionsFromAttributes(() => null).loop).toBeUndefined()
  })
})

test('docs/LYRIC_MOTION.md documents every theme, world, decor, camera move and transition (doc drift guard)', async () => {
  const doc = await Bun.file(new URL('../../../docs/LYRIC_MOTION.md', import.meta.url).pathname).text()
  const tables: Record<string, object> = { theme: stageThemes, world: stageWorlds, decor: stageDecor, camera: cameraMoves, transition: stageTransitions }
  for (const [kind, table] of Object.entries(tables)) {
    for (const name of Object.keys(table)) expect({ kind, name, documented: doc.includes(`\`${name}\``) }).toEqual({ kind, name, documented: true })
  }
  void motions
})
