import { test, expect, spyOn } from 'bun:test'
import { CODES, type Vec3 } from '@yura/core'
import { WebGPUParticleRenderer } from '../src/renderer'
import type { LookParams, MotionParams, BlendMode, ToneMapping } from '../src/renderer'
import { SIM_WGSL, RENDER_WGSL, POST_WGSL, buildPostWgsl } from '../src/shaders'
import { gpuBlendState, resolveBlendMode, resolveToneMapping } from '../src/blend'
import { getZeroScratch } from '../src/view-cache'

// ---------------------------------------------------------------------------
// Fake WebGPU harness (same style as model-renderer.test.ts, self-contained).
// ---------------------------------------------------------------------------

class FakeBuffer {
  destroyed = false
  bytes: Uint8Array
  constructor(public desc: { label?: string; size: number; usage: number }) {
    this.bytes = new Uint8Array(desc.size)
  }
  mapAsync(): Promise<void> {
    return Promise.resolve()
  }
  getMappedRange(): ArrayBuffer {
    return this.bytes.buffer as ArrayBuffer
  }
  destroy(): void {
    this.destroyed = true
  }
}

interface FakeTextureDesc {
  label?: string
  size?: { width: number; height: number }
  format?: string
}

class FakeTexture {
  destroyed = false
  views = 0
  constructor(public desc: FakeTextureDesc) {}
  createView(): object {
    this.views++
    return {}
  }
  destroy(): void {
    this.destroyed = true
  }
}

const PRESENT_FORMAT = 'bgra8unorm'

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
  const gpu = { getPreferredCanvasFormat: () => PRESENT_FORMAT }
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
  vertex?: { entryPoint?: string }
  fragment?: { entryPoint?: string; targets?: { format?: string; blend?: GPUBlendState }[] }
  compute?: { entryPoint?: string }
}

interface RecordedWrite {
  buffer: FakeBuffer
  offset: number
  data: unknown
  dataOffset?: number
  size?: number
}

function makeFakeGPU() {
  const buffers: FakeBuffer[] = []
  const textures: FakeTexture[] = []
  const shaderModules: { label?: string; code: string }[] = []
  const renderPipelines: FakePipelineDesc[] = []
  const computePipelines: FakePipelineDesc[] = []
  const bindGroups: { label?: string; layout: unknown }[] = []
  const writes: RecordedWrite[] = []
  const draws: number[] = []
  const dispatches: number[] = []
  const renderPassDescs: { label?: string; loadOp?: string }[] = []
  const counters = { submits: 0, swapchainViews: 0 }

  let loseDevice: (info: { reason: string; message: string }) => void = () => {}
  const lost = new Promise<{ reason: string; message: string }>((resolve) => {
    loseDevice = resolve
  })

  const renderPass = {
    setPipeline() {}, setBindGroup() {},
    draw(n: number) { draws.push(n) },
    end() {},
  }
  const computePass = {
    setPipeline() {}, setBindGroup() {},
    dispatchWorkgroups(x: number) { dispatches.push(x) },
    end() {},
  }
  const device = {
    destroyed: false,
    createShaderModule: (desc: { label?: string; code: string }) => {
      shaderModules.push(desc)
      return {}
    },
    createRenderPipeline: (desc: FakePipelineDesc) => {
      renderPipelines.push(desc)
      return { getBindGroupLayout: () => ({}) }
    },
    createComputePipeline: (desc: FakePipelineDesc) => {
      computePipelines.push(desc)
      return { getBindGroupLayout: () => ({}) }
    },
    createTexture: (desc: FakeTextureDesc) => {
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
    createBindGroup: (desc: { label?: string; layout: unknown }) => {
      bindGroups.push(desc)
      return {}
    },
    createCommandEncoder: () => ({
      beginComputePass: () => computePass,
      beginRenderPass: (desc: { label?: string; colorAttachments?: { loadOp?: string }[] }) => {
        renderPassDescs.push({ label: desc.label, loadOp: desc.colorAttachments?.[0]?.loadOp })
        return renderPass
      },
      copyBufferToBuffer(src: FakeBuffer, srcOffset: number, dst: FakeBuffer, dstOffset: number, size: number) {
        dst.bytes.set(src.bytes.subarray(srcOffset, srcOffset + size), dstOffset)
      },
      finish: () => ({}),
    }),
    queue: {
      writeBuffer(buffer: FakeBuffer, offset: number, data: unknown, dataOffset?: number, size?: number) {
        writes.push({ buffer, offset, data, dataOffset, size })
        let src: Uint8Array
        if (ArrayBuffer.isView(data)) {
          // dataOffset/size are in elements for typed-array sources.
          const elem = (data as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1
          const start = (dataOffset ?? 0) * elem
          const len = size !== undefined ? size * elem : data.byteLength - start
          src = new Uint8Array(data.buffer, data.byteOffset + start, len)
        } else {
          const ab = data as ArrayBuffer
          const start = dataOffset ?? 0
          src = new Uint8Array(ab, start, size !== undefined ? size : ab.byteLength - start)
        }
        buffer.bytes.set(src, offset)
      },
      submit() { counters.submits++ },
    },
    lost,
    destroy() {
      this.destroyed = true
    },
  }
  const context = {
    unconfigured: false,
    configured: null as unknown,
    configure(desc: unknown) { this.configured = desc },
    unconfigure() {
      this.unconfigured = true
    },
    getCurrentTexture: () => ({
      createView: () => {
        counters.swapchainViews++
        return {}
      },
    }),
  }
  const canvas = {
    width: 0,
    height: 0,
    getContext: (kind: string) => (kind === 'webgpu' ? context : null),
  }
  return {
    device, context, canvas, buffers, textures, shaderModules,
    renderPipelines, computePipelines, bindGroups, writes,
    draws, dispatches, renderPassDescs, counters, loseDevice,
  }
}

// ---------------------------------------------------------------------------
// WGSL uniform-struct sizing, derived from the exported shader sources so the
// expected buffer sizes are never hardcoded independently of the shaders.
// ---------------------------------------------------------------------------

const WGSL_LAYOUT: Record<string, { size: number; align: number }> = {
  f32: { size: 4, align: 4 },
  i32: { size: 4, align: 4 },
  u32: { size: 4, align: 4 },
  'vec2<f32>': { size: 8, align: 8 },
  'vec3<f32>': { size: 12, align: 16 },
  'vec4<f32>': { size: 16, align: 16 },
  'mat4x4<f32>': { size: 64, align: 16 },
}

function wgslStructSize(wgsl: string, structName: string): number {
  const body = wgsl.match(new RegExp(`struct\\s+${structName}\\s*\\{([\\s\\S]*?)\\}`))?.[1]
  if (!body) throw new Error(`struct ${structName} not found in shader source`)
  let offset = 0
  let structAlign = 1
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim()
    const m = line.match(/^\w+\s*:\s*([\w<>]+)\s*,?$/)
    if (!m) continue
    const layout = WGSL_LAYOUT[m[1]!]
    if (!layout) throw new Error(`unhandled WGSL member type: ${m[1]}`)
    offset = Math.ceil(offset / layout.align) * layout.align + layout.size
    structAlign = Math.max(structAlign, layout.align)
  }
  return Math.ceil(offset / structAlign) * structAlign
}

/** Compute workgroup size, parsed from the exported sim shader (not hardcoded). */
function simWorkgroupSize(): number {
  const wg = Number(SIM_WGSL.match(/@workgroup_size\((\d+)\)/)?.[1])
  if (!Number.isFinite(wg) || wg <= 0) throw new Error('no @workgroup_size in SIM_WGSL')
  return wg
}

// ---------------------------------------------------------------------------
// Renderer fixtures
// ---------------------------------------------------------------------------

const LOOK: LookParams = {
  exposure: 1, bloomStrength: 0.5, bloomThreshold: 1, vignette: 0, grain: 0,
  background: [0, 0, 0], particleSize: 1, intensity: 1, hot: [1, 1, 1],
  twinkle: 0, trail: 0, aberration: 0, streak: 0, nebula: 0, stars: 0,
}

const MOTION: MotionParams = {
  attraction: 1, damping: 0.9, noiseScale: 1, noiseStrength: 1,
  swirl: 0.5, maxSpeed: 10, speedColorMix: 0.2,
}

async function makeRenderer(count = 64) {
  const env = makeFakeGPU()
  const r = await WebGPUParticleRenderer.create(
    env.canvas as unknown as HTMLCanvasElement,
    env.device as unknown as GPUDevice,
    {
      count,
      look: { ...LOOK },
      motion: { ...MOTION },
      colorA: [1, 0.5, 0.2],
      colorB: [0.2, 0.5, 1],
    },
  )
  return { ...env, r }
}

function bufByLabel(buffers: FakeBuffer[], label: string): FakeBuffer {
  const b = buffers.find((x) => x.desc.label === label)
  if (!b) throw new Error(`buffer ${label} not created`)
  return b
}

/** A blend/tone mode guaranteed to differ from the resolved default. */
const NON_DEFAULT_BLEND: BlendMode = resolveBlendMode(undefined) === 'screen' ? 'additive' : 'screen'
const NON_DEFAULT_TONE: ToneMapping = resolveToneMapping(undefined) === 'reinhard' ? 'linear' : 'reinhard'

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

test('create() builds each pipeline and buffer exactly once, sizes derived from WGSL', async () => {
  const count = 64
  const { context, device, buffers, shaderModules, renderPipelines, computePipelines } =
    await makeRenderer(count)

  // Canvas context is configured against the fake device and preferred format.
  expect(context.configured).toMatchObject({ device, format: PRESENT_FORMAT })

  // Shader modules: sim + render + post, compiled from the exported sources.
  expect(shaderModules.map((m) => m.label)).toEqual(['yura-sim', 'yura-render', 'yura-post'])
  expect(shaderModules[0]!.code).toBe(SIM_WGSL)
  expect(shaderModules[1]!.code).toBe(RENDER_WGSL)
  expect(shaderModules[2]!.code).toBe(POST_WGSL) // default tone mapping = historic post shader

  // Pipelines: 1 compute + 5 render, each built exactly once.
  expect(computePipelines.map((p) => p.label)).toEqual(['yura-sim'])
  expect(computePipelines[0]!.compute?.entryPoint).toBe('sim')
  expect(renderPipelines.map((p) => p.label)).toEqual([
    'yura-particles', 'yura-fade', 'yura-brightFS', 'yura-blurFS', 'yura-compositeFS',
  ])
  const particles = renderPipelines[0]!
  expect(particles.fragment?.targets?.[0]?.format).toBe('rgba16float')
  expect(particles.fragment?.targets?.[0]?.blend).toEqual(gpuBlendState(resolveBlendMode(undefined)))
  expect(renderPipelines[4]!.fragment?.targets?.[0]?.format).toBe(PRESENT_FORMAT)

  // Buffers: 4 particle storage buffers + 9 uniform buffers, nothing else.
  expect(buffers.length).toBe(13)
  const storage = buffers.filter((b) => b.desc.usage & GPUBufferUsage.STORAGE)
  const uniforms = buffers.filter((b) => b.desc.usage & GPUBufferUsage.UNIFORM)
  expect(storage.map((b) => b.desc.label)).toEqual([
    'yura-positions', 'yura-velocities', 'yura-targetA', 'yura-targetB',
  ])
  expect(uniforms.length).toBe(9)

  // Storage size: one vec4<f32> per particle.
  const vec4Bytes = WGSL_LAYOUT['vec4<f32>']!.size
  for (const b of storage) expect(b.desc.size).toBe(count * vec4Bytes)

  // Uniform sizes follow the WGSL uniform structs they feed.
  const simSize = wgslStructSize(SIM_WGSL, 'SimParams')
  const renderSize = wgslStructSize(RENDER_WGSL, 'RenderParams')
  const postSize = wgslStructSize(POST_WGSL, 'PostParams')
  expect(bufByLabel(buffers, 'yura-sim-ub').desc.size).toBe(simSize)
  expect(bufByLabel(buffers, 'yura-render-ub').desc.size).toBe(renderSize)
  for (const label of [
    'yura-fade-ub', 'yura-bright-ub', 'yura-blurh-ub', 'yura-blurv-ub',
    'yura-streak1-ub', 'yura-streak2-ub', 'yura-composite-ub',
  ]) {
    expect(bufByLabel(buffers, label).desc.size).toBe(postSize)
  }

  // The sim UB is the turbulence-extended 80-byte layout (18 scalars, 16-byte
  // aligned) — the turbulence members are what grew it past the legacy 64.
  expect(SIM_WGSL).toContain('turbulence: f32')
  expect(SIM_WGSL).toContain('turbulenceScale: f32')
  expect(simSize).toBe(80)
})

// ---------------------------------------------------------------------------
// writePositions zero-scratch reuse
// ---------------------------------------------------------------------------

test('writePositions clears velocities from one shared zero scratch (same instance)', async () => {
  const { r, buffers, writes } = await makeRenderer(64)
  const posBuf = bufByLabel(buffers, 'yura-positions')
  const velBuf = bufByLabel(buffers, 'yura-velocities')
  const floats = r.count * 4

  // Pre-grow so the instance the renderer must reuse is pinned down.
  const scratch = getZeroScratch(floats)
  const baseline = writes.length

  const a = new Float32Array(floats).fill(1)
  const b = new Float32Array(floats).fill(2)
  r.writePositions(a)
  r.writePositions(b)

  const posWrites = writes.slice(baseline).filter((w) => w.buffer === posBuf)
  const velWrites = writes.slice(baseline).filter((w) => w.buffer === velBuf)
  expect(posWrites.length).toBe(2)
  expect(posWrites[0]!.data).toBe(a)
  expect(posWrites[1]!.data).toBe(b)

  expect(velWrites.length).toBe(2)
  // Same scratch instance on every call — zero per-call allocation.
  expect(velWrites[0]!.data).toBe(scratch)
  expect(velWrites[1]!.data).toBe(scratch)
  expect(getZeroScratch(floats)).toBe(scratch)
  // Only the needed prefix is written even if the scratch is larger.
  for (const w of velWrites) {
    expect(w.offset).toBe(0)
    expect(w.dataOffset).toBe(0)
    expect(w.size).toBe(floats)
  }

  // writeTargetA/B forward the exact data to their buffers.
  r.writeTargetA(a)
  r.writeTargetB(b)
  expect(writes[writes.length - 2]!.buffer).toBe(bufByLabel(buffers, 'yura-targetA'))
  expect(writes[writes.length - 2]!.data).toBe(a)
  expect(writes[writes.length - 1]!.buffer).toBe(bufByLabel(buffers, 'yura-targetB'))
  expect(writes[writes.length - 1]!.data).toBe(b)
})

// ---------------------------------------------------------------------------
// frame(): steady state
// ---------------------------------------------------------------------------

test('frame() before resize is a no-op (no encoder submit)', async () => {
  const { r, counters, draws, dispatches } = await makeRenderer()
  r.frame(1 / 60, 0, r.count)
  expect(counters.submits).toBe(0)
  expect(draws.length).toBe(0)
  expect(dispatches.length).toBe(0)
})

test('steady-state frames: zero offscreen createView and zero pipeline/bindgroup churn', async () => {
  const env = await makeRenderer()
  const { r, textures, shaderModules, renderPipelines, computePipelines, bindGroups, counters } = env
  r.resize(64, 64)
  r.frame(1 / 60, 0, r.count) // warm-up

  const viewsWarm = textures.map((t) => t.views)
  const pipesWarm = renderPipelines.length
  const computeWarm = computePipelines.length
  const modulesWarm = shaderModules.length
  const bgWarm = bindGroups.length
  const swapWarm = counters.swapchainViews
  const submitsWarm = counters.submits

  r.frame(1 / 60, 1 / 60, r.count)
  r.frame(1 / 60, 2 / 60, r.count)

  // ViewCache: no offscreen texture view is created again.
  expect(textures.map((t) => t.views)).toEqual(viewsWarm)
  // No pipeline / shader / bind group is rebuilt.
  expect(renderPipelines.length).toBe(pipesWarm)
  expect(computePipelines.length).toBe(computeWarm)
  expect(shaderModules.length).toBe(modulesWarm)
  expect(bindGroups.length).toBe(bgWarm)
  // Only the per-frame swapchain view and one submit per frame remain.
  expect(counters.swapchainViews).toBe(swapWarm + 2)
  expect(counters.submits).toBe(submitsWarm + 2)
})

test('frame() clamps activeCount and dispatches by the WGSL workgroup size', async () => {
  const count = 300
  const { r, draws, dispatches } = await makeRenderer(count)
  const wg = simWorkgroupSize()
  r.resize(64, 64)

  // activeCount above count clamps down to count.
  r.frame(1 / 60, 0, 1000)
  expect(dispatches).toEqual([Math.ceil(count / wg)])
  // Per frame: fade(3), scene(n*6), then 6 fullscreen passes of 3 vertices.
  expect(draws.length).toBe(8)
  expect(draws[0]).toBe(3)
  expect(draws[1]).toBe(count * 6)
  expect(draws.slice(2)).toEqual([3, 3, 3, 3, 3, 3])

  // activeCount 0 clamps up to a single particle.
  r.frame(1 / 60, 1 / 60, 0)
  expect(dispatches).toEqual([Math.ceil(count / wg), 1])
  expect(draws[9]).toBe(6)
})

// ---------------------------------------------------------------------------
// syncLookModes
// ---------------------------------------------------------------------------

test('blendMode switch rebuilds the particle pipeline exactly once', async () => {
  const { r, renderPipelines, shaderModules, bindGroups, textures } = await makeRenderer()
  r.resize(64, 64)
  r.frame(1 / 60, 0, r.count)
  r.frame(1 / 60, 1 / 60, r.count)
  const pipesBefore = renderPipelines.length
  const modulesBefore = shaderModules.length
  const bgBefore = bindGroups.length
  const viewsBefore = textures.map((t) => t.views)

  r.look = { ...LOOK, blendMode: NON_DEFAULT_BLEND }
  r.frame(1 / 60, 2 / 60, r.count)
  expect(renderPipelines.length).toBe(pipesBefore + 1)
  const rebuilt = renderPipelines[renderPipelines.length - 1]!
  expect(rebuilt.label).toBe('yura-particles')
  expect(rebuilt.fragment?.targets?.[0]?.blend).toEqual(gpuBlendState(NON_DEFAULT_BLEND))
  expect(bindGroups.length).toBe(bgBefore + 1) // render bind group follows the new layout
  expect(shaderModules.length).toBe(modulesBefore) // no shader recompilation for blend

  // Exactly once: further frames with the same mode change nothing.
  r.frame(1 / 60, 3 / 60, r.count)
  r.frame(1 / 60, 4 / 60, r.count)
  expect(renderPipelines.length).toBe(pipesBefore + 1)
  expect(bindGroups.length).toBe(bgBefore + 1)
  expect(textures.map((t) => t.views)).toEqual(viewsBefore)

  // Switching back rebuilds once more, restoring the original blend state.
  r.look = { ...LOOK }
  r.frame(1 / 60, 5 / 60, r.count)
  expect(renderPipelines.length).toBe(pipesBefore + 2)
  expect(renderPipelines[renderPipelines.length - 1]!.fragment?.targets?.[0]?.blend).toEqual(
    gpuBlendState(resolveBlendMode(undefined)),
  )
})

test('toneMapping switch recompiles post shader and composite pipeline exactly once', async () => {
  const { r, renderPipelines, shaderModules, bindGroups, textures } = await makeRenderer()
  r.resize(64, 64)
  r.frame(1 / 60, 0, r.count)
  r.frame(1 / 60, 1 / 60, r.count)
  const pipesBefore = renderPipelines.length
  const modulesBefore = shaderModules.length
  const bgBefore = bindGroups.length
  const viewsBefore = textures.map((t) => t.views)

  r.look = { ...LOOK, toneMapping: NON_DEFAULT_TONE }
  r.frame(1 / 60, 2 / 60, r.count)
  expect(shaderModules.length).toBe(modulesBefore + 1)
  const post = shaderModules[shaderModules.length - 1]!
  expect(post.label).toBe('yura-post')
  expect(post.code).toBe(buildPostWgsl(NON_DEFAULT_TONE))
  expect(renderPipelines.length).toBe(pipesBefore + 1)
  expect(renderPipelines[renderPipelines.length - 1]!.label).toBe('yura-compositeFS')
  expect(bindGroups.length).toBe(bgBefore + 1) // composite bind group rebuilt
  // The composite BG reuses cached views — the switch creates no new texture views.
  expect(textures.map((t) => t.views)).toEqual(viewsBefore)

  // Exactly once.
  r.frame(1 / 60, 3 / 60, r.count)
  r.frame(1 / 60, 4 / 60, r.count)
  expect(shaderModules.length).toBe(modulesBefore + 1)
  expect(renderPipelines.length).toBe(pipesBefore + 1)
  expect(bindGroups.length).toBe(bgBefore + 1)
})

// ---------------------------------------------------------------------------
// resize
// ---------------------------------------------------------------------------

test('resize recreates offscreen textures and invalidates the view cache', async () => {
  const { r, canvas, textures, renderPassDescs } = await makeRenderer()
  const half = (v: number) => Math.max(1, Math.floor(v) >> 1)

  expect(textures.length).toBe(0)
  r.resize(64.9, 48.2) // fractional sizes floor
  expect(canvas.width).toBe(64)
  expect(canvas.height).toBe(48)
  expect(textures.map((t) => t.desc.label)).toEqual([
    'yura-hdr', 'yura-bloom-a', 'yura-bloom-b', 'yura-bloom-c',
  ])
  expect(textures[0]!.desc.size).toEqual({ width: 64, height: 48 })
  for (const t of textures.slice(1)) {
    expect(t.desc.size).toEqual({ width: half(64), height: half(48) })
    expect(t.desc.format).toBe('rgba16float')
  }
  // resize itself warms the cache: exactly one view per texture, deduped
  // across all the bind groups that share it.
  expect(textures.map((t) => t.views)).toEqual([1, 1, 1, 1])

  // Same-size resize is a no-op.
  r.resize(64, 48)
  expect(textures.length).toBe(4)
  expect(textures.some((t) => t.destroyed)).toBe(false)

  // First frame clears the accumulation buffer, the next one loads it.
  r.frame(1 / 60, 0, r.count)
  r.frame(1 / 60, 1 / 60, r.count)
  const fadeOps = renderPassDescs.filter((p) => p.label === 'yura-fade').map((p) => p.loadOp)
  expect(fadeOps).toEqual(['clear', 'load'])
  expect(textures.map((t) => t.views)).toEqual([1, 1, 1, 1]) // frames reuse cached views

  // A real resize destroys the old textures and makes fresh ones.
  const firstGen = textures.slice()
  r.resize(32, 32)
  expect(firstGen.every((t) => t.destroyed)).toBe(true)
  expect(textures.length).toBe(8)
  const secondGen = textures.slice(4)
  expect(secondGen[0]!.desc.size).toEqual({ width: 32, height: 32 })
  expect(secondGen[1]!.desc.size).toEqual({ width: half(32), height: half(32) })
  // ViewCache was invalidated: the new generation gets exactly one fresh view each.
  expect(secondGen.map((t) => t.views)).toEqual([1, 1, 1, 1])

  // The scene clear flag is re-armed, and steady state resumes with no new views.
  r.frame(1 / 60, 2 / 60, r.count)
  r.frame(1 / 60, 3 / 60, r.count)
  const fadeOpsAfter = renderPassDescs.filter((p) => p.label === 'yura-fade').map((p) => p.loadOp)
  expect(fadeOpsAfter).toEqual(['clear', 'load', 'clear', 'load'])
  expect(secondGen.map((t) => t.views)).toEqual([1, 1, 1, 1])

  // Degenerate sizes clamp to 1x1 (and half-res floors to 1).
  r.resize(0, -5)
  const thirdGen = textures.slice(8)
  expect(thirdGen[0]!.desc.size).toEqual({ width: 1, height: 1 })
  expect(thirdGen[1]!.desc.size).toEqual({ width: 1, height: 1 })
})

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

test('dispose destroys every GPU resource it created (and is idempotent)', async () => {
  const { r, device, context, buffers, textures, counters } = await makeRenderer()
  r.resize(64, 64)
  r.frame(1 / 60, 0, r.count)

  r.dispose()

  const leakedBuffers = buffers.filter((b) => !b.destroyed)
  expect(leakedBuffers.map((b) => b.desc.label ?? `unlabeled(size=${b.desc.size})`)).toEqual([])
  const leakedTextures = textures.filter((t) => !t.destroyed)
  expect(leakedTextures.map((t) => t.desc.label)).toEqual([])
  expect(context.unconfigured).toBe(true)
  expect(device.destroyed).toBe(true)

  // Idempotent, and a disposed renderer no longer submits frames.
  const submits = counters.submits
  r.dispose()
  r.frame(1 / 60, 1 / 60, r.count)
  expect(counters.submits).toBe(submits)
})

// ---------------------------------------------------------------------------
// pointerToWorld
// ---------------------------------------------------------------------------

test('pointerToWorld is null before any frame, exact under an external camera', async () => {
  const { r } = await makeRenderer()
  r.resize(64, 64)

  // No frame yet: the viewProj matrix is all zeros and cannot be inverted.
  expect(r.pointerToWorld(0, 0)).toBeNull()

  // Identity camera looking down -z from [0,0,5]: the pointer plane passes
  // through the origin, so NDC coordinates map straight onto world x/y.
  const identity = new Float32Array(16)
  identity[0] = identity[5] = identity[10] = identity[15] = 1
  r.externalCamera = {
    viewProj: identity,
    right: [1, 0, 0] as Vec3,
    up: [0, 1, 0] as Vec3,
    eye: [0, 0, 5] as Vec3,
  }
  r.frame(1 / 60, 0, r.count)

  const p = r.pointerToWorld(0.5, -0.25)
  expect(p).not.toBeNull()
  expect(p![0]).toBeCloseTo(0.5, 6)
  expect(p![1]).toBeCloseTo(-0.25, 6)
  expect(p![2]).toBeCloseTo(0, 6)
})

// ---------------------------------------------------------------------------
// Device loss & debug readback
// ---------------------------------------------------------------------------

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0))

test('unexpected device loss warns YURA-050 and fires onDeviceLost; intentional/disposed does not', async () => {
  const infoSpy = spyOn(console, 'info').mockImplementation(() => {})
  try {
    // Unexpected loss: recovery callback + coded warning.
    const a = await makeRenderer()
    let called = 0
    a.r.onDeviceLost = () => {
      called++
    }
    a.loseDevice({ reason: 'unknown', message: 'boom' })
    await flushMicrotasks()
    expect(called).toBe(1)
    const warned = infoSpy.mock.calls.map((args) => String(args[0]))
    expect(warned.some((m) => m.includes(CODES.DEVICE_LOST) && m.includes('boom'))).toBe(true)

    // reason 'destroyed' means we tore the device down on purpose: stay silent.
    const b = await makeRenderer()
    b.r.onDeviceLost = () => {
      throw new Error('must not fire for an intentional destroy')
    }
    b.loseDevice({ reason: 'destroyed', message: '' })
    await flushMicrotasks()

    // A disposed renderer ignores late loss notifications.
    const c = await makeRenderer()
    c.r.onDeviceLost = () => {
      throw new Error('must not fire after dispose')
    }
    c.r.dispose()
    c.loseDevice({ reason: 'unknown', message: 'late' })
    await flushMicrotasks()
  } finally {
    infoSpy.mockRestore()
  }
})

test('debugReadPositions round-trips the requested slice of the positions buffer', async () => {
  const { r, buffers } = await makeRenderer(16)
  const data = Float32Array.from({ length: 16 * 4 }, (_, i) => i)
  r.writePositions(data)

  const out = await r.debugReadPositions(2, 4)
  expect(out.length).toBe(4 * 4)
  expect(Array.from(out)).toEqual(Array.from(data.slice(2 * 4, 6 * 4)))

  // The staging buffer it allocated is destroyed again after the readback.
  const staging = buffers.filter((b) => b.desc.usage & GPUBufferUsage.MAP_READ)
  expect(staging.length).toBe(1)
  expect(staging[0]!.destroyed).toBe(true)
})
