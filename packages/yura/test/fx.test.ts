import { test, expect } from 'bun:test'
import { FxPool, FxTrailEmitter, FX_FLOATS } from '../src/fx'
import { YuraScene } from '../src/scene'

// FX logic is pure (no DOM, no GPU): pools, emitters, and lifetimes step headless.

/** Deterministic LCG in [0, 1) for reproducible particle tests. */
function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

test('burst spawns exactly the requested count', () => {
  const pool = new FxPool(1024, seeded(1))
  pool.burst([0, 0, 0], { count: 50 })
  expect(pool.alive).toBe(50)
  pool.burst([1, 2, 3], { count: 7 })
  expect(pool.alive).toBe(57)
})

test('lifetimes decay: particles die within the jitter window', () => {
  const pool = new FxPool(1024, seeded(2))
  // life jitter is 0.7x..1.15x of the mean
  pool.burst([0, 0, 0], { count: 40, life: 0.5 })
  for (let i = 0; i < 12; i++) pool.step(1 / 60) // 0.2s < 0.35s minimum life
  expect(pool.alive).toBe(40)
  for (let i = 0; i < 48; i++) pool.step(1 / 60) // 1.0s > 0.575s maximum life
  expect(pool.alive).toBe(0)
})

test('instances pack position, size, color, and a fading alpha', () => {
  const pool = new FxPool(64, seeded(3))
  pool.burst([2, 5, -1], { count: 8, life: 1, speed: 0, gravity: 0 })
  const out = new Float32Array(64 * FX_FLOATS)
  let n = pool.writeInstances(out)
  expect(n).toBe(8)
  expect(out[0]).toBeCloseTo(2, 5)
  expect(out[1]).toBeCloseTo(5, 5)
  expect(out[2]).toBeCloseTo(-1, 5)
  expect(out[3]).toBeGreaterThan(0) // size
  expect(out[4]).toBeGreaterThan(0) // color has HDR energy
  expect(out[7]).toBeGreaterThan(0.9) // alpha starts near 1

  for (let i = 0; i < 30; i++) pool.step(1 / 60)
  n = pool.writeInstances(out)
  expect(n).toBe(pool.alive)
  for (let i = 0; i < n; i++) {
    const alpha = out[i * FX_FLOATS + 7]
    expect(alpha).toBeGreaterThan(0)
    expect(alpha).toBeLessThan(0.9) // faded after 0.5s of a ~1s life
  }
})

test('gravity pulls particles down over time', () => {
  const pool = new FxPool(16, seeded(4))
  pool.burst([0, 10, 0], { count: 4, speed: 0, gravity: -10, life: 5 })
  for (let i = 0; i < 60; i++) pool.step(1 / 60)
  const out = new Float32Array(16 * FX_FLOATS)
  const n = pool.writeInstances(out)
  for (let i = 0; i < n; i++) expect(out[i * FX_FLOATS + 1]).toBeLessThan(10)
})

test('pool caps at capacity and recycles slots instead of growing', () => {
  const pool = new FxPool(100, seeded(5))
  pool.burst([0, 0, 0], { count: 80 })
  pool.burst([0, 0, 0], { count: 80 })
  expect(pool.alive).toBe(100) // never exceeds capacity
  expect(pool.capacity).toBe(100)
})

test('slots freed by dead particles are reused', () => {
  const pool = new FxPool(100, seeded(6))
  pool.burst([0, 0, 0], { count: 100, life: 0.1 })
  for (let i = 0; i < 30; i++) pool.step(1 / 60) // everything dies
  expect(pool.alive).toBe(0)
  pool.burst([0, 0, 0], { count: 60 })
  expect(pool.alive).toBe(60)
})

test('injected rng makes bursts fully deterministic', () => {
  const run = (): Float32Array => {
    const pool = new FxPool(256, seeded(42))
    pool.burst([1, 2, 3], { count: 64, color: ['#ff0000', '#00ff00'] })
    for (let i = 0; i < 20; i++) pool.step(1 / 60)
    const out = new Float32Array(256 * FX_FLOATS)
    const n = pool.writeInstances(out)
    return out.slice(0, n * FX_FLOATS)
  }
  expect(run()).toEqual(run())
})

test('trail emitter spawns at an exact rate via its accumulator', () => {
  const pool = new FxPool(4096, seeded(7))
  const trail = new FxTrailEmitter(pool, { rate: 60, life: 10 })
  for (let i = 0; i < 60; i++) trail.step(1 / 60, [i * 0.1, 0, 0], [6, 0, 0])
  expect(pool.alive).toBe(60)

  const pool2 = new FxPool(4096, seeded(7))
  const slow = new FxTrailEmitter(pool2, { rate: 30, life: 10 })
  for (let i = 0; i < 60; i++) slow.step(1 / 60, [0, 0, 0], [0, 0, 0])
  expect(pool2.alive).toBe(30)
})

test('celebrate schedules bursts over time', () => {
  const pool = new FxPool(4096, seeded(8))
  pool.celebrate({ bursts: 3, interval: 0.1, count: 20, life: 10 })
  expect(pool.alive).toBe(0) // nothing until stepped
  pool.step(0.01) // first burst is due at t = 0
  expect(pool.alive).toBe(20)
  pool.step(0.1)
  expect(pool.alive).toBe(40)
  pool.step(0.1)
  expect(pool.alive).toBe(60)
})

test('scene.burst and obj.trail run headless through scene.step', () => {
  const scene = new YuraScene({ gravity: -10 })
  scene.add('plane', { size: 10 })
  const player = scene.add('sphere', { radius: 0.5, position: [0, 2, 0], body: 'dynamic' })

  scene.burst(player.position, { count: 25, life: 10 })
  expect(scene.fx.alive).toBe(25)

  const handle = player.trail({ rate: 60, life: 10 })
  for (let i = 0; i < 30; i++) scene.step(1 / 60, i / 60)
  expect(scene.fx.alive).toBe(25 + 30)

  handle.stop()
  const frozen = scene.fx.alive
  for (let i = 0; i < 30; i++) scene.step(1 / 60, 1 + i / 60)
  expect(scene.fx.alive).toBe(frozen) // stopped trail emits nothing new
})

test('scene.celebrate feeds the shared pool', () => {
  const scene = new YuraScene({})
  scene.celebrate({ bursts: 2, interval: 0, count: 15, life: 10 })
  scene.step(1 / 60, 0)
  expect(scene.fx.alive).toBe(30)
})

test('spread=0 sends every particle exactly along direction', () => {
  const pool = new FxPool(256, seeded(11))
  pool.burst([0, 0, 0], { count: 32, direction: [1, 2, -0.5], spread: 0, gravity: 0, life: 10 })
  pool.step(1 / 60)
  const out = new Float32Array(256 * FX_FLOATS)
  const n = pool.writeInstances(out)
  expect(n).toBe(32)
  const len = Math.hypot(1, 2, -0.5)
  const ex = 1 / len
  const ey = 2 / len
  const ez = -0.5 / len
  for (let i = 0; i < n; i++) {
    const o = i * FX_FLOATS
    const m = Math.hypot(out[o], out[o + 1], out[o + 2])
    expect(m).toBeGreaterThan(0)
    expect(out[o] / m).toBeCloseTo(ex, 5)
    expect(out[o + 1] / m).toBeCloseTo(ey, 5)
    expect(out[o + 2] / m).toBeCloseTo(ez, 5)
  }
})

test('spread widens the cone but stays within its half-angle', () => {
  const pool = new FxPool(256, seeded(21))
  const spread = Math.PI / 4
  pool.burst([0, 0, 0], { count: 64, direction: [0, 1, 0], spread, gravity: 0, life: 10 })
  pool.step(1 / 60)
  const out = new Float32Array(256 * FX_FLOATS)
  const n = pool.writeInstances(out)
  let minCos = 1
  for (let i = 0; i < n; i++) {
    const o = i * FX_FLOATS
    const m = Math.hypot(out[o], out[o + 1], out[o + 2])
    const cos = out[o + 1] / m
    expect(cos).toBeGreaterThanOrEqual(Math.cos(spread) - 1e-4)
    minCos = Math.min(minCos, cos)
  }
  expect(minCos).toBeLessThan(0.999)
})

test('colorEnd shifts particle color across the lifetime', () => {
  const pool = new FxPool(16, seeded(12))
  pool.burst([0, 0, 0], {
    count: 4, color: '#ff0000', colorEnd: '#0000ff',
    life: 1, speed: 0, gravity: 0, intensity: 1,
  })
  const out = new Float32Array(16 * FX_FLOATS)
  pool.writeInstances(out)
  const r0 = out[4]
  const b0 = out[6]
  expect(r0).toBeGreaterThan(0.9)
  expect(b0).toBeLessThan(0.1)
  for (let i = 0; i < 30; i++) pool.step(1 / 60)
  expect(pool.alive).toBe(4)
  pool.writeInstances(out)
  expect(out[4]).toBeLessThan(r0)
  expect(out[6]).toBeGreaterThan(b0)
})

test('drag decays velocity monotonically and faster than no drag', () => {
  const make = (drag?: number): FxPool => {
    const p = new FxPool(8, seeded(13))
    p.burst([0, 0, 0], { count: 1, speed: 8, gravity: 0, life: 100, ...(drag === undefined ? {} : { drag }) })
    return p
  }
  const dragged = make(3)
  const free = make()
  const out = new Float32Array(8 * FX_FLOATS)
  const posOf = (p: FxPool): [number, number, number] => {
    p.writeInstances(out)
    return [out[0], out[1], out[2]]
  }
  let prev = posOf(dragged)
  let prevStep = Number.POSITIVE_INFINITY
  for (let k = 0; k < 60; k++) {
    dragged.step(1 / 60)
    free.step(1 / 60)
    const cur = posOf(dragged)
    const d = Math.hypot(cur[0] - prev[0], cur[1] - prev[1], cur[2] - prev[2])
    expect(d).toBeLessThan(prevStep)
    prevStep = d
    prev = cur
  }
  const df = posOf(free)
  expect(Math.hypot(prev[0], prev[1], prev[2])).toBeLessThan(Math.hypot(df[0], df[1], df[2]))
})

test('shape controls the emission source volume', () => {
  const pool = new FxPool(256, seeded(16))
  pool.burst([5, 5, 5], { count: 40, shape: 'disc', radius: 2, speed: 0, gravity: 0, life: 10 })
  const out = new Float32Array(256 * FX_FLOATS)
  let n = pool.writeInstances(out)
  let spreadOut = false
  for (let i = 0; i < n; i++) {
    const o = i * FX_FLOATS
    expect(out[o + 1]).toBeCloseTo(5, 5)
    const d = Math.hypot(out[o] - 5, out[o + 2] - 5)
    expect(d).toBeLessThanOrEqual(2.000001)
    if (d > 0.01) spreadOut = true
  }
  expect(spreadOut).toBe(true)

  pool.clear()
  pool.burst([0, 0, 0], { count: 40, shape: 'box', radius: 1.5, speed: 0, gravity: 0, life: 10 })
  n = pool.writeInstances(out)
  for (let i = 0; i < n; i++) {
    const o = i * FX_FLOATS
    for (let k = 0; k < 3; k++) expect(Math.abs(out[o + k])).toBeLessThanOrEqual(1.5000001)
  }
})

test('neutral new options leave default bursts bit-identical', () => {
  const run = (extra: Record<string, unknown>): Float32Array => {
    const pool = new FxPool(256, seeded(42))
    pool.burst([1, 2, 3], { count: 64, color: ['#ff0000', '#00ff00'], ...extra })
    for (let i = 0; i < 20; i++) pool.step(1 / 60)
    const out = new Float32Array(256 * FX_FLOATS)
    const n = pool.writeInstances(out)
    return out.slice(0, n * FX_FLOATS)
  }
  expect(run({ drag: 0 })).toEqual(run({}))
})

test('non-finite option values fall back to safe defaults', () => {
  const pool = new FxPool(64, seeded(15))
  pool.burst([0, 0, 0], {
    count: 8,
    speed: Number.NaN,
    life: Number.POSITIVE_INFINITY,
    gravity: Number.NaN,
    drag: Number.NaN,
    spread: Number.NaN,
    direction: [Number.NaN, 0, 0],
    shape: 'box',
    radius: Number.NaN,
    colorEnd: [Number.NaN, 1, 0],
  })
  expect(pool.alive).toBe(8)
  for (let i = 0; i < 10; i++) pool.step(1 / 60)
  const out = new Float32Array(64 * FX_FLOATS)
  const n = pool.writeInstances(out)
  expect(n).toBe(8)
  for (let i = 0; i < n * FX_FLOATS; i++) expect(Number.isFinite(out[i])).toBe(true)
})

test('trail colorEnd fades spark color toward the tail', () => {
  const pool = new FxPool(64, seeded(31))
  const trail = new FxTrailEmitter(pool, {
    color: '#ff0000', colorEnd: '#0000ff', intensity: 1, rate: 60, life: 1, jitter: 0,
  })
  trail.step(1 / 60, [0, 0, 0], [0, 0, 0])
  expect(pool.alive).toBe(1)
  const out = new Float32Array(64 * FX_FLOATS)
  pool.writeInstances(out)
  const r0 = out[4]
  const b0 = out[6]
  expect(r0).toBeGreaterThan(0.9)
  expect(b0).toBeLessThan(0.1)
  for (let i = 0; i < 30; i++) pool.step(1 / 60) // 0.5s < 0.7s minimum life
  expect(pool.alive).toBe(1)
  pool.writeInstances(out)
  expect(out[4]).toBeLessThan(r0) // red drains away...
  expect(out[6]).toBeGreaterThan(b0) // ...as blue blends in
})

test('trail width scales sprite size and nothing else', () => {
  const run = (width?: number): { out: Float32Array; n: number } => {
    const pool = new FxPool(256, seeded(32))
    const trail = new FxTrailEmitter(pool, { rate: 600, life: 10, ...(width === undefined ? {} : { width }) })
    trail.step(0.1, [1, 2, 3], [4, 0, 0])
    const out = new Float32Array(256 * FX_FLOATS)
    return { out, n: pool.writeInstances(out) }
  }
  const base = run()
  const wide = run(2)
  expect(base.n).toBeGreaterThan(0)
  expect(wide.n).toBe(base.n)
  for (let i = 0; i < base.n; i++) {
    const o = i * FX_FLOATS
    expect(wide.out[o]).toBe(base.out[o]) // position untouched
    expect(wide.out[o + 3]).toBeCloseTo(base.out[o + 3] * 2, 6) // size doubled
    expect(wide.out[o + 4]).toBe(base.out[o + 4]) // color untouched
    expect(wide.out[o + 7]).toBe(base.out[o + 7]) // alpha untouched
  }
})

test('trail fade reshapes the alpha decay curve (1 stays linear)', () => {
  const run = (fade?: number): Float32Array => {
    const pool = new FxPool(64, seeded(33))
    const trail = new FxTrailEmitter(pool, { rate: 60, life: 1, ...(fade === undefined ? {} : { fade }) })
    trail.step(1 / 60, [0, 0, 0], [0, 0, 0])
    for (let i = 0; i < 24; i++) pool.step(1 / 60) // 0.4s into a >= 0.7s life
    const out = new Float32Array(64 * FX_FLOATS)
    const n = pool.writeInstances(out)
    expect(n).toBe(1)
    return out
  }
  const linear = run()
  const sharp = run(2)
  // fade = 2 squares the remaining-life fraction: alpha (1-t)^2 -> (1-t)^4.
  expect(sharp[7]).toBeCloseTo(linear[7] * linear[7], 5)
  expect(sharp[7]).toBeLessThan(linear[7]) // non-linear: dies out sooner
  expect(sharp[3]).toBeLessThan(linear[3]) // size envelope shrinks with it
})

test('neutral new trail options leave default trails bit-identical', () => {
  const run = (extra: Record<string, unknown>): Float32Array => {
    const pool = new FxPool(256, seeded(42))
    const trail = new FxTrailEmitter(pool, { rate: 120, color: '#ff8800', ...extra })
    for (let i = 0; i < 12; i++) trail.step(1 / 60, [i * 0.05, 1, 0], [3, 0, 0])
    for (let i = 0; i < 6; i++) pool.step(1 / 60)
    const out = new Float32Array(256 * FX_FLOATS)
    const n = pool.writeInstances(out)
    return out.slice(0, n * FX_FLOATS)
  }
  expect(run({ width: 1, fade: 1 })).toEqual(run({}))
  expect(run({ colorEnd: '#ff8800' })).toEqual(run({})) // end = start color
})

test('non-finite trail option values fall back to safe defaults', () => {
  const pool = new FxPool(64, seeded(34))
  const trail = new FxTrailEmitter(pool, {
    rate: 60,
    life: 10,
    width: Number.NaN,
    fade: Number.NaN,
    colorEnd: [Number.NaN, 1, 0],
  })
  for (let i = 0; i < 8; i++) trail.step(1 / 60, [0, 0, 0], [0, 0, 0])
  for (let i = 0; i < 10; i++) pool.step(1 / 60)
  const out = new Float32Array(64 * FX_FLOATS)
  const n = pool.writeInstances(out)
  expect(n).toBe(8)
  for (let i = 0; i < n * FX_FLOATS; i++) expect(Number.isFinite(out[i])).toBe(true)
})
