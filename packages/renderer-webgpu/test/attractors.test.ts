import { test, expect } from 'bun:test'
import {
  SIM_WGSL,
  attractorTermSource,
  shaderFloatLiteral,
  MAX_ATTRACTORS,
  ATTRACTOR_VEC4S,
  ATTRACTOR_RADIUS2_SLOT,
  ATTRACTOR_ARRAY_VEC4S,
  DEFAULT_ATTRACTOR_RADIUS,
  ATTRACTOR_DIST_EPSILON,
  SIM_ATTRACTOR_COUNT_INDEX,
  SIM_ATTRACTORS_INDEX,
  SIM_PARAMS_BYTES,
  packAttractors,
  type AttractorParams,
} from '../src/shaders'
// Cross-backend imports are deep-relative on purpose: the GLSL sim must embed
// the very same generated attractor source, and the WebGL renderer must wire
// the very same packAttractors.
import { SIM_VS } from '../../renderer-webgl/src/shaders'
import { WebGL2ParticleRenderer } from '../../renderer-webgl/src/renderer'
import type { RendererOptions, MotionParams } from '../src/renderer'

// ---------------------------------------------------------------------------
// 1. Both sim shaders embed the generated guarded attractor term verbatim,
//    plus their uniforms, in the exact uniform-layout order the renderers
//    pack (simF32/simU32 on WebGPU, uAttractors/uAttractorCount on WebGL).
// ---------------------------------------------------------------------------

test('SIM_WGSL embeds the generated WGSL attractor term and uniforms', () => {
  expect(SIM_WGSL).toContain(attractorTermSource('wgsl'))
  expect(SIM_WGSL).toContain('attractorCount: u32')
  expect(SIM_WGSL).toContain(`attractors: array<vec4<f32>, ${ATTRACTOR_ARRAY_VEC4S}>`)
  // Field order matters for the uniform-buffer packing (simU32[18], simF32[20..]).
  expect(SIM_WGSL).toMatch(
    new RegExp(
      String.raw`turbulenceScale: f32,[^\n]*\n\s*attractorCount: u32,[^\n]*\n(\s*//[^\n]*\n)*\s*attractors: array<vec4<f32>, ${ATTRACTOR_ARRAY_VEC4S}>`,
    ),
  )
})

test('SIM_VS embeds the generated GLSL attractor term and uniforms', () => {
  expect(SIM_VS).toContain(attractorTermSource('glsl'))
  expect(SIM_VS).toContain(`uniform vec4 uAttractors[${ATTRACTOR_ARRAY_VEC4S}];`)
  expect(SIM_VS).toContain('uniform int uAttractorCount;')
})

test('the attractor term is guarded so the default count 0 adds nothing at all', () => {
  expect(attractorTermSource('wgsl')).toContain('if (P.attractorCount != 0u) {')
  expect(attractorTermSource('glsl')).toContain('if (uAttractorCount != 0) {')
})

// ---------------------------------------------------------------------------
// 2. WGSL <-> GLSL 1:1 correspondence. Both sources come from one builder,
//    but this normalization locks them together even against future
//    hand-edits of either language branch: after erasing pure declaration
//    syntax (types, let, u32 suffixes/loop syntax) and uniform naming, the
//    token streams must be IDENTICAL — same constants, same operations,
//    same order.
// ---------------------------------------------------------------------------

const normalize = (src: string): string =>
  src
    .replace(/for \(var j = 0u; /g, 'for (j = 0; ')
    .replace(/for \(int j = 0; /g, 'for (j = 0; ')
    .replace(/; j = j \+ 1u\)/g, '; j++)')
    .replace(/^(\s*)let (\w+) = /gm, '$1$2 = ')
    .replace(/^(\s*)(?:float|vec3|vec4) (\w+) = /gm, '$1$2 = ')
    .replace(/\b(\d+)u\b/g, '$1')
    .replace(/\bP\.attractorCount\b/g, '@count')
    .replace(/\buAttractorCount\b/g, '@count')
    .replace(/\bP\.attractors\b/g, '@data')
    .replace(/\buAttractors\b/g, '@data')

test('attractor term WGSL and GLSL are token-identical after syntax erasure', () => {
  expect(normalize(attractorTermSource('wgsl'))).toBe(normalize(attractorTermSource('glsl')))
})

// ---------------------------------------------------------------------------
// 3. No hardcoded constants: the named constants reach BOTH generated
//    sources, and the SimParams layout constants are self-consistent.
// ---------------------------------------------------------------------------

test('named attractor constants are embedded verbatim in both languages', () => {
  for (const lang of ['wgsl', 'glsl'] as const) {
    const src = attractorTermSource(lang)
    // vec4 stride and radius^2 slot drive the array indexing.
    const u = lang === 'wgsl' ? 'u' : ''
    expect(src).toContain(`[j * ${ATTRACTOR_VEC4S}${u}]`)
    expect(src).toContain(`[j * ${ATTRACTOR_VEC4S}${u} + ${ATTRACTOR_RADIUS2_SLOT}${u}].x`)
    // The softening epsilon appears as the exact same float literal in BOTH
    // denominator factors (inverse-square softening AND normalization).
    expect(src).toContain(`attD2 + soft2 + ${shaderFloatLiteral(ATTRACTOR_DIST_EPSILON)}`)
    expect(src).toContain(`sqrt(attD2 + ${shaderFloatLiteral(ATTRACTOR_DIST_EPSILON)})`)
  }
})

test('SimParams attractor layout constants are self-consistent', () => {
  expect(ATTRACTOR_ARRAY_VEC4S).toBe(MAX_ATTRACTORS * ATTRACTOR_VEC4S)
  expect(SIM_ATTRACTORS_INDEX % 4).toBe(0) // vec4-aligned (16-byte) offset
  expect(SIM_ATTRACTORS_INDEX).toBeGreaterThan(SIM_ATTRACTOR_COUNT_INDEX)
  expect(SIM_ATTRACTORS_INDEX - (SIM_ATTRACTOR_COUNT_INDEX + 1)).toBeLessThan(4) // minimal pad
  expect(SIM_PARAMS_BYTES).toBe((SIM_ATTRACTORS_INDEX + ATTRACTOR_ARRAY_VEC4S * 4) * 4)
  expect(SIM_PARAMS_BYTES % 16).toBe(0) // WGSL struct alignment / WebGPU buffer size
})

// ---------------------------------------------------------------------------
// 4. CPU reference implementation of the SAME math, built from the SAME
//    exported constants and reading the SAME packed layout the shaders read.
//    Verifies inverse-square falloff, attraction/repulsion direction, radius
//    softening, finiteness at the singularity, and superposition.
// ---------------------------------------------------------------------------

type V3 = [number, number, number]

/** Mirrors attractorTermSource: the velocity increment for one sim step. */
function attractorVelDeltaRef(pos: V3, packed: Float32Array, count: number, dt: number): V3 {
  const out: V3 = [0, 0, 0]
  for (let j = 0; j < count; j++) {
    const base = j * ATTRACTOR_VEC4S * 4
    const toAtt: V3 = [packed[base] - pos[0], packed[base + 1] - pos[1], packed[base + 2] - pos[2]]
    const attD2 = toAtt[0] * toAtt[0] + toAtt[1] * toAtt[1] + toAtt[2] * toAtt[2]
    const soft2 = packed[base + ATTRACTOR_RADIUS2_SLOT * 4]
    const s =
      (packed[base + 3] /
        ((attD2 + soft2 + ATTRACTOR_DIST_EPSILON) * Math.sqrt(attD2 + ATTRACTOR_DIST_EPSILON))) *
      dt
    out[0] += toAtt[0] * s
    out[1] += toAtt[1] * s
    out[2] += toAtt[2] * s
  }
  return out
}

const pack = (list: AttractorParams[] | undefined): { packed: Float32Array; count: number } => {
  const packed = new Float32Array(ATTRACTOR_ARRAY_VEC4S * 4)
  return { packed, count: packAttractors(list, packed) }
}

const mag = (v: V3): number => Math.hypot(v[0], v[1], v[2])

test('packAttractors writes [pos.xyz, strength] + [radius^2, 0, 0, 0] pairs', () => {
  const { packed, count } = pack([
    { position: [1, 2, 3], strength: 2.5, radius: 0.5 },
    { position: [-4, 5, -6], strength: -1.25 },
  ])
  expect(count).toBe(2)
  expect(Array.from(packed.subarray(0, 8))).toEqual([1, 2, 3, 2.5, 0.25, 0, 0, 0])
  const stride = ATTRACTOR_VEC4S * 4
  expect(Array.from(packed.subarray(stride, stride + 4))).toEqual([-4, 5, -6, -1.25])
  // Omitted radius takes the named default (stored squared, as float32).
  expect(packed[stride + ATTRACTOR_RADIUS2_SLOT * 4]).toBe(Math.fround(DEFAULT_ATTRACTOR_RADIUS ** 2))
  // Unused tail stays zero.
  expect(Array.from(packed.subarray(stride + 8)).every((x) => x === 0)).toBe(true)
})

test('packAttractors: omitted list packs count 0 and all zeros; excess is clamped', () => {
  const { packed, count } = pack(undefined)
  expect(count).toBe(0)
  expect(Array.from(packed).every((x) => x === 0)).toBe(true)
  const many = Array.from({ length: MAX_ATTRACTORS + 2 }, (_, i) => ({
    position: [i, 0, 0] as [number, number, number],
    strength: 1,
  }))
  expect(pack(many).count).toBe(MAX_ATTRACTORS)
})

test('force follows inverse-square falloff (radius 0: doubling distance quarters it)', () => {
  const { packed, count } = pack([{ position: [0, 0, 0], strength: 1, radius: 0 }])
  const dir: V3 = [0.6, -0.48, 0.64] // arbitrary non-axis direction
  const near = attractorVelDeltaRef([dir[0] * 2, dir[1] * 2, dir[2] * 2], packed, count, 1)
  const far = attractorVelDeltaRef([dir[0] * 4, dir[1] * 4, dir[2] * 4], packed, count, 1)
  expect(mag(far) / mag(near)).toBeCloseTo(0.25, 5)
})

test('positive strength pulls toward the attractor, negative pushes away, and dt scales linearly', () => {
  const pos: V3 = [3, -1, 2]
  const toward: V3 = [-3, 1, -2] // from pos to the origin attractor
  const pull = pack([{ position: [0, 0, 0], strength: 2 }])
  const push = pack([{ position: [0, 0, 0], strength: -2 }])
  const fPull = attractorVelDeltaRef(pos, pull.packed, pull.count, 0.016)
  const fPush = attractorVelDeltaRef(pos, push.packed, push.count, 0.016)
  const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  expect(dot(fPull, toward)).toBeGreaterThan(0)
  expect(dot(fPush, toward)).toBeLessThan(0)
  // Exact mirror: same math, sign flipped.
  expect(fPush[0]).toBeCloseTo(-fPull[0], 12)
  // dt is a plain linear factor.
  const fPull2 = attractorVelDeltaRef(pos, pull.packed, pull.count, 0.032)
  expect(mag(fPull2)).toBeCloseTo(2 * mag(fPull), 12)
})

test('radius softens by exactly d^2 / (d^2 + r^2) and the singularity stays finite', () => {
  const pos: V3 = [1.2, 0.4, -0.9]
  const d2 = pos[0] ** 2 + pos[1] ** 2 + pos[2] ** 2
  const r = 0.8
  const hard = pack([{ position: [0, 0, 0], strength: 1, radius: 0 }])
  const soft = pack([{ position: [0, 0, 0], strength: 1, radius: r }])
  const fHard = attractorVelDeltaRef(pos, hard.packed, hard.count, 1)
  const fSoft = attractorVelDeltaRef(pos, soft.packed, soft.count, 1)
  // The packed radius^2 is float32; the softening ratio is exact against it
  // (the epsilon rides in both denominators), and matches the ideal
  // d^2 / (d^2 + r^2) to well beyond the epsilon's magnitude.
  const soft2 = soft.packed[ATTRACTOR_RADIUS2_SLOT * 4]
  expect(soft2).toBe(Math.fround(r * r))
  const eps = ATTRACTOR_DIST_EPSILON
  expect(mag(fSoft) / mag(fHard)).toBeCloseTo((d2 + eps) / (d2 + soft2 + eps), 12)
  expect(mag(fSoft) / mag(fHard)).toBeCloseTo(d2 / (d2 + r * r), 5)
  // A particle exactly on the attractor: zero force, never NaN/Infinity.
  const atCenter = attractorVelDeltaRef([0, 0, 0], hard.packed, hard.count, 1)
  for (const v of atCenter) {
    expect(Number.isFinite(v)).toBe(true)
    expect(v).toBe(0)
  }
})

test('multiple attractors superpose (sum of the individual forces)', () => {
  const a: AttractorParams = { position: [5, 0, 0], strength: 1.5, radius: 0.2 }
  const b: AttractorParams = { position: [-2, 3, 1], strength: -0.75 }
  const pos: V3 = [0.5, -0.5, 0.25]
  const both = pack([a, b])
  const onlyA = pack([a])
  const onlyB = pack([b])
  const fBoth = attractorVelDeltaRef(pos, both.packed, both.count, 0.016)
  const fA = attractorVelDeltaRef(pos, onlyA.packed, onlyA.count, 0.016)
  const fB = attractorVelDeltaRef(pos, onlyB.packed, onlyB.count, 0.016)
  for (let axis = 0; axis < 3; axis++) expect(fBoth[axis]).toBeCloseTo(fA[axis] + fB[axis], 12)
})

// ---------------------------------------------------------------------------
// 5. Default wiring: no attractors uploads count 0 and an all-zero array
//    (the shader skips the term — bit-identical legacy trajectories), and
//    explicit attractors pass through as packAttractors packs them. Verified
//    end to end through the WebGL renderer against a recording fake GL; the
//    WebGPU renderer packs the very same packAttractors output into
//    simF32[SIM_ATTRACTORS_INDEX..] and simU32[SIM_ATTRACTOR_COUNT_INDEX].
// ---------------------------------------------------------------------------

interface GLCall { name: string; args: unknown[] }

function createFakeGL(): { gl: WebGL2RenderingContext; calls: GLCall[]; loc: (name: string) => object | undefined } {
  const calls: GLCall[] = []
  let nextId = 1
  const locByName = new Map<string, object>()
  const constants = new Map<string, number>()
  let nextConst = 1
  const gl = new Proxy({}, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined
      if (/^[A-Z][A-Z0-9_]*$/.test(prop)) {
        if (!constants.has(prop)) constants.set(prop, nextConst++)
        return constants.get(prop)
      }
      return (...args: unknown[]) => {
        calls.push({ name: prop, args })
        switch (prop) {
          case 'getShaderParameter':
          case 'getProgramParameter':
            return true
          case 'getParameter':
            if (args[0] === constants.get('ALIASED_POINT_SIZE_RANGE')) return new Float32Array([1, 64])
            return undefined
          case 'getExtension':
            if (args[0] === 'WEBGL_lose_context') return { loseContext: () => {} }
            return {}
          case 'createShader':
          case 'createProgram':
          case 'createBuffer':
          case 'createVertexArray':
          case 'createTransformFeedback':
          case 'createTexture':
          case 'createFramebuffer':
            return { kind: prop, id: nextId++ }
          case 'getUniformLocation': {
            const name = args[1] as string
            let l = locByName.get(name)
            if (!l) { l = { uniform: name, id: nextId++ }; locByName.set(name, l) }
            return l
          }
          case 'getShaderInfoLog':
          case 'getProgramInfoLog':
            return ''
          default:
            return undefined
        }
      }
    },
  }) as unknown as WebGL2RenderingContext
  return { gl, calls, loc: (name) => locByName.get(name) }
}

const baseMotion: MotionParams = {
  attraction: 1,
  damping: 1,
  noiseScale: 1,
  noiseStrength: 1,
  swirl: 0.5,
  maxSpeed: 10,
  speedColorMix: 0.2,
}

const optsWith = (motion: MotionParams): RendererOptions => ({
  count: 8,
  look: {
    exposure: 1, bloomStrength: 1, bloomThreshold: 1, vignette: 0, grain: 0,
    background: [0, 0, 0], particleSize: 1, intensity: 1, hot: [1, 1, 1],
    twinkle: 0, trail: 0.5, aberration: 0, streak: 0, nebula: 0, stars: 0,
  },
  motion,
  colorA: [1, 0.5, 0.2],
  colorB: [0.2, 0.5, 1],
})

function attractorUploads(motion: MotionParams): { counts: unknown[]; data: number[][] } {
  const fake = createFakeGL()
  const canvas = {
    width: 0, height: 0, getContext: () => fake.gl,
    addEventListener: () => {}, removeEventListener: () => {},
  } as unknown as HTMLCanvasElement
  const r = WebGL2ParticleRenderer.create(canvas, optsWith(motion))
  if (!r) throw new Error('expected renderer against the fake GL')
  r.resize(64, 32)
  r.frame(0.016, 0.016, 8)
  const counts = fake.calls
    .filter((c) => c.name === 'uniform1i' && c.args[0] === fake.loc('uAttractorCount'))
    .map((c) => c.args[1])
  const data = fake.calls
    .filter((c) => c.name === 'uniform4fv' && c.args[0] === fake.loc('uAttractors'))
    .map((c) => Array.from(c.args[1] as Float32Array))
  r.dispose()
  return { counts, data }
}

test('omitted attractors upload count 0 and an all-zero packed array', () => {
  const { counts, data } = attractorUploads(baseMotion)
  expect(counts).toEqual([0])
  expect(data).toHaveLength(1)
  expect(data[0]).toHaveLength(ATTRACTOR_ARRAY_VEC4S * 4)
  expect(data[0].every((x) => x === 0)).toBe(true)
})

test('explicit attractors upload the packAttractors packing verbatim', () => {
  const attractors: AttractorParams[] = [
    { position: [1, 2, 3], strength: 2.5, radius: 0.5 },
    { position: [-4, 0, 6], strength: -1 },
  ]
  const { counts, data } = attractorUploads({ ...baseMotion, attractors })
  expect(counts).toEqual([attractors.length])
  const expected = new Float32Array(ATTRACTOR_ARRAY_VEC4S * 4)
  expect(packAttractors(attractors, expected)).toBe(attractors.length)
  expect(data).toEqual([Array.from(expected)])
})

test('more than MAX_ATTRACTORS uploads a count clamped to MAX_ATTRACTORS', () => {
  const attractors: AttractorParams[] = Array.from({ length: MAX_ATTRACTORS + 3 }, (_, i) => ({
    position: [i, 1, -i] as [number, number, number],
    strength: 1 + i,
  }))
  const { counts } = attractorUploads({ ...baseMotion, attractors })
  expect(counts).toEqual([MAX_ATTRACTORS])
})
