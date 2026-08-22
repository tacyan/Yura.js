import { test, expect, spyOn } from 'bun:test'
import { perspective, lookAt, multiply, invert, transform4, hexToLinear } from '../src/math'
import { QualityGovernor, DEFAULT_LEVELS } from '../src/governor'

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

test('hexToLinear supports #rgb shorthand', () => {
  expect(hexToLinear('#f0a')).toEqual(hexToLinear('#ff00aa'))
  expect(hexToLinear('#fff')).toEqual(hexToLinear('#ffffff'))
})

test('hexToLinear takes the first 6 digits of #rrggbbaa', () => {
  expect(hexToLinear('#8b5cf680')).toEqual(hexToLinear('#8b5cf6'))
  expect(hexToLinear('#00000000')).toEqual(hexToLinear('#000000'))
})

test('hexToLinear falls back to white on invalid input, warning once', () => {
  const info = spyOn(console, 'info').mockImplementation(() => {})
  try {
    for (const bad of ['red', '#12', '', '#12345', '#gghhii', '#1234', '#1234567']) {
      expect(hexToLinear(bad)).toEqual([1, 1, 1])
    }
    expect(info).toHaveBeenCalledTimes(7)
    expect(info.mock.calls[0][0]).toContain('YURA-012')
  } finally {
    info.mockRestore()
  }
})

test('hexToLinear output is always finite', () => {
  for (const input of ['#8b5cf6', '#f0a', '#8b5cf680', 'red', '#12', '', 'not-a-color']) {
    const info = spyOn(console, 'info').mockImplementation(() => {})
    const [r, g, b] = hexToLinear(input)
    info.mockRestore()
    expect(Number.isFinite(r)).toBe(true)
    expect(Number.isFinite(g)).toBe(true)
    expect(Number.isFinite(b)).toBe(true)
  }
})

test('governor with empty levels falls back to defaults', () => {
  const g = new QualityGovernor([])
  expect(g.current()).toBeDefined()
  expect(g.current()).toEqual(DEFAULT_LEVELS[0])
  g.setLevel(999)
  expect(g.current()).toEqual(DEFAULT_LEVELS[DEFAULT_LEVELS.length - 1])
})

test('governor update ignores NaN and Infinity frame times', () => {
  const g = new QualityGovernor()
  const before = g.frameMs
  expect(g.update(NaN)).toBe(false)
  expect(g.update(Infinity)).toBe(false)
  expect(g.update(-Infinity)).toBe(false)
  expect(g.frameMs).toBe(before)
  expect(Number.isFinite(g.frameMs)).toBe(true)
  // Still degrades normally after garbage input.
  for (let i = 0; i < 300 && g.level === 0; i++) g.update(40)
  expect(g.level).toBeGreaterThan(0)
  expect(Number.isFinite(g.frameMs)).toBe(true)
})

test('governor setLevel(NaN) resolves to level 0', () => {
  const g = new QualityGovernor()
  g.setLevel(3)
  expect(g.level).toBe(3)
  g.setLevel(NaN)
  expect(g.level).toBe(0)
  expect(g.current()).toEqual(DEFAULT_LEVELS[0])
})

test('CODES registry has no duplicate code values', async () => {
  const { CODES } = await import('../src/errors')
  const values = Object.values(CODES)
  expect(new Set(values).size).toBe(values.length)
})
