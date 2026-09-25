import { test, expect, describe } from 'bun:test'
import {
  motions,
  kineticMoods,
  kineticCatalog,
  identityPose,
  composePose,
  glyphRank,
  hash01,
  ACCENT_ENTERS,
  ACCENT_HOLD,
  type GlyphPose,
  type MotionGlyph,
  type TransitionRecipe,
  type HoldRecipe,
} from '../src/motions'
import {
  planKinetic,
  framePoses,
  phaseAt,
  originAt,
  poseToStyle,
  kineticDuration,
  kineticLyrics,
  type KineticElement,
  type KineticScheduler,
} from '../src/kinetic'
import { YuraError, CODES } from '@yura/core'

const REST = poseToStyle(identityPose())
const styleOf = (layer: Partial<GlyphPose>) => poseToStyle(composePose(identityPose(), layer))
const glyph = (i: number, n: number, seed = 7): MotionGlyph => ({ i, n, seed, char: '字', rank: n <= 1 ? 0 : i / (n - 1) })

/** Visually absent: transparent, collapsed to zero on an axis, or clipped away entirely. */
function hidden(layer: Partial<GlyphPose>): boolean {
  const p = composePose(identityPose(), layer)
  const [t, r, b, l] = p.clip
  return p.opacity <= 0.01 || Math.abs(p.scale * p.sx) < 0.01 || Math.abs(p.scale * p.sy) < 0.01 || t + b >= 100 || l + r >= 100
}

/** Seeded LCG — fuzz stays deterministic and failures print their seed. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

const enters = Object.entries(motions.enter) as [string, TransitionRecipe][]
const exits = Object.entries(motions.exit) as [string, TransitionRecipe][]
const holds = Object.entries(motions.hold) as [string, HoldRecipe][]

describe('vocabulary contracts', () => {
  test('every entrance ends exactly at rest (so the hold takes over without a jump)', () => {
    for (const [name, r] of enters) {
      for (let i = 0; i < 5; i++) {
        const s = styleOf(r.pose(1, glyph(i, 5)))
        expect({ name, ...s }).toEqual({ name, ...REST })
        expect(r.pose(1, glyph(i, 5)).char).toBeUndefined()
      }
    }
  })

  test('every exit starts exactly at rest', () => {
    for (const [name, r] of exits) {
      for (let i = 0; i < 5; i++) {
        expect({ name, ...styleOf(r.pose(0, glyph(i, 5))) }).toEqual({ name, ...REST })
        expect(r.pose(0, glyph(i, 5)).char).toBeUndefined()
      }
    }
  })

  test('every entrance starts hidden and every exit ends hidden', () => {
    for (const [name, r] of enters) for (let i = 0; i < 4; i++) expect({ name, hidden: hidden(r.pose(0, glyph(i, 4))) }).toEqual({ name, hidden: true })
    for (const [name, r] of exits) for (let i = 0; i < 4; i++) expect({ name, hidden: hidden(r.pose(1, glyph(i, 4))) }).toEqual({ name, hidden: true })
  })

  test('the still hold is the identity; every hold stays finite with opacity in 0..1', () => {
    expect(styleOf(motions.hold.still.pose(3, glyph(0, 1), 0.5))).toEqual(REST)
    const rand = lcg(42)
    for (const [name, r] of holds) {
      for (let k = 0; k < 200; k++) {
        const t = rand() * 60
        const p = composePose(identityPose(), r.pose(t, glyph(k % 9, 9, k), 0.3 + rand()))
        const css = Object.values(poseToStyle(p)).join(' ')
        expect({ name, k, bad: /NaN|Infinity/.test(css) }).toEqual({ name, k, bad: false })
        expect(p.opacity).toBeGreaterThanOrEqual(0)
        expect(p.opacity).toBeLessThanOrEqual(1)
      }
    }
  })

  test('scramble glyphs are real characters and blanks stay blank', () => {
    const r = motions.enter.scramble
    const mid = r.pose(0.4, glyph(1, 3))
    expect(typeof mid.char).toBe('string')
    expect(Array.from(mid.char as string)).toHaveLength(1)
    expect(r.pose(0.4, { ...glyph(1, 3), char: ' ' }).char).toBe(' ')
  })

  test('random-looking effects are pure functions of the seed', () => {
    const a = motions.exit.scatter.pose(0.5, glyph(2, 6, 11))
    const b = motions.exit.scatter.pose(0.5, glyph(2, 6, 11))
    const c = motions.exit.scatter.pose(0.5, glyph(2, 6, 12))
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
    expect(hash01(1, 2, 3)).toBe(hash01(1, 2, 3))
    for (let i = 0; i < 1000; i++) {
      const h = hash01(i, i * 3, 5)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(1)
    }
  })

  test('glyph orders rank 0..1 with the right glyph first', () => {
    expect(glyphRank('ltr', 0, 5)).toBe(0)
    expect(glyphRank('rtl', 4, 5)).toBe(0)
    expect(glyphRank('center', 2, 5)).toBe(0)
    expect(glyphRank('center', 0, 5)).toBe(1)
    expect(glyphRank('edges', 0, 5)).toBe(0)
    expect(glyphRank('edges', 2, 5)).toBe(1)
    expect(glyphRank('all', 3, 5)).toBe(0)
    for (const o of ['ltr', 'rtl', 'center', 'edges', 'random', 'all'] as const) expect(glyphRank(o, 0, 1)).toBe(0)
  })

  test('the catalog puts every recipe into words, and moods only name real recipes', () => {
    const cat = kineticCatalog()
    const total = Object.values(motions).reduce((n, reg) => n + Object.keys(reg).length, 0)
    expect(cat).toHaveLength(total)
    for (const e of cat) {
      expect(e.ja.length).toBeGreaterThan(0)
      expect(e.desc.length).toBeGreaterThan(10)
    }
    for (const [mood, m] of Object.entries(kineticMoods)) {
      for (const phase of ['enter', 'hold', 'exit', 'layout'] as const) {
        expect(m[phase].length).toBeGreaterThan(0)
        for (const name of m[phase]) expect({ mood, phase, name, ok: name in motions[phase] }).toEqual({ mood, phase, name, ok: true })
      }
    }
    for (const name of ACCENT_ENTERS) expect(name in motions.enter).toBe(true)
    expect(ACCENT_HOLD in motions.hold).toBe(true)
  })

  test('docs/LYRIC_MOTION.md documents every recipe and mood (doc drift guard)', async () => {
    const doc = await Bun.file(new URL('../../../docs/LYRIC_MOTION.md', import.meta.url).pathname).text()
    for (const e of kineticCatalog()) expect({ phase: e.phase, name: e.name, documented: doc.includes(`\`${e.name}\``) }).toEqual({ phase: e.phase, name: e.name, documented: true })
    for (const mood of Object.keys(kineticMoods)) expect(doc.includes(`\`${mood}\``)).toBe(true)
  })
})

describe('planKinetic', () => {
  const song = ['君の声が', '夜を照らす', '粒子のなかで', 'また君に出会う', '光の中で', 'もう一度', '歌おう', 'ずっと']

  test('same seed → same plan; different seeds → a different plan', () => {
    expect(planKinetic(song, { seed: 3 })).toEqual(planKinetic(song, { seed: 3 }))
    const a = planKinetic(song, { seed: 3, mood: 'mix' }).map((l) => l.enter + l.exit + l.layout)
    const b = planKinetic(song, { seed: 4, mood: 'mix' }).map((l) => l.enter + l.exit + l.layout)
    expect(a).not.toEqual(b)
  })

  test('draws from the chosen mood and never repeats an entrance back to back', () => {
    for (const mood of Object.keys(kineticMoods) as (keyof typeof kineticMoods)[]) {
      for (let seed = 1; seed <= 20; seed++) {
        const plan = planKinetic(song, { mood, seed })
        for (let i = 0; i < plan.length; i++) {
          const m = kineticMoods[mood] as { enter: readonly string[]; hold: readonly string[]; exit: readonly string[]; layout: readonly string[] }
          expect(m.enter).toContain(plan[i].enter)
          expect(m.hold).toContain(plan[i].hold)
          expect(m.exit).toContain(plan[i].exit)
          expect(m.layout).toContain(plan[i].layout)
          if (i > 0) expect({ mood, seed, i, repeat: plan[i].enter === plan[i - 1].enter }).toEqual({ mood, seed, i, repeat: false })
        }
      }
    }
  })

  test('line fields beat run overrides, which beat the mood', () => {
    const plan = planKinetic([{ text: 'a', enter: 'pop' }, 'b'], { enter: 'wipe', hold: 'wave', mood: 'glitch' })
    expect(plan[0].enter).toBe('pop')
    expect(plan[1].enter).toBe('wipe')
    expect(plan[1].hold).toBe('wave')
  })

  test('accent lines use the loud entrances, a beat pulse, and center stage', () => {
    for (let seed = 1; seed < 10; seed++) {
      const [l] = planKinetic([{ text: 'サビ', accent: true }], { seed })
      expect(ACCENT_ENTERS).toContain(l.enter)
      expect(l.hold).toBe(ACCENT_HOLD)
      expect(l.layout).toBe('center')
    }
  })

  test('reduced motion quiets every phase', () => {
    for (const l of planKinetic(song, { mood: 'glitch', reducedMotion: true })) {
      expect([l.enter, l.hold, l.exit]).toEqual(['fade', 'still', 'fade'])
    }
  })

  test('unknown recipe or mood names throw YURA-019 with the available names', () => {
    const bad = [
      () => planKinetic(['x'], { enter: 'nope' as never }),
      () => planKinetic([{ text: 'x', exit: 'nope' as never }]),
      () => planKinetic(['x'], { mood: 'nope' as never }),
      () => planKinetic(['x'], { enter: 'toString' as never }),
    ]
    for (const f of bad) {
      try {
        f()
        throw new Error('expected a throw')
      } catch (e) {
        expect(e).toBeInstanceOf(YuraError)
        expect((e as YuraError).code).toBe(CODES.UNKNOWN_MOTION)
      }
    }
  })

  test('timing: auto-timed lines, capped transitions, the last line holds unless looping', () => {
    const plan = planKinetic(['a', 'b', { text: 'c', at: 7.2 }], { every: 3, enterDuration: 2, exitDuration: 2 })
    expect(plan.map((l) => l.start)).toEqual([3, 6, 7.2])
    expect(plan[0].end).toBe(6)
    expect(plan[1].enterDuration).toBeCloseTo(1.2 * 0.45)
    expect(plan[1].exitDuration).toBeCloseTo(1.2 * 0.3)
    expect(plan[2].end).toBe(Infinity)
    expect(plan[2].exitDuration).toBe(0)
    expect(kineticDuration(plan)).toBe(0)
    const looped = planKinetic(['a', 'b'], { every: 2, loop: true, loopTail: 1.5 })
    expect(looped[1].end).toBe(5.5)
    expect(kineticDuration(looped)).toBe(5.5)
  })

  test('non-finite knobs fall back instead of poisoning the timeline', () => {
    const plan = planKinetic(['a', 'b'], { every: NaN, enterDuration: Infinity, exitDuration: -1, seed: NaN })
    for (const l of plan) {
      expect(Number.isFinite(l.start)).toBe(true)
      expect(Number.isFinite(l.enterDuration)).toBe(true)
      expect(Number.isFinite(l.seed)).toBe(true)
    }
  })

  test('graphemes stay whole and rows split on newlines', () => {
    const [l] = planKinetic(['👨‍👩‍👧 が\n笑う'])
    expect(l.glyphs).toEqual(['👨‍👩‍👧', ' ', 'が', '笑', 'う'])
    expect(l.rows).toEqual([3, 2])
  })
})

describe('framePoses / phases', () => {
  const [line] = planKinetic([{ text: 'ことば', at: 1, enter: 'rise', hold: 'still', exit: 'sink' }, { text: 'next', at: 5 }], { enterDuration: 1, exitDuration: 1 })

  test('off screen before start and from end on', () => {
    expect(framePoses(line, 0.99)).toBeNull()
    expect(framePoses(line, 5)).toBeNull()
    expect(framePoses(line, NaN)).toBeNull()
    expect(phaseAt(line, 0.5)).toBeNull()
  })

  test('enter → hold → exit, resting in between', () => {
    expect(phaseAt(line, 1.5)).toBe('enter')
    expect(phaseAt(line, 3)).toBe('hold')
    expect(phaseAt(line, 4.5)).toBe('exit')
    const mid = framePoses(line, 1.3)!
    expect(mid).toHaveLength(3)
    expect(poseToStyle(mid[0]).clipPath).not.toBe('none')
    for (const p of framePoses(line, 3)!) expect(poseToStyle(p)).toEqual(REST)
    const leaving = framePoses(line, 4.9)!
    expect(leaving.some((p) => poseToStyle(p).transform !== 'none')).toBe(true)
  })

  test('the entrance staggers: the first glyph leads the last', () => {
    const p = framePoses(line, 1.35)!
    expect(p[0].ty).toBeLessThan(p[2].ty)
  })

  test('transform-origin follows the active phase', () => {
    const [l] = planKinetic([{ text: 'ab', enter: 'domino', hold: 'sway', exit: 'fade' }, { text: 'c', at: 10 }], { every: 1 })
    expect(originAt(l, 1.1)).toBe('0% 100%')
    expect(originAt(l, 5)).toBe('50% 100%')
    const [plain] = planKinetic([{ text: 'ab', enter: 'fade', hold: 'still', exit: 'fade' }])
    expect(originAt(plain, 5)).toBe('50% 50%')
  })

  test('fuzz: any seed, mood, time and bpm yields finite CSS', () => {
    const moods = [...Object.keys(kineticMoods), 'mix'] as const
    for (let seed = 1; seed <= 40; seed++) {
      const rand = lcg(seed)
      const plan = planKinetic(['あいう', 'hello world', { text: '★', accent: true }, '縦\n書き'], {
        mood: moods[seed % moods.length] as never,
        seed,
        every: 0.2 + rand() * 3,
        loop: seed % 2 === 0,
      })
      for (let k = 0; k < 60; k++) {
        const t = rand() * 15
        const bpm = [NaN, 0, -5, 60, 174, Infinity][k % 6]
        for (const l of plan) {
          const poses = framePoses(l, t, bpm)
          if (!poses) continue
          const css = poses.map((p) => Object.values(poseToStyle(p)).join(' ')).join(' ')
          expect({ seed, k, bad: /NaN|Infinity|undefined/.test(css) }).toEqual({ seed, k, bad: false })
        }
      }
    }
  })
})

describe('poseToStyle', () => {
  test('rest writes none everywhere', () => {
    expect(REST).toEqual({ transform: 'none', opacity: '1', filter: 'none', clipPath: 'none', textShadow: 'none' })
  })

  test('serializes each channel in em / % / deg', () => {
    const s = styleOf({ x: 0.5, ty: 20, rotate: 10, scale: 2, sy: 0.5, blur: 0.1, clip: [0, 0, 20, 0], glow: 0.2, split: 0.1, opacity: 0.5 })
    expect(s.transform).toBe('translate(0.5em, 0em) translate(0%, 20%) rotate(10deg) scale(2, 1)')
    expect(s.filter).toBe('blur(0.1em)')
    expect(s.clipPath).toBe('inset(0% 0% 20% 0%)')
    expect(s.textShadow).toContain('0 0 0.2em currentColor')
    expect(s.textShadow).toContain('var(--yura-split-a')
    expect(s.opacity).toBe('0.5')
  })

  test('non-finite fields collapse to rest instead of reaching CSS', () => {
    const p = identityPose()
    Object.assign(p, { x: NaN, scale: Infinity, opacity: NaN, blur: NaN, glow: -Infinity, split: NaN })
    p.clip = [NaN, 0, 0, 0]
    expect(poseToStyle(p)).toEqual(REST)
  })
})

// ------------------------------------------------------------------ DOM shell (fakes)

interface FakeEl extends KineticElement {
  tag: string
  children: FakeEl[]
  parent: FakeEl | null
  attrs: Record<string, string>
  style: Record<string, string>
  writes: number
}

function fakeDocument() {
  const make = (tag: string): FakeEl => {
    const el: FakeEl = {
      tag,
      children: [],
      parent: null,
      attrs: {},
      textContent: null,
      writes: 0,
      style: {},
      appendChild(child: KineticElement) {
        const c = child as FakeEl
        c.parent = el
        el.children.push(c)
        return c
      },
      remove() {
        if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el)
        el.parent = null
      },
      setAttribute(k: string, v: string) {
        el.attrs[k] = v
      },
    }
    el.style = new Proxy({} as Record<string, string>, {
      set(o, k, v) {
        el.writes++
        o[k as string] = v
        return true
      },
    })
    return el
  }
  const body = make('body')
  return {
    body,
    doc: { createElement: make, querySelector: (sel: string) => (sel === '#stage' ? body : null) },
  }
}

function manualScheduler(): KineticScheduler & { pending: number } {
  let id = 0
  const s = {
    pending: 0,
    request: () => {
      s.pending++
      return ++id
    },
    cancel: () => {
      s.pending--
    },
  }
  return s
}

const spans = (el: FakeEl): FakeEl[] => (el.tag === 'span' ? [el] : el.children.flatMap(spans))

describe('kineticLyrics (DOM shell)', () => {
  test('mounts a line when it arrives and unmounts it when it leaves', () => {
    const { body, doc } = fakeDocument()
    const run = kineticLyrics('#stage', [{ text: 'やあ', at: 0 }, { text: 'またね', at: 2 }], { document: doc, scheduler: manualScheduler(), reducedMotion: false })
    const root = body.children[0]
    expect(root.style.position).toBe('absolute')
    run.render(0.5)
    expect(root.children).toHaveLength(1)
    expect(root.children[0].attrs['aria-label']).toBe('やあ')
    expect(spans(root).map((s) => s.textContent)).toEqual(['や', 'あ'])
    run.render(1.99)
    run.render(2.5)
    expect(root.children).toHaveLength(1)
    expect(root.children[0].attrs['aria-label']).toBe('またね')
    run.stop()
    expect(body.children).toHaveLength(0)
  })

  test('an unchanged frame writes nothing to the DOM', () => {
    const { body, doc } = fakeDocument()
    const run = kineticLyrics('#stage', [{ text: 'しずか', enter: 'fade', hold: 'still', exit: 'fade' }], { document: doc, scheduler: manualScheduler(), every: 0 })
    run.render(5)
    const s = spans(body.children[0])
    const before = s.reduce((n, el) => n + el.writes, 0)
    run.render(6)
    run.render(7)
    expect(s.reduce((n, el) => n + el.writes, 0)).toBe(before)
  })

  test('scramble writes replacement characters, then settles on the real text', () => {
    const { body, doc } = fakeDocument()
    const run = kineticLyrics('#stage', [{ text: 'ABCDEFGH', enter: 'scramble', hold: 'still' }], { document: doc, scheduler: manualScheduler(), every: 0, enterDuration: 1 })
    run.render(0.5)
    const mid = spans(body.children[0]).map((s) => s.textContent).join('')
    expect(mid).not.toBe('ABCDEFGH')
    run.render(2)
    expect(spans(body.children[0]).map((s) => s.textContent).join('')).toBe('ABCDEFGH')
  })

  test('drives frames through the scheduler and honors a custom clock with looping', () => {
    const { body, doc } = fakeDocument()
    const sched = manualScheduler()
    let clock = 0
    const run = kineticLyrics('#stage', ['いち', 'に'], { document: doc, scheduler: sched, clock: () => clock, every: 1, loop: true, loopTail: 1 })
    expect(sched.pending).toBe(1)
    clock = 3.5 // wraps to 0.5 → before the first line (at 1)
    run.render(clock % kineticDuration(run.plan))
    expect(body.children[0].children).toHaveLength(0)
    run.stop()
    expect(sched.pending).toBe(0)
  })

  test('a missing target throws YURA-003', () => {
    const { doc } = fakeDocument()
    try {
      kineticLyrics('#nope', ['x'], { document: doc, scheduler: manualScheduler() })
      throw new Error('expected a throw')
    } catch (e) {
      expect((e as YuraError).code).toBe(CODES.TARGET_NOT_FOUND)
    }
  })
})
