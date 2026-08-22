import { test, expect } from 'bun:test'
import { looks, cinematic, cyberpunk, aurora, neon, studio, sakura } from '../src/index'
import type { LookParams, LookName } from '../src/index'

const LOOK_NAMES = ['aurora', 'cinematic', 'cyberpunk', 'neon', 'sakura', 'studio'] as const

// Optional LookParams keys. Looks may declare them (sakura, aurora,
// cinematic and studio do); every other key is a required numeric field.
// blendMode/toneMapping hold enum strings; softParticles is the numeric
// scene-mode FX depth-fade distance.
const OPTIONAL_LOOK_KEYS: readonly string[] = ['blendMode', 'toneMapping', 'softParticles']
const BLEND_MODES: readonly string[] = ['additive', 'alpha', 'screen']
const TONE_MAPPINGS: readonly string[] = ['aces', 'reinhard', 'linear']

const coreKeys = (p: LookParams): string[] =>
  Object.keys(p)
    .filter((k) => !OPTIONAL_LOOK_KEYS.includes(k))
    .sort()

const flatten = (p: LookParams): number[] =>
  Object.entries(p)
    .filter(([key]) => !OPTIONAL_LOOK_KEYS.includes(key))
    .flatMap(([, v]) => (Array.isArray(v) ? v : [v as number]))

test('looks registry keys match exactly {cinematic, cyberpunk, aurora, neon, studio, sakura}', () => {
  expect(Object.keys(looks).sort()).toEqual([...LOOK_NAMES])
  const named = { cinematic, cyberpunk, aurora, neon, studio, sakura }
  for (const [name, fn] of Object.entries(named)) {
    expect(looks[name as LookName]).toBe(fn)
  }
})

test('every look returns the same core field set, plus only known optional keys', () => {
  const reference = coreKeys(studio())
  expect(reference.length).toBeGreaterThan(0)
  for (const name of LOOK_NAMES) {
    const p = looks[name]()
    expect(coreKeys(p)).toEqual(reference)
    const extras = Object.keys(p).filter((k) => !reference.includes(k))
    for (const extra of extras) {
      expect(OPTIONAL_LOOK_KEYS).toContain(extra)
    }
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

    if (p.blendMode !== undefined) expect(BLEND_MODES).toContain(p.blendMode)
    if (p.toneMapping !== undefined) expect(TONE_MAPPINGS).toContain(p.toneMapping)
    if (p.softParticles !== undefined) {
      expect(Number.isFinite(p.softParticles)).toBe(true)
      expect(p.softParticles).toBeGreaterThanOrEqual(0)
      expect(p.softParticles).toBeLessThanOrEqual(2)
    }
  }
})

test('each look declares only the pipeline modes that fit its world', () => {
  // cinematic: Reinhard film curve — highlights keep their warm hue instead
  // of clipping — with exposure lifted above 1 to compensate Reinhard's
  // softer response. Blend stays the default additive.
  const cin = cinematic()
  expect(cin.toneMapping).toBe('reinhard')
  expect(cin.blendMode).toBeUndefined()
  expect(cin.exposure).toBeGreaterThan(1)

  // aurora: screen blend (commutative, so still order-free) saturates dense
  // curtain cores at the palette color instead of burning white; tone curve
  // stays the default ACES for sky contrast.
  const au = aurora()
  expect(au.blendMode).toBe('screen')
  expect(au.toneMapping).toBeUndefined()

  // studio: post stack stays clean (additive + ACES is the neutral PBR
  // pipeline), but its glTF/PBR purpose gets the sub-world-unit scene-mode
  // depth fade so FX sprites melt into geometry instead of hard-clipping.
  const st = studio()
  expect(st.blendMode).toBeUndefined()
  expect(st.toneMapping).toBeUndefined()
  expect(st.softParticles).toBeGreaterThan(0)
  expect(st.softParticles).toBeLessThan(1)

  // neon & cyberpunk: deliberately the classic additive + ACES pipeline —
  // the hard additive burn-to-white is the neon signature, and 'alpha' would
  // be order-dependent without a depth sort.
  for (const p of [neon(), cyberpunk()]) {
    expect(p.blendMode).toBeUndefined()
    expect(p.toneMapping).toBeUndefined()
    expect(p.softParticles).toBeUndefined()
  }
})

test('sakura declares its Japanese-dusk pipeline: screen blend + reinhard', () => {
  const p = sakura()
  expect(p.blendMode).toBe('screen')
  expect(p.toneMapping).toBe('reinhard')
  // Soft particles on, and subtle: a sub-world-unit depth fade so petals
  // melt into geometry instead of hard-clipping.
  expect(p.softParticles).toBeGreaterThan(0)
  expect(p.softParticles).toBeLessThan(1)
  // Restrained bloom: gentler than the flashy looks (cyberpunk is 1.2).
  expect(p.bloomStrength).toBeLessThan(0.6)
  // Petal pink lifted toward white: red leads, blue sits above green.
  const [r, g, b] = p.hot
  expect(r).toBeGreaterThan(g)
  expect(r).toBeGreaterThan(b)
  expect(b).toBeGreaterThan(g)
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
