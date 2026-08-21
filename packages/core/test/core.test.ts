import { test, expect } from 'bun:test'
import { perspective, lookAt, multiply, invert, transform4, hexToLinear } from '../src/math'
import { QualityGovernor } from '../src/governor'

test('invert(M) * M ~= identity', () => {
  const proj = perspective(Math.PI / 3, 16 / 9, 0.1, 200)
  const view = lookAt([0, 3, 26], [0, 0, 0], [0, 1, 0])
  const vp = multiply(proj, view)
  const inv = invert(vp)!
  expect(inv).not.toBeNull()
  const id = multiply(vp, inv)
  for (let i = 0; i < 16; i++) {
    const expected = i % 5 === 0 ? 1 : 0
    expect(Math.abs(id[i] - expected)).toBeLessThan(1e-4)
  }
})

test('transform4 applies translation columns', () => {
  const m = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1])
  const out = transform4(m, [1, 2, 3, 1])
  expect(out[0]).toBe(6)
  expect(out[1]).toBe(8)
  expect(out[2]).toBe(10)
  expect(out[3]).toBe(1)
})

test('hexToLinear converts and clamps sensibly', () => {
  const white = hexToLinear('#ffffff')
  const black = hexToLinear('#000000')
  expect(white[0]).toBeCloseTo(1, 5)
  expect(black[0]).toBe(0)
  const violet = hexToLinear('#8b5cf6')
  expect(violet[2]).toBeGreaterThan(violet[0])
})

test('governor steps down under sustained load, then recovers', () => {
  const g = new QualityGovernor()
  for (let i = 0; i < 300 && g.level === 0; i++) g.update(40)
  expect(g.level).toBeGreaterThan(0)
  const degraded = g.level
  for (let i = 0; i < 2000 && g.level === degraded; i++) g.update(8)
  expect(g.level).toBeLessThan(degraded)
})

test('governor recovers on a 60 Hz display (vsync-quantized frames)', () => {
  const g = new QualityGovernor()
  // Sustained overload drops quality…
  for (let i = 0; i < 300 && g.level === 0; i++) g.update(40)
  expect(g.level).toBeGreaterThan(0)
  const degraded = g.level
  // …then healthy 60 Hz frames (16.7 ms — never "far below" budget) must
  // still climb back once the probe backoff expires.
  for (let i = 0; i < 3000 && g.level === degraded; i++) g.update(16.7)
  expect(g.level).toBeLessThan(degraded)
})

test('governor backs off harder after a failed climb probe', () => {
  const g = new QualityGovernor()
  for (let i = 0; i < 300 && g.level === 0; i++) g.update(40)
  const degraded = g.level
  // Recover one level, then immediately overload again (probe failed).
  for (let i = 0; i < 3000 && g.level === degraded; i++) g.update(16.7)
  expect(g.level).toBe(degraded - 1)
  for (let i = 0; i < 300 && g.level === degraded - 1; i++) g.update(40)
  expect(g.level).toBe(degraded)
  // The next climb needs a longer quiet stretch than the first one did.
  let climbFrames = 0
  for (; climbFrames < 3000 && g.level === degraded; climbFrames++) g.update(16.7)
  expect(climbFrames).toBeGreaterThan(240 + 8000 / 16.7)
})

test('governor stays put when disabled', () => {
  const g = new QualityGovernor()
  g.enabled = false
  for (let i = 0; i < 300; i++) g.update(50)
  expect(g.level).toBe(0)
})
