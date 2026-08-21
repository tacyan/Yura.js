import { test, expect } from 'bun:test'
import { presetNames, resolvePreset } from '../src/presets'
import { YuraError } from '@yura/core'

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
