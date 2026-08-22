import { test, expect } from 'bun:test'
import * as api from '../src/index'
import {
  yura,
  YuraApp,
  YuraScene,
  looks,
  cinematic,
  cyberpunk,
  aurora,
  neon,
  studio,
  sakura,
  shapes,
  galaxy,
  sphere,
  ring,
  vortex,
  flow,
  box,
  cone,
  helix,
  text,
  image,
  materials,
  matte,
  plastic,
  metal,
  neonMaterial,
  resolveMaterial,
  eases,
  formatStats,
  FrameRing,
  noteToFreq,
  layoutColumns,
  CODES,
  MAX_ATTRACTORS,
  DEFAULT_ATTRACTOR_RADIUS,
} from '../src/index'
import type {
  Backend,
  Vec3,
  LookParams,
  MotionParams,
  SceneMaterial,
  MaterialLike,
  LookName,
  EaseFn,
  EaseName,
  Ease,
  GameSetup,
  MorphNowOptions,
  SweepDirection,
  ColumnPlacement,
  YuraStats,
} from '../src/index'

const _backend: Backend = 'webgpu'
const _vec: Vec3 = [0, 0, 0]
const _look: LookParams = studio()
const _motion: Partial<MotionParams> = {}
const _material: SceneMaterial = resolveMaterial('chrome')
const _materialLike: MaterialLike = 'iridescent'
const _lookName: LookName = 'studio'
// Night API types stay exported and type-guardable.
const _easeName: EaseName = 'linear'
const _easeFn: EaseFn = (t) => t
const _ease: Ease = eases.cubic
const _gameSetup: GameSetup = (scene) => {
  void scene
}
const _morphOpts: MorphNowOptions = {}
const _sweepDir: SweepDirection = 'center'
const _stats: YuraStats = {
  backend: 'webgpu',
  fps: 60,
  frameMs: 16.7,
  particles: 1_000_000,
  requestedParticles: 1_000_000,
  resolutionScale: 1,
  qualityLevel: 3,
}
void [
  _backend,
  _vec,
  _look,
  _motion,
  _material,
  _materialLike,
  _lookName,
  _easeName,
  _easeFn,
  _ease,
  _gameSetup,
  _morphOpts,
  _sweepDir,
]

test('yura entry point is exported', () => {
  expect(typeof yura).toBe('function')
  expect(typeof YuraApp).toBe('function')
})

test('every look is exported, by name and in the registry', () => {
  const named = { cinematic, cyberpunk, aurora, neon, studio, sakura }
  for (const [name, fn] of Object.entries(named)) {
    expect(typeof fn).toBe('function')
    expect(typeof looks[name as LookName]).toBe('function')
  }

  expect(Object.keys(looks).sort()).toEqual(Object.keys(named).sort())

  for (const fn of Object.values(looks)) {
    const p = fn()
    expect(p.exposure).toBeGreaterThan(0)
    expect(p.background).toHaveLength(3)
  }
})

test('every material preset name resolves through the public surface', () => {
  // Every key of the real registry must resolve, not just a frozen sample.
  const presetNames = Object.keys(materials)
  expect(presetNames.length).toBeGreaterThan(0)
  for (const name of presetNames) {
    expect(materials[name as keyof typeof materials]).toBeDefined()
    const resolved = resolveMaterial(name as MaterialLike)
    expect(resolved.color).toHaveLength(4)
    expect(typeof resolved.metallic).toBe('number')
    expect(typeof resolved.roughness).toBe('number')
  }

  for (const fn of [matte, plastic, metal, neonMaterial]) {
    expect(typeof fn).toBe('function')
    const m = fn('#ff00aa')
    expect(m.color).toHaveLength(4)
  }
})

test('shapes registry carries every named shape export, including box/cone/helix', () => {
  const named = { galaxy, sphere, ring, vortex, flow, box, cone, helix, text, image }
  // The registry and the named exports are the same functions, one per key.
  expect(Object.keys(shapes).sort()).toEqual(Object.keys(named).sort())
  for (const [name, fn] of Object.entries(named)) {
    expect(typeof fn).toBe('function')
    expect(shapes[name as keyof typeof shapes]).toBe(fn)
  }
  for (const key of ['box', 'cone', 'helix']) {
    expect(Object.keys(shapes)).toContain(key)
  }
})

test('eases registry is exported and every ease maps 0→0 and 1→1', () => {
  const names = Object.keys(eases)
  expect(names.length).toBeGreaterThan(0)
  expect(names).toContain('linear')
  for (const name of names) {
    const fn = eases[name as EaseName]
    expect(typeof fn).toBe('function')
    expect(fn(0)).toBeCloseTo(0, 6)
    expect(fn(1)).toBeCloseTo(1, 6)
  }
})

test('formatStats and FrameRing are exported and usable', () => {
  const line = formatStats(_stats)
  expect(typeof line).toBe('string')
  expect(line).toContain('webgpu')
  expect(line).toContain('60 fps')

  const ringBuf = new FrameRing(3)
  for (const v of [1, 2, 3, 4]) ringBuf.push(v)
  expect(ringBuf.size).toBe(3)
  expect(ringBuf.last()).toEqual([2, 3, 4])
  expect(() => new FrameRing(0)).toThrow(RangeError)
})

test('noteToFreq is exported and tuned to A4 = 440 Hz', () => {
  expect(noteToFreq('A4')).toBeCloseTo(440, 6)
  expect(noteToFreq('A5')).toBeCloseTo(880, 6)
  expect(() => noteToFreq('not-a-note')).toThrow(RangeError)
})

test('layoutColumns is exported and places one column per height', () => {
  const placements: ColumnPlacement[] = layoutColumns([2, 2], 1, 0.5, 'center', 10)
  expect(placements).toHaveLength(2)
  for (const p of placements) {
    expect(typeof p.x).toBe('number')
    expect(typeof p.y).toBe('number')
  }
})

test('CODES, MAX_ATTRACTORS and DEFAULT_ATTRACTOR_RADIUS are exported constants', () => {
  const codeValues = Object.values(CODES)
  expect(codeValues.length).toBeGreaterThan(0)
  for (const code of codeValues) {
    expect(code).toMatch(/^YURA-\d+$/)
  }
  expect(Number.isInteger(MAX_ATTRACTORS)).toBe(true)
  expect(MAX_ATTRACTORS).toBeGreaterThan(0)
  expect(DEFAULT_ATTRACTOR_RADIUS).toBeGreaterThan(0)
})

test('YuraScene.gravityWell and YuraApp morph APIs are on the public prototypes', () => {
  expect(typeof YuraScene.prototype.gravityWell).toBe('function')
  expect(typeof YuraApp.prototype.morphTo).toBe('function')
  expect(typeof YuraApp.prototype.morphNow).toBe('function')
})

// ---------------------------------------------------------------------------
// Structural net: the real export list of index.ts, scanned from source, must
// match this test file's asserted manifest exactly. Adding an export to
// index.ts without asserting it here fails the suite (same technique as
// readme.test.ts / recipes.test.ts).
// ---------------------------------------------------------------------------

const indexSourcePath = new URL('../src/index.ts', import.meta.url).pathname
const indexSource = await Bun.file(indexSourcePath).text()
const transpiler = new Bun.Transpiler({ loader: 'ts' })
const typeOnlyNames = new Set<string>()
for (const clause of indexSource.matchAll(/export\s+type\s*\{([^}]*)\}/g)) {
  for (const entry of clause[1]!.split(',')) {
    const name = entry.trim().split(/\s+as\s+/).pop()?.trim()
    if (name) typeOnlyNames.add(name)
  }
}
const realValueExports = new Set(
  transpiler.scan(indexSource).exports.filter((name) => !typeOnlyNames.has(name)),
)

/**
 * Every value export of packages/yura/src/index.ts, asserted by name. This is
 * the coverage manifest the structural-net test below diffs against the real
 * source — extend it (and ideally the behavioral tests above) when index.ts
 * grows a new export.
 */
const assertedValueExports = new Set<string>([
  // app
  'yura',
  'YuraApp',
  'formatStats',
  'FrameRing',
  'eases',
  'sweepProgress',
  'applySweepDirection',
  // shapes
  'shapes',
  'galaxy',
  'sphere',
  'ring',
  'vortex',
  'flow',
  'box',
  'cone',
  'helix',
  'text',
  'image',
  'segmentGraphemes',
  'charCoord',
  'layoutLines',
  'layoutColumns',
  // looks
  'looks',
  'cinematic',
  'cyberpunk',
  'aurora',
  'neon',
  'studio',
  'sakura',
  // presets
  'presetNames',
  'resolvePreset',
  // scene
  'YuraScene',
  'SceneObject',
  'SceneInput',
  // materials
  'materials',
  'matte',
  'plastic',
  'metal',
  'neonMaterial',
  'resolveMaterial',
  // @yura/core
  'YuraError',
  'CODES',
  // @yura/renderer-webgpu
  'MAX_ATTRACTORS',
  'DEFAULT_ATTRACTOR_RADIUS',
  // fx
  'FxPool',
  'FxTrailEmitter',
  'FX_FLOATS',
  // three
  'yuraLayer',
  'YuraThreeLayer',
  'composeSwarmCamera',
  'glProjectionToWebGPU',
  'fovAspectFromProjection',
  'eyeFromView',
  'worldPositionOf',
  'YURA_SHAPE_RADIUS',
  // audio
  'gameAudio',
  'clamp01',
  'pickupTone',
  'jumpTone',
  'landTone',
  'winTones',
  'noteToFreq',
  // lyrics
  'lyrics',
  'orderLines',
  'buildTimeline',
  'timelineDuration',
  'wrapTime',
  'advanceCursor',
])

test('every value export scanned from index.ts exists at runtime (no broken re-exports)', () => {
  expect(realValueExports.size).toBeGreaterThan(0)
  const brokenAtRuntime = [...realValueExports].filter((name) => !(name in api)).sort()
  expect(brokenAtRuntime).toEqual([])
})

test('asserted export manifest and the real index.ts export list have zero diff', () => {
  const missingFromManifest = [...realValueExports]
    .filter((name) => !assertedValueExports.has(name))
    .sort()
  const staleInManifest = [...assertedValueExports]
    .filter((name) => !realValueExports.has(name))
    .sort()
  expect({ missingFromManifest, staleInManifest }).toEqual({
    missingFromManifest: [],
    staleInManifest: [],
  })
})
