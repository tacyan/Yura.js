import {
  perspective,
  lookAt,
  multiply,
  invert,
  transform4,
  type Vec3,
  CODES,
  warnCode,
} from '@yura/core'
import { SIM_WGSL, RENDER_WGSL, POST_WGSL } from './shaders'

export interface LookParams {
  exposure: number
  bloomStrength: number
  bloomThreshold: number
  vignette: number
  grain: number
  /** Linear-space tint for the procedural nebula (background). */
  background: Vec3
  particleSize: number
  intensity: number
  /** Highlight color fast particles shift toward. Linear RGB. */
  hot: Vec3
  /** 0..1 brightness shimmer per particle. */
  twinkle: number
  /** Trail persistence in seconds (0 disables trails). */
  trail: number
  /** Chromatic aberration amount (~0.002-0.005). */
  aberration: number
  /** Anamorphic horizontal streak strength. */
  streak: number
  /** Procedural nebula background amount. */
  nebula: number
  /** Procedural starfield amount. */
  stars: number
}

export interface MotionParams {
  attraction: number
  damping: number
  noiseScale: number
  noiseStrength: number
  swirl: number
  maxSpeed: number
  speedColorMix: number
}

export interface RendererOptions {
  count: number
  look: LookParams
  motion: MotionParams
  colorA: Vec3
  colorB: Vec3
}

/**
 * External camera override for embedding the swarm inside another engine's
 * scene (e.g. the Three.js adapter). When set, the internal sway camera is
 * bypassed and these matrices drive the frame instead.
 */
export interface ExternalCamera {
  /** Column-major premultiplied projection * view * model, WebGPU [0,1] clip depth. */
  viewProj: Float32Array
  /** Unit billboard right axis in swarm-local space. */
  right: Vec3
  /** Unit billboard up axis in swarm-local space. */
  up: Vec3
  /** Camera position in swarm-local space (pointer-plane math). */
  eye: Vec3
  /** Vertical field of view in radians (WebGL point sizing). */
  fovY?: number
  /** Uniform model scale baked into viewProj (WebGL point sizing). */
  sizeScale?: number
}

const WORKGROUP = 256

/**
 * WebGPU compute-driven particle renderer (F-001, F-003).
 * One storage-buffer simulation pass, a trail-accumulating additive HDR scene
 * pass, and a bloom + anamorphic streak + ACES post chain. No depth buffer —
 * additive blending is order-free.
 */
export class WebGPUParticleRenderer {
  readonly count: number
  onDeviceLost: (() => void) | null = null

  private device: GPUDevice
  private context: GPUCanvasContext
  private canvas: HTMLCanvasElement
  private format: GPUTextureFormat

  private simPipeline!: GPUComputePipeline
  private renderPipeline!: GPURenderPipeline
  private fadePipeline!: GPURenderPipeline
  private brightPipeline!: GPURenderPipeline
  private blurPipeline!: GPURenderPipeline
  private compositePipeline!: GPURenderPipeline

  private positions!: GPUBuffer
  private velocities!: GPUBuffer
  private targetA!: GPUBuffer
  private targetB!: GPUBuffer
  private simUB!: GPUBuffer
  private renderUB!: GPUBuffer
  private fadeUB!: GPUBuffer
  private brightUB!: GPUBuffer
  private blurHUB!: GPUBuffer
  private blurVUB!: GPUBuffer
  private streak1UB!: GPUBuffer
  private streak2UB!: GPUBuffer
  private compositeUB!: GPUBuffer

  private simBG!: GPUBindGroup
  private renderBG!: GPUBindGroup
  private fadeBG!: GPUBindGroup
  private brightBG!: GPUBindGroup
  private blurHBG!: GPUBindGroup
  private blurVBG!: GPUBindGroup
  private streak1BG!: GPUBindGroup
  private streak2BG!: GPUBindGroup
  private compositeBG!: GPUBindGroup

  private hdrTex: GPUTexture | null = null
  private bloomA: GPUTexture | null = null
  private bloomB: GPUTexture | null = null
  private bloomC: GPUTexture | null = null
  private sampler!: GPUSampler

  private simData = new ArrayBuffer(64)
  private simF32 = new Float32Array(this.simData)
  private simU32 = new Uint32Array(this.simData)
  private renderData = new Float32Array(40)
  private postData = new Float32Array(16)

  private width = 0
  private height = 0
  private disposed = false
  private sceneNeedsClear = true

  look: LookParams
  motion: MotionParams
  colorA: Vec3
  colorB: Vec3
  morphT = 0
  /** 0..1 extra turbulence while a morph transition is in flight. */
  morphBoost = 0
  /**
   * Per-particle morph stagger. |value| = spread (0 = uniform, legacy);
   * the sign selects which target buffer's palette coordinate delays each
   * particle (+ = targetB, the destination when morphT rises; - = targetA).
   */
  morphSpread = 0
  /**
   * Text-readability damping, eased per frame by the app. 1 = neutral
   * (multiplies by exactly 1.0 — bit-exact base look); lower values scale
   * particle intensity, bloom strength, and streak strength toward a
   * text-safe level so glyph strokes stay distinct while the morph target
   * is a text shape (additive accumulation would otherwise blow lines out
   * into solid bars under high-bloom looks).
   */
  textDamp = 1
  pointerWorld: Vec3 = [0, 0, 0]
  pointerStrength = 0
  /** Smoothed pointer NDC used for camera parallax. */
  parallax: [number, number] = [0, 0]
  /** When set, replaces the internal sway camera (external engine adapters). */
  externalCamera: ExternalCamera | null = null

  private eye: Vec3 = [0, 3, 26]
  private center: Vec3 = [0, 0, 0]
  private viewProj: Float32Array = new Float32Array(16)

  private constructor(
    canvas: HTMLCanvasElement,
    device: GPUDevice,
    context: GPUCanvasContext,
    format: GPUTextureFormat,
    opts: RendererOptions,
  ) {
    this.canvas = canvas
    this.device = device
    this.context = context
    this.format = format
    this.count = opts.count
    this.look = opts.look
    this.motion = opts.motion
    this.colorA = opts.colorA
    this.colorB = opts.colorB
  }

  static async create(
    canvas: HTMLCanvasElement,
    device: GPUDevice,
    opts: RendererOptions,
  ): Promise<WebGPUParticleRenderer> {
    const context = canvas.getContext('webgpu')
    if (!context) throw new Error('webgpu canvas context unavailable')
    const format = navigator.gpu.getPreferredCanvasFormat()
    context.configure({ device, format, alphaMode: 'opaque' })

    const r = new WebGPUParticleRenderer(canvas, device, context, format, opts)
    r.initPipelines()
    r.initBuffers()
    r.trackDeviceLost()
    return r
  }

  private trackDeviceLost(): void {
    this.device.lost.then((info) => {
      if (this.disposed || info.reason === 'destroyed') return
      warnCode(CODES.DEVICE_LOST, `GPU device lost (${info.message}). Attempting recovery.`)
      this.onDeviceLost?.()
    })
  }

  private initPipelines(): void {
    const d = this.device
    const simModule = d.createShaderModule({ label: 'yura-sim', code: SIM_WGSL })
    const renderModule = d.createShaderModule({ label: 'yura-render', code: RENDER_WGSL })
    const postModule = d.createShaderModule({ label: 'yura-post', code: POST_WGSL })

    this.simPipeline = d.createComputePipeline({
      label: 'yura-sim',
      layout: 'auto',
      compute: { module: simModule, entryPoint: 'sim' },
    })

    const additive: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    }
    this.renderPipeline = d.createRenderPipeline({
      label: 'yura-particles',
      layout: 'auto',
      vertex: { module: renderModule, entryPoint: 'vs' },
      fragment: {
        module: renderModule,
        entryPoint: 'fs',
        targets: [{ format: 'rgba16float', blend: additive }],
      },
      primitive: { topology: 'triangle-list' },
    })

    // Trail decay: dst *= (1 - srcAlpha), src contributes nothing.
    const fadeBlend: GPUBlendState = {
      color: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    }
    this.fadePipeline = d.createRenderPipeline({
      label: 'yura-fade',
      layout: 'auto',
      vertex: { module: postModule, entryPoint: 'fsVS' },
      fragment: {
        module: postModule,
        entryPoint: 'fadeFS',
        targets: [{ format: 'rgba16float', blend: fadeBlend }],
      },
      primitive: { topology: 'triangle-list' },
    })

    const makePost = (entryPoint: string, format: GPUTextureFormat): GPURenderPipeline =>
      d.createRenderPipeline({
        label: `yura-${entryPoint}`,
        layout: 'auto',
        vertex: { module: postModule, entryPoint: 'fsVS' },
        fragment: { module: postModule, entryPoint, targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      })
    this.brightPipeline = makePost('brightFS', 'rgba16float')
    this.blurPipeline = makePost('blurFS', 'rgba16float')
    this.compositePipeline = makePost('compositeFS', this.format)

    this.sampler = d.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })
  }

  private initBuffers(): void {
    const d = this.device
    const n = this.count
    const bytes = n * 16

    const storage = (label: string) =>
      d.createBuffer({
        label,
        size: bytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      })
    this.positions = storage('yura-positions')
    this.velocities = storage('yura-velocities')
    this.targetA = storage('yura-targetA')
    this.targetB = storage('yura-targetB')

    const uniform = (label: string, size: number) =>
      d.createBuffer({ label, size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.simUB = uniform('yura-sim-ub', 64)
    this.renderUB = uniform('yura-render-ub', 160)
    this.fadeUB = uniform('yura-fade-ub', 64)
    this.brightUB = uniform('yura-bright-ub', 64)
    this.blurHUB = uniform('yura-blurh-ub', 64)
    this.blurVUB = uniform('yura-blurv-ub', 64)
    this.streak1UB = uniform('yura-streak1-ub', 64)
    this.streak2UB = uniform('yura-streak2-ub', 64)
    this.compositeUB = uniform('yura-composite-ub', 64)

    // Initial cloud: random shell so the first shape "assembles" on load.
    const init = new Float32Array(n * 4)
    for (let i = 0; i < n; i++) {
      const r = 14 + Math.random() * 8
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      init[i * 4] = r * Math.sin(phi) * Math.cos(theta)
      init[i * 4 + 1] = r * Math.cos(phi)
      init[i * 4 + 2] = r * Math.sin(phi) * Math.sin(theta)
      init[i * 4 + 3] = Math.random()
    }
    d.queue.writeBuffer(this.positions, 0, init)
    d.queue.writeBuffer(this.velocities, 0, new Float32Array(n * 4))

    this.simBG = d.createBindGroup({
      label: 'yura-sim-bg',
      layout: this.simPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.simUB } },
        { binding: 1, resource: { buffer: this.positions } },
        { binding: 2, resource: { buffer: this.velocities } },
        { binding: 3, resource: { buffer: this.targetA } },
        { binding: 4, resource: { buffer: this.targetB } },
      ],
    })
    this.renderBG = d.createBindGroup({
      label: 'yura-render-bg',
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.renderUB } },
        { binding: 1, resource: { buffer: this.positions } },
        { binding: 2, resource: { buffer: this.velocities } },
      ],
    })
    this.fadeBG = d.createBindGroup({
      label: 'yura-fade-bg',
      layout: this.fadePipeline.getBindGroupLayout(0),
      entries: [{ binding: 2, resource: { buffer: this.fadeUB } }],
    })
  }

  /** Read back particle positions (debugging/testing). offset in particles. */
  async debugReadPositions(offset = 0, count = 8): Promise<Float32Array> {
    const bytes = count * 16
    const staging = this.device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    const enc = this.device.createCommandEncoder()
    enc.copyBufferToBuffer(this.positions, offset * 16, staging, 0, bytes)
    this.device.queue.submit([enc.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    const out = new Float32Array(staging.getMappedRange().slice(0))
    staging.destroy()
    return out
  }

  writeTargetA(data: Float32Array<ArrayBuffer>): void {
    this.device.queue.writeBuffer(this.targetA, 0, data)
  }

  writeTargetB(data: Float32Array<ArrayBuffer>): void {
    this.device.queue.writeBuffer(this.targetB, 0, data)
  }

  /**
   * Overwrite live particle positions (pos3 + palette). Used to seed the
   * swarm on or near the first shape so frame one already reads as the
   * finished picture instead of a 10-second fly-in.
   */
  writePositions(data: Float32Array<ArrayBuffer>): void {
    this.device.queue.writeBuffer(this.positions, 0, data)
    this.device.queue.writeBuffer(this.velocities, 0, new Float32Array(data.length))
  }

  resize(width: number, height: number): void {
    width = Math.max(1, Math.floor(width))
    height = Math.max(1, Math.floor(height))
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height
    this.canvas.width = width
    this.canvas.height = height
    this.sceneNeedsClear = true

    this.hdrTex?.destroy()
    this.bloomA?.destroy()
    this.bloomB?.destroy()
    this.bloomC?.destroy()

    const d = this.device
    const tex = (label: string, w: number, h: number) =>
      d.createTexture({
        label,
        size: { width: w, height: h },
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      })
    const hw = Math.max(1, width >> 1)
    const hh = Math.max(1, height >> 1)
    this.hdrTex = tex('yura-hdr', width, height)
    this.bloomA = tex('yura-bloom-a', hw, hh)
    this.bloomB = tex('yura-bloom-b', hw, hh)
    this.bloomC = tex('yura-bloom-c', hw, hh)

    // Blur/streak directions carry texel size, so they refresh on resize.
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
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: hdrView },
        { binding: 2, resource: { buffer: this.brightUB } },
      ],
    })
    const blurBG = (view: GPUTextureView, buffer: GPUBuffer) =>
      d.createBindGroup({
        layout: this.blurPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.sampler },
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
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: hdrView },
        { binding: 2, resource: { buffer: this.compositeUB } },
        { binding: 3, resource: bloomAView },
        { binding: 4, resource: bloomCView },
      ],
    })
  }

  /** Unproject canvas NDC to the world plane through origin facing the camera. */
  pointerToWorld(ndcX: number, ndcY: number): Vec3 | null {
    const inv = invert(this.viewProj)
    if (!inv) return null
    const p0h = transform4(inv, [ndcX, ndcY, 0, 1])
    const p1h = transform4(inv, [ndcX, ndcY, 1, 1])
    const p0: Vec3 = [p0h[0] / p0h[3], p0h[1] / p0h[3], p0h[2] / p0h[3]]
    const p1: Vec3 = [p1h[0] / p1h[3], p1h[1] / p1h[3], p1h[2] / p1h[3]]
    let dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2]
    const dl = Math.hypot(dx, dy, dz) || 1
    dx /= dl; dy /= dl; dz /= dl
    let nx = this.eye[0] - this.center[0]
    let ny = this.eye[1] - this.center[1]
    let nz = this.eye[2] - this.center[2]
    const nl = Math.hypot(nx, ny, nz) || 1
    nx /= nl; ny /= nl; nz /= nl
    const denom = dx * nx + dy * ny + dz * nz
    if (Math.abs(denom) < 1e-6) return null
    const t = -(p0[0] * nx + p0[1] * ny + p0[2] * nz) / denom
    return [p0[0] + dx * t, p0[1] + dy * t, p0[2] + dz * t]
  }

  /** Simulate + render one frame. `activeCount` is the governed particle count. */
  frame(dt: number, time: number, activeCount: number): void {
    if (this.disposed || !this.hdrTex || !this.bloomA || !this.bloomB || !this.bloomC) return
    const d = this.device
    const n = Math.max(1, Math.min(this.count, Math.floor(activeCount)))

    // Camera: external override (engine adapters) or the internal gentle
    // sway + pointer parallax. A full orbit would view flat shapes (text,
    // images) edge-on, so we oscillate instead.
    const aspect = this.width / this.height
    let right: Vec3
    let up: Vec3
    const ext = this.externalCamera
    if (ext) {
      this.eye = ext.eye
      this.viewProj = ext.viewProj
      right = ext.right
      up = ext.up
    } else {
      const angle = Math.sin(time * 0.12) * 0.45
      const radius = 26
      this.eye = [
        Math.sin(angle) * radius + this.parallax[0] * 2.2,
        3 + this.parallax[1] * 1.6,
        Math.cos(angle) * radius,
      ]
      const proj = perspective((50 * Math.PI) / 180, aspect, 0.1, 200)
      const view = lookAt(this.eye, this.center, [0, 1, 0])
      this.viewProj = multiply(proj, view)
      right = [view[0], view[4], view[8]]
      up = [view[1], view[5], view[9]]
    }

    // Sim uniforms.
    this.simF32[0] = dt
    this.simF32[1] = time
    this.simF32[2] = this.morphT
    this.simU32[3] = n
    this.simF32[4] = this.pointerWorld[0]
    this.simF32[5] = this.pointerWorld[1]
    this.simF32[6] = this.pointerWorld[2]
    this.simF32[7] = this.pointerStrength
    this.simF32[8] = this.motion.attraction
    this.simF32[9] = this.motion.damping
    this.simF32[10] = this.motion.noiseScale
    this.simF32[11] = this.motion.noiseStrength
    this.simF32[12] = this.motion.swirl
    this.simF32[13] = this.motion.maxSpeed
    this.simF32[14] = this.morphBoost
    this.simF32[15] = this.morphSpread
    d.queue.writeBuffer(this.simUB, 0, this.simData)

    // Trail decay per frame, framerate-independent. Compensate particle
    // intensity so steady-state accumulation stays in a sane HDR range.
    const trail = Math.max(this.look.trail, 0)
    const fadeAlpha = trail > 0.02 ? 1 - Math.exp(-dt / trail) : 1
    const trailComp = trail > 0.02 ? Math.min(Math.max(fadeAlpha * 1.4, 0.06), 1) : 1
    // When the governor sheds particles, brighten the survivors so the total
    // light on screen stays comparable — otherwise low levels fade to black.
    const countComp = Math.min(Math.pow(this.count / n, 0.7), 4)
    // Text-readability damping (1 = bit-exact neutral, see field docs).
    const damp = Math.min(Math.max(this.textDamp, 0), 1)

    // Render uniforms. Camera right/up derived from the view matrix rows.
    this.renderData.set(this.viewProj, 0)
    this.renderData[16] = right[0]
    this.renderData[17] = right[1]
    this.renderData[18] = right[2]
    this.renderData[19] = this.look.particleSize
    this.renderData[20] = up[0]
    this.renderData[21] = up[1]
    this.renderData[22] = up[2]
    this.renderData[23] = this.look.intensity * trailComp * countComp * damp
    this.renderData[24] = this.colorA[0]
    this.renderData[25] = this.colorA[1]
    this.renderData[26] = this.colorA[2]
    this.renderData[27] = 1
    this.renderData[28] = this.colorB[0]
    this.renderData[29] = this.colorB[1]
    this.renderData[30] = this.colorB[2]
    this.renderData[31] = 1
    this.renderData[32] = this.look.hot[0]
    this.renderData[33] = this.look.hot[1]
    this.renderData[34] = this.look.hot[2]
    this.renderData[35] = this.look.twinkle
    this.renderData[36] = time
    this.renderData[37] = this.motion.speedColorMix
    d.queue.writeBuffer(this.renderUB, 0, this.renderData)

    // Post uniforms.
    this.postData.fill(0)
    this.postData[0] = fadeAlpha
    d.queue.writeBuffer(this.fadeUB, 0, this.postData)
    this.postData.fill(0)
    this.postData[0] = this.look.bloomThreshold
    d.queue.writeBuffer(this.brightUB, 0, this.postData)
    this.postData.fill(0)
    this.postData[0] = this.look.bloomStrength * damp
    this.postData[1] = this.look.exposure
    this.postData[2] = this.look.vignette
    this.postData[3] = this.look.grain
    this.postData[4] = time
    this.postData[5] = this.look.aberration
    this.postData[6] = this.look.streak * damp
    this.postData[7] = this.look.nebula
    this.postData[8] = this.look.background[0]
    this.postData[9] = this.look.background[1]
    this.postData[10] = this.look.background[2]
    this.postData[11] = this.look.stars
    this.postData[12] = this.colorB[0] * 0.5 + this.colorA[0] * 0.5
    this.postData[13] = this.colorB[1] * 0.5 + this.colorA[1] * 0.5
    this.postData[14] = this.colorB[2] * 0.5 + this.colorA[2] * 0.5
    this.postData[15] = aspect
    d.queue.writeBuffer(this.compositeUB, 0, this.postData)

    const enc = d.createCommandEncoder({ label: 'yura-frame' })

    const compute = enc.beginComputePass({ label: 'yura-sim' })
    compute.setPipeline(this.simPipeline)
    compute.setBindGroup(0, this.simBG)
    compute.dispatchWorkgroups(Math.ceil(n / WORKGROUP))
    compute.end()

    const hdrView = this.hdrTex.createView()

    // Trail fade (or a fresh clear right after resize).
    const fade = enc.beginRenderPass({
      label: 'yura-fade',
      colorAttachments: [
        {
          view: hdrView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: this.sceneNeedsClear ? 'clear' : 'load',
          storeOp: 'store',
        },
      ],
    })
    fade.setPipeline(this.fadePipeline)
    fade.setBindGroup(0, this.fadeBG)
    fade.draw(3)
    fade.end()
    this.sceneNeedsClear = false

    const scene = enc.beginRenderPass({
      label: 'yura-scene',
      colorAttachments: [{ view: hdrView, loadOp: 'load', storeOp: 'store' }],
    })
    scene.setPipeline(this.renderPipeline)
    scene.setBindGroup(0, this.renderBG)
    scene.draw(n * 6)
    scene.end()

    const fullscreen = (
      label: string,
      pipeline: GPURenderPipeline,
      bindGroup: GPUBindGroup,
      view: GPUTextureView,
    ) => {
      const pass = enc.beginRenderPass({
        label,
        colorAttachments: [
          { view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' },
        ],
      })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.draw(3)
      pass.end()
    }

    fullscreen('yura-bright', this.brightPipeline, this.brightBG, this.bloomA.createView())
    fullscreen('yura-blur-h', this.blurPipeline, this.blurHBG, this.bloomB.createView())
    fullscreen('yura-blur-v', this.blurPipeline, this.blurVBG, this.bloomA.createView())
    // Anamorphic streaks: two widening horizontal smears of the bloom chain.
    fullscreen('yura-streak-1', this.blurPipeline, this.streak1BG, this.bloomB.createView())
    fullscreen('yura-streak-2', this.blurPipeline, this.streak2BG, this.bloomC.createView())
    fullscreen(
      'yura-composite',
      this.compositePipeline,
      this.compositeBG,
      this.context.getCurrentTexture().createView(),
    )

    d.queue.submit([enc.finish()])
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const b of [
      this.positions, this.velocities, this.targetA, this.targetB,
      this.simUB, this.renderUB, this.fadeUB, this.brightUB, this.blurHUB,
      this.blurVUB, this.streak1UB, this.streak2UB, this.compositeUB,
    ]) {
      b?.destroy()
    }
    this.hdrTex?.destroy()
    this.bloomA?.destroy()
    this.bloomB?.destroy()
    this.bloomC?.destroy()
    this.context.unconfigure()
    this.device.destroy()
  }
}
