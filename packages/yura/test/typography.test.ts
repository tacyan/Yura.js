import { test, expect } from 'bun:test'
import { segmentGraphemes, charCoord, layoutLines, text } from '../src/shapes'
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
  type LyricLine,
} from '../src/lyrics'

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
