import { test, expect } from 'bun:test'
import { looks, cinematic, cyberpunk, aurora, neon, studio, sakura } from '../src/index'
import type { LookParams, LookName } from '../src/index'

const LOOK_NAMES = ['aurora', 'cinematic', 'cyberpunk', 'neon', 'sakura', 'studio'] as const

// Optional LookParams keys. Looks may declare them (sakura, aurora,
// cinematic and studio do); every other key is a required numeric field.
// blendMode/toneMapping hold enum strings; softParticles is the numeric
// scene-mode FX depth-fade distance; dofFocus/dofStrength drive the
// per-sprite bokeh CoC (strength*|depth-focus|/depth — cinematic and sakura
// set strength; focus is always left to the renderer default, which tracks
// the internal camera's orbit radius).
const OPTIONAL_LOOK_KEYS: readonly string[] = [
  'blendMode',
  'toneMapping',
  'softParticles',
  'dofFocus',
  'dofStrength',
]
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
    // dofStrength is the CoC scale (coc approaches strength at far depths);
    // anything past 2 turns the swarm to mush. Looks always leave dofFocus
    // to the renderer default so it tracks the internal camera orbit, but if
    // one ever sets it, it must be a positive finite view depth.
    if (p.dofStrength !== undefined) {
      expect(Number.isFinite(p.dofStrength)).toBe(true)
      expect(p.dofStrength).toBeGreaterThanOrEqual(0)
      expect(p.dofStrength).toBeLessThanOrEqual(2)
    }
    if (p.dofFocus !== undefined) {
      expect(Number.isFinite(p.dofFocus)).toBe(true)
      expect(p.dofFocus).toBeGreaterThan(0)
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
  // Shallow film focus: restrained bokeh (edge CoC ~0.2-0.37 at the stock
  // shape radii), and focus left to the renderer default so it tracks the
  // internal camera's orbit radius.
  expect(cin.dofStrength).toBeGreaterThan(0)
  expect(cin.dofStrength).toBeLessThan(1)
  expect(cin.dofFocus).toBeUndefined()

  // aurora: screen blend (commutative, so still order-free) saturates dense
  // curtain cores at the palette color instead of burning white; tone curve
  // stays the default ACES for sky contrast. No DoF — the huge soft sprites
  // and nebula haze are already all blur; defocus would have no sharp
  // counterpart to play against.
  const au = aurora()
  expect(au.blendMode).toBe('screen')
  expect(au.toneMapping).toBeUndefined()
  expect(au.dofStrength).toBeUndefined()

  // studio: post stack stays clean (additive + ACES is the neutral PBR
  // pipeline), but its glTF/PBR purpose gets the sub-world-unit scene-mode
  // depth fade so FX sprites melt into geometry instead of hard-clipping.
  const st = studio()
  expect(st.blendMode).toBeUndefined()
  expect(st.toneMapping).toBeUndefined()
  expect(st.softParticles).toBeGreaterThan(0)
  expect(st.softParticles).toBeLessThan(1)
  // studio: no DoF — external cameras (model viewer) break the
  // internal-orbit focus assumption, and a neutral inspection look must
  // not defocus what it presents.
  expect(st.dofStrength).toBeUndefined()

  // neon & cyberpunk: deliberately the classic additive + ACES pipeline —
  // the hard additive burn-to-white is the neon signature, and 'alpha' would
  // be order-dependent without a depth sort. Both also reject bokeh DoF:
  // their identity is the hard crisp edge (cyberpunk's haze is already
  // carried by bloom 1.2 + aberration).
  for (const p of [neon(), cyberpunk()]) {
    expect(p.blendMode).toBeUndefined()
    expect(p.toneMapping).toBeUndefined()
    expect(p.softParticles).toBeUndefined()
    expect(p.dofStrength).toBeUndefined()
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
  // Dreamy whisper of bokeh (out-of-focus hanami petals): present but
  // strictly subtler than cinematic's shallow film focus, with focus left
  // to the renderer default (tracks the camera orbit).
  expect(p.dofStrength).toBeGreaterThan(0)
  expect(p.dofStrength).toBeLessThan(cinematic().dofStrength as number)
  expect(p.dofFocus).toBeUndefined()
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
