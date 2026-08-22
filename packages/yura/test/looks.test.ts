import { test, expect } from 'bun:test'
import { looks, cinematic, cyberpunk, aurora, neon, studio } from '../src/index'
import type { LookParams, LookName } from '../src/index'

const LOOK_NAMES = ['aurora', 'cinematic', 'cyberpunk', 'neon', 'studio'] as const

const flatten = (p: LookParams): number[] =>
  Object.values(p).flatMap((v) => (Array.isArray(v) ? v : [v as number]))

test('looks registry keys match exactly {cinematic, cyberpunk, aurora, neon, studio}', () => {
  expect(Object.keys(looks).sort()).toEqual([...LOOK_NAMES])
  const named = { cinematic, cyberpunk, aurora, neon, studio }
  for (const [name, fn] of Object.entries(named)) {
    expect(looks[name as LookName]).toBe(fn)
  }
})

test('every look returns the same field set', () => {
  const reference = Object.keys(studio()).sort()
  expect(reference.length).toBeGreaterThan(0)
  for (const name of LOOK_NAMES) {
    expect(Object.keys(looks[name]()).sort()).toEqual(reference)
  }
})

test('every numeric component of every look is finite', () => {
  for (const name of LOOK_NAMES) {
    const p = looks[name]()
    for (const value of flatten(p)) {
      expect(typeof value).toBe('number')
      expect(Number.isFinite(value)).toBe(true)
    }
  }
})

test('look values stay within sane ranges', () => {
  for (const name of LOOK_NAMES) {
    const p = looks[name]()

    expect(p.exposure).toBeGreaterThan(0)

    expect(p.bloomThreshold).toBeGreaterThanOrEqual(0)
    expect(p.bloomThreshold).toBeLessThanOrEqual(2)

    expect(p.background).toHaveLength(3)
    for (const c of p.background) {
      expect(c).toBeGreaterThanOrEqual(0)
      expect(c).toBeLessThanOrEqual(1)
    }

    expect(p.hot).toHaveLength(3)
    for (const c of p.hot) {
      expect(c).toBeGreaterThanOrEqual(0)
      expect(c).toBeLessThanOrEqual(2)
    }

    expect(p.bloomStrength).toBeGreaterThanOrEqual(0)
    expect(p.bloomStrength).toBeLessThanOrEqual(3)

    expect(p.particleSize).toBeGreaterThan(0)
    expect(p.intensity).toBeGreaterThan(0)

    for (const key of ['vignette', 'grain', 'twinkle', 'trail', 'streak', 'stars'] as const) {
      expect(p[key]).toBeGreaterThanOrEqual(0)
      expect(p[key]).toBeLessThanOrEqual(1)
    }

    expect(p.aberration).toBeGreaterThanOrEqual(0)
    expect(p.aberration).toBeLessThanOrEqual(0.05)

    expect(p.nebula).toBeGreaterThanOrEqual(0)
    expect(p.nebula).toBeLessThanOrEqual(2)
  }
})

test('overrides win over defaults and calls return fresh objects', () => {
  for (const name of LOOK_NAMES) {
    const overridden = looks[name]({ exposure: 2.5, background: [1, 1, 1] })
    expect(overridden.exposure).toBe(2.5)
    expect(overridden.background).toEqual([1, 1, 1])

    const a = looks[name]()
    const b = looks[name]()
    expect(a).not.toBe(b)
    expect(a).toEqual(b)
  }
})
