import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type FrameCompInput,
  COUNT_COMP_EXPONENT,
  COUNT_COMP_MAX,
  TRAIL_COMP_FLOOR,
  TRAIL_COMP_GAIN,
  TRAIL_OFF_THRESHOLD,
  computeFrameComp,
  type FrameComp,
} from '../src/look-math'
// The exact specifier the WebGL renderer uses (package root re-export).
import { computeFrameComp as viaPackageRoot } from '@yura/renderer-webgpu'

/**
 * Byte-for-byte copy of the formulas both renderers inlined before the
 * extraction (webgpu renderer.ts frame(), webgl renderer.ts frame()).
 * computeFrameComp must reproduce it bit-exactly.
 */
function legacyInline(lookTrail: number, dt: number, count: number, n: number, textDamp: number) {
  const trail = Math.max(lookTrail, 0)
  const fadeAlpha = trail > 0.02 ? 1 - Math.exp(-dt / trail) : 1
  const trailComp = trail > 0.02 ? Math.min(Math.max(fadeAlpha * 1.4, 0.06), 1) : 1
  const countComp = Math.min(Math.pow(count / n, 0.7), 4)
  const damp = Math.min(Math.max(textDamp, 0), 1)
  return { fadeAlpha, trailComp, countComp, damp }
}

/** toBe uses Object.is — bit-exact for doubles (also separates NaN/-0). */
function expectBitIdentical(actual: FrameComp, want: ReturnType<typeof legacyInline>) {
  expect(actual.fadeAlpha).toBe(want.fadeAlpha)
  expect(actual.trailComp).toBe(want.trailComp)
  expect(actual.countComp).toBe(want.countComp)
  expect(actual.damp).toBe(want.damp)
}

const TRAILS = [-1, 0, 0.019, 0.02, 0.020000001, 0.05, 0.35, 1, 3]
const DTS = [0, 1 / 240, 1 / 120, 1 / 60, 1 / 30, 0.1, 1, 10, 1e6]
const COUNTS: Array<[number, number]> = [
  [0, 1],
  [1, 1],
  [4096, 1024],
  [4096, 4096],
  [1_000_000, 1],
  [1_000_000, 250_000],
  [1_000_000, 999_999],
  [1_000_000, 1_000_000],
]
const DAMPS = [-0.5, 0, 0.25, 0.62, 1, 2]

describe('computeFrameComp: bit-identical to the pre-extraction inline math', () => {
  test('full scenario sweep (trail x dt x count x damp) matches via Object.is', () => {
    let cases = 0
    for (const trail of TRAILS)
      for (const dt of DTS)
        for (const [count, n] of COUNTS)
          for (const textDamp of DAMPS) {
            const got = computeFrameComp({ trail, dt, count, activeCount: n, textDamp })
            expectBitIdentical(got, legacyInline(trail, dt, count, n, textDamp))
            cases++
          }
    expect(cases).toBe(TRAILS.length * DTS.length * COUNTS.length * DAMPS.length)
  })

  test('default scenario (60fps, trail 0.35, full count, neutral damp) is bit-exact', () => {
    const got = computeFrameComp({
      trail: 0.35,
      dt: 1 / 60,
      count: 100_000,
      activeCount: 100_000,
      textDamp: 1,
    })
    expectBitIdentical(got, legacyInline(0.35, 1 / 60, 100_000, 100_000, 1))
    // And the well-known closed forms, for readability of the contract:
    expect(got.fadeAlpha).toBe(1 - Math.exp(-(1 / 60) / 0.35))
    expect(got.countComp).toBe(1)
    expect(got.damp).toBe(1)
  })
})

describe('computeFrameComp: boundary behavior', () => {
  test('trail = 0 (and any trail <= threshold) disables fade + compensation', () => {
    for (const trail of [0, -5, TRAIL_OFF_THRESHOLD]) {
      const c = computeFrameComp({ trail, dt: 1 / 60, count: 10, activeCount: 10, textDamp: 1 })
      expect(c.fadeAlpha).toBe(1)
      expect(c.trailComp).toBe(1)
    }
  })

  test('trail = 1 at 60fps: shallow fade, trailComp pinned to its floor', () => {
    const c = computeFrameComp({ trail: 1, dt: 1 / 60, count: 10, activeCount: 10, textDamp: 1 })
    expect(c.fadeAlpha).toBe(1 - Math.exp(-1 / 60))
    expect(c.fadeAlpha).toBeGreaterThan(0)
    expect(c.fadeAlpha).toBeLessThan(0.02)
    expect(c.trailComp).toBe(TRAIL_COMP_FLOOR)
  })

  test('dt = 0 with trails on: nothing fades, trailComp clamps to floor', () => {
    const c = computeFrameComp({ trail: 0.5, dt: 0, count: 10, activeCount: 10, textDamp: 1 })
    expect(c.fadeAlpha).toBe(0)
    expect(c.trailComp).toBe(TRAIL_COMP_FLOOR)
  })

  test('huge dt: fadeAlpha saturates at exactly 1, trailComp capped at 1', () => {
    const c = computeFrameComp({ trail: 1, dt: 1e9, count: 10, activeCount: 10, textDamp: 1 })
    expect(c.fadeAlpha).toBe(1)
    expect(c.trailComp).toBe(1) // min(1 * 1.4, ...) capped
    expect(TRAIL_COMP_GAIN).toBeGreaterThan(1)
  })

  test('count = 0: survivors compensation is 0 (nothing to brighten)', () => {
    const c = computeFrameComp({ trail: 0.35, dt: 1 / 60, count: 0, activeCount: 1, textDamp: 1 })
    expect(c.countComp).toBe(0)
  })

  test('count = activeCount (governor idle): countComp is exactly 1', () => {
    const c = computeFrameComp({
      trail: 0.35,
      dt: 1 / 60,
      count: 123_456,
      activeCount: 123_456,
      textDamp: 1,
    })
    expect(c.countComp).toBe(1)
    expect(COUNT_COMP_EXPONENT).toBeGreaterThan(0)
  })

  test('extreme shedding: countComp capped at COUNT_COMP_MAX', () => {
    const c = computeFrameComp({
      trail: 0.35,
      dt: 1 / 60,
      count: 1_000_000,
      activeCount: 1,
      textDamp: 1,
    })
    expect(c.countComp).toBe(COUNT_COMP_MAX)
  })

  test('textDamp clamps to [0, 1] and 1 stays a bit-exact neutral', () => {
    const base = { trail: 0.35, dt: 1 / 60, count: 10, activeCount: 10 }
    expect(computeFrameComp({ ...base, textDamp: -3 }).damp).toBe(0)
    expect(computeFrameComp({ ...base, textDamp: 2 }).damp).toBe(1)
    expect(computeFrameComp({ ...base, textDamp: 1 }).damp).toBe(1)
    expect(computeFrameComp({ ...base, textDamp: 0.62 }).damp).toBe(0.62)
  })
})

describe('both backends reference the single shared function', () => {
  const pkgs = join(import.meta.dir, '..', '..')
  const webgpuSrc = readFileSync(join(pkgs, 'renderer-webgpu', 'src', 'renderer.ts'), 'utf8')
  const webglSrc = readFileSync(join(pkgs, 'renderer-webgl', 'src', 'renderer.ts'), 'utf8')

  test('the package-root export (the WebGL import path) IS the local function', () => {
    expect(Object.is(viaPackageRoot, computeFrameComp)).toBe(true)
  })

  test('webgpu renderer calls computeFrameComp and keeps no inline duplicate', () => {
    expect(webgpuSrc).toContain('computeFrameComp({')
    expect(webgpuSrc).toContain("from './look-math'")
    expect(webgpuSrc).not.toMatch(/Math\.exp\(-dt \/ trail\)/)
    expect(webgpuSrc).not.toMatch(/Math\.pow\(this\.count \/ n, 0\.7\)/)
  })

  test('webgl renderer calls computeFrameComp via @yura/renderer-webgpu, no duplicate', () => {
    expect(webglSrc).toContain('computeFrameComp({')
    expect(webglSrc).toMatch(/computeFrameComp[\s\S]*?from '@yura\/renderer-webgpu'/)
    expect(webglSrc).not.toMatch(/Math\.exp\(-dt \/ trail\)/)
    expect(webglSrc).not.toMatch(/Math\.pow\(this\.count \/ n, 0\.7\)/)
  })
})

// --- Non-finite input must not reach the GPU -------------------------------
//
// Every factor here multiplies particle intensity, bloom, or the fade pass. A
// NaN in any of them paints the frame as undefined — a black canvas with
// nothing in the console. Math.min/Math.max/Math.pow all pass NaN through.

test('computeFrameComp stays finite and in range for hostile input', () => {
  const hostile: Array<[string, FrameCompInput]> = [
    ['zero particles', { trail: 0.2, dt: 1 / 60, count: 0, activeCount: 0, textDamp: 1 }],
    ['no active particles', { trail: 0.2, dt: 1 / 60, count: 1000, activeCount: 0, textDamp: 1 }],
    ['NaN dt', { trail: 0.2, dt: NaN, count: 1000, activeCount: 1000, textDamp: 1 }],
    ['NaN textDamp', { trail: 0.2, dt: 1 / 60, count: 1000, activeCount: 1000, textDamp: NaN }],
    ['NaN trail', { trail: NaN, dt: 1 / 60, count: 1000, activeCount: 1000, textDamp: 1 }],
    ['NaN count', { trail: 0.2, dt: 1 / 60, count: NaN, activeCount: 1000, textDamp: 1 }],
  ]
  for (const [what, input] of hostile) {
    const c = computeFrameComp(input)
    const detail = `${what} -> ${JSON.stringify(c)}`
    expect([detail, Object.values(c).every(Number.isFinite)]).toEqual([detail, true])
    expect([detail, c.fadeAlpha >= 0 && c.fadeAlpha <= 1]).toEqual([detail, true])
    expect([detail, c.damp >= 0 && c.damp <= 1]).toEqual([detail, true])
    expect([detail, c.countComp > 0]).toEqual([detail, true])
  }
})

test('the non-finite guards leave every finite result bit-identical', () => {
  // The guards must be inert for real input — the two backends stay in lockstep
  // only while this function is bit-exact (see the module docstring).
  const samples: FrameCompInput[] = [
    { trail: 0, dt: 1 / 60, count: 200000, activeCount: 200000, textDamp: 1 },
    { trail: 0.02, dt: 1 / 60, count: 200000, activeCount: 200000, textDamp: 1 },
    { trail: 0.35, dt: 1 / 120, count: 200000, activeCount: 50000, textDamp: 0.6 },
    { trail: 4, dt: 1 / 30, count: 1000000, activeCount: 1, textDamp: 0 },
    { trail: 0.2, dt: 1 / 60, count: 1000, activeCount: 0, textDamp: 1 }, // Infinity ratio
  ]
  const expected = [
    { fadeAlpha: 1, trailComp: 1, countComp: 1, damp: 1 },
    { fadeAlpha: 1, trailComp: 1, countComp: 1, damp: 1 },
    {
      fadeAlpha: 1 - Math.exp(-(1 / 120) / 0.35),
      trailComp: Math.min(Math.max((1 - Math.exp(-(1 / 120) / 0.35)) * 1.4, 0.06), 1),
      countComp: Math.min(Math.pow(200000 / 50000, 0.7), 4),
      damp: 0.6,
    },
    {
      fadeAlpha: 1 - Math.exp(-(1 / 30) / 4),
      trailComp: Math.min(Math.max((1 - Math.exp(-(1 / 30) / 4)) * 1.4, 0.06), 1),
      countComp: 4,
      damp: 0,
    },
    {
      fadeAlpha: 1 - Math.exp(-(1 / 60) / 0.2),
      trailComp: Math.min(Math.max((1 - Math.exp(-(1 / 60) / 0.2)) * 1.4, 0.06), 1),
      countComp: 4, // Infinity ratio still clamps to COUNT_COMP_MAX, unchanged
      damp: 1,
    },
  ]
  samples.forEach((input, i) => {
    expect(computeFrameComp(input)).toEqual(expected[i])
  })
})
