import { test, expect } from 'bun:test'
import { segmentGraphemes, charCoord, layoutLines, layoutColumns, text, sphere, vortex, type ShapeSpec } from '../src/shapes'
import {
  sweepProgress,
  applySweepDirection,
  textDampTarget,
  easeDampFactor,
  TEXT_DAMP_NEUTRAL,
  TEXT_DAMP_AT_REF,
  TEXT_DAMP_MIN,
  TEXT_DAMP_REF_COUNT,
} from '../src/app'
import {
  orderLines,
  buildTimeline,
  timelineDuration,
  wrapTime,
  advanceCursor,
  normalizeLines,
  lyrics,
  type LyricLine,
} from '../src/lyrics'
import type { YuraApp } from '../src/app'

// Kinetic-typography pure math: grapheme segmentation, per-character
// coordinate ordering, multi-line layout, the shader sweep mirror, and the
// lyrics scheduling core. The canvas/GPU halves (actual rasterization, the
// WGSL/GLSL sweep) need a browser.

// ---- grapheme segmentation ----

test('CJK text segments per character', () => {
  const gs = segmentGraphemes('ゆらめくヒカリ')
  expect(gs).toEqual(['ゆ', 'ら', 'め', 'く', 'ヒ', 'カ', 'リ'])
})

test('compound emoji stay whole with Intl.Segmenter', () => {
  expect('Segmenter' in Intl).toBe(true) // bun ships ICU segmentation
  expect(segmentGraphemes('👨‍👩‍👧‍👦')).toHaveLength(1)
  expect(segmentGraphemes('君❤️夜')).toHaveLength(3)
})

test('fallback path is surrogate-pair safe', () => {
  expect(segmentGraphemes('あ😀B', false)).toEqual(['あ', '😀', 'B'])
  // ZWJ families do split under the fallback — that is the accepted cost.
  expect(segmentGraphemes('👨‍👩‍👧', false).length).toBeGreaterThan(1)
})

// ---- per-character coordinate ordering ----

test('charCoord orders characters monotonically in reading order', () => {
  const starts = [0, 1, 2, 3, 4].map((i) => charCoord(i, 0, 5))
  for (let i = 1; i < starts.length; i++) expect(starts[i]).toBeGreaterThan(starts[i - 1])
  // Character i owns the band [i/count, (i+1)/count].
  expect(charCoord(2, 0, 5)).toBeCloseTo(0.4, 6)
  expect(charCoord(2, 1, 5)).toBeCloseTo(0.6, 6)
})

test('charCoord spreads within a character and clamps intra + range', () => {
  expect(charCoord(0, 0.25, 4)).toBeGreaterThan(charCoord(0, 0.1, 4))
  expect(charCoord(0, -5, 4)).toBe(0) // intra clamps low
  expect(charCoord(3, 5, 4)).toBe(1) // intra clamps high, coord caps at 1
  expect(charCoord(0, 0, 0)).toBe(0) // degenerate charCount
})

// ---- multi-line layout ----

test('layoutLines stacks lines around the vertical center', () => {
  const placed = layoutLines([300, 500], 100, 20, 'center', 1000)
  // Total block = 2*100 + 20 = 220, centered: line centers at -60 and +60.
  expect(placed[0].y).toBeCloseTo(-60, 6)
  expect(placed[1].y).toBeCloseTo(60, 6)
  // A single line sits exactly on the center.
  expect(layoutLines([300], 100, 20, 'center', 1000)[0].y).toBeCloseTo(0, 6)
})

test('layoutLines aligns left, center, and right', () => {
  expect(layoutLines([100], 50, 0, 'left', 1000)[0].x).toBe(0)
  expect(layoutLines([100], 50, 0, 'center', 1000)[0].x).toBe(450)
  expect(layoutLines([100], 50, 0, 'right', 1000)[0].x).toBe(900)
})

test('text v2 accepts multi-line and layout options without breaking the API', () => {
  const spec = text('こんにちは\n世界', { lineGap: 0.3, align: 'left', letterSpacing: 0.05 })
  expect(spec.kind).toBe('text')
  const legacy = text('YURA', { font: '900 250px sans-serif', worldWidth: 20 })
  expect(legacy.kind).toBe('text') // v1 call sites still typecheck and build
})

// ---- vertical (tategaki) layout ----

test('layoutColumns stacks columns right-to-left around the horizontal center', () => {
  const placed = layoutColumns([300, 500], 100, 20, 'left', 1000)
  // Total block = 2*100 + 20 = 220: centers at ±60, the FIRST column rightmost.
  expect(placed[0].x).toBeCloseTo(60, 6)
  expect(placed[1].x).toBeCloseTo(-60, 6)
  expect(placed[0].x).toBeGreaterThan(placed[1].x) // line order runs right→left
  // A single column sits exactly on the horizontal center.
  expect(layoutColumns([300], 100, 20, 'center', 1000)[0].x).toBeCloseTo(0, 6)
})

test('layoutColumns transposes align onto the vertical reading axis', () => {
  expect(layoutColumns([100], 50, 0, 'left', 1000)[0].y).toBe(0) // top
  expect(layoutColumns([100], 50, 0, 'center', 1000)[0].y).toBe(450)
  expect(layoutColumns([100], 50, 0, 'right', 1000)[0].y).toBe(900) // bottom
})

// The canvas half of text() runs headless here through a deterministic mock:
// fillText calls are recorded, and getImageData lights one pixel per drawn
// glyph, so layout decisions and the sampled particles are fully observable.

interface Fill {
  text: string
  x: number
  y: number
}

function withMockCanvas<T>(run: () => T): { result: T; fills: Fill[] } {
  const fills: Fill[] = []
  const g = globalThis as { document?: unknown }
  const prevDoc = g.document
  g.document = {
    createElement: () => {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({
          fillStyle: '',
          textAlign: '',
          textBaseline: '',
          font: '',
          measureText: (s: string) => ({ width: 100 * segmentGraphemes(s).length }),
          fillText: (t: string, x: number, y: number) => {
            fills.push({ text: t, x, y })
          },
          getImageData: (_x: number, _y: number, w: number, h: number) => {
            const data = new Uint8ClampedArray(w * h * 4)
            for (const f of fills) {
              const px = Math.min(Math.max(Math.round(f.x), 0), w - 1)
              const py = Math.min(Math.max(Math.round(f.y), 0), h - 1)
              data[(py * w + px) * 4 + 3] = 255
            }
            return { data }
          },
        }),
      }
      return canvas
    },
  }
  try {
    return { result: run(), fills }
  } finally {
    if (prevDoc === undefined) delete g.document
    else g.document = prevDoc
  }
}

/** Runs `fn` with Math.random replaced by a seeded LCG (same sequence every call). */
function stubRandom<T>(fn: () => T): T {
  const orig = Math.random
  let seed = 42
  Math.random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
  try {
    return fn()
  } finally {
    Math.random = orig
  }
}

const FONT = '900 100px sans-serif'

test('vertical text draws graphemes top-to-bottom and lines as columns right-to-left', () => {
  const { fills } = withMockCanvas(() => {
    text('ゆらめ\nヒカリ', { font: FONT, vertical: true }).generate(8)
  })
  const at = (g: string): Fill => fills.find((f) => f.text === g)!
  const col1 = ['ゆ', 'ら', 'め'].map(at)
  const col2 = ['ヒ', 'カ', 'リ'].map(at)
  for (const col of [col1, col2]) {
    // Within a column: one shared x, strictly increasing y (top→bottom).
    expect(col[1].x).toBeCloseTo(col[0].x, 6)
    expect(col[2].x).toBeCloseTo(col[0].x, 6)
    expect(col[1].y).toBeGreaterThan(col[0].y)
    expect(col[2].y).toBeGreaterThan(col[1].y)
  }
  // The FIRST input line is the RIGHTMOST column (tategaki reading order).
  expect(col1[0].x).toBeGreaterThan(col2[0].x)
  // Equal-height columns start at the same top edge.
  expect(col2[0].y).toBeCloseTo(col1[0].y, 6)
})

test('vertical defaults off: omitted and vertical:false generate bit-identical particles', () => {
  const gen = (opts: { vertical?: boolean }): Float32Array =>
    withMockCanvas(() =>
      stubRandom(() => text('ゆら\nYURA', { font: FONT, ...opts }).generate(96) as Float32Array),
    ).result
  const legacy = gen({})
  const explicit = gen({ vertical: false })
  expect(explicit.length).toBe(legacy.length)
  let diffs = 0
  for (let i = 0; i < legacy.length; i++) {
    if (!Object.is(explicit[i], legacy[i])) diffs++
  }
  expect(diffs).toBe(0) // bit-exact: the flag's false path IS the legacy path
  // ...while vertical:true actually changes the layout under the same seed.
  const tategaki = gen({ vertical: true })
  expect(tategaki.some((v, i) => !Object.is(v, legacy[i]))).toBe(true)
})

test('vertical composes with align, letterSpacing, and lineGap (meanings transposed)', () => {
  const run = (opts: object): Fill[] =>
    withMockCanvas(() => {
      text('ゆら\nヒ', { font: FONT, vertical: true, ...opts }).generate(8)
    }).fills
  const at = (fills: Fill[], g: string): Fill => fills.find((f) => f.text === g)!
  // align: 'left' pins the short column to the top, 'right' to the bottom.
  expect(at(run({ align: 'right' }), 'ヒ').y).toBeGreaterThan(at(run({ align: 'left' }), 'ヒ').y)
  const tight = run({})
  // letterSpacing opens the gap along the READING axis (y), not x.
  const spaced = run({ letterSpacing: 0.5 })
  const gapY = (fills: Fill[]): number => at(fills, 'ら').y - at(fills, 'ゆ').y
  expect(gapY(spaced)).toBeGreaterThan(gapY(tight))
  expect(at(spaced, 'ら').x).toBeCloseTo(at(spaced, 'ゆ').x, 6) // still one column
  // lineGap opens the gap BETWEEN columns (x).
  const wide = run({ lineGap: 1.0 })
  const gapX = (fills: Fill[]): number => at(fills, 'ゆ').x - at(fills, 'ヒ').x
  expect(gapX(wide)).toBeGreaterThan(gapX(tight))
})

test('vertical particle coords sweep in tategaki reading order', () => {
  // 2×2 grid: あ=right-top, い=right-bottom, う=left-top, え=left-bottom.
  const data = withMockCanvas(() =>
    stubRandom(() => text('あい\nうえ', { font: FONT, vertical: true }).generate(200) as Float32Array),
  ).result
  for (let i = 0; i < 200; i++) {
    const x = data[i * 4]
    const y = data[i * 4 + 1]
    const c = data[i * 4 + 3]
    // charCoord bands (charCount 4, intra 0.5): reading order is the right
    // column top→bottom, THEN the left column — not row-major.
    if (x > 0) expect(c).toBeCloseTo(y > 0 ? 0.125 : 0.375, 2)
    else expect(c).toBeCloseTo(y > 0 ? 0.625 : 0.875, 2)
  }
})

// ---- sweep clamp math (mirror of the WGSL/GLSL sim) ----

test('sweep spread 0 is the uniform morph (bit-exact legacy)', () => {
  for (const t of [0, 0.25, 0.618, 1]) {
    for (const delay of [0, 0.3, 0.99, 1]) {
      expect(sweepProgress(t, delay, 0)).toBe(t)
    }
  }
})

test('sweep endpoints reach 0 and 1 for every delay', () => {
  const s = 0.8
  for (const delay of [0, 0.25, 0.5, 0.75, 1]) {
    expect(sweepProgress(0, delay, s)).toBe(0)
    expect(sweepProgress(1, delay, s)).toBe(1)
  }
  // First char lands early, last char leaves late — the stagger itself.
  expect(sweepProgress(1 / (1 + s), 0, s)).toBeCloseTo(1, 6)
  expect(sweepProgress(s / (1 + s), 1, s)).toBeCloseTo(0, 6)
  expect(sweepProgress(0.5, 0, s)).toBeGreaterThan(sweepProgress(0.5, 1, s))
})

test('applySweepDirection remaps the delay coordinate in place', () => {
  const make = () => new Float32Array([0, 0, 0, 0, 0, 0, 0, 0.25, 0, 0, 0, 0.5, 0, 0, 0, 1])
  const rtl = applySweepDirection(make(), 'rtl')
  expect([rtl[3], rtl[7], rtl[11], rtl[15]]).toEqual([1, 0.75, 0.5, 0])
  const center = applySweepDirection(make(), 'center')
  expect(center[11]).toBeCloseTo(0, 6) // middle char goes first
  expect(center[3]).toBeCloseTo(1, 6) // edges go last
  expect(center[15]).toBeCloseTo(1, 6)
  const r1 = applySweepDirection(make(), 'random')
  const r2 = applySweepDirection(make(), 'random')
  for (const i of [3, 7, 11, 15]) {
    expect(r1[i]).toBeGreaterThanOrEqual(0)
    expect(r1[i]).toBeLessThan(1)
    expect(r1[i]).toBe(r2[i]) // deterministic
  }
  const ltr = applySweepDirection(make(), 'ltr')
  expect([ltr[3], ltr[7], ltr[11], ltr[15]]).toEqual([0, 0.25, 0.5, 1]) // untouched
})

// ---- lyrics timing table ----

const LINES: LyricLine[] = [
  { text: '夜を照らす', at: 4 },
  { text: '君の声が', at: 0 },
  { text: '波のように踊る', at: 6 },
]

test('orderLines sorts by start time and is stable', () => {
  const ordered = orderLines(LINES)
  expect(ordered.map((l) => l.at)).toEqual([0, 4, 6])
  const tied = orderLines([
    { text: 'a', at: 2 },
    { text: 'b', at: 2 },
  ])
  expect(tied.map((l) => l.text)).toEqual(['a', 'b'])
})

test('dissolve timeline is one line event per line, in order', () => {
  const events = buildTimeline(LINES, { out: 'dissolve' })
  expect(events.map((e) => e.kind)).toEqual(['line', 'line', 'line'])
  expect(events.map((e) => e.time)).toEqual([0, 4, 6])
  expect(events.map((e) => e.line)).toEqual([0, 1, 2])
})

test('explode timeline inserts interstitials strictly between lines', () => {
  const events = buildTimeline(LINES, { out: 'explode', lead: 0.9 })
  expect(events.map((e) => e.kind)).toEqual(['line', 'interstitial', 'line', 'interstitial', 'line'])
  expect(events[1].time).toBeCloseTo(3.1, 6) // 4 - 0.9
  expect(events[3].time).toBeCloseTo(5.1, 6) // max(6 - 0.9, midpoint 5)
  // Never before the first line; strictly increasing overall.
  for (let i = 1; i < events.length; i++) {
    expect(events[i].time).toBeGreaterThan(events[i - 1].time)
  }
})

test('explode interstitial clamps into tight gaps and skips zero gaps', () => {
  const tight = buildTimeline(
    [
      { text: 'a', at: 0 },
      { text: 'b', at: 0.4 },
    ],
    { out: 'explode', lead: 0.9 },
  )
  expect(tight).toHaveLength(3)
  expect(tight[1].time).toBeCloseTo(0.2, 6) // midpoint wins over at - lead
  const coincident = buildTimeline(
    [
      { text: 'a', at: 2 },
      { text: 'b', at: 2 },
    ],
    { out: 'explode' },
  )
  expect(coincident.filter((e) => e.kind === 'interstitial')).toHaveLength(0)
})

test('loop duration and wrap math', () => {
  const events = buildTimeline(LINES, { out: 'dissolve' })
  expect(timelineDuration(events, 3.2)).toBeCloseTo(9.2, 6)
  expect(timelineDuration([], 3.2)).toBe(0)
  expect(wrapTime(9.2 + 1.5, 9.2)).toBeCloseTo(1.5, 6)
  expect(wrapTime(-0.5, 9.2)).toBeCloseTo(8.7, 6)
  expect(wrapTime(5, 0)).toBe(0)
})

test('advanceCursor fires only the newest overdue event (tab-switch catch-up)', () => {
  const events = buildTimeline(LINES, { out: 'explode', lead: 0.9 })
  // Sleep through line 0, its interstitial, and line 1: only line 1 fires.
  const late = advanceCursor(events, 0, 4.5)
  expect(late.fire).toBe(2)
  expect(events[late.fire].kind).toBe('line')
  expect(late.cursor).toBe(3)
  // Mid-transition: the interstitial IS the current timeline state.
  const mid = advanceCursor(events, 3, 5.5)
  expect(events[mid.fire].kind).toBe('interstitial')
  // Nothing due yet.
  expect(advanceCursor(events, 3, 5.0).fire).toBe(-1)
})

// ---- auto-timing & input normalization ----

test('normalizeLines auto-times omitted at as previous at (or 0) + every', () => {
  const auto = normalizeLines([{ text: 'a' }, { text: 'b' }, { text: 'c' }])
  expect(auto.map((l) => l.at)).toEqual([3.5, 7, 10.5]) // default every = 3.5
  const chained = normalizeLines([{ text: 'a', at: 0 }, { text: 'b' }, { text: 'c' }], 2)
  expect(chained.map((l) => l.at)).toEqual([0, 2, 4])
  // Fully-timed input passes through byte-identical in time (legacy behavior).
  expect(normalizeLines(LINES).map((l) => l.at)).toEqual(LINES.map((l) => l.at))
})

test('normalizeLines accepts bare strings and keeps per-line overrides', () => {
  const lines = normalizeLines(['YURA', '君の声が'], 3.4)
  expect(lines.map((l) => l.text)).toEqual(['YURA', '君の声が'])
  expect(lines[0].at).toBeCloseTo(3.4, 6)
  expect(lines[1].at).toBeCloseTo(6.8, 6)
  const mixed = normalizeLines(['intro', { text: 'x', at: 8, sweep: 0.5 }, 'outro'], 3.5)
  expect(mixed.map((l) => l.at)).toEqual([3.5, 8, 11.5])
  expect(mixed[1].sweep).toBe(0.5)
})

test('mixed explicit and auto-timed lines build a strictly monotone timeline', () => {
  const lines = normalizeLines([
    { text: 'auto-a' }, // 3.5
    { text: 'jump', at: 10 }, // explicit
    { text: 'auto-b' }, // 13.5 — chains from the explicit at
    { text: 'early', at: 1 }, // explicit, earlier than the autos
  ])
  expect(lines.map((l) => l.at)).toEqual([3.5, 10, 13.5, 1])
  const events = buildTimeline(lines, { out: 'dissolve' })
  expect(events.map((e) => e.time)).toEqual([1, 3.5, 10, 13.5])
  for (let i = 1; i < events.length; i++) {
    expect(events[i].time).toBeGreaterThan(events[i - 1].time)
  }
})

test('lyrics() accepts a plain string array end-to-end', () => {
  const morphs: string[] = []
  const app = {
    morphNow: (shape: { kind: string }) => {
      morphs.push(shape.kind)
      return Promise.resolve()
    },
  } as unknown as YuraApp
  const run = lyrics(app, ['YURA', '君の声が'], { every: 3.5 })
  run.seek(3.5) // first auto-timed line is due
  expect(morphs).toHaveLength(1)
  run.seek(7) // second line
  expect(morphs).toHaveLength(2)
  expect(morphs.every((k) => k === 'text')).toBe(true)
  run.stop()
})

// ---- text-readability damping (renderer brightness/bloom scaling) ----

test('no text target -> factor is exactly neutral at any count', () => {
  for (const n of [1, 250_000, 1_000_000, 2_000_000]) {
    expect(textDampTarget(false, n)).toBe(TEXT_DAMP_NEUTRAL) // === 1, bit-exact path
  }
})

test('active text damping is text-safe, density-aware, and clamped', () => {
  const ref = textDampTarget(true, TEXT_DAMP_REF_COUNT)
  expect(ref).toBeCloseTo(TEXT_DAMP_AT_REF, 6)
  // Heavier swarms accumulate more light per glyph pixel -> damp harder.
  const at1m = textDampTarget(true, 1_000_000)
  const at2m = textDampTarget(true, 2_000_000)
  expect(at1m).toBeLessThan(ref)
  expect(at2m).toBeLessThanOrEqual(at1m)
  // Every count stays inside [floor, neutral]; sparse swarms are left alone.
  for (const n of [1, 10_000, 50_000, 600_000, 8_000_000]) {
    const f = textDampTarget(true, n)
    expect(f).toBeGreaterThanOrEqual(TEXT_DAMP_MIN)
    expect(f).toBeLessThanOrEqual(TEXT_DAMP_NEUTRAL)
  }
  expect(textDampTarget(true, 10_000)).toBe(TEXT_DAMP_NEUTRAL) // no over-dimming below ramp
})

test('easeDampFactor approaches monotonically without overshoot', () => {
  let f = 1
  let prev = f
  for (let i = 0; i < 90; i++) {
    f = easeDampFactor(f, 0.2, 1 / 60)
    expect(f).toBeLessThanOrEqual(prev) // monotone descent...
    expect(f).toBeGreaterThanOrEqual(0.2) // ...never past the target
    prev = f
  }
  expect(f).toBeCloseTo(0.2, 2) // settled within ~1.5 s
  expect(easeDampFactor(0.5, 0.5, 1 / 60)).toBe(0.5) // already there: stays put
  expect(easeDampFactor(0.7, 0.2, 0)).toBe(0.7) // dt = 0 is a no-op
  expect(easeDampFactor(0.7, 0.2, -1)).toBe(0.7) // negative dt never runs backward
})

test('restore-on-stop returns bit-exact to neutral in finite time', () => {
  // Text held at 1M -> damped; released -> target flips back to neutral.
  let f = textDampTarget(true, 1_000_000)
  expect(f).toBeLessThan(1)
  let steps = 0
  while (f !== TEXT_DAMP_NEUTRAL && steps < 600) {
    f = easeDampFactor(f, textDampTarget(false, 1_000_000), 1 / 60)
    steps++
  }
  expect(f).toBe(TEXT_DAMP_NEUTRAL) // exact ===: the renderer multiplies by 1.0 again
  expect(steps).toBeLessThan(200) // snaps in ~2 s, not asymptotically never
})

// ---- px-font auto-shrink when text overflows the fixed canvas ----

test('overlong horizontal lines shrink px fonts: the line stack tightens', () => {
  const rowGap = (fills: Fill[]): number => {
    const ys = [...new Set(fills.map((f) => f.y))].sort((a, b) => a - b)
    expect(ys.length).toBe(2) // one y per line
    return ys[1] - ys[0]
  }
  const short = withMockCanvas(() => {
    text('ab\ncd', { font: FONT }).generate(8)
  }).fills
  const long = withMockCanvas(() => {
    text('あいうえおかきくけこさし\nたちつてとなにぬねのはひ', { font: FONT }).generate(8)
  }).fills
  expect(long).toHaveLength(24) // every glyph still drawn
  // The overflow case rescaled fontPx down, so its line pitch is tighter.
  expect(rowGap(long)).toBeLessThan(rowGap(short))
})

test('overlong tategaki columns shrink px fonts so the column fits the canvas', () => {
  const glyphGap = (fills: Fill[]): number => {
    expect(fills[1].x).toBeCloseTo(fills[0].x, 6) // same column
    return fills[1].y - fills[0].y
  }
  const short = withMockCanvas(() => {
    text('あい', { font: FONT, vertical: true }).generate(8)
  }).fills
  const long = withMockCanvas(() => {
    text('あいうえおかきくけこさし', { font: FONT, vertical: true }).generate(8)
  }).fills
  expect(long).toHaveLength(12)
  // Shrunken em cells: tighter vertical pitch than the unshrunk short column…
  expect(glyphGap(long)).toBeLessThan(glyphGap(short))
  // …and that is exactly what keeps every glyph inside the 1024px reading span
  // (unshrunk, 12 cells at the short column's pitch would overflow it).
  expect(glyphGap(short) * 12).toBeGreaterThan(1024)
  for (const f of long) {
    expect(f.y).toBeGreaterThan(0)
    expect(f.y).toBeLessThan(1024)
  }
})

test('empty or whitespace-only text falls back to the tiny sphere', () => {
  const { result, fills } = withMockCanvas(
    () => text('', { font: FONT }).generate(64) as Float32Array,
  )
  expect(fills).toHaveLength(0) // nothing was drawable
  expect(result.length).toBe(64 * 4)
  for (let i = 0; i < 64; i++) {
    // sphere({ radius: 2 }) shell: r = 2 * (0.92 + rand * 0.08)
    const r = Math.hypot(result[i * 4], result[i * 4 + 1], result[i * 4 + 2])
    expect(r).toBeGreaterThan(2 * 0.92 - 1e-6)
    expect(r).toBeLessThanOrEqual(2 + 1e-6)
    expect(result[i * 4 + 3]).toBeGreaterThanOrEqual(0)
    expect(result[i * 4 + 3]).toBeLessThanOrEqual(1)
  }
  // Whitespace-only: charCount > 0 but zero drawn pixels — same fallback.
  const ws = withMockCanvas(() => text(' ', { font: FONT }).generate(8) as Float32Array)
  expect(ws.fills).toHaveLength(0)
  expect(ws.result.length).toBe(8 * 4)
})

// ---- lyrics runtime: interstitial blasts and the timer loop ----

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms))

const markShape = (kind: string): ShapeSpec => ({ kind, generate: () => new Float32Array(0) })

test('explode style fires alternating interstitial blasts between lines', () => {
  const morphs: Array<{ kind: string; opts: { sweep?: number; direction?: string } }> = []
  const app = {
    morphNow: (s: ShapeSpec, o: { sweep?: number; direction?: string }) => {
      morphs.push({ kind: s.kind, opts: o })
      return Promise.resolve()
    },
  } as unknown as YuraApp
  const lines: LyricLine[] = [
    { text: 'x', at: 0 },
    { text: 'y', at: 10 },
    { text: 'z', at: 20 },
  ]
  // Derive the interstitial instants from the same timeline the runner builds.
  const events = buildTimeline(orderLines(normalizeLines(lines)), { out: 'explode' })
  const ints = events.filter((e) => e.kind === 'interstitial')
  expect(ints.map((e) => e.line)).toEqual([1, 2])
  const run = lyrics(app, lines, { style: 'explode' })
  try {
    run.seek(ints[0].time) // the newest overdue event at this instant IS the blast
    expect(morphs).toHaveLength(1)
    expect(morphs[0].kind).toBe(vortex().kind) // odd line index: light tornado
    expect(morphs[0].opts.sweep).toBe(0.25)
    expect(morphs[0].opts.direction).toBe('random')
    run.seek(ints[1].time)
    expect(morphs).toHaveLength(2)
    expect(morphs[1].kind).toBe(sphere().kind) // even line index: shell burst
  } finally {
    run.stop()
  }
})

test('the wall-clock timer loop fires lines in order and halts after the last (no loop)', async () => {
  const fired: string[] = []
  const app = {
    morphNow: (s: ShapeSpec) => {
      fired.push(s.kind)
      return Promise.resolve()
    },
  } as unknown as YuraApp
  const run = lyrics(app, [
    { text: 'a', at: 0, shape: markShape('L0') },
    { text: 'b', at: 0.3, shape: markShape('L1') },
  ])
  try {
    const deadline = Date.now() + 3000
    while (!fired.includes('L1') && Date.now() < deadline) await sleep(20)
    expect(fired[fired.length - 1]).toBe('L1') // the last line lands last
    // Background-throttle collapse may skip L0 under load, but never reorders.
    expect(fired.length).toBeLessThanOrEqual(2)
    if (fired.length === 2) expect(fired).toEqual(['L0', 'L1'])
    const settled = fired.length
    await sleep(120)
    expect(fired.length).toBe(settled) // finished: without loop nothing re-fires
  } finally {
    run.stop()
  }
})

test('loop: true wraps the timeline clock and replays from the top', async () => {
  const fired: string[] = []
  const app = {
    morphNow: (s: ShapeSpec) => {
      fired.push(s.kind)
      return Promise.resolve()
    },
  } as unknown as YuraApp
  const run = lyrics(app, [{ text: 'a', at: 0, shape: markShape('L') }], {
    loop: true,
    loopTail: 0.2, // duration = 0.2s per cycle
  })
  try {
    const deadline = Date.now() + 4000
    while (fired.length < 3 && Date.now() < deadline) await sleep(20)
    expect(fired.length).toBeGreaterThanOrEqual(3) // wrapped at least twice
    expect(fired.every((k) => k === 'L')).toBe(true)
  } finally {
    run.stop()
  }
})

test('a seek mid-gap re-arms the timer without re-firing consumed lines', async () => {
  const fired: string[] = []
  const app = {
    morphNow: (s: ShapeSpec) => {
      fired.push(s.kind)
      return Promise.resolve()
    },
  } as unknown as YuraApp
  const run = lyrics(app, [
    { text: 'a', at: 0, shape: markShape('L0') },
    { text: 'b', at: 600, shape: markShape('L1') }, // far future: never due here
  ])
  try {
    run.seek(1) // consumes L0 synchronously and re-arms the timer
    expect(fired).toEqual(['L0'])
    await sleep(120) // the re-armed tick runs, finds nothing due, re-schedules
    expect(fired).toEqual(['L0'])
  } finally {
    run.stop()
  }
})
