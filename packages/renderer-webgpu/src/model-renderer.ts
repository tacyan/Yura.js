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
import { POST_WGSL } from './shaders'
import { ENV_WGSL, BLIT_WGSL, PBR_WGSL, SHADOW_WGSL } from './model-shaders'
import { loadGLB, type GLTFModel } from './gltf'
import type { MeshGeometry } from './meshes'
import type { LookParams } from './renderer'

const ENV_SIZE = 256
const ENV_MIPS = 7
const SHADOW_SIZE = 2048

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

  private frameData = new Float32Array(72)
  private postData = new Float32Array(16)

  private width = 0
  private height = 0
  private disposed = false

  look: LookParams
  colorA: Vec3 = [0.05, 0.3, 0.5]
  colorB: Vec3 = [0.25, 0.1, 0.6]
  envIntensity = 1.0
  /** Half-extent of the shadow-casting area around the origin. */
  shadowArea = 4
  /** Orbit camera state, driven by the app's pointer handlers. */
  yaw = Math.PI + 0.93
  pitch = 0.1
  distance = 3.2
  autoRotate = 0.12
  /** When set, overrides the orbit camera (game follow-cams etc.). */
  cameraPose: { eye: Vec3; target: Vec3 } | null = null
  private yawVel = 0
  private pitchVel = 0
  private idleTime = 10

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
    const postModule = d.createShaderModule({ label: 'yura-model-post', code: POST_WGSL })

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

    const makePost = (entryPoint: string, format: GPUTextureFormat): GPURenderPipeline =>
      d.createRenderPipeline({
        label: `yura-model-${entryPoint}`,
        layout: 'auto',
        vertex: { module: postModule, entryPoint: 'fsVS' },
        fragment: { module: postModule, entryPoint, targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      })
    this.brightPipeline = makePost('brightFS', 'rgba16float')
    this.blurPipeline = makePost('blurFS', 'rgba16float')
    this.compositePipeline = makePost('compositeFS', this.format)

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
      d.createBuffer({ label, size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.frameUB = uniform('yura-frame-ub', 288)
    this.shadowUB = uniform('yura-shadow-ub', 64)
    this.brightUB = uniform('yura-mbright-ub', 64)
    this.blurHUB = uniform('yura-mblurh-ub', 64)
    this.blurVUB = uniform('yura-mblurv-ub', 64)
    this.streak1UB = uniform('yura-mstreak1-ub', 64)
    this.streak2UB = uniform('yura-mstreak2-ub', 64)
    this.compositeUB = uniform('yura-mcomposite-ub', 64)
  }

  /** Render the procedural studio HDRI into a mipped cubemap, once. */
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
      const ub = d.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
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
  addMesh(geo: MeshGeometry, mat: SceneMaterial): MeshHandle {
    const d = this.device
    const upload = (data: Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>, usage: number): GPUBuffer => {
      const buf = d.createBuffer({ size: Math.ceil(data.byteLength / 4) * 4, usage: usage | GPUBufferUsage.COPY_DST })
      d.queue.writeBuffer(buf, 0, data)
      return buf
    }
    const unlit = mat.unlit === true
    const pipeline = unlit ? this.unlitPipeline : this.pbrPipeline

    const matUB = d.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const matData = new Float32Array(12)
    matData.set(mat.color, 0)
    matData[4] = mat.metallic
    matData[5] = mat.roughness
    matData[6] = 0
    matData[7] = mat.fade ? 1 : 0
    matData[8] = mat.emissive[0]
    matData[9] = mat.emissive[1]
    matData[10] = mat.emissive[2]
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

    const objectUB = d.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
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
      shadowBG: unlit
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
        mesh.positions.destroy()
        mesh.normals.destroy()
        mesh.uvs.destroy()
        mesh.indices.destroy()
        mesh.objectUB.destroy()
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
      const ub = d.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
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
      const buf = d.createBuffer({ size: Math.ceil(data.byteLength / 4) * 4, usage: usage | GPUBufferUsage.COPY_DST })
      d.queue.writeBuffer(buf, 0, data)
      return buf
    }

    this.primitives = model.primitives.map((p) => {
      const world = multiply(fit, p.world)
      const ub = d.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
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
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
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

    const hdrView = this.hdrTex.createView()
    const bloomAView = this.bloomA.createView()
    const bloomBView = this.bloomB.createView()
    const bloomCView = this.bloomC.createView()

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
    this.compositeBG = d.createBindGroup({
      layout: this.compositePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.postSampler },
        { binding: 1, resource: hdrView },
        { binding: 2, resource: { buffer: this.compositeUB } },
        { binding: 3, resource: bloomAView },
        { binding: 4, resource: bloomCView },
      ],
    })
  }

  rotateBy(dx: number, dy: number): void {
    this.yawVel = dx
    this.pitchVel = dy
    this.idleTime = 0
  }

  zoomBy(factor: number): void {
    this.distance = Math.min(Math.max(this.distance * factor, 1.6), 7)
    this.idleTime = 0
  }

  frame(dt: number, time: number): void {
    if (this.disposed || !this.hdrTex || !this.depthTex || !this.frameBG) return
    if (this.primitives.length === 0 && this.dynMeshes.length === 0) return
    const d = this.device

    let target: Vec3 = [0, 0, 0]
    if (this.cameraPose) {
      this.eye = this.cameraPose.eye
      target = this.cameraPose.target
    } else {
      // Orbit camera: drag velocity with inertia, auto-rotate after idle.
      this.idleTime += dt
      this.yaw += this.yawVel * dt
      this.pitch += this.pitchVel * dt
      this.yawVel *= Math.exp(-dt * 4)
      this.pitchVel *= Math.exp(-dt * 4)
      if (this.idleTime > 2.5) {
        this.yaw += this.autoRotate * dt * Math.min((this.idleTime - 2.5) / 2, 1)
      }
      this.pitch = Math.min(Math.max(this.pitch, -1.25), 1.25)
      const cp = Math.cos(this.pitch)
      this.eye = [
        Math.sin(this.yaw) * cp * this.distance,
        Math.sin(this.pitch) * this.distance,
        Math.cos(this.yaw) * cp * this.distance,
      ]
    }

    const aspect = this.width / this.height
    const proj = perspective((45 * Math.PI) / 180, aspect, 0.05, 200)
    const view = lookAt(this.eye, target, [0, 1, 0])
    const viewProj = multiply(proj, view)
    const invVP = invert(viewProj) ?? identity()

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
    const a = this.shadowArea
    const lightDir: Vec3 = [-0.5, 0.5, -0.65]
    const ll = Math.hypot(...lightDir)
    const lightEye: Vec3 = [
      (lightDir[0] / ll) * a * 2.4,
      (lightDir[1] / ll) * a * 2.4,
      (lightDir[2] / ll) * a * 2.4,
    ]
    const lightVP = multiply(
      ortho(-a, a, -a, a, 0.1, a * 6),
      lookAt(lightEye, [0, 0, 0], [0, 1, 0]),
    )
    this.frameData.set(lightVP, 56)
    d.queue.writeBuffer(this.frameUB, 0, this.frameData)
    d.queue.writeBuffer(this.shadowUB, 0, lightVP)

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
        view: this.shadowTex.createView(),
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
        view: this.hdrTex.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.depthTex.createView(),
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
    scene.end()

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
    fullscreen('yura-mbright', this.brightPipeline, this.brightBG, this.bloomA!.createView())
    fullscreen('yura-mblur-h', this.blurPipeline, this.blurHBG, this.bloomB!.createView())
    fullscreen('yura-mblur-v', this.blurPipeline, this.blurVBG, this.bloomA!.createView())
    fullscreen('yura-mstreak-1', this.blurPipeline, this.streak1BG, this.bloomB!.createView())
    fullscreen('yura-mstreak-2', this.blurPipeline, this.streak2BG, this.bloomC!.createView())
    fullscreen('yura-mcomposite', this.compositePipeline, this.compositeBG, this.context.getCurrentTexture().createView())

    d.queue.submit([enc.finish()])
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
    for (const t of this.textureCache.values()) t.destroy()
    this.context.unconfigure()
    this.device.destroy()
  }
}
