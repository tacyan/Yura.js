import { test, expect } from 'bun:test'
import { presetNames, resolvePreset } from '../src/presets'
import { YuraError } from '@yura/core'
import { DEFAULT_TURBULENCE_SCALE } from '@yura/renderer-webgpu'

test('all four launch presets exist', () => {
  const names = presetNames()
  for (const expected of ['neon-galaxy', 'aurora', 'cinematic', 'cyberpunk']) {
    expect(names).toContain(expected)
  }
})

test('presets resolve to complete configs', () => {
  for (const name of presetNames()) {
    const p = resolvePreset(name)
    expect(p.particles).toBeGreaterThan(0)
    expect(p.shapes.length).toBeGreaterThan(0)
    expect(p.look.exposure).toBeGreaterThan(0)
    expect(p.colorA).toMatch(/^#/)
  }
})

test('every launch preset switches on curl-noise turbulence, tuned per world', () => {
  const motion = (name: string) => resolvePreset(name).motion

  // No first screen is the bare legacy trig flow any more: each preset
  // layers a restrained (never > 1) divergence-free curl field on top.
  for (const name of presetNames()) {
    const t = motion(name).turbulence ?? 0
    expect(t).toBeGreaterThan(0)
    expect(t).toBeLessThanOrEqual(1)
  }

  // aurora is the fluid look: the strongest turbulence of the set.
  const auroraT = motion('aurora').turbulence ?? 0
  for (const name of presetNames()) {
    if (name !== 'aurora') expect(motion(name).turbulence ?? 0).toBeLessThan(auroraT)
  }

  // cyberpunk jitters at a finer spatial frequency than the default field
  // (electric crackle, not fluid billows); the others keep the broad default.
  expect(motion('cyberpunk').turbulenceScale ?? 0).toBeGreaterThan(DEFAULT_TURBULENCE_SCALE)
  for (const name of ['neon-galaxy', 'aurora', 'cinematic']) {
    expect(motion(name).turbulenceScale).toBeUndefined()
  }

  // The text-morphing presets stay legible: peak curl displacement scales
  // with turbulence/attraction, kept well under a glyph stroke width.
  for (const name of ['neon-galaxy', 'cyberpunk']) {
    const m = motion(name)
    expect((m.turbulence ?? 0) / m.attraction).toBeLessThan(0.15)
  }
})

test('unknown preset throws YURA-010 with a fix hint', () => {
  let err: unknown
  try {
    resolvePreset('does-not-exist')
  } catch (e) {
    err = e
  }
  expect(err).toBeInstanceOf(YuraError)
  expect((err as YuraError).code).toBe('YURA-010')
  expect((err as YuraError).message).toContain('Fix:')
})
