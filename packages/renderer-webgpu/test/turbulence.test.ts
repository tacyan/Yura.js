import { test, expect } from 'bun:test'
import {
  SIM_WGSL,
  curlNoiseSource,
  turbulenceTermSource,
  shaderFloatLiteral,
  CURL_HASH_SCALE,
  CURL_HASH_SHIFT,
  CURL_OFFSET_Y,
  CURL_OFFSET_Z,
  TURBULENCE_TIME_SCALE,
  DEFAULT_TURBULENCE,
  DEFAULT_TURBULENCE_SCALE,
} from '../src/shaders'
// Cross-backend imports are deep-relative on purpose: the GLSL sim must embed
// the very same generated curl source, and the WebGL renderer must wire the
// very same defaults.
import { SIM_VS } from '../../renderer-webgl/src/shaders'
import { WebGL2ParticleRenderer } from '../../renderer-webgl/src/renderer'
import type { RendererOptions, MotionParams } from '../src/renderer'

// ---------------------------------------------------------------------------
// 1. Both sim shaders embed the generated curl noise and the guarded
//    turbulence term verbatim, plus their uniforms.
// ---------------------------------------------------------------------------

test('SIM_WGSL embeds the generated WGSL curl noise and turbulence uniforms', () => {
  expect(SIM_WGSL).toContain(curlNoiseSource('wgsl'))
  expect(SIM_WGSL).toContain(turbulenceTermSource('wgsl'))
  expect(SIM_WGSL).toContain('turbulence: f32')
  expect(SIM_WGSL).toContain('turbulenceScale: f32')
  // Field order matters for the uniform-buffer packing (simF32[16], [17]).
  expect(SIM_WGSL).toMatch(/morphSpread: f32,\s*\n\s*turbulence: f32[^\n]*\n\s*turbulenceScale: f32/)
})

test('SIM_VS embeds the generated GLSL curl noise and turbulence uniforms', () => {
  expect(SIM_VS).toContain(curlNoiseSource('glsl'))
  expect(SIM_VS).toContain(turbulenceTermSource('glsl'))
  expect(SIM_VS).toContain('uTurbulence')
  expect(SIM_VS).toContain('uTurbulenceScale')
})

test('the turbulence term is guarded so the default 0 adds nothing at all', () => {
  expect(turbulenceTermSource('wgsl')).toContain('if (P.turbulence != 0.0) {')
  expect(turbulenceTermSource('glsl')).toContain('if (uTurbulence != 0.0) {')
})

// ---------------------------------------------------------------------------
// 2. WGSL <-> GLSL 1:1 correspondence. Both sources come from one builder,
//    but this normalization locks them together even against future
//    hand-edits of either language branch: after erasing pure declaration
//    syntax (types, let) and uniform naming, the token streams must be
//    IDENTICAL — same constants, same operations, same order.
// ---------------------------------------------------------------------------

const normalize = (src: string): string =>
  src
    .replace(/vec3<f32>/g, 'vec3')
    .replace(/^fn (\w+)\(p: vec3\) -> (?:f32|vec3) \{/gm, '$1(p) {')
    .replace(/^(?:float|vec3) (\w+)\(vec3 p\) \{/gm, '$1(p) {')
    .replace(/^(\s*)let (\w+) = /gm, '$1$2 = ')
    .replace(/^(\s*)(?:float|vec3) (\w+) = /gm, '$1$2 = ')
    .replace(/\bP\.turbulenceScale\b/g, '@scale')
    .replace(/\buTurbulenceScale\b/g, '@scale')
    .replace(/\bP\.turbulence\b/g, '@strength')
    .replace(/\buTurbulence\b/g, '@strength')
    .replace(/\bP\.time\b/g, '@time')
    .replace(/\buTime\b/g, '@time')

test('curl noise WGSL and GLSL are token-identical after syntax erasure', () => {
  expect(normalize(curlNoiseSource('wgsl'))).toBe(normalize(curlNoiseSource('glsl')))
})

test('turbulence term WGSL and GLSL are token-identical after syntax erasure', () => {
  expect(normalize(turbulenceTermSource('wgsl'))).toBe(normalize(turbulenceTermSource('glsl')))
})

// ---------------------------------------------------------------------------
// 3. No hardcoded noise constants: every named constant reaches BOTH
//    generated sources as the exact same float literal.
// ---------------------------------------------------------------------------

test('named noise constants are embedded verbatim in both languages', () => {
  const curlConstants = [CURL_HASH_SCALE, CURL_HASH_SHIFT, ...CURL_OFFSET_Y, ...CURL_OFFSET_Z]
  for (const lang of ['wgsl', 'glsl'] as const) {
    const curl = curlNoiseSource(lang)
    for (const c of curlConstants) expect(curl).toContain(shaderFloatLiteral(c))
    expect(turbulenceTermSource(lang)).toContain(`* ${shaderFloatLiteral(TURBULENCE_TIME_SCALE)})`)
  }
})

test('float literals are valid in both WGSL and GLSL ES (always a . or exponent)', () => {
  expect(shaderFloatLiteral(3)).toBe('3.0')
  expect(shaderFloatLiteral(0.35)).toBe('0.35')
  expect(shaderFloatLiteral(1e-7)).toBe('1e-7')
})

// ---------------------------------------------------------------------------
// 4. CPU reference implementation of the SAME math, built from the SAME
//    exported constants. Verifies the analytic gradient against finite
//    differences and — the whole point of curl noise — that the field is
//    divergence-free.
// ---------------------------------------------------------------------------

type V3 = [number, number, number]
const fract = (x: number): number => x - Math.floor(x)
const add3 = (a: V3, b: readonly number[]): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

/** Mirrors curlHash: fract/dot folding with CURL_HASH_SCALE / CURL_HASH_SHIFT. */
function hashRef(p: V3): number {
  const q = [fract(p[0] * CURL_HASH_SCALE), fract(p[1] * CURL_HASH_SCALE), fract(p[2] * CURL_HASH_SCALE)]
  // dot(q, q.zyx + shift)
  const dq =
    q[0] * (q[2] + CURL_HASH_SHIFT) + q[1] * (q[1] + CURL_HASH_SHIFT) + q[2] * (q[0] + CURL_HASH_SHIFT)
  const r = [q[0] + dq, q[1] + dq, q[2] + dq]
  return fract((r[0] + r[1]) * r[2])
}

/** Mirrors curlNoiseGrad, additionally returning the noise value itself. */
function noiseRef(p: V3): { value: number; grad: V3 } {
  const i: V3 = [Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2])]
  const f: V3 = [fract(p[0]), fract(p[1]), fract(p[2])]
  const u = f.map((x) => x * x * (3 - 2 * x)) as V3
  const du = f.map((x) => 6 * x * (1 - x)) as V3
  const h = (dx: number, dy: number, dz: number) => hashRef([i[0] + dx, i[1] + dy, i[2] + dz])
  const n000 = h(0, 0, 0), n100 = h(1, 0, 0), n010 = h(0, 1, 0), n110 = h(1, 1, 0)
  const n001 = h(0, 0, 1), n101 = h(1, 0, 1), n011 = h(0, 1, 1), n111 = h(1, 1, 1)
  const k1 = n100 - n000, k2 = n010 - n000, k3 = n001 - n000
  const k4 = n000 - n100 - n010 + n110
  const k5 = n000 - n010 - n001 + n011
  const k6 = n000 - n100 - n001 + n101
  const k7 = -n000 + n100 + n010 - n110 + n001 - n101 - n011 + n111
  const value =
    n000 + k1 * u[0] + k2 * u[1] + k3 * u[2] +
    k4 * u[0] * u[1] + k5 * u[1] * u[2] + k6 * u[2] * u[0] + k7 * u[0] * u[1] * u[2]
  const grad: V3 = [
    du[0] * (k1 + k4 * u[1] + k6 * u[2] + k7 * u[1] * u[2]),
    du[1] * (k2 + k4 * u[0] + k5 * u[2] + k7 * u[2] * u[0]),
    du[2] * (k3 + k5 * u[1] + k6 * u[0] + k7 * u[0] * u[1]),
  ]
  return { value, grad }
}

/** Mirrors curlNoise: curl of the potential (n(p), n(p+OY), n(p+OZ)). */
function curlRef(p: V3): V3 {
  const gx = noiseRef(p).grad
  const gy = noiseRef(add3(p, CURL_OFFSET_Y)).grad
  const gz = noiseRef(add3(p, CURL_OFFSET_Z)).grad
  return [gz[1] - gy[2], gx[2] - gz[0], gy[0] - gx[1]]
}

// Sample points away from lattice-cell boundaries (finite differences must
// not straddle the C1 seam of the cubic fade).
const SAMPLES: V3[] = [
  [0.37, 0.61, 0.43],
  [3.29, -1.53, 2.71],
  [-7.44, 5.18, -0.66],
  [12.31, 8.57, -4.42],
  [-0.58, -9.36, 6.24],
]

test('analytic value-noise gradient matches central finite differences', () => {
  const h = 1e-5
  for (const p of SAMPLES) {
    const { grad } = noiseRef(p)
    for (let axis = 0; axis < 3; axis++) {
      const hi: V3 = [...p]; hi[axis] += h
      const lo: V3 = [...p]; lo[axis] -= h
      const fd = (noiseRef(hi).value - noiseRef(lo).value) / (2 * h)
      expect(Math.abs(grad[axis] - fd)).toBeLessThan(1e-5)
    }
  }
})

test('curl field is divergence-free (finite-difference divergence ~ 0)', () => {
  const h = 1e-4
  for (const p of SAMPLES) {
    let div = 0
    for (let axis = 0; axis < 3; axis++) {
      const hi: V3 = [...p]; hi[axis] += h
      const lo: V3 = [...p]; lo[axis] -= h
      div += (curlRef(hi)[axis] - curlRef(lo)[axis]) / (2 * h)
    }
    expect(Math.abs(div)).toBeLessThan(1e-5)
  }
})

test('curl field is finite and actually non-trivial', () => {
  let maxLen = 0
  for (const p of SAMPLES) {
    const c = curlRef(p)
    for (const v of c) expect(Number.isFinite(v)).toBe(true)
    maxLen = Math.max(maxLen, Math.hypot(...c))
  }
  expect(maxLen).toBeGreaterThan(0.01)
})

// ---------------------------------------------------------------------------
// 5. Default wiring: turbulence defaults to exactly 0 (bit-identical legacy
//    trajectories) and turbulenceScale to its named constant. Verified end to
//    end through the WebGL renderer against a recording fake GL; the WebGPU
//    renderer packs the same `?? DEFAULT_*` values into simF32[16..17].
// ---------------------------------------------------------------------------

test('DEFAULT_TURBULENCE is exactly 0', () => {
  expect(DEFAULT_TURBULENCE).toBe(0)
})

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

function turbulenceUploads(motion: MotionParams): { turbulence: unknown[]; scale: unknown[] } {
  const fake = createFakeGL()
  const canvas = {
    width: 0, height: 0, getContext: () => fake.gl,
    addEventListener: () => {}, removeEventListener: () => {},
  } as unknown as HTMLCanvasElement
  const r = WebGL2ParticleRenderer.create(canvas, optsWith(motion))
  if (!r) throw new Error('expected renderer against the fake GL')
  r.resize(64, 32)
  r.frame(0.016, 0.016, 8)
  const uploads = (name: string) =>
    fake.calls.filter((c) => c.name === 'uniform1f' && c.args[0] === fake.loc(name)).map((c) => c.args[1])
  const out = { turbulence: uploads('uTurbulence'), scale: uploads('uTurbulenceScale') }
  r.dispose()
  return out
}

test('omitted turbulence uploads the named defaults (0 / DEFAULT_TURBULENCE_SCALE)', () => {
  const { turbulence, scale } = turbulenceUploads(baseMotion)
  expect(turbulence).toEqual([DEFAULT_TURBULENCE])
  expect(scale).toEqual([DEFAULT_TURBULENCE_SCALE])
})

test('explicit turbulence values pass through to the sim uniforms', () => {
  const { turbulence, scale } = turbulenceUploads({ ...baseMotion, turbulence: 1.5, turbulenceScale: 0.2 })
  expect(turbulence).toEqual([1.5])
  expect(scale).toEqual([0.2])
})
