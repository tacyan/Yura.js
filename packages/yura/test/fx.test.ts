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
