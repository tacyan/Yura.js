import { test, expect } from 'bun:test'
import { galaxy, sphere, ring, vortex, flow } from '../src/shapes'

const N = 5000

for (const [name, spec] of [
  ['galaxy', galaxy()],
  ['sphere', sphere()],
  ['ring', ring()],
  ['vortex', vortex()],
  ['flow', flow()],
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
