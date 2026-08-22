import { test, expect } from 'bun:test'
import { ortho, lookAt, multiply, transform4, type Vec3 } from '@yura/core'
import { WebGPUModelRenderer, computeLightViewProj, DEFAULT_SOFT_PARTICLES } from '../src/model-renderer'
import type { SceneMaterial } from '../src/model-renderer'
import { POST_WGSL } from '../src/shaders'
import { FX_WGSL, FX_SOFT_WGSL, buildFxWgsl } from '../src/model-shaders'
import { gpuBlendState } from '../src/blend'
import type { LookParams } from '../src/renderer'
import type { MeshGeometry } from '../src/meshes'

// ---------------------------------------------------------------------------
// Fake WebGPU environment — no GPU required. Buffers and textures record
// their destroy() calls so dispose() coverage can be asserted exactly.
// ---------------------------------------------------------------------------

class FakeBuffer {
  destroyed = false
  constructor(public desc: { label?: string; size: number; usage: number }) {}
  destroy(): void {
    this.destroyed = true
  }
}

class FakeTexture {
  destroyed = false
  views = 0
  constructor(public desc: unknown) {}
  createView(): object {
    this.views++
    return {}
  }
  destroy(): void {
    this.destroyed = true
  }
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

interface FakePipelineDesc {
  label?: string
  fragment?: { targets?: { format?: string; blend?: GPUBlendState }[] }
}

function makeFakeGPU() {
  const buffers: FakeBuffer[] = []
  const textures: FakeTexture[] = []
  const shaderModules: { label?: string; code: string }[] = []
  const pipelines: FakePipelineDesc[] = []
  const bindGroups: { layout: unknown }[] = []
  const passes: Record<string, unknown>[] = []
  const writes: { label?: string; f32: Float32Array }[] = []
  const pass = {
    setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, setIndexBuffer() {},
    draw() {}, drawIndexed() {}, end() {},
  }
  const device = {
    destroyed: false,
    createShaderModule: (desc: { label?: string; code: string }) => {
      shaderModules.push(desc)
      return {}
    },
    createRenderPipeline: (desc: FakePipelineDesc) => {
      pipelines.push(desc)
      return { getBindGroupLayout: () => ({}) }
    },
    createTexture: (desc: unknown) => {
      const t = new FakeTexture(desc)
      textures.push(t)
      return t
    },
    createSampler: () => ({}),
    createBuffer: (desc: { label?: string; size: number; usage: number }) => {
      const b = new FakeBuffer(desc)
      buffers.push(b)
      return b
    },
    createBindGroup: (desc: { layout: unknown }) => {
      bindGroups.push(desc)
      return {}
    },
    createCommandEncoder: () => ({
      beginRenderPass: (desc: Record<string, unknown>) => {
        passes.push(desc)
        return pass
      },
      finish: () => ({}),
    }),
    queue: {
      writeBuffer(buffer: FakeBuffer, _offset: number, data: ArrayBufferView | ArrayBuffer) {
        const view = ArrayBuffer.isView(data)
          ? new Float32Array(data.buffer, data.byteOffset, data.byteLength >>> 2)
          : new Float32Array(data)
        writes.push({ label: buffer.desc.label, f32: Float32Array.from(view) })
      },
      writeTexture() {}, submit() {}, copyExternalImageToTexture() {},
    },
    lost: new Promise(() => {}),
    destroy() {
      this.destroyed = true
    },
  }
  const context = {
    unconfigured: false,
    configure() {},
    unconfigure() {
      this.unconfigured = true
    },
    getCurrentTexture: () => ({ createView: () => ({}) }),
  }
  const canvas = {
    width: 0,
    height: 0,
    getContext: (kind: string) => (kind === 'webgpu' ? context : null),
  }
  return { device, context, canvas, buffers, textures, shaderModules, pipelines, bindGroups, passes, writes }
}

const LOOK: LookParams = {
  exposure: 1, bloomStrength: 0.5, bloomThreshold: 1, vignette: 0, grain: 0,
  background: [0, 0, 0], particleSize: 1, intensity: 1, hot: [1, 1, 1],
  twinkle: 0, trail: 0, aberration: 0, streak: 0, nebula: 0, stars: 0,
}

function triangleGeo(): MeshGeometry {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
  } as MeshGeometry
}

const PBR_MAT: SceneMaterial = {
  color: [1, 1, 1, 1], metallic: 0, roughness: 0.5, emissive: [0, 0, 0],
}
const UNLIT_MAT: SceneMaterial = {
  color: [1, 0, 0, 1], metallic: 0, roughness: 1, emissive: [0, 0, 0], unlit: true,
}

async function makeRenderer() {
  const env = makeFakeGPU()
  const r = await WebGPUModelRenderer.create(
    env.canvas as unknown as HTMLCanvasElement,
    env.device as unknown as GPUDevice,
    LOOK,
  )
  return { ...env, r }
}

// ---------------------------------------------------------------------------
// dispose(): every GPUBuffer the renderer ever created must be destroyed.
// ---------------------------------------------------------------------------

test('dispose destroys every GPUBuffer the renderer created', async () => {
  const { r, device, context, buffers, textures } = await makeRenderer()

  // create() alone allocates the frame/shadow/post/fx UBOs + 6 env-face UBOs.
  expect(buffers.length).toBeGreaterThanOrEqual(15)

  // Dynamic meshes add vertex/index/material/object buffers on top.
  r.addMesh(triangleGeo(), PBR_MAT, { shadow: true })
  r.addMesh(triangleGeo(), UNLIT_MAT)
  expect(buffers.length).toBeGreaterThanOrEqual(27)

  r.dispose()

  const leaked = buffers.filter((b) => !b.destroyed)
  expect(leaked.map((b) => b.desc.label ?? `unlabeled(size=${b.desc.size})`)).toEqual([])
  expect(textures.filter((t) => !t.destroyed)).toEqual([])
  expect(device.destroyed).toBe(true)
  expect(context.unconfigured).toBe(true)
})

test('mesh remove() destroys its buffers immediately; dispose is idempotent', async () => {
  const { r, buffers } = await makeRenderer()
  const before = buffers.length
  const handle = r.addMesh(triangleGeo(), PBR_MAT, { shadow: true })
  const meshBuffers = buffers.slice(before)
  expect(meshBuffers.length).toBe(6) // positions, normals, uvs, indices, matUB, objectUB

  handle.remove()
  expect(meshBuffers.every((b) => b.destroyed)).toBe(true)
  handle.remove() // second remove is a no-op

  r.dispose()
  r.dispose() // second dispose is a no-op
  expect(buffers.every((b) => b.destroyed)).toBe(true)
})

// ---------------------------------------------------------------------------
// toneMapping: default is byte-identical to the historic shader; switching
// modes rebuilds the composite pipeline exactly once.
// ---------------------------------------------------------------------------

test('default toneMapping compiles the exact historic post shader', async () => {
  const { shaderModules } = await makeRenderer()
  const post = shaderModules.filter((m) => m.label === 'yura-model-post')
  expect(post.length).toBe(1)
  expect(post[0]!.code).toBe(POST_WGSL)
})

test('toneMapping switch rebuilds the composite pipeline exactly once', async () => {
  const { r, pipelines, shaderModules } = await makeRenderer()
  r.addMesh(triangleGeo(), PBR_MAT, { shadow: true })
  r.resize(64, 64)
  const pipesBefore = pipelines.length
  const modulesBefore = shaderModules.length

  // Default ('aces') frames never rebuild anything.
  r.frame(1 / 60, 0)
  r.frame(1 / 60, 1 / 60)
  expect(pipelines.length).toBe(pipesBefore)
  expect(shaderModules.length).toBe(modulesBefore)

  // Switching the mode rebuilds the post module + composite pipeline once.
  r.look = { ...LOOK, toneMapping: 'reinhard' }
  r.frame(1 / 60, 2 / 60)
  expect(pipelines.length).toBe(pipesBefore + 1)
  expect(pipelines[pipelines.length - 1]!.label).toBe('yura-model-compositeFS')
  expect(shaderModules.length).toBe(modulesBefore + 1)

  // Further frames with the same mode do not rebuild again.
  r.frame(1 / 60, 3 / 60)
  r.frame(1 / 60, 4 / 60)
  expect(pipelines.length).toBe(pipesBefore + 1)
  expect(shaderModules.length).toBe(modulesBefore + 1)
})

// ---------------------------------------------------------------------------
// blendMode: the FX sprite pipeline uses the shared blend.ts table. The
// default ('additive') descriptor is pinned; switching modes rebuilds the FX
// pipeline (and its bind group) exactly once, reusing the compiled module.
// ---------------------------------------------------------------------------

function fxPipelines(pipelines: FakePipelineDesc[]): FakePipelineDesc[] {
  return pipelines.filter((p) => p.label === 'yura-fx')
}

function fxBlend(desc: FakePipelineDesc): GPUBlendState | undefined {
  return desc.fragment?.targets?.[0]?.blend
}

test('default blendMode builds one FX pipeline with the pinned additive blend', async () => {
  const { pipelines } = await makeRenderer()
  const fx = fxPipelines(pipelines)
  expect(fx.length).toBe(1)
  // Pinned descriptor: identical color math to the historic hand-rolled
  // additive state. The alpha component is the shared blend.ts additive
  // (one/one); with the FX shader emitting alpha 0 it degenerates to the
  // historic zero/one — destination alpha is preserved either way.
  expect(fxBlend(fx[0]!)).toEqual({
    color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  })
  expect(fxBlend(fx[0]!)).toEqual(gpuBlendState('additive'))
  expect(fx[0]!.fragment?.targets?.[0]?.format).toBe('rgba16float')
})

test('blendMode switch rebuilds the FX pipeline exactly once', async () => {
  const { r, pipelines, shaderModules, bindGroups } = await makeRenderer()
  r.addMesh(triangleGeo(), PBR_MAT, { shadow: true })
  r.resize(64, 64)
  const pipesBefore = pipelines.length
  const modulesBefore = shaderModules.length
  const bgBefore = bindGroups.length

  // Default ('additive') frames never rebuild anything.
  r.frame(1 / 60, 0)
  r.frame(1 / 60, 1 / 60)
  expect(pipelines.length).toBe(pipesBefore)
  expect(bindGroups.length).toBe(bgBefore)

  // Switching the mode rebuilds the FX pipeline + bind group once,
  // reusing the already-compiled FX shader module.
  r.look = { ...LOOK, blendMode: 'screen' }
  r.frame(1 / 60, 2 / 60)
  expect(pipelines.length).toBe(pipesBefore + 1)
  expect(bindGroups.length).toBe(bgBefore + 1)
  expect(shaderModules.length).toBe(modulesBefore)
  const rebuilt = pipelines[pipelines.length - 1]!
  expect(rebuilt.label).toBe('yura-fx')
  expect(fxBlend(rebuilt)).toEqual(gpuBlendState('screen'))

  // Further frames with the same mode do not rebuild again.
  r.frame(1 / 60, 3 / 60)
  r.frame(1 / 60, 4 / 60)
  expect(pipelines.length).toBe(pipesBefore + 1)
  expect(bindGroups.length).toBe(bgBefore + 1)

  // Switching back to the default rebuilds once more, byte-equal to the
  // original default descriptor.
  r.look = { ...LOOK, blendMode: 'additive' }
  r.frame(1 / 60, 5 / 60)
  expect(pipelines.length).toBe(pipesBefore + 2)
  const restored = pipelines[pipelines.length - 1]!
  expect(restored.label).toBe('yura-fx')
  expect(fxBlend(restored)).toEqual(fxBlend(fxPipelines(pipelines)[0]!))
})

// ---------------------------------------------------------------------------
// ViewCache: steady-state frames must not call createView() on any
// renderer-owned texture; resize invalidates and re-caches.
// ---------------------------------------------------------------------------

test('steady-state frames reuse cached texture views (no per-frame createView)', async () => {
  const { r, textures } = await makeRenderer()
  r.addMesh(triangleGeo(), PBR_MAT, { shadow: true })
  r.resize(64, 64)

  // First frame warms the cache (shadow/depth/bloomC views created lazily).
  r.frame(1 / 60, 0)
  const warm = textures.map((t) => t.views)

  r.frame(1 / 60, 1 / 60)
  r.frame(1 / 60, 2 / 60)
  expect(textures.map((t) => t.views)).toEqual(warm)

  // Recreating render targets invalidates the cache; the next steady state
  // again stops calling createView().
  r.resize(32, 32)
  r.frame(1 / 60, 3 / 60)
  const rewarmed = textures.map((t) => t.views)
  r.frame(1 / 60, 4 / 60)
  expect(textures.map((t) => t.views)).toEqual(rewarmed)
})

// ---------------------------------------------------------------------------
// computeLightViewProj: deterministic, memoized, numerically unchanged.
// ---------------------------------------------------------------------------

const DIR: Vec3 = [-0.5, 0.5, -0.65]

test('computeLightViewProj matches the reference ortho*lookAt formula', () => {
  for (const a of [1, 4, 10]) {
    const ll = Math.hypot(DIR[0], DIR[1], DIR[2])
    const eye: Vec3 = [(DIR[0] / ll) * a * 2.4, (DIR[1] / ll) * a * 2.4, (DIR[2] / ll) * a * 2.4]
    const expected = multiply(ortho(-a, a, -a, a, 0.1, a * 6), lookAt(eye, [0, 0, 0], [0, 1, 0]))
    expect(Array.from(computeLightViewProj(a, DIR))).toEqual(Array.from(expected))
  }
})

test('computeLightViewProj is deterministic across memo eviction', () => {
  const first = computeLightViewProj(4, [...DIR])
  const snapshot = Float32Array.from(first)

  // Evict the single-slot memo, then recompute with the original inputs.
  computeLightViewProj(7, [1, 2, 3])
  const again = computeLightViewProj(4, [...DIR])

  expect(again).not.toBe(first) // freshly computed, not a stale cache
  expect(Array.from(again)).toEqual(Array.from(snapshot))
})

test('computeLightViewProj memo hit returns the same instance (zero allocation)', () => {
  const a = computeLightViewProj(4, [...DIR])
  const b = computeLightViewProj(4, [...DIR]) // distinct input arrays, same values
  expect(b).toBe(a)

  const moved = computeLightViewProj(5, [...DIR])
  expect(moved).not.toBe(a)
  expect(computeLightViewProj(5, [...DIR])).toBe(moved)
})

test('computeLightViewProj maps the world origin inside NDC', () => {
  for (const area of [1, 4, 10]) {
    const m = computeLightViewProj(area, DIR)
    const [x, y, z, w] = transform4(m, [0, 0, 0, 1])
    expect(w).toBeCloseTo(1, 5) // orthographic: no perspective divide
    expect(Math.abs(x / w)).toBeLessThanOrEqual(1)
    expect(Math.abs(y / w)).toBeLessThanOrEqual(1)
    expect(z / w).toBeGreaterThan(0)
    expect(z / w).toBeLessThan(1)
  }
})

// ---------------------------------------------------------------------------
// Soft particles (LookParams.softParticles): default 0 must stay bit-exact
// legacy; > 0 swaps in the depth-fade FX variant exactly once.
// ---------------------------------------------------------------------------

// Byte-exact snapshot of the historic FX shader. buildFxWgsl(false) — the
// default softParticles=0 path — must reproduce it forever.
const LEGACY_FX_WGSL = `
struct FxFrame {
  viewProj: mat4x4<f32>,
  right: vec4<f32>,
  up: vec4<f32>,
}
@group(0) @binding(0) var<uniform> F: FxFrame;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) corner: vec2<f32>,
  @location(1) color: vec4<f32>,
}

@vertex
fn vs(
  @builtin(vertex_index) vi: u32,
  @location(0) centerSize: vec4<f32>,
  @location(1) colorAlpha: vec4<f32>,
) -> VSOut {
  var corners = array<vec2<f32>, 4>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, 1.0),
  );
  let c = corners[vi];
  let world = centerSize.xyz + (F.right.xyz * c.x + F.up.xyz * c.y) * centerSize.w;
  var out: VSOut;
  out.pos = F.viewProj * vec4<f32>(world, 1.0);
  out.corner = c;
  out.color = colorAlpha;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let d2 = dot(in.corner, in.corner);
  let falloff = max(1.0 - d2, 0.0);
  // Soft round sprite with a hot core; alpha=0 keeps additive blending pure.
  let glow = falloff * falloff * (0.35 + 1.9 * falloff);
  return vec4<f32>(in.color.rgb * (in.color.a * glow * 2.2), 0.0);
}
`

function oneFxSprite(): Float32Array<ArrayBuffer> {
  // x, y, z, size, r, g, b, alpha
  return new Float32Array([0, 0, 0, 0.1, 1, 1, 1, 1])
}

test('default softParticles compiles the exact legacy FX shader and pipeline descriptor', async () => {
  expect(DEFAULT_SOFT_PARTICLES).toBe(0)
  expect(buildFxWgsl(false)).toBe(LEGACY_FX_WGSL)
  expect(FX_WGSL).toBe(LEGACY_FX_WGSL)

  const { shaderModules, pipelines } = await makeRenderer()
  const fxModules = shaderModules.filter((m) => m.label === 'yura-fx')
  expect(fxModules.length).toBe(1)
  expect(fxModules[0]!.code).toBe(FX_WGSL)
  expect(shaderModules.filter((m) => m.label === 'yura-fx-soft').length).toBe(0)

  const fx = fxPipelines(pipelines)
  expect(fx.length).toBe(1)
  expect(fx[0]).toEqual({
    label: 'yura-fx',
    layout: 'auto',
    vertex: {
      module: {},
      entryPoint: 'vs',
      buffers: [
        {
          arrayStride: 32,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x4' },
            { shaderLocation: 1, offset: 16, format: 'float32x4' },
          ],
        },
      ],
    },
    fragment: {
      module: {},
      entryPoint: 'fs',
      targets: [{ format: 'rgba16float', blend: gpuBlendState('additive') }],
    },
    primitive: { topology: 'triangle-strip', cullMode: 'none' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' },
  } as unknown as FakePipelineDesc)
})

test('softParticles>0 rebuilds the FX pipeline exactly once and feeds the fade uniform', async () => {
  const { r, pipelines, shaderModules, bindGroups, writes } = await makeRenderer()
  r.addMesh(triangleGeo(), PBR_MAT, { shadow: true })
  r.resize(64, 64)
  r.frame(1 / 60, 0)
  const lastFxUB = () => {
    const fxWrites = writes.filter((w) => w.label === 'yura-fx-ub')
    return fxWrites[fxWrites.length - 1]!.f32
  }
  expect(lastFxUB()[24]).toBe(0)
  const pipesBefore = pipelines.length
  const modulesBefore = shaderModules.length
  const bgBefore = bindGroups.length

  r.look = { ...LOOK, softParticles: 0.35 }
  r.frame(1 / 60, 1 / 60)
  expect(pipelines.length).toBe(pipesBefore + 1)
  expect(pipelines[pipelines.length - 1]!.label).toBe('yura-fx')
  expect(shaderModules.length).toBe(modulesBefore + 1)
  const softModule = shaderModules[shaderModules.length - 1]!
  expect(softModule.label).toBe('yura-fx-soft')
  expect(softModule.code).toBe(FX_SOFT_WGSL)
  expect(softModule.code).toBe(buildFxWgsl(true))
  expect(softModule.code).toContain('texture_depth_2d')
  expect(softModule.code).toContain('saturate(separation / F.soft.x)')
  expect(bindGroups.length).toBe(bgBefore + 1)
  const softBG = bindGroups[bindGroups.length - 1] as unknown as { entries: { binding: number }[] }
  expect(softBG.entries.map((e) => e.binding)).toEqual([0, 1])

  // Uniform carries fade distance + frustum planes for depth linearization.
  const u = lastFxUB()
  expect(u.length).toBe(28)
  expect(u[24]).toBeCloseTo(0.35, 5)
  expect(u[25]).toBeCloseTo(0.05, 5)
  expect(u[26]).toBe(200)

  // Steady frames and fade-distance tweaks touch only the uniform.
  r.frame(1 / 60, 2 / 60)
  r.look = { ...LOOK, softParticles: 0.9 }
  r.frame(1 / 60, 3 / 60)
  expect(pipelines.length).toBe(pipesBefore + 1)
  expect(shaderModules.length).toBe(modulesBefore + 1)
  expect(bindGroups.length).toBe(bgBefore + 1)
  expect(lastFxUB()[24]).toBeCloseTo(0.9, 5)

  // Back to 0: one rebuild restores the legacy pipeline, no new module.
  r.look = { ...LOOK, softParticles: 0 }
  r.frame(1 / 60, 4 / 60)
  expect(pipelines.length).toBe(pipesBefore + 2)
  expect(shaderModules.length).toBe(modulesBefore + 1)
  expect(lastFxUB()[24]).toBe(0)
  r.frame(1 / 60, 5 / 60)
  expect(pipelines.length).toBe(pipesBefore + 2)
})

test('FX draws inside the scene pass by default; soft mode adds a read-only depth pass', async () => {
  const { r, passes } = await makeRenderer()
  r.resize(64, 64)
  r.setFX(oneFxSprite(), 1)

  r.frame(1 / 60, 0)
  expect(passes.filter((p) => p.label === 'yura-fx-soft').length).toBe(0)

  r.look = { ...LOOK, softParticles: 0.25 }
  r.frame(1 / 60, 1 / 60)
  const soft = passes.filter((p) => p.label === 'yura-fx-soft')
  expect(soft.length).toBe(1)
  const desc = soft[0] as unknown as {
    colorAttachments: { loadOp?: string; storeOp?: string }[]
    depthStencilAttachment: { depthReadOnly?: boolean; depthLoadOp?: string; depthStoreOp?: string }
  }
  // HDR target is accumulated, not cleared; depth is attached strictly
  // read-only (no load/store ops allowed) so the same texture can be bound
  // as texture_depth_2d for the fade.
  expect(desc.colorAttachments[0]!.loadOp).toBe('load')
  expect(desc.colorAttachments[0]!.storeOp).toBe('store')
  expect(desc.depthStencilAttachment.depthReadOnly).toBe(true)
  expect(desc.depthStencilAttachment.depthLoadOp).toBeUndefined()
  expect(desc.depthStencilAttachment.depthStoreOp).toBeUndefined()

  // The scene pass no longer hosts the FX draw in soft mode; back at 0 the
  // dedicated pass disappears again.
  r.look = { ...LOOK, softParticles: 0 }
  r.frame(1 / 60, 2 / 60)
  expect(passes.filter((p) => p.label === 'yura-fx-soft').length).toBe(1)
})
