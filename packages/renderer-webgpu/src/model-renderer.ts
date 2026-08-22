import {
  perspective,
  ortho,
  lookAt,
  multiply,
  invert,
  identity,
  CODES,
  warnCode,
  type Vec3,
} from '@yura/core'
import { buildPostWgsl } from './shaders'
import { gpuBlendState, resolveBlendMode, resolveToneMapping, type BlendMode, type ToneMapping } from './blend'
import { ViewCache } from './view-cache'
import { ENV_WGSL, BLIT_WGSL, PBR_WGSL, SHADOW_WGSL, FX_WGSL, FX_SOFT_WGSL } from './model-shaders'
import { loadGLB, type GLTFModel } from './gltf'
import type { MeshGeometry } from './meshes'
import type { LookParams } from './renderer'

const ENV_SIZE = 256
const ENV_MIPS = 7
const SHADOW_SIZE = 2048

/** Camera frustum planes; also feed the soft-particle depth linearization. */
const MODEL_CAMERA_NEAR = 0.05
const MODEL_CAMERA_FAR = 200

/**
 * Default soft-particle fade distance (world units) for scene-mode FX
 * sprites. 0 = off: the FX path stays bit-identical to the legacy shader
 * and pipeline (same discipline as DEFAULT_TURBULENCE in shaders.ts).
 */
export const DEFAULT_SOFT_PARTICLES = 0

/** FX frame uniform floats: viewProj (16) + right (4) + up (4) + soft params (4). */
const FX_FRAME_FLOATS = 28

/** Direction of the key light (matches the analytic light fed to the PBR shader). */
const MODEL_LIGHT_DIR: Vec3 = [-0.5, 0.5, -0.65]

let lightVPMemo: { area: number; dir: Vec3; matrix: Float32Array<ArrayBuffer> } | null = null

/**
 * Light view-projection matrix for the key-light shadow camera: an
 * orthographic box of half-extent `shadowArea` looking down `lightDir`.
 *
 * Pure and memoized — identical inputs return the exact same Float32Array
 * instance, so the steady state (light and area unchanged) allocates
 * nothing. Callers must treat the returned matrix as immutable.
 */
export function computeLightViewProj(shadowArea: number, lightDir: Vec3): Float32Array<ArrayBuffer> {
  const memo = lightVPMemo
  if (
    memo !== null &&
    memo.area === shadowArea &&
    memo.dir[0] === lightDir[0] &&
    memo.dir[1] === lightDir[1] &&
    memo.dir[2] === lightDir[2]
  ) {
    return memo.matrix
  }
  const a = shadowArea
  const ll = Math.hypot(lightDir[0], lightDir[1], lightDir[2])
  const lightEye: Vec3 = [
    (lightDir[0] / ll) * a * 2.4,
    (lightDir[1] / ll) * a * 2.4,
    (lightDir[2] / ll) * a * 2.4,
  ]
  const matrix = multiply(
    ortho(-a, a, -a, a, 0.1, a * 6),
    lookAt(lightEye, [0, 0, 0], [0, 1, 0]),
  )
  lightVPMemo = { area: a, dir: [lightDir[0], lightDir[1], lightDir[2]], matrix }
  return matrix
}
/** Boot framing for the orbit camera — a stylish three-quarter view. */
const ModelHome: { yaw: number; pitch: number; distance: number } = {
  yaw: Math.PI + 0.93,
  pitch: 0.1,
  distance: 3.2,
}
/** Double-click target: the model's FRONT (glTF forward faces yaw 0). */
const ModelFront: { yaw: number; pitch: number; distance: number } = {
  yaw: 0,
  pitch: 0.08,
  distance: 3.2,
}

interface GpuPrimitive {
  positions: GPUBuffer
  normals: GPUBuffer
  uvs: GPUBuffer
  indices: GPUBuffer
  indexCount: number
  materialBG: GPUBindGroup
  objectBG: GPUBindGroup
  shadowBG: GPUBindGroup
}

/** Parametric material for procedural meshes — no image assets required. */
export interface SceneMaterial {
  /** Linear-space base color + alpha. */
  color: [number, number, number, number]
  metallic: number
  roughness: number
  /** Linear-space HDR emissive. */
  emissive: [number, number, number]
  /** Procedural pattern multiplied into the base color. */
  pattern?: 'none' | 'checker' | 'grid'
  /** Skip lighting; render translucent (blob shadows, glow discs). */
  unlit?: boolean
  /** With unlit: radial alpha falloff from the UV center. */
  fade?: boolean
  /** Lightless normal-space pastel rainbow with a fresnel sheen. */
  iridescent?: boolean
}

export interface MeshHandle {
  setWorld(world: Float32Array<ArrayBuffer>): void
  remove(): void
}

interface DynMesh {
  positions: GPUBuffer
  normals: GPUBuffer
  uvs: GPUBuffer
  indices: GPUBuffer
  indexCount: number
  objectUB: GPUBuffer
  materialBG: GPUBindGroup
  objectBG: GPUBindGroup
  shadowBG: GPUBindGroup | null
  unlit: boolean
  alive: boolean
}

/**
 * WebGPU glTF/PBR renderer (F-011, spec §7.1): Cook-Torrance GGX direct
 * lighting plus IBL from a procedural studio environment cubemap with a
 * roughness-indexed mip chain. Shares the HDR post look (bloom, streaks,
 * ACES) with the particle renderer.
 */
export class WebGPUModelRenderer {
  onDeviceLost: (() => void) | null = null

  private device: GPUDevice
  private context: GPUCanvasContext
  private canvas: HTMLCanvasElement
  private format: GPUTextureFormat

  private pbrPipeline!: GPURenderPipeline
  private skyPipeline!: GPURenderPipeline
  private unlitPipeline!: GPURenderPipeline
  private shadowPipeline!: GPURenderPipeline
  private brightPipeline!: GPURenderPipeline
  private blurPipeline!: GPURenderPipeline
  private compositePipeline!: GPURenderPipeline
  private fxPipeline!: GPURenderPipeline

  private postModule!: GPUShaderModule
  private fxModule!: GPUShaderModule
  private appliedToneMapping: ToneMapping
  private appliedBlendMode: BlendMode
  /** Caches per-frame texture views; invalidated when render targets are recreated. */
  private readonly viewCache = new ViewCache()

  private envTex!: GPUTexture
  private shadowTex!: GPUTexture
  private envSampler!: GPUSampler
  private matSampler!: GPUSampler
  private postSampler!: GPUSampler
  private shadowSampler!: GPUSampler

  private frameUB!: GPUBuffer
  private shadowUB!: GPUBuffer
  private brightUB!: GPUBuffer
  private blurHUB!: GPUBuffer
  private blurVUB!: GPUBuffer
  private streak1UB!: GPUBuffer
  private streak2UB!: GPUBuffer
  private compositeUB!: GPUBuffer

  private frameBG!: GPUBindGroup
  private skyBG!: GPUBindGroup
  private unlitFrameBG!: GPUBindGroup
  private shadowFrameBG!: GPUBindGroup
  private brightBG!: GPUBindGroup
  private blurHBG!: GPUBindGroup
  private blurVBG!: GPUBindGroup
  private streak1BG!: GPUBindGroup
  private streak2BG!: GPUBindGroup
  private compositeBG!: GPUBindGroup

  private hdrTex: GPUTexture | null = null
  private depthTex: GPUTexture | null = null
  private bloomA: GPUTexture | null = null
  private bloomB: GPUTexture | null = null
  private bloomC: GPUTexture | null = null

  private primitives: GpuPrimitive[] = []
  private dynMeshes: DynMesh[] = []
  private textureCache = new Map<string, GPUTexture>()
  /** Every GPUBuffer this renderer created and has not yet destroyed. */
  private ownedBuffers = new Set<GPUBuffer>()

  private frameData = new Float32Array(72)
  private postData = new Float32Array(16)
  /** Last light view-proj written to shadowUB — skip the upload while unchanged. */
  private lastLightVP: Float32Array | null = null

  private width = 0
  private height = 0
  private disposed = false

  // FX sprite pass: pooled instance buffer, grown on demand.
  private fxUB!: GPUBuffer
  private fxBG!: GPUBindGroup
  private fxBuffer: GPUBuffer | null = null
  private fxCapacity = 0
  private fxData: Float32Array<ArrayBuffer> | null = null
  private fxCount = 0
  private fxFrameData = new Float32Array(FX_FRAME_FLOATS)
  // Soft-particle state: module built lazily on first activation; the flag
  // mirrors look.softParticles > 0 so toggling rebuilds the FX pipeline once.
  private fxSoftModule: GPUShaderModule | null = null
  private appliedFxSoft = false

  look: LookParams
  colorA: Vec3 = [0.05, 0.3, 0.5]
  colorB: Vec3 = [0.25, 0.1, 0.6]
  envIntensity = 1.0
  /** Half-extent of the shadow-casting area around the origin. */
  shadowArea = 4
  /** Orbit camera state, driven by the app's pointer handlers. */
  yaw = ModelHome.yaw
  pitch = ModelHome.pitch
  distance = ModelHome.distance
  autoRotate = 0.12
  /** When set, overrides the orbit camera (game follow-cams etc.). */
  cameraPose: { eye: Vec3; target: Vec3 } | null = null
  private yawVel = 0
  private pitchVel = 0
  private idleTime = 10
  /** Seconds since the last direct drag delta — gates inertia integration. */
  private directAge = 10
  /** Click-to-aim / reset goals — eased in frame(), cancelled by dragging. */
  private goalYaw: number | null = null
  private goalPitch: number | null = null
  private goalDistance: number | null = null
  private targetOffset: [number, number, number] = [0, 0, 0]
  private resetOffset = false

  private eye: Vec3 = [0, 0, 3.2]

  private constructor(
    canvas: HTMLCanvasElement,
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    look: LookParams,
  ) {
    this.canvas = canvas
    this.device = device
    this.context = context
    this.format = format
    this.look = look
    this.appliedToneMapping = resolveToneMapping(look.toneMapping)
    this.appliedBlendMode = resolveBlendMode(look.blendMode)
  }

  static async create(canvas: HTMLCanvasElement, device: GPUDevice, look: LookParams): Promise<WebGPUModelRenderer> {
    const context = canvas.getContext('webgpu')
    if (!context) throw new Error('webgpu canvas context unavailable')
    const format = navigator.gpu.getPreferredCanvasFormat()
    context.configure({ device, format, alphaMode: 'opaque' })
    const r = new WebGPUModelRenderer(canvas, device, context, format, look)
    r.initPipelines()
    r.buildEnvironment()
    r.initFrameBindGroups()
    device.lost.then((info) => {
      if (r.disposed || info.reason === 'destroyed') return
      warnCode(CODES.DEVICE_LOST, `GPU device lost (${info.message}). Attempting recovery.`)
      r.onDeviceLost?.()
    })
    return r
  }

  private initPipelines(): void {
    const d = this.device
    const pbrModule = d.createShaderModule({ label: 'yura-pbr', code: PBR_WGSL })
    this.postModule = d.createShaderModule({
      label: 'yura-model-post',
      code: buildPostWgsl(this.appliedToneMapping),
    })

    this.pbrPipeline = d.createRenderPipeline({
      label: 'yura-pbr',
      layout: 'auto',
      vertex: {
        module: pbrModule,
        entryPoint: 'vs',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
          { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
          { arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
        ],
      },
      fragment: { module: pbrModule, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    })
    this.skyPipeline = d.createRenderPipeline({
      label: 'yura-sky',
      layout: 'auto',
      vertex: { module: pbrModule, entryPoint: 'skyVS' },
      fragment: { module: pbrModule, entryPoint: 'skyFS', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' },
    })

    const shadowModule = d.createShaderModule({ label: 'yura-shadow', code: SHADOW_WGSL })
    this.shadowPipeline = d.createRenderPipeline({
      label: 'yura-shadow',
      layout: 'auto',
      vertex: {
        module: shadowModule,
        entryPoint: 'vs',
        buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: {
        format: 'depth32float',
        depthWriteEnabled: true,
        depthCompare: 'less',
        depthBias: 2,
        depthBiasSlopeScale: 3,
      },
    })
    this.shadowTex = d.createTexture({
      label: 'yura-shadow-map',
      size: { width: SHADOW_SIZE, height: SHADOW_SIZE },
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.shadowSampler = d.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' })

    const premultiplied: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    }
    this.unlitPipeline = d.createRenderPipeline({
      label: 'yura-unlit',
      layout: 'auto',
      vertex: {
        module: pbrModule,
        entryPoint: 'vs',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
          { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
          { arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
        ],
      },
      fragment: {
        module: pbrModule,
        entryPoint: 'unlitFS',
        targets: [{ format: 'rgba16float', blend: premultiplied }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' },
    })

    this.brightPipeline = this.makePostPipeline('brightFS', 'rgba16float')
    this.blurPipeline = this.makePostPipeline('blurFS', 'rgba16float')
    this.buildCompositePipeline()

    this.envSampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' })
    this.matSampler = d.createSampler({
      magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
      addressModeU: 'repeat', addressModeV: 'repeat',
    })
    this.postSampler = d.createSampler({
      magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    })

    const uniform = (label: string, size: number) =>
      this.makeBuffer({ label, size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.frameUB = uniform('yura-frame-ub', 288)
    this.shadowUB = uniform('yura-shadow-ub', 64)
    this.brightUB = uniform('yura-mbright-ub', 64)
    this.blurHUB = uniform('yura-mblurh-ub', 64)
    this.blurVUB = uniform('yura-mblurv-ub', 64)
    this.streak1UB = uniform('yura-mstreak1-ub', 64)
    this.streak2UB = uniform('yura-mstreak2-ub', 64)
    this.compositeUB = uniform('yura-mcomposite-ub', 64)
    this.fxUB = uniform('yura-fx-ub', FX_FRAME_FLOATS * 4)

    // FX sprites: instanced camera-facing quads blended into the HDR target
    // with the look's blend mode (additive by default), depth-tested against
    // the mesh scene without writing depth.
    this.fxModule = d.createShaderModule({ label: 'yura-fx', code: FX_WGSL })
    this.buildFxPipeline()
  }

  private buildFxPipeline(): void {
    // Pipeline selection keeps the default path byte-identical to the legacy
    // descriptor: the soft variant only swaps in the depth-fade module.
    const module = this.appliedFxSoft ? (this.fxSoftModule as GPUShaderModule) : this.fxModule
    this.fxPipeline = this.device.createRenderPipeline({
      label: 'yura-fx',
      layout: 'auto',
      vertex: {
        module,
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
        module,
        entryPoint: 'fs',
        targets: [{ format: 'rgba16float', blend: gpuBlendState(this.appliedBlendMode) }],
      },
      primitive: { topology: 'triangle-strip', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' },
    })
  }

  /** Render the procedural studio HDRI into a mipped cubemap, once. */
  private makePostPipeline(entryPoint: string, format: GPUTextureFormat): GPURenderPipeline {
    return this.device.createRenderPipeline({
      label: `yura-model-${entryPoint}`,
      layout: 'auto',
      vertex: { module: this.postModule, entryPoint: 'fsVS' },
      fragment: { module: this.postModule, entryPoint, targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    })
  }

  private buildCompositePipeline(): void {
    this.compositePipeline = this.makePostPipeline('compositeFS', this.format)
  }

  private rebuildCompositeBG(): void {
    if (!this.hdrTex || !this.bloomA || !this.bloomC) return
    this.compositeBG = this.device.createBindGroup({
      layout: this.compositePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.postSampler },
        { binding: 1, resource: this.viewCache.getView(this.hdrTex) },
        { binding: 2, resource: { buffer: this.compositeUB } },
        { binding: 3, resource: this.viewCache.getView(this.bloomA) },
        { binding: 4, resource: this.viewCache.getView(this.bloomC) },
      ],
    })
  }

  /**
   * Rebuild pipelines only when look.blendMode / look.toneMapping actually
   * changed (same discipline as the particle renderer's syncLookModes).
   */
  private syncLookModes(): void {
    const blend = resolveBlendMode(this.look.blendMode)
    const soft = (this.look.softParticles ?? DEFAULT_SOFT_PARTICLES) > 0
    if (blend !== this.appliedBlendMode || soft !== this.appliedFxSoft) {
      this.appliedBlendMode = blend
      this.appliedFxSoft = soft
      if (soft && !this.fxSoftModule) {
        this.fxSoftModule = this.device.createShaderModule({ label: 'yura-fx-soft', code: FX_SOFT_WGSL })
      }
      this.buildFxPipeline()
      this.rebuildFxBG()
    }
    const tone = resolveToneMapping(this.look.toneMapping)
    if (tone === this.appliedToneMapping) return
    this.appliedToneMapping = tone
    this.postModule = this.device.createShaderModule({
      label: 'yura-model-post',
      code: buildPostWgsl(tone),
    })
    this.buildCompositePipeline()
    this.rebuildCompositeBG()
  }

  private buildEnvironment(): void {
    const d = this.device
    const envModule = d.createShaderModule({ label: 'yura-env', code: ENV_WGSL })
    const blitModule = d.createShaderModule({ label: 'yura-blit', code: BLIT_WGSL })
    const envPipeline = d.createRenderPipeline({
      label: 'yura-env-face',
      layout: 'auto',
      vertex: { module: envModule, entryPoint: 'fsVS' },
      fragment: { module: envModule, entryPoint: 'faceFS', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' },
    })
    const blitPipeline = d.createRenderPipeline({
      label: 'yura-env-blit',
      layout: 'auto',
      vertex: { module: blitModule, entryPoint: 'fsVS' },
      fragment: { module: blitModule, entryPoint: 'blitFS', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' },
    })

    this.envTex = d.createTexture({
      label: 'yura-env-cube',
      size: { width: ENV_SIZE, height: ENV_SIZE, depthOrArrayLayers: 6 },
      format: 'rgba16float',
      mipLevelCount: ENV_MIPS,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    })

    const enc = d.createCommandEncoder({ label: 'yura-env-build' })
    for (let face = 0; face < 6; face++) {
      const ub = this.makeBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      const data = new Float32Array(16)
      data[0] = face
      d.queue.writeBuffer(ub, 0, data)
      const bg = d.createBindGroup({
        layout: envPipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: ub } }],
      })
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: this.envTex.createView({ dimension: '2d', baseMipLevel: 0, mipLevelCount: 1, baseArrayLayer: face, arrayLayerCount: 1 }),
          loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      })
      pass.setPipeline(envPipeline)
      pass.setBindGroup(0, bg)
      pass.draw(3)
      pass.end()
    }
    this.encodeMipChain(enc, blitPipeline, this.envTex, ENV_MIPS, 6)
    d.queue.submit([enc.finish()])
    this.blitPipeline2d = blitPipeline
  }

  private blitPipeline2d!: GPURenderPipeline

  private initFrameBindGroups(): void {
    const d = this.device
    const envView = this.envTex.createView({ dimension: 'cube' })
    this.frameBG = d.createBindGroup({
      layout: this.pbrPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.frameUB } },
        { binding: 1, resource: envView },
        { binding: 2, resource: this.envSampler },
        { binding: 3, resource: this.shadowTex.createView() },
        { binding: 4, resource: this.shadowSampler },
      ],
    })
    this.shadowFrameBG = d.createBindGroup({
      layout: this.shadowPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.shadowUB } }],
    })
    this.skyBG = d.createBindGroup({
      layout: this.skyPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.frameUB } },
        { binding: 1, resource: envView },
        { binding: 2, resource: this.envSampler },
      ],
    })
    this.unlitFrameBG = d.createBindGroup({
      layout: this.unlitPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.frameUB } }],
    })
    this.rebuildFxBG()
  }

  private rebuildFxBG(): void {
    const entries: GPUBindGroupEntry[] = [{ binding: 0, resource: { buffer: this.fxUB } }]
    if (this.appliedFxSoft) {
      // The soft variant samples the scene depth buffer. Before the first
      // resize() there is no depth target yet; resize() rebuilds this BG.
      if (!this.depthTex) return
      entries.push({ binding: 1, resource: this.viewCache.getView(this.depthTex) })
    }
    this.fxBG = this.device.createBindGroup({
      layout: this.fxPipeline.getBindGroupLayout(0),
      entries,
    })
  }

  /** Procedural material patterns: no image assets, still mipped + sRGB. */
  private patternTexture(kind: 'checker' | 'grid'): GPUTexture {
    const key = `pattern:${kind}`
    const cached = this.textureCache.get(key)
    if (cached) return cached
    const size = 512
    const data = new Uint8Array(size * size * 4)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const o = (y * size + x) * 4
        let r: number, g: number, b: number
        if (kind === 'checker') {
          const on = ((x >> 8) + (y >> 8)) % 2 === 0
          r = on ? 210 : 38
          g = on ? 213 : 42
          b = on ? 222 : 56
        } else {
          const line = x % 64 < 2 || y % 64 < 2
          r = line ? 40 : 12
          g = line ? 150 : 14
          b = line ? 200 : 22
        }
        data[o] = r
        data[o + 1] = g
        data[o + 2] = b
        data[o + 3] = 255
      }
    }
    const mips = 10
    const tex = this.device.createTexture({
      size: { width: size, height: size },
      format: 'rgba8unorm-srgb',
      mipLevelCount: mips,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    })
    this.device.queue.writeTexture({ texture: tex }, data, { bytesPerRow: size * 4 }, { width: size, height: size })
    const enc = this.device.createCommandEncoder()
    this.encodeMipChain(enc, this.blitPipeline2d, tex, mips, 1)
    this.device.queue.submit([enc.finish()])
    this.textureCache.set(key, tex)
    return tex
  }

  /** Add a procedural mesh with a parametric PBR (or unlit) material. */
  addMesh(geo: MeshGeometry, mat: SceneMaterial, opts: { shadow?: boolean } = {}): MeshHandle {
    const d = this.device
    const upload = (data: Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>, usage: number): GPUBuffer => {
      const buf = this.makeBuffer({ size: Math.ceil(data.byteLength / 4) * 4, usage: usage | GPUBufferUsage.COPY_DST })
      d.queue.writeBuffer(buf, 0, data)
      return buf
    }
    const unlit = mat.unlit === true
    const pipeline = unlit ? this.unlitPipeline : this.pbrPipeline

    const matUB = this.makeBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const matData = new Float32Array(12)
    matData.set(mat.color, 0)
    matData[4] = mat.metallic
    matData[5] = mat.roughness
    matData[6] = 0
    matData[7] = mat.fade ? 1 : 0
    matData[8] = mat.emissive[0]
    matData[9] = mat.emissive[1]
    matData[10] = mat.emissive[2]
    matData[11] = mat.iridescent ? 1 : 0 // emissive.w — iridescent flag in the PBR shader
    d.queue.writeBuffer(matUB, 0, matData)

    let materialBG: GPUBindGroup
    if (unlit) {
      materialBG = d.createBindGroup({
        layout: pipeline.getBindGroupLayout(1),
        entries: [{ binding: 0, resource: { buffer: matUB } }],
      })
    } else {
      const baseTex = mat.pattern && mat.pattern !== 'none'
        ? this.patternTexture(mat.pattern)
        : this.solidTexture([255, 255, 255, 255], true)
      materialBG = d.createBindGroup({
        layout: pipeline.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: { buffer: matUB } },
          { binding: 1, resource: this.matSampler },
          { binding: 2, resource: baseTex.createView() },
          { binding: 3, resource: this.solidTexture([255, 255, 255, 255], false).createView() },
          { binding: 4, resource: this.solidTexture([128, 128, 255, 255], false).createView() },
          { binding: 5, resource: this.solidTexture([255, 255, 255, 255], true).createView() },
          { binding: 6, resource: this.solidTexture([255, 255, 255, 255], false).createView() },
        ],
      })
    }

    const objectUB = this.makeBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const world = new Float32Array(16)
    world[0] = world[5] = world[10] = world[15] = 1
    d.queue.writeBuffer(objectUB, 0, world)

    const mesh: DynMesh = {
      positions: upload(geo.positions, GPUBufferUsage.VERTEX),
      normals: upload(geo.normals, GPUBufferUsage.VERTEX),
      uvs: upload(geo.uvs, GPUBufferUsage.VERTEX),
      indices: upload(geo.indices, GPUBufferUsage.INDEX),
      indexCount: geo.indices.length,
      objectUB,
      materialBG,
      objectBG: d.createBindGroup({
        layout: pipeline.getBindGroupLayout(2),
        entries: [{ binding: 0, resource: { buffer: objectUB } }],
      }),
      // Only meshes registered with shadow:true cast into the shadow map.
      shadowBG:
        unlit || opts.shadow !== true
          ? null
          : d.createBindGroup({
              layout: this.shadowPipeline.getBindGroupLayout(1),
              entries: [{ binding: 0, resource: { buffer: objectUB } }],
            }),
      unlit,
      alive: true,
    }
    this.dynMeshes.push(mesh)
    return {
      setWorld: (m) => {
        if (mesh.alive) d.queue.writeBuffer(objectUB, 0, m)
      },
      remove: () => {
        if (!mesh.alive) return
        mesh.alive = false
        this.destroyBuffer(mesh.positions)
        this.destroyBuffer(mesh.normals)
        this.destroyBuffer(mesh.uvs)
        this.destroyBuffer(mesh.indices)
        this.destroyBuffer(mesh.objectUB)
        this.destroyBuffer(matUB)
        this.dynMeshes = this.dynMeshes.filter((x) => x !== mesh)
      },
    }
  }

  /** Downsample level m-1 -> m for every layer of a texture. */
  private encodeMipChain(enc: GPUCommandEncoder, pipeline: GPURenderPipeline, tex: GPUTexture, mips: number, layers: number): void {
    const d = this.device
    for (let m = 1; m < mips; m++) {
      for (let layer = 0; layer < layers; layer++) {
        const srcView = tex.createView({ dimension: '2d', baseMipLevel: m - 1, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 })
        const dstView = tex.createView({ dimension: '2d', baseMipLevel: m, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 })
        const bg = d.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.postSampler },
            { binding: 1, resource: srcView },
          ],
        })
        const pass = enc.beginRenderPass({
          colorAttachments: [{ view: dstView, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
        })
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, bg)
        pass.draw(3)
        pass.end()
      }
    }
  }

  private solidTexture(rgba: [number, number, number, number], srgb: boolean): GPUTexture {
    const key = `solid:${rgba.join(',')}:${srgb ? 1 : 0}`
    const cached = this.textureCache.get(key)
    if (cached) return cached
    const tex = this.device.createTexture({
      size: { width: 1, height: 1 },
      format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    this.device.queue.writeTexture({ texture: tex }, new Uint8Array(rgba), { bytesPerRow: 4 }, { width: 1, height: 1 })
    this.textureCache.set(key, tex)
    return tex
  }

  private imageTexture(model: GLTFModel, imageIndex: number, srgb: boolean, fallback: [number, number, number, number]): GPUTexture {
    if (imageIndex < 0 || !model.images[imageIndex]) return this.solidTexture(fallback, srgb)
    const key = `img:${imageIndex}:${srgb ? 1 : 0}`
    const cached = this.textureCache.get(key)
    if (cached) return cached
    const bitmap = model.images[imageIndex]
    const mips = Math.floor(Math.log2(Math.max(bitmap.width, bitmap.height))) + 1
    const tex = this.device.createTexture({
      size: { width: bitmap.width, height: bitmap.height },
      format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm',
      mipLevelCount: mips,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    })
    this.device.queue.copyExternalImageToTexture({ source: bitmap }, { texture: tex }, { width: bitmap.width, height: bitmap.height })
    const enc = this.device.createCommandEncoder()
    this.encodeMipChain(enc, this.blitPipeline2d, tex, mips, 1)
    this.device.queue.submit([enc.finish()])
    this.textureCache.set(key, tex)
    return tex
  }

  async loadModel(url: string): Promise<void> {
    const model = await loadGLB(url)
    const d = this.device

    // Normalize: center the model and scale its bounding radius to ~1.15.
    const cx = (model.min[0] + model.max[0]) / 2
    const cy = (model.min[1] + model.max[1]) / 2
    const cz = (model.min[2] + model.max[2]) / 2
    const r = Math.max(
      Math.hypot(model.max[0] - model.min[0], model.max[1] - model.min[1], model.max[2] - model.min[2]) / 2,
      1e-4,
    )
    const s = 1.15 / r
    const fit = identity()
    fit[0] = fit[5] = fit[10] = s
    fit[12] = -cx * s
    fit[13] = -cy * s
    fit[14] = -cz * s

    const materialBGs: GPUBindGroup[] = model.materials.map((m) => {
      const ub = this.makeBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      const data = new Float32Array(12)
      data.set(m.baseColorFactor, 0)
      data[4] = m.metallicFactor
      data[5] = m.roughnessFactor
      data[6] = m.occlusionImage >= 0 ? 1 : 0
      data[8] = m.emissiveFactor[0]
      data[9] = m.emissiveFactor[1]
      data[10] = m.emissiveFactor[2]
      d.queue.writeBuffer(ub, 0, data)
      return d.createBindGroup({
        layout: this.pbrPipeline.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: { buffer: ub } },
          { binding: 1, resource: this.matSampler },
          { binding: 2, resource: this.imageTexture(model, m.baseColorImage, true, [255, 255, 255, 255]).createView() },
          { binding: 3, resource: this.imageTexture(model, m.mrImage, false, [255, 255, 255, 255]).createView() },
          { binding: 4, resource: this.imageTexture(model, m.normalImage, false, [128, 128, 255, 255]).createView() },
          { binding: 5, resource: this.imageTexture(model, m.emissiveImage, true, [255, 255, 255, 255]).createView() },
          { binding: 6, resource: this.imageTexture(model, m.occlusionImage, false, [255, 255, 255, 255]).createView() },
        ],
      })
    })

    const upload = (data: Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>, usage: number): GPUBuffer => {
      const buf = this.makeBuffer({ size: Math.ceil(data.byteLength / 4) * 4, usage: usage | GPUBufferUsage.COPY_DST })
      d.queue.writeBuffer(buf, 0, data)
      return buf
    }

    this.primitives = model.primitives.map((p) => {
      const world = multiply(fit, p.world)
      const ub = this.makeBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      d.queue.writeBuffer(ub, 0, world)
      return {
        positions: upload(p.positions, GPUBufferUsage.VERTEX),
        normals: upload(p.normals, GPUBufferUsage.VERTEX),
        uvs: upload(p.uvs, GPUBufferUsage.VERTEX),
        indices: upload(p.indices, GPUBufferUsage.INDEX),
        indexCount: p.indices.length,
        materialBG: materialBGs[p.materialIndex],
        objectBG: d.createBindGroup({
          layout: this.pbrPipeline.getBindGroupLayout(2),
          entries: [{ binding: 0, resource: { buffer: ub } }],
        }),
        shadowBG: d.createBindGroup({
          layout: this.shadowPipeline.getBindGroupLayout(1),
          entries: [{ binding: 0, resource: { buffer: ub } }],
        }),
      }
    })

  }

  resize(width: number, height: number): void {
    width = Math.max(1, Math.floor(width))
    height = Math.max(1, Math.floor(height))
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height
    this.canvas.width = width
    this.canvas.height = height

    this.hdrTex?.destroy()
    this.depthTex?.destroy()
    this.bloomA?.destroy()
    this.bloomB?.destroy()
    this.bloomC?.destroy()
    this.viewCache.invalidate()

    const d = this.device
    const tex = (label: string, w: number, h: number, format: GPUTextureFormat) =>
      d.createTexture({
        label,
        size: { width: w, height: h },
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      })
    const hw = Math.max(1, width >> 1)
    const hh = Math.max(1, height >> 1)
    this.hdrTex = tex('yura-mhdr', width, height, 'rgba16float')
    this.bloomA = tex('yura-mbloom-a', hw, hh, 'rgba16float')
    this.bloomB = tex('yura-mbloom-b', hw, hh, 'rgba16float')
    this.bloomC = tex('yura-mbloom-c', hw, hh, 'rgba16float')
    this.depthTex = d.createTexture({
      label: 'yura-mdepth',
      size: { width, height },
      format: 'depth24plus',
      // TEXTURE_BINDING lets the soft-particle FX pass read the scene depth
      // while the same texture is attached read-only for the depth test.
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })

    const writeDir = (buffer: GPUBuffer, dx: number, dy: number) => {
      this.postData.fill(0)
      this.postData[0] = dx
      this.postData[1] = dy
      d.queue.writeBuffer(buffer, 0, this.postData)
    }
    writeDir(this.blurHUB, 1 / hw, 0)
    writeDir(this.blurVUB, 0, 1 / hh)
    writeDir(this.streak1UB, 3.5 / hw, 0)
    writeDir(this.streak2UB, 10 / hw, 0)

    const hdrView = this.viewCache.getView(this.hdrTex)
    const bloomAView = this.viewCache.getView(this.bloomA)
    const bloomBView = this.viewCache.getView(this.bloomB)

    this.brightBG = d.createBindGroup({
      layout: this.brightPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.postSampler },
        { binding: 1, resource: hdrView },
        { binding: 2, resource: { buffer: this.brightUB } },
      ],
    })
    const blurBG = (view: GPUTextureView, buffer: GPUBuffer) =>
      d.createBindGroup({
        layout: this.blurPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.postSampler },
          { binding: 1, resource: view },
          { binding: 2, resource: { buffer } },
        ],
      })
    this.blurHBG = blurBG(bloomAView, this.blurHUB)
    this.blurVBG = blurBG(bloomBView, this.blurVUB)
    this.streak1BG = blurBG(bloomAView, this.streak1UB)
    this.streak2BG = blurBG(bloomBView, this.streak2UB)
    this.rebuildCompositeBG()
    // The soft FX bind group references the recreated depth texture.
    if (this.appliedFxSoft) this.rebuildFxBG()
  }

  /**
   * Direct grab: the delta lands on the camera immediately (1:1 with the
   * cursor), and doubles as the flick velocity released as inertia once
   * pointer events stop (~60Hz event rate assumed).
   */
  rotateBy(dx: number, dy: number): void {
    this.yaw += dx
    this.pitch += dy
    this.yawVel = dx * 60
    this.pitchVel = dy * 60
    this.directAge = 0
    this.goalYaw = null
    this.goalPitch = null
    this.idleTime = 0
  }

  zoomBy(factor: number): void {
    this.distance = Math.min(Math.max(this.distance * factor, 1.6), 7)
    this.goalDistance = null
    this.idleTime = 0
  }

  /** Eased orbit toward an absolute yaw/pitch — click-to-aim. */
  aimTo(yaw: number, pitch: number): void {
    this.goalYaw = yaw
    this.goalPitch = Math.min(Math.max(pitch, -1.25), 1.25)
    this.yawVel = 0
    this.pitchVel = 0
    this.idleTime = 0
  }

  /** Slide the orbit centre in the camera plane (drag-to-pan). */
  panBy(dx: number, dy: number): void {
    // Camera right = (cos yaw, 0, -sin yaw); up ≈ world Y for small pitches.
    const s = this.distance * 0.001
    this.targetOffset[0] += (Math.cos(this.yaw) * dx) * s
    this.targetOffset[2] += (-Math.sin(this.yaw) * dx) * s
    this.targetOffset[1] += dy * s
    const len = Math.hypot(...this.targetOffset)
    if (len > 2) for (let i = 0; i < 3; i++) this.targetOffset[i] *= 2 / len
    this.idleTime = 0
  }

  /** Ease to the model's front framing (double-click), shortest way round. */
  resetView(): void {
    const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
    this.goalYaw = this.yaw - wrap(this.yaw - ModelFront.yaw)
    this.goalPitch = ModelFront.pitch
    this.goalDistance = ModelFront.distance
    this.resetOffset = true
    this.yawVel = 0
    this.pitchVel = 0
    this.idleTime = 0
  }

  /**
   * Uploads camera-facing FX sprite instances for the next frame.
   * `data` holds FX_FLOATS (8) floats per sprite — x, y, z, size, r, g, b,
   * alpha — and only the first `count` sprites are drawn. The array is read
   * during frame(), so callers may reuse one persistent buffer. Pass
   * `count = 0` to clear the effect layer.
   */
  setFX(data: Float32Array<ArrayBuffer>, count: number): void {
    this.fxData = data
    this.fxCount = Math.max(0, Math.min(Math.floor(count), Math.floor(data.length / 8)))
  }

  frame(dt: number, time: number): void {
    if (this.disposed || !this.hdrTex || !this.depthTex || !this.frameBG) return
    if (this.primitives.length === 0 && this.dynMeshes.length === 0 && this.fxCount === 0) return
    this.syncLookModes()
    const d = this.device

    let target: Vec3 = [0, 0, 0]
    if (this.cameraPose) {
      this.eye = this.cameraPose.eye
      target = this.cameraPose.target
    } else {
      // Orbit camera: direct grab while dragging (rotateBy applies deltas
      // 1:1), flick inertia once pointer events stop, auto-rotate after idle.
      this.idleTime += dt
      this.directAge += dt
      if (this.directAge > 0.08) {
        this.yaw += this.yawVel * dt
        this.pitch += this.pitchVel * dt
      }
      this.yawVel *= Math.exp(-dt * 4)
      this.pitchVel *= Math.exp(-dt * 4)
      // Eased goals from click-to-aim / double-click reset.
      const k = 1 - Math.exp(-dt * 6)
      if (this.goalYaw !== null) {
        this.yaw += (this.goalYaw - this.yaw) * k
        if (Math.abs(this.goalYaw - this.yaw) < 0.002) this.goalYaw = null
      }
      if (this.goalPitch !== null) {
        this.pitch += (this.goalPitch - this.pitch) * k
        if (Math.abs(this.goalPitch - this.pitch) < 0.002) this.goalPitch = null
      }
      if (this.goalDistance !== null) {
        this.distance += (this.goalDistance - this.distance) * k
        if (Math.abs(this.goalDistance - this.distance) < 0.01) this.goalDistance = null
      }
      if (this.resetOffset) {
        let live = false
        for (let i = 0; i < 3; i++) {
          this.targetOffset[i] *= 1 - k
          if (Math.abs(this.targetOffset[i]) > 0.005) live = true
        }
        if (!live) {
          this.targetOffset = [0, 0, 0]
          this.resetOffset = false
        }
      }
      if (this.goalYaw === null && this.goalPitch === null && this.idleTime > 2.5) {
        this.yaw += this.autoRotate * dt * Math.min((this.idleTime - 2.5) / 2, 1)
      }
      this.pitch = Math.min(Math.max(this.pitch, -1.25), 1.25)
      const cp = Math.cos(this.pitch)
      const off = this.targetOffset
      target = [off[0], off[1], off[2]]
      this.eye = [
        off[0] + Math.sin(this.yaw) * cp * this.distance,
        off[1] + Math.sin(this.pitch) * this.distance,
        off[2] + Math.cos(this.yaw) * cp * this.distance,
      ]
    }

    const aspect = this.width / this.height
    const proj = perspective((45 * Math.PI) / 180, aspect, MODEL_CAMERA_NEAR, MODEL_CAMERA_FAR)
    const view = lookAt(this.eye, target, [0, 1, 0])
    const viewProj = multiply(proj, view)
    const invVP = invert(viewProj) ?? identity()

    // FX frame uniforms: viewProj + camera right/up rows for billboarding.
    this.fxFrameData.set(viewProj, 0)
    this.fxFrameData[16] = view[0]
    this.fxFrameData[17] = view[4]
    this.fxFrameData[18] = view[8]
    this.fxFrameData[19] = 0
    this.fxFrameData[20] = view[1]
    this.fxFrameData[21] = view[5]
    this.fxFrameData[22] = view[9]
    this.fxFrameData[23] = 0
    // Soft-particle params (ignored by the legacy shader, which only reads
    // the first 24 floats): fade distance + frustum planes for linearization.
    this.fxFrameData[24] = this.look.softParticles ?? DEFAULT_SOFT_PARTICLES
    this.fxFrameData[25] = MODEL_CAMERA_NEAR
    this.fxFrameData[26] = MODEL_CAMERA_FAR
    this.fxFrameData[27] = 0
    d.queue.writeBuffer(this.fxUB, 0, this.fxFrameData)
    if (this.fxCount > 0 && this.fxData) {
      if (!this.fxBuffer || this.fxCapacity < this.fxCount) {
        if (this.fxBuffer) this.destroyBuffer(this.fxBuffer)
        this.fxCapacity = Math.max(this.fxCount, this.fxCapacity * 2, 256)
        this.fxBuffer = this.makeBuffer({
          label: 'yura-fx-instances',
          size: this.fxCapacity * 32,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        })
      }
      d.queue.writeBuffer(this.fxBuffer, 0, this.fxData, 0, this.fxCount * 8)
    }

    this.frameData.set(viewProj, 0)
    this.frameData.set(invVP, 16)
    this.frameData[32] = this.eye[0]
    this.frameData[33] = this.eye[1]
    this.frameData[34] = this.eye[2]
    this.frameData[35] = time
    // Key + rim analytic lights matched to the environment softboxes.
    this.frameData.set([-0.5, 0.5, -0.65, 2.2], 36)
    this.frameData.set([1.0, 0.93, 0.85, 0], 40)
    this.frameData.set([0.7, 0.25, 0.65, 1.1], 44)
    this.frameData.set([0.5, 0.7, 1.0, 0], 48)
    this.frameData[52] = this.envIntensity
    this.frameData[53] = ENV_MIPS - 1
    this.frameData[54] = 2.6 // sky blur lod
    this.frameData[55] = 0.32 // sky dim

    // Key-light shadow camera: orthographic box over the play area.
    // Memoized — same instance comes back until the light or area moves,
    // so the shadow UBO upload can be skipped by identity comparison.
    const lightVP = computeLightViewProj(this.shadowArea, MODEL_LIGHT_DIR)
    this.frameData.set(lightVP, 56)
    d.queue.writeBuffer(this.frameUB, 0, this.frameData)
    if (this.lastLightVP !== lightVP) {
      this.lastLightVP = lightVP
      d.queue.writeBuffer(this.shadowUB, 0, lightVP)
    }

    this.postData.fill(0)
    this.postData[0] = this.look.bloomThreshold
    d.queue.writeBuffer(this.brightUB, 0, this.postData)
    this.postData.fill(0)
    this.postData[0] = this.look.bloomStrength
    this.postData[1] = this.look.exposure
    this.postData[2] = this.look.vignette
    this.postData[3] = this.look.grain
    this.postData[4] = time
    this.postData[5] = this.look.aberration
    this.postData[6] = this.look.streak
    this.postData[7] = this.look.nebula
    this.postData[8] = this.colorA[0]
    this.postData[9] = this.colorA[1]
    this.postData[10] = this.colorA[2]
    this.postData[11] = this.look.stars
    this.postData[12] = this.colorB[0]
    this.postData[13] = this.colorB[1]
    this.postData[14] = this.colorB[2]
    this.postData[15] = aspect
    d.queue.writeBuffer(this.compositeUB, 0, this.postData)

    const enc = d.createCommandEncoder({ label: 'yura-model-frame' })

    // Depth-only shadow pass from the key light.
    const shadow = enc.beginRenderPass({
      label: 'yura-shadow',
      colorAttachments: [],
      depthStencilAttachment: {
        view: this.viewCache.getView(this.shadowTex),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    })
    shadow.setPipeline(this.shadowPipeline)
    shadow.setBindGroup(0, this.shadowFrameBG)
    for (const p of this.primitives) {
      shadow.setBindGroup(1, p.shadowBG)
      shadow.setVertexBuffer(0, p.positions)
      shadow.setIndexBuffer(p.indices, 'uint32')
      shadow.drawIndexed(p.indexCount)
    }
    for (const m of this.dynMeshes) {
      if (!m.alive || !m.shadowBG) continue
      shadow.setBindGroup(1, m.shadowBG)
      shadow.setVertexBuffer(0, m.positions)
      shadow.setIndexBuffer(m.indices, 'uint32')
      shadow.drawIndexed(m.indexCount)
    }
    shadow.end()

    const scene = enc.beginRenderPass({
      label: 'yura-model-scene',
      colorAttachments: [{
        view: this.viewCache.getView(this.hdrTex),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.viewCache.getView(this.depthTex),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    })
    scene.setPipeline(this.skyPipeline)
    scene.setBindGroup(0, this.skyBG)
    scene.draw(3)
    scene.setPipeline(this.pbrPipeline)
    scene.setBindGroup(0, this.frameBG)
    for (const p of this.primitives) {
      scene.setBindGroup(1, p.materialBG)
      scene.setBindGroup(2, p.objectBG)
      scene.setVertexBuffer(0, p.positions)
      scene.setVertexBuffer(1, p.normals)
      scene.setVertexBuffer(2, p.uvs)
      scene.setIndexBuffer(p.indices, 'uint32')
      scene.drawIndexed(p.indexCount)
    }
    for (const m of this.dynMeshes) {
      if (m.unlit || !m.alive) continue
      scene.setBindGroup(1, m.materialBG)
      scene.setBindGroup(2, m.objectBG)
      scene.setVertexBuffer(0, m.positions)
      scene.setVertexBuffer(1, m.normals)
      scene.setVertexBuffer(2, m.uvs)
      scene.setIndexBuffer(m.indices, 'uint32')
      scene.drawIndexed(m.indexCount)
    }
    // Translucent unlit pass (blob shadows, glow discs) after opaques.
    let hasUnlit = false
    for (const m of this.dynMeshes) {
      if (m.unlit && m.alive) { hasUnlit = true; break }
    }
    if (hasUnlit) {
      scene.setPipeline(this.unlitPipeline)
      scene.setBindGroup(0, this.unlitFrameBG)
      for (const m of this.dynMeshes) {
        if (!m.unlit || !m.alive) continue
        scene.setBindGroup(1, m.materialBG)
        scene.setBindGroup(2, m.objectBG)
        scene.setVertexBuffer(0, m.positions)
        scene.setVertexBuffer(1, m.normals)
        scene.setVertexBuffer(2, m.uvs)
        scene.setIndexBuffer(m.indices, 'uint32')
        scene.drawIndexed(m.indexCount)
      }
    }
    // FX sprites last: additive on top of opaques + translucents, still
    // occluded by geometry via the depth test. With soft particles enabled
    // the draw moves to its own pass below (unchanged draw order) so the
    // depth buffer can be bound for the fade.
    if (this.fxCount > 0 && this.fxBuffer && !this.appliedFxSoft) {
      scene.setPipeline(this.fxPipeline)
      scene.setBindGroup(0, this.fxBG)
      scene.setVertexBuffer(0, this.fxBuffer)
      scene.draw(4, this.fxCount)
    }
    scene.end()

    if (this.fxCount > 0 && this.fxBuffer && this.appliedFxSoft) {
      // Soft-particle FX pass: same HDR target (loadOp 'load') and the same
      // depth test, but the depth attachment is read-only so the very texture
      // being tested against can legally be bound as texture_depth_2d.
      const fx = enc.beginRenderPass({
        label: 'yura-fx-soft',
        colorAttachments: [{
          view: this.viewCache.getView(this.hdrTex),
          loadOp: 'load',
          storeOp: 'store',
        }],
        depthStencilAttachment: {
          view: this.viewCache.getView(this.depthTex),
          depthReadOnly: true,
        },
      })
      fx.setPipeline(this.fxPipeline)
      fx.setBindGroup(0, this.fxBG)
      fx.setVertexBuffer(0, this.fxBuffer)
      fx.draw(4, this.fxCount)
      fx.end()
    }

    const fullscreen = (label: string, pipeline: GPURenderPipeline, bg: GPUBindGroup, view: GPUTextureView) => {
      const pass = enc.beginRenderPass({
        label,
        colorAttachments: [{ view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bg)
      pass.draw(3)
      pass.end()
    }
    fullscreen('yura-mbright', this.brightPipeline, this.brightBG, this.viewCache.getView(this.bloomA!))
    fullscreen('yura-mblur-h', this.blurPipeline, this.blurHBG, this.viewCache.getView(this.bloomB!))
    fullscreen('yura-mblur-v', this.blurPipeline, this.blurVBG, this.viewCache.getView(this.bloomA!))
    fullscreen('yura-mstreak-1', this.blurPipeline, this.streak1BG, this.viewCache.getView(this.bloomB!))
    fullscreen('yura-mstreak-2', this.blurPipeline, this.streak2BG, this.viewCache.getView(this.bloomC!))
    fullscreen('yura-mcomposite', this.compositePipeline, this.compositeBG, this.context.getCurrentTexture().createView())

    d.queue.submit([enc.finish()])
  }

  /** Create a GPUBuffer registered for destruction on dispose(). */
  private makeBuffer(desc: GPUBufferDescriptor): GPUBuffer {
    const buf = this.device.createBuffer(desc)
    this.ownedBuffers.add(buf)
    return buf
  }

  /** Destroy a tracked buffer now and drop it from the registry. */
  private destroyBuffer(buf: GPUBuffer): void {
    this.ownedBuffers.delete(buf)
    buf.destroy()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.hdrTex?.destroy()
    this.depthTex?.destroy()
    this.bloomA?.destroy()
    this.bloomB?.destroy()
    this.bloomC?.destroy()
    this.envTex?.destroy()
    this.shadowTex?.destroy()
    this.viewCache.invalidate()
    // Every buffer this renderer ever created (frame/shadow/post UBOs, env
    // face UBOs, model primitive + dynamic mesh buffers, fx instances).
    for (const b of this.ownedBuffers) b.destroy()
    this.ownedBuffers.clear()
    this.fxBuffer = null
    for (const t of this.textureCache.values()) t.destroy()
    this.textureCache.clear()
    this.context.unconfigure()
    this.device.destroy()
  }
}
