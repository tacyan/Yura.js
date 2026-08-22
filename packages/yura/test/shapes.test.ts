import { test, expect } from 'bun:test'
import { galaxy, sphere, ring, vortex, flow, box, cone, helix } from '../src/shapes'

const N = 5000

for (const [name, spec] of [
  ['galaxy', galaxy()],
  ['sphere', sphere()],
  ['ring', ring()],
  ['vortex', vortex()],
  ['flow', flow()],
  ['box', box()],
  ['cone', cone()],
  ['helix', helix()],
] as const) {
  test(`${name} generates n*4 finite floats`, () => {
    const data = spec.generate(N) as Float32Array
    expect(data).toBeInstanceOf(Float32Array)
    expect(data.length).toBe(N * 4)
    for (let i = 0; i < data.length; i++) {
      if (!Number.isFinite(data[i])) {
        throw new Error(`non-finite value at index ${i}`)
      }
    }
  })
}

test('galaxy stays within its radius envelope', () => {
  const data = galaxy({ radius: 10 }).generate(N) as Float32Array
  let maxR = 0
  for (let i = 0; i < N; i++) {
    const r = Math.hypot(data[i * 4], data[i * 4 + 2])
    maxR = Math.max(maxR, r)
  }
  expect(maxR).toBeLessThan(16)
})

test('sphere points lie on the shell', () => {
  const data = sphere({ radius: 8 }).generate(N) as Float32Array
  for (let i = 0; i < 100; i++) {
    const r = Math.hypot(data[i * 4], data[i * 4 + 1], data[i * 4 + 2])
    expect(r).toBeGreaterThan(7)
    expect(r).toBeLessThan(8.2)
  }
})

test('box stays inside its size bounds', () => {
  const data = box({ size: [6, 8, 10] }).generate(N) as Float32Array
  let mx = 0
  let my = 0
  let mz = 0
  for (let i = 0; i < N; i++) {
    mx = Math.max(mx, Math.abs(data[i * 4]))
    my = Math.max(my, Math.abs(data[i * 4 + 1]))
    mz = Math.max(mz, Math.abs(data[i * 4 + 2]))
  }
  expect(mx).toBeLessThanOrEqual(3)
  expect(my).toBeLessThanOrEqual(4)
  expect(mz).toBeLessThanOrEqual(5)
})

test('cone stays inside its radius and height bounds', () => {
  const data = cone({ radius: 5, height: 10 }).generate(N) as Float32Array
  for (let i = 0; i < N; i++) {
    const y = data[i * 4 + 1]
    const r = Math.hypot(data[i * 4], data[i * 4 + 2])
    if (Math.abs(y) > 5.001) throw new Error(`y out of bounds at particle ${i}: ${y}`)
    const localRadius = 5 * ((5 - y) / 10)
    if (r > localRadius + 0.001) throw new Error(`r exceeds cone surface at particle ${i}: ${r}`)
  }
})

test('cone fills its volume uniformly along the height', () => {
  const data = cone({ radius: 5, height: 10 }).generate(N) as Float32Array
  let apexHalf = 0
  for (let i = 0; i < N; i++) {
    if (data[i * 4 + 1] > 0) apexHalf++
  }
  const frac = apexHalf / N
  expect(frac).toBeGreaterThan(0.08)
  expect(frac).toBeLessThan(0.18)
})

test('helix winds within its radius and spans its height', () => {
  const data = helix({ turns: 3, radius: 4, height: 10 }).generate(N) as Float32Array
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < N; i++) {
    const r = Math.hypot(data[i * 4], data[i * 4 + 2])
    expect(r).toBeGreaterThan(2)
    expect(r).toBeLessThan(6.5)
    minY = Math.min(minY, data[i * 4 + 1])
    maxY = Math.max(maxY, data[i * 4 + 1])
  }
  expect(minY).toBeLessThan(-4)
  expect(maxY).toBeGreaterThan(4)
  expect(minY).toBeGreaterThan(-7)
  expect(maxY).toBeLessThan(7)
})
