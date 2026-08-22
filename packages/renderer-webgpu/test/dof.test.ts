import { test, expect } from 'bun:test'
import {
  RENDER_WGSL,
  buildRenderWgsl,
  dofVertexTermSource,
  dofSpriteProfileSource,
  shaderFloatLiteral,
  DEFAULT_DOF_FOCUS,
  DEFAULT_DOF_STRENGTH,
  DOF_DEPTH_EPSILON,
  SPRITE_CORE_FALLOFF,
} from '../src/shaders'
// Cross-backend imports are deep-relative on purpose: the GLSL sprite shaders
// must embed the very same generated DoF terms, and the WebGL renderer must
// wire the very same defaults.
import { RENDER_VS, RENDER_FS } from '../../renderer-webgl/src/shaders'
import { WebGL2ParticleRenderer } from '../../renderer-webgl/src/renderer'
import { WebGPUParticleRenderer } from '../src/renderer'
import type { RendererOptions, MotionParams, LookParams } from '../src/renderer'

// ---------------------------------------------------------------------------
// 1. The builder is the single source: the exported default render WGSL is
//    byte-identical to buildRenderWgsl(), and both particle pipelines embed
//    the generated DoF terms verbatim, plus their uniforms/varyings.
// ---------------------------------------------------------------------------

test('RENDER_WGSL is byte-identical to the buildRenderWgsl() default', () => {
  expect(RENDER_WGSL).toBe(buildRenderWgsl())
})

test('RENDER_WGSL embeds the generated WGSL DoF terms, misc slots, and coc varying', () => {
  expect(RENDER_WGSL).toContain(dofVertexTermSource('wgsl'))
  expect(RENDER_WGSL).toContain(dofSpriteProfileSource('wgsl'))
  expect(RENDER_WGSL).toContain('@location(2) coc: f32')
  // The uniforms ride in the EXISTING misc vec4 (z/w spare slots): the
  // RenderParams struct — and so the uniform buffer size — must not grow.
  expect(RENDER_WGSL).toMatch(/misc: vec4<f32>,\s*\/\/[^\n]*dof/)
})

test('RENDER_VS/RENDER_FS embed the generated GLSL DoF terms, uniforms, and varying', () => {
  expect(RENDER_VS).toContain(dofVertexTermSource('glsl'))
  expect(RENDER_VS).toContain('uDofFocus')
  expect(RENDER_VS).toContain('uDofStrength')
  expect(RENDER_VS).toContain('out float vCoc;')
  expect(RENDER_VS).toContain('vCoc = coc;')
  expect(RENDER_FS).toContain(dofSpriteProfileSource('glsl'))
  expect(RENDER_FS).toContain('in float vCoc;')
})

test('both DoF terms are guarded so the default strength 0 adds nothing at all', () => {
  expect(dofVertexTermSource('wgsl')).toContain('if (R.misc.w != 0.0) {')
  expect(dofVertexTermSource('glsl')).toContain('if (uDofStrength != 0.0) {')
  expect(dofSpriteProfileSource('wgsl')).toContain('if (in.coc > 0.0) {')
  expect(dofSpriteProfileSource('glsl')).toContain('if (vCoc > 0.0) {')
})

// ---------------------------------------------------------------------------
// 2. WGSL <-> GLSL 1:1 correspondence. Both sources come from one builder,
//    but this normalization locks them together even against future
//    hand-edits of either language branch: after erasing pure declaration
//    syntax (types, let/var) and uniform/varying naming, the token streams
//    must be IDENTICAL — same constants, same operations, same order.
// ---------------------------------------------------------------------------

const normalize = (src: string): string =>
  src
    .replace(/^(\s*)var (\w+) = /gm, '$1$2 = ')
    .replace(/^(\s*)let (\w+) = /gm, '$1$2 = ')
    .replace(/^(\s*)(?:float|vec3) (\w+) = /gm, '$1$2 = ')
    // The center depth: a fresh viewProj transform in WGSL, the already
    // computed gl_Position in GLSL — same quantity, one placeholder.
    .replace(/\(R\.viewProj \* vec4<f32>\(p, 1\.0\)\)\.w/g, '@depth')
    .replace(/\bgl_Position\.w\b/g, '@depth')
    .replace(/\bR\.misc\.w\b/g, '@strength')
    .replace(/\buDofStrength\b/g, '@strength')
    .replace(/\bR\.misc\.z\b/g, '@focus')
    .replace(/\buDofFocus\b/g, '@focus')
    .replace(/\bin\.coc\b/g, '@coc')
    .replace(/\bvCoc\b/g, '@coc')
    .replace(/\bin\.col\b/g, '@col')
    .replace(/\bvCol\b/g, '@col')

test('DoF vertex term WGSL and GLSL are token-identical after syntax erasure', () => {
  expect(normalize(dofVertexTermSource('wgsl'))).toBe(normalize(dofVertexTermSource('glsl')))
})

test('DoF sprite profile WGSL and GLSL are token-identical after syntax erasure', () => {
  expect(normalize(dofSpriteProfileSource('wgsl'))).toBe(normalize(dofSpriteProfileSource('glsl')))
})

test('named DoF constants are embedded verbatim in both languages', () => {
  for (const lang of ['wgsl', 'glsl'] as const) {
    expect(dofVertexTermSource(lang)).toContain(
      `max(dofDepth, ${shaderFloatLiteral(DOF_DEPTH_EPSILON)})`,
    )
    expect(dofSpriteProfileSource(lang)).toContain(
      `exp(-d2 * ${shaderFloatLiteral(SPRITE_CORE_FALLOFF)})`,
    )
  }
})

test('DEFAULT_DOF_STRENGTH is exactly 0 (DoF fully off by default)', () => {
  expect(DEFAULT_DOF_STRENGTH).toBe(0)
})

// ---------------------------------------------------------------------------
// 3. CPU reference implementation of the SAME math, built from the SAME
//    exported constants. Verifies the CoC formula (zero on the focus plane,
//    monotonic defocus growth on both sides, linear in strength, finite at
//    the camera plane) and the fragment profile (bit-equal legacy splat at
//    coc 0, flat-disc flattening, and the 1/(1+coc^2) energy conservation).
// ---------------------------------------------------------------------------

/** Mirrors dofVertexTermSource: coc = strength * |depth - focus| / max(depth, eps). */
const cocRef = (depth: number, focus: number, strength: number): number =>
  (strength * Math.abs(depth - focus)) / Math.max(depth, DOF_DEPTH_EPSILON)

/** Mirrors dofSpriteProfileSource: alpha profile + color scale for one sprite. */
function spriteProfileRef(d2: number, coc: number): { alpha: number; colScale: number } {
  let core = Math.exp(-d2 * SPRITE_CORE_FALLOFF)
  let colScale = 1
  if (coc > 0) {
    const cocMix = coc / (1 + coc)
    core = core + (1 - core) * cocMix // mix(core, 1.0, cocMix)
    colScale = 1 / (1 + coc * coc)
  }
  return { alpha: core * (1 - d2), colScale }
}

/** The legacy (pre-DoF) sprite splat both fragment shaders used verbatim. */
const legacyAlpha = (d2: number): number => Math.exp(-d2 * SPRITE_CORE_FALLOFF) * (1 - d2)

const FOCUS = DEFAULT_DOF_FOCUS
const STRENGTH = 1.5

test('CoC is exactly 0 on the focus plane and non-negative everywhere', () => {
  expect(cocRef(FOCUS, FOCUS, STRENGTH)).toBe(0)
  for (const depth of [0.01, 1, 10, FOCUS, 40, 1000]) {
    expect(cocRef(depth, FOCUS, STRENGTH)).toBeGreaterThanOrEqual(0)
  }
})

test('CoC grows monotonically with defocus on BOTH sides of the focus plane', () => {
  // Far side: deeper -> larger CoC.
  const far = [FOCUS, FOCUS * 1.5, FOCUS * 2, FOCUS * 4, FOCUS * 16].map((d) =>
    cocRef(d, FOCUS, STRENGTH),
  )
  for (let i = 1; i < far.length; i++) expect(far[i]).toBeGreaterThan(far[i - 1])
  // Near side: closer to the camera -> larger CoC.
  const near = [FOCUS, FOCUS * 0.75, FOCUS * 0.5, FOCUS * 0.25, FOCUS * 0.05].map((d) =>
    cocRef(d, FOCUS, STRENGTH),
  )
  for (let i = 1; i < near.length; i++) expect(near[i]).toBeGreaterThan(near[i - 1])
})

test('CoC is linear in dofStrength and saturates toward strength at far depths', () => {
  const depth = FOCUS * 3
  const one = cocRef(depth, FOCUS, 1)
  expect(cocRef(depth, FOCUS, 2)).toBeCloseTo(2 * one, 12)
  expect(cocRef(depth, FOCUS, 0)).toBe(0)
  // depth >> focus: |depth - focus| / depth -> 1, so coc -> strength.
  const farCoc = cocRef(FOCUS * 1e5, FOCUS, STRENGTH)
  expect(farCoc).toBeLessThan(STRENGTH)
  expect(farCoc).toBeGreaterThan(STRENGTH * 0.999)
})

test('the depth epsilon keeps the CoC finite at the camera plane (depth -> 0)', () => {
  const atCamera = cocRef(0, FOCUS, STRENGTH)
  expect(Number.isFinite(atCamera)).toBe(true)
  expect(atCamera).toBeCloseTo((STRENGTH * FOCUS) / DOF_DEPTH_EPSILON, 6)
})

test('at coc 0 the sprite profile is exactly the legacy splat (bit-identical default)', () => {
  for (const d2 of [0, 0.1, 0.25, 0.5, 0.8, 0.99]) {
    const { alpha, colScale } = spriteProfileRef(d2, 0)
    expect(alpha).toBe(legacyAlpha(d2))
    expect(colScale).toBe(1)
  }
})

test('growing coc flattens the Gaussian core toward a flat disc (bokeh ball)', () => {
  const edgeD2 = 0.8
  // Edge alpha rises monotonically with coc ...
  const cocs = [0, 0.5, 1, 2, 4, 16]
  const edge = cocs.map((coc) => spriteProfileRef(edgeD2, coc).alpha)
  for (let i = 1; i < edge.length; i++) expect(edge[i]).toBeGreaterThan(edge[i - 1])
  // ... toward the flat-disc limit (1 - d2), while the center stays at 1.
  expect(edge[0]).toBeCloseTo(legacyAlpha(edgeD2), 12)
  expect(edge[edge.length - 1]).toBeLessThan(1 - edgeD2)
  expect(spriteProfileRef(edgeD2, 1e6).alpha).toBeCloseTo(1 - edgeD2, 4)
  expect(spriteProfileRef(0, 1e6).alpha).toBeCloseTo(1, 6)
})

test('the color divisor is exactly 1 / (1 + coc^2)', () => {
  for (const coc of [0.25, 1, 3, 10]) {
    expect(spriteProfileRef(0.5, coc).colScale).toBeCloseTo(1 / (1 + coc * coc), 12)
  }
})

/**
 * Total emitted energy of one sprite: the profile integrated over the unit
 * disc (polar: pi * integral of alpha(d2) over d2 in [0,1]), times the
 * (1 + coc)^2 quad-area growth from the vertex stage, times the color scale
 * (or 1 to measure what would happen WITHOUT the conservation divisor).
 */
function spriteEnergyRef(coc: number, conserve: boolean): number {
  const steps = 2000
  let integral = 0
  for (let i = 0; i < steps; i++) {
    const d2 = (i + 0.5) / steps
    integral += spriteProfileRef(d2, coc).alpha / steps
  }
  const area = (1 + coc) * (1 + coc)
  const colScale = conserve ? spriteProfileRef(0.5, coc).colScale : 1
  return Math.PI * integral * area * colScale
}

test('col /= (1 + coc^2) conserves energy: defocus spreads light instead of multiplying it', () => {
  const base = spriteEnergyRef(0, true)
  for (const coc of [0.5, 1, 2, 4, 8]) {
    const ratio = spriteEnergyRef(coc, true) / base
    // With the divisor the flat-disc/Gaussian shape difference is all that
    // remains: total energy stays within a small constant band of in-focus.
    expect(ratio).toBeGreaterThan(1)
    expect(ratio).toBeLessThan(3.5)
  }
  // Without the divisor the (1 + coc)^2 area growth multiplies the light —
  // the classic additive-bloom blowout the factor exists to prevent.
  expect(spriteEnergyRef(8, false) / base).toBeGreaterThan(100)
})

// ---------------------------------------------------------------------------
// 4. Wiring, WebGPU: the renderer packs look.dofFocus/dofStrength (or the
//    named defaults) into the render UB's misc.z/w slots — verified against
//    a recording fake GPU — and the UB keeps its historic size.
// ---------------------------------------------------------------------------

class FakeBuffer {
  bytes: Uint8Array
  constructor(public desc: { label?: string; size: number; usage: number }) {
    this.bytes = new Uint8Array(desc.size)
  }
  destroy(): void {}
}

function installWebGPUGlobals(): void {
  const g = globalThis as Record<string, unknown>
  g.GPUBufferUsage = {
    MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
    VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
  }
  g.GPUTextureUsage = {
    COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16,
  }
  g.GPUMapMode = { READ: 1, WRITE: 2 }
  const gpu = { getPreferredCanvasFormat: () => 'bgra8unorm' }
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: { gpu },
      configurable: true,
      writable: true,
    })
  } catch {
    ;(globalThis.navigator as unknown as { gpu: unknown }).gpu = gpu
  }
}
installWebGPUGlobals()

function makeFakeGPU() {
  const buffers: FakeBuffer[] = []
  const pass = {
    setPipeline() {}, setBindGroup() {}, draw() {}, dispatchWorkgroups() {}, end() {},
  }
  const device = {
    createShaderModule: () => ({}),
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createSampler: () => ({}),
    createBuffer: (desc: { label?: string; size: number; usage: number }) => {
      const b = new FakeBuffer(desc)
      buffers.push(b)
      return b
    },
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({
      beginComputePass: () => pass,
      beginRenderPass: () => pass,
      finish: () => ({}),
    }),
    queue: {
      writeBuffer(buffer: FakeBuffer, offset: number, data: unknown) {
        const src = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data as ArrayBuffer)
        buffer.bytes.set(src, offset)
      },
      submit() {},
    },
    lost: new Promise(() => {}),
    destroy() {},
  }
  const context = {
    configure() {},
    unconfigure() {},
    getCurrentTexture: () => ({ createView: () => ({}) }),
  }
  const canvas = {
    width: 0,
    height: 0,
    getContext: (kind: string) => (kind === 'webgpu' ? context : null),
  }
  return { device, canvas, buffers }
}

const LOOK: LookParams = {
  exposure: 1, bloomStrength: 1, bloomThreshold: 1, vignette: 0, grain: 0,
  background: [0, 0, 0], particleSize: 1, intensity: 1, hot: [1, 1, 1],
  twinkle: 0, trail: 0.5, aberration: 0, streak: 0, nebula: 0, stars: 0,
}

const MOTION: MotionParams = {
  attraction: 1, damping: 1, noiseScale: 1, noiseStrength: 1,
  swirl: 0.5, maxSpeed: 10, speedColorMix: 0.2,
}

const optsWith = (look: LookParams): RendererOptions => ({
  count: 8,
  look,
  motion: { ...MOTION },
  colorA: [1, 0.5, 0.2],
  colorB: [0.2, 0.5, 1],
})

// Float indices of the RenderParams misc vec4 inside the 40-float render UB:
// mat4 viewProj (16) + 5 vec4s (right/up/colorA/colorB/colorHot, 20) = 36.
const MISC_BASE = 16 + 5 * 4
const MISC_Z = MISC_BASE + 2
const MISC_W = MISC_BASE + 3
/** Historic render UB byte size (mat4 + 6 vec4) — DoF must NOT grow it. */
const RENDER_UB_BYTES = (16 + 6 * 4) * 4

async function renderMisc(look: LookParams): Promise<{ z: number; w: number; ubSize: number }> {
  const env = makeFakeGPU()
  const r = await WebGPUParticleRenderer.create(
    env.canvas as unknown as HTMLCanvasElement,
    env.device as unknown as GPUDevice,
    optsWith(look),
  )
  r.resize(64, 32)
  r.frame(0.016, 0.5, 8)
  const ub = env.buffers.find((b) => b.desc.label === 'yura-render-ub')
  if (!ub) throw new Error('yura-render-ub not created')
  const f32 = new Float32Array(ub.bytes.buffer)
  r.dispose()
  return { z: f32[MISC_Z], w: f32[MISC_W], ubSize: ub.desc.size }
}

test('WebGPU: omitted DoF writes the named defaults into misc.z/w; UB size unchanged', async () => {
  const { z, w, ubSize } = await renderMisc({ ...LOOK })
  expect(z).toBe(DEFAULT_DOF_FOCUS)
  expect(w).toBe(DEFAULT_DOF_STRENGTH)
  expect(ubSize).toBe(RENDER_UB_BYTES)
})

test('WebGPU: explicit dofFocus/dofStrength pass through to misc.z/w', async () => {
  const { z, w } = await renderMisc({ ...LOOK, dofFocus: 18.5, dofStrength: 1.25 })
  expect(z).toBe(18.5)
  expect(w).toBe(1.25)
})

// ---------------------------------------------------------------------------
// 5. Wiring, WebGL: the same defaults reach uDofFocus/uDofStrength — verified
//    against the recording fake GL (same harness style as turbulence.test.ts).
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

function dofUploads(look: LookParams): { focus: unknown[]; strength: unknown[] } {
  const fake = createFakeGL()
  const canvas = {
    width: 0, height: 0, getContext: () => fake.gl,
    addEventListener: () => {}, removeEventListener: () => {},
  } as unknown as HTMLCanvasElement
  const r = WebGL2ParticleRenderer.create(canvas, optsWith(look))
  if (!r) throw new Error('expected renderer against the fake GL')
  r.resize(64, 32)
  r.frame(0.016, 0.016, 8)
  const uploads = (name: string) =>
    fake.calls.filter((c) => c.name === 'uniform1f' && c.args[0] === fake.loc(name)).map((c) => c.args[1])
  const out = { focus: uploads('uDofFocus'), strength: uploads('uDofStrength') }
  r.dispose()
  return out
}

test('WebGL: omitted DoF uploads the named defaults (DEFAULT_DOF_FOCUS / 0)', () => {
  const { focus, strength } = dofUploads({ ...LOOK })
  expect(focus).toEqual([DEFAULT_DOF_FOCUS])
  expect(strength).toEqual([DEFAULT_DOF_STRENGTH])
})

test('WebGL: explicit dofFocus/dofStrength pass through to the render uniforms', () => {
  const { focus, strength } = dofUploads({ ...LOOK, dofFocus: 18.5, dofStrength: 1.25 })
  expect(focus).toEqual([18.5])
  expect(strength).toEqual([1.25])
})
