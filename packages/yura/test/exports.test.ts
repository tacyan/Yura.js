import { test, expect } from 'bun:test'
import {
  yura,
  YuraApp,
  looks,
  cinematic,
  cyberpunk,
  aurora,
  neon,
  studio,
  shapes,
  materials,
  matte,
  plastic,
  metal,
  neonMaterial,
  resolveMaterial,
} from '../src/index'
import type {
  Backend,
  Vec3,
  LookParams,
  MotionParams,
  SceneMaterial,
  MaterialLike,
  LookName,
} from '../src/index'

// ---- type-level guards (compile under `tsc --noEmit`; inert at runtime) ----
const _backend: Backend = 'webgpu'
const _vec: Vec3 = [0, 0, 0]
const _look: LookParams = studio()
const _motion: Partial<MotionParams> = {}
const _material: SceneMaterial = resolveMaterial('chrome')
const _materialLike: MaterialLike = 'iridescent'
const _lookName: LookName = 'studio'
void [_backend, _vec, _look, _motion, _material, _materialLike, _lookName]

test('yura entry point is exported', () => {
  expect(typeof yura).toBe('function')
  expect(typeof YuraApp).toBe('function')
})

test('every look is exported, by name and in the registry', () => {
  const named = { cinematic, cyberpunk, aurora, neon, studio }
  for (const [name, fn] of Object.entries(named)) {
    expect(typeof fn).toBe('function')
    expect(typeof looks[name as LookName]).toBe('function')
  }
  // README table promises exactly these five looks.
  expect(Object.keys(looks).sort()).toEqual(['aurora', 'cinematic', 'cyberpunk', 'neon', 'studio'])
  // Each look produces complete LookParams.
  for (const fn of Object.values(looks)) {
    const p = fn()
    expect(p.exposure).toBeGreaterThan(0)
    expect(p.background).toHaveLength(3)
  }
})

test('every material preset name resolves through the public surface', () => {
  const presetNames = [
    'chrome',
    'gold',
    'copper',
    'obsidian',
    'pearl',
    'rubber',
    'checker',
    'grid',
    'iridescent',
  ] as const
  for (const name of presetNames) {
    expect(materials[name]).toBeDefined()
    const resolved = resolveMaterial(name)
    expect(resolved.color).toHaveLength(4)
    expect(typeof resolved.metallic).toBe('number')
    expect(typeof resolved.roughness).toBe('number')
  }
  // Parametric material factories are exported too.
  for (const fn of [matte, plastic, metal, neonMaterial]) {
    expect(typeof fn).toBe('function')
    const m = fn('#ff00aa')
    expect(m.color).toHaveLength(4)
  }
})

test('shapes registry exposes the existing shape keys', () => {
  const existing = ['galaxy', 'sphere', 'ring', 'vortex', 'flow', 'text', 'image']
  const keys = Object.keys(shapes)
  for (const key of existing) {
    expect(keys).toContain(key)
  }
})
