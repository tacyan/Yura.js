import {
  YuraError,
  CODES,
  hexToLinear,
  acquireWebGPU,
  prefersReducedMotion,
  watchVisibility,
  QualityGovernor,
  type Vec3,
  type Backend,
} from '@yura/core'
import {
  WebGPUParticleRenderer,
  WebGPUModelRenderer,
  type LookParams,
  type MotionParams,
} from '@yura/renderer-webgpu'
import { WebGL2ParticleRenderer } from '@yura/renderer-webgl'
import { resolvePreset, DEFAULT_MOTION } from './presets'
import { looks as lookRegistry, type LookName } from './looks'
import { shapes as shapeRegistry, type ShapeSpec } from './shapes'
import { YuraScene, type SceneOptions } from './scene'

export interface YuraOptions {
  /** 'auto' adapts to the frame budget, 'high' pins max quality, 'low' starts conservative. */
  quality?: 'auto' | 'high' | 'low'
  /** Force a rendering backend ('webgl2' is particles-only). Default 'auto'. */
  backend?: 'auto' | 'webgpu' | 'webgl2'
}

export interface YuraStats {
  backend: Backend
  fps: number
  frameMs: number
  particles: number
  requestedParticles: number
  resolutionScale: number
  qualityLevel: number
}

const HOLD_SECONDS = 3.2
const MORPH_SECONDS = 2.6
const MAX_DT = 1 / 30

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

/**
 * The chainable facade (spec §8.1). Configuration is collected synchronously;
 * everything async (GPU init, shape generation, asset loads) happens in run().
 */
export class YuraApp {
  private container: HTMLElement
  private canvas: HTMLCanvasElement | null = null
  private renderer: WebGPUParticleRenderer | WebGL2ParticleRenderer | null = null
  private modelRenderer: WebGPUModelRenderer | null = null
  private modelUrl: string | null = null
  private sceneObj: YuraScene | null = null
  private lookExplicit = false
  private governor = new QualityGovernor()
  private backend: Backend = 'poster'

  private particleCount = 500_000
  private colorA = '#06b6d4'
  private colorB = '#8b5cf6'
  private lookParams: LookParams = lookRegistry.cinematic()
  private motionParams: MotionParams = { ...DEFAULT_MOTION }
  private shapeSeq: ShapeSpec[] = [shapeRegistry.galaxy()]
  private shapeOverridden = false
  private pointerEnabled = false
  private qualityMode: 'auto' | 'high' | 'low'
  private backendOpt: 'auto' | 'webgpu' | 'webgl2'

  private shapeData: Float32Array<ArrayBuffer>[] = []
  private morph = { pos: 0 as 0 | 1, phase: 'hold' as 'hold' | 'move', timer: 0, nextShape: 2 }
  /** Set by morphNow(): halts the automatic shape cycle on arrival. */
  private morphPinned = false

  private rafId = 0
  private running = false
  private visible = true
  private disposed = false
  private lastTime = 0
  private simTime = 0
  private fpsEma = 60

  private pointerNdc: [number, number] | null = null
  /** 1 right after a click, decaying — drives the shockwave burst. */
  private burst = 0
  private cleanups: Array<() => void> = []

  constructor(target: string | HTMLElement, options: YuraOptions = {}) {
    const el = typeof target === 'string' ? document.querySelector<HTMLElement>(target) : target
    if (!el) {
      throw new YuraError(
        CODES.TARGET_NOT_FOUND,
        `Target "${String(target)}" not found in the document.`,
        `Make sure the element exists before calling yura():\n  <div id="hero"></div>\n  yura('#hero').run()`,
      )
    }
    this.container = el
    this.qualityMode = options.quality ?? 'auto'
    this.backendOpt = options.backend ?? 'auto'
  }

  particles(n: number): this {
    this.particleCount = Math.max(1, Math.floor(n))
    return this
  }

  /** Render a glTF/GLB model with PBR + IBL instead of particles (F-011). */
  model(url: string): this {
    this.modelUrl = url
    return this
  }

  /**
   * Procedural 3D scene + game kit: primitives, PBR materials, physics-lite,
   * input, follow camera, HUD text. No assets required.
   */
  scene(opts: SceneOptions = {}): YuraScene {
    this.sceneObj = new YuraScene(opts)
    return this.sceneObj
  }

  gradient(a: string, b: string): this {
    this.colorA = a
    this.colorB = b
    return this
  }

  look(l: LookParams | LookName): this {
    if (typeof l === 'string') {
      const factory = lookRegistry[l]
      if (!factory) {
        throw new YuraError(
          CODES.UNKNOWN_LOOK,
          `Unknown look "${l}". Available: ${Object.keys(lookRegistry).join(', ')}.`,
          `yura('#app').look('cinematic').run()`,
        )
      }
      this.lookParams = factory()
    } else {
      this.lookParams = l
    }
    this.lookExplicit = true
    return this
  }

  motion(m: Partial<MotionParams>): this {
    this.motionParams = { ...this.motionParams, ...m }
    return this
  }

  shape(s: ShapeSpec | string): this {
    this.shapeSeq = [this.toShape(s)]
    this.shapeOverridden = true
    return this
  }

  morphTo(seq: Array<ShapeSpec | string>): this {
    const rest = seq.map((s) => this.toShape(s))
    this.shapeSeq = this.shapeOverridden ? [this.shapeSeq[0], ...rest] : rest.length ? rest : this.shapeSeq
    return this
  }

  preset(name: string): this {
    const p = resolvePreset(name)
    this.particleCount = p.particles
    this.colorA = p.colorA
    this.colorB = p.colorB
    this.lookParams = p.look
    this.motionParams = p.motion
    if (!this.shapeOverridden) this.shapeSeq = p.shapes
    return this
  }

  interactive(): this {
    this.pointerEnabled = true
    return this
  }

  /**
   * Morph the running swarm to a new shape right now (strings become text).
   * The automatic shape cycle pauses on the new shape until the app is
   * reconfigured. Before run(), behaves like .shape().
   */
  async morphNow(s: ShapeSpec | string): Promise<this> {
    const spec = this.toShape(s)
    if (!this.renderer) {
      this.shape(spec)
      return this
    }
    const data = await Promise.resolve(spec.generate(this.particleCount))
    if (this.disposed || !this.renderer) return this
    const m = this.morph
    // Mid-flight: adopt the nearer endpoint as the new origin so the goal
    // interpolation barely snaps (the swarm itself always moves smoothly).
    if (m.phase === 'move') {
      const k = Math.min(m.timer / MORPH_SECONDS, 1)
      const e = easeInOutCubic(k)
      const t = m.pos === 0 ? e : 1 - e
      m.pos = t > 0.5 ? (m.pos === 0 ? 1 : 0) : m.pos
    }
    if (m.pos === 0) this.renderer.writeTargetB(data)
    else this.renderer.writeTargetA(data)
    this.renderer.morphT = m.pos
    m.phase = 'move'
    m.timer = 0
    this.morphPinned = true
    return this
  }

  /** Alias kept for spec §8.1 parity. */
  reactToPointer(): this {
    return this.interactive()
  }

  get stats(): YuraStats {
    const level = this.governor.current()
    return {
      backend: this.backend,
      fps: Math.round(this.fpsEma),
      frameMs: Math.round(this.governor.frameMs * 10) / 10,
      particles: this.renderer && !this.modelRenderer ? Math.floor(this.particleCount * level.frac) : 0,
      requestedParticles: this.particleCount,
      resolutionScale: level.res,
      qualityLevel: this.governor.level,
    }
  }

  async run(): Promise<this> {
    if (this.disposed) return this
    this.mountCanvas()

    if (this.qualityMode === 'low') this.governor.setLevel(4)
    if (this.qualityMode === 'high') this.governor.enabled = false
    // Heavy particle counts boot one notch down and climb once the governor
    // sees headroom — full quality from frame one can freeze the first
    // seconds on mid GPUs, which is a worse first impression than a ramp.
    if (
      this.qualityMode === 'auto' &&
      !this.sceneObj &&
      !this.modelUrl &&
      this.particleCount >= 300_000
    ) {
      this.governor.setLevel(2)
    }

    const gpu = this.backendOpt === 'webgl2' ? null : await acquireWebGPU()
    if (!this.canvas) return this

    if (gpu && this.sceneObj) {
      return this.runScene(gpu.device)
    }
    if (gpu && this.modelUrl) {
      return this.runModel(gpu.device)
    }
    if (!gpu && (this.sceneObj || this.modelUrl)) {
      // PBR paths are WebGPU-only for now; keep the no-white-screen promise.
      this.backend = 'poster'
      this.renderPoster()
      return this
    }

    const rendererOpts = {
      count: this.particleCount,
      look: this.lookParams,
      motion: this.motionParams,
      colorA: hexToLinear(this.colorA),
      colorB: hexToLinear(this.colorB),
    }
    if (gpu) {
      this.backend = 'webgpu'
      this.renderer = await WebGPUParticleRenderer.create(this.canvas, gpu.device, rendererOpts)
    } else {
      const glRenderer = WebGL2ParticleRenderer.create(this.canvas, rendererOpts)
      if (!glRenderer) {
        this.backend = 'poster'
        this.renderPoster()
        return this
      }
      this.backend = 'webgl2'
      this.renderer = glRenderer
    }
    this.renderer.onDeviceLost = () => this.recoverFromDeviceLost()

    // Only the first shape blocks first paint; the rest generate in the
    // background so a 1M x N-shape preset doesn't stall the page for seconds.
    const first = await Promise.resolve(this.shapeSeq[0].generate(this.particleCount))
    this.shapeData = [first]
    this.renderer.writeTargetA(first)
    this.renderer.writeTargetB(first)
    this.morph = { pos: 0, phase: 'hold', timer: 0, nextShape: 2 }
    void this.generateRemainingShapes()

    this.observeResize()
    this.bindPointer()
    this.cleanups.push(
      watchVisibility(this.container, (visible) => {
        this.visible = visible
        if (visible && this.running && !this.rafId) {
          this.lastTime = performance.now()
          this.rafId = requestAnimationFrame(this.tick)
        }
      }),
    )

    if (prefersReducedMotion()) {
      // A11y: settle the simulation and present a single static frame.
      this.applyResolution()
      for (let i = 0; i < 240; i++) {
        this.renderer.frame(1 / 60, this.simTime, this.activeCount())
        this.simTime += 1 / 60
      }
      return this
    }

    this.running = true
    this.lastTime = performance.now()
    this.rafId = requestAnimationFrame(this.tick)
    return this
  }

  pause(): void {
    this.running = false
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
  }

  resume(): void {
    if (this.disposed || this.running) return
    this.running = true
    this.lastTime = performance.now()
    this.rafId = requestAnimationFrame(this.tick)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pause()
    for (const c of this.cleanups) c()
    this.cleanups = []
    this.renderer?.dispose()
    this.renderer = null
    this.modelRenderer?.dispose()
    this.modelRenderer = null
    this.canvas?.remove()
    this.canvas = null
  }

  // ---- internals ----

  private async runScene(device: GPUDevice): Promise<this> {
    this.backend = 'webgpu'
    if (!this.lookExplicit) this.lookParams = lookRegistry.studio()
    this.modelRenderer = await WebGPUModelRenderer.create(this.canvas!, device, this.lookParams)
    this.modelRenderer.colorA = hexToLinear(this.colorA)
    this.modelRenderer.colorB = hexToLinear(this.colorB)
    this.modelRenderer.onDeviceLost = () => this.recoverFromDeviceLost()
    this.cleanups.push(this.sceneObj!.attach(this.modelRenderer, this.container))

    this.observeResize()
    this.bindModelPointer()
    this.cleanups.push(
      watchVisibility(this.container, (visible) => {
        this.visible = visible
        if (visible && this.running && !this.rafId) {
          this.lastTime = performance.now()
          this.rafId = requestAnimationFrame(this.tick)
        }
      }),
    )

    if (prefersReducedMotion()) {
      this.applyResolution()
      this.modelRenderer.autoRotate = 0
      this.sceneObj!.step(1 / 60, 0)
      this.modelRenderer.frame(1 / 60, 0)
      return this
    }

    this.running = true
    this.lastTime = performance.now()
    this.rafId = requestAnimationFrame(this.tick)
    return this
  }

  private async runModel(device: GPUDevice): Promise<this> {
    this.backend = 'webgpu'
    if (!this.lookExplicit) this.lookParams = lookRegistry.studio()
    this.modelRenderer = await WebGPUModelRenderer.create(this.canvas!, device, this.lookParams)
    this.modelRenderer.colorA = hexToLinear(this.colorA)
    this.modelRenderer.colorB = hexToLinear(this.colorB)
    this.modelRenderer.onDeviceLost = () => this.recoverFromDeviceLost()
    await this.modelRenderer.loadModel(new URL(this.modelUrl!, location.href).href)

    this.observeResize()
    this.bindModelPointer()
    this.cleanups.push(
      watchVisibility(this.container, (visible) => {
        this.visible = visible
        if (visible && this.running && !this.rafId) {
          this.lastTime = performance.now()
          this.rafId = requestAnimationFrame(this.tick)
        }
      }),
    )

    if (prefersReducedMotion()) {
      this.applyResolution()
      this.modelRenderer.autoRotate = 0
      this.modelRenderer.frame(1 / 60, 0)
      return this
    }

    this.running = true
    this.lastTime = performance.now()
    this.rafId = requestAnimationFrame(this.tick)
    return this
  }

  private bindModelPointer(): void {
    if (!this.pointerEnabled) return
    const el = this.container
    let dragging = false
    let lastX = 0
    let lastY = 0
    const onDown = (e: PointerEvent) => {
      dragging = true
      lastX = e.clientX
      lastY = e.clientY
      el.setPointerCapture?.(e.pointerId)
    }
    const onMove = (e: PointerEvent) => {
      if (!dragging || !this.modelRenderer) return
      this.modelRenderer.rotateBy((e.clientX - lastX) * 0.006, (e.clientY - lastY) * 0.006)
      lastX = e.clientX
      lastY = e.clientY
    }
    const onUp = () => {
      dragging = false
    }
    const onWheel = (e: WheelEvent) => {
      if (!this.modelRenderer) return
      e.preventDefault()
      this.modelRenderer.zoomBy(1 + e.deltaY * 0.001)
    }
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointerleave', onUp)
    el.addEventListener('wheel', onWheel, { passive: false })
    this.cleanups.push(() => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointerleave', onUp)
      el.removeEventListener('wheel', onWheel)
    })
  }

  private async generateRemainingShapes(): Promise<void> {
    for (let idx = 1; idx < this.shapeSeq.length; idx++) {
      // Yield to the event loop between shapes so the animation keeps frames.
      await new Promise((resolve) => setTimeout(resolve, 50))
      if (this.disposed) return
      const data = await Promise.resolve(this.shapeSeq[idx].generate(this.particleCount))
      if (this.disposed || !this.renderer) return
      this.shapeData.push(data)
      if (idx === 1) this.renderer.writeTargetB(data)
    }
  }

  private toShape(s: ShapeSpec | string): ShapeSpec {
    return typeof s === 'string' ? shapeRegistry.text(s) : s
  }

  private mountCanvas(): void {
    if (this.canvas) return
    const style = getComputedStyle(this.container)
    if (style.position === 'static') this.container.style.position = 'relative'
    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;'
    canvas.setAttribute('aria-hidden', 'true')
    canvas.setAttribute('role', 'presentation')
    this.container.appendChild(canvas)
    this.canvas = canvas
  }

  private activeCount(): number {
    return Math.max(1, Math.floor(this.particleCount * this.governor.current().frac))
  }

  private applyResolution(): void {
    const target = this.modelRenderer ?? this.renderer
    if (!target || !this.canvas) return
    const dpr = Math.min(devicePixelRatio || 1, 2)
    const scale = this.governor.current().res
    target.resize(
      this.canvas.clientWidth * dpr * scale,
      this.canvas.clientHeight * dpr * scale,
    )
  }

  private observeResize(): void {
    const ro = new ResizeObserver(() => this.applyResolution())
    ro.observe(this.container)
    this.cleanups.push(() => ro.disconnect())
    this.applyResolution()
  }

  private bindPointer(): void {
    if (!this.pointerEnabled) return
    const el = this.container
    const onMove = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect()
      this.pointerNdc = [
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -(((e.clientY - rect.top) / rect.height) * 2 - 1),
      ]
    }
    const onLeave = () => {
      this.pointerNdc = null
    }
    const onDown = (e: PointerEvent) => {
      onMove(e)
      this.burst = 1
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerleave', onLeave)
    el.addEventListener('pointerdown', onDown)
    this.cleanups.push(() => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerleave', onLeave)
      el.removeEventListener('pointerdown', onDown)
    })
  }

  private updateMorph(dt: number): void {
    if (!this.renderer) return
    if (!this.morphPinned && this.shapeData.length < 2) return
    const m = this.morph
    m.timer += dt
    if (m.phase === 'hold') {
      this.renderer.morphBoost = 0
      // Pinned by morphNow(): hold the shape until the next explicit morph.
      if (!this.morphPinned && m.timer >= HOLD_SECONDS) {
        m.phase = 'move'
        m.timer = 0
      }
      return
    }
    const k = Math.min(m.timer / MORPH_SECONDS, 1)
    const e = easeInOutCubic(k)
    this.renderer.morphT = m.pos === 0 ? e : 1 - e
    // Extra turbulence mid-flight turns transitions into comet swarms.
    this.renderer.morphBoost = Math.sin(Math.PI * k) ** 2
    if (k >= 1) {
      m.pos = m.pos === 0 ? 1 : 0
      if (!this.morphPinned) {
        // Arrived at the far buffer. Preload the next shape into the buffer we left.
        const next = this.shapeData[m.nextShape % this.shapeData.length]
        if (m.pos === 1) this.renderer.writeTargetA(next)
        else this.renderer.writeTargetB(next)
        m.nextShape++
      }
      m.phase = 'hold'
      m.timer = 0
    }
  }

  private tick = (now: number): void => {
    this.rafId = 0
    if (!this.running || this.disposed || (!this.renderer && !this.modelRenderer)) return
    if (!this.visible) return // resumes from the visibility watcher

    // rAF timestamps can PRECEDE the performance.now() captured at run() /
    // resume() after a long stall (pipeline compiles, tab switches). A
    // negative dt runs the simulation backward: damping exp(-d*dt) becomes
    // exponential velocity amplification and one frame can fling the whole
    // swarm thousands of units off-screen. Clamp both ends.
    const dtMs = Math.max(now - this.lastTime, 0)
    this.lastTime = now
    const dt = Math.min(dtMs / 1000, MAX_DT)
    this.simTime += dt
    this.fpsEma = this.fpsEma * 0.95 + (1000 / Math.max(dtMs, 0.1)) * 0.05

    if (this.governor.update(dtMs)) this.applyResolution()

    if (this.modelRenderer) {
      this.sceneObj?.step(dt, this.simTime)
      this.modelRenderer.frame(dt, this.simTime)
      this.rafId = requestAnimationFrame(this.tick)
      return
    }
    if (!this.renderer) return
    this.updateMorph(dt)

    if (this.pointerNdc) {
      const world = this.renderer.pointerToWorld(this.pointerNdc[0], this.pointerNdc[1])
      if (world) {
        this.renderer.pointerWorld = world
        // Hover repels gently; a click detonates a decaying shockwave.
        this.renderer.pointerStrength = 60 + this.burst * 2400
      }
      this.renderer.parallax = [
        this.renderer.parallax[0] * 0.92 + this.pointerNdc[0] * 0.08,
        this.renderer.parallax[1] * 0.92 + this.pointerNdc[1] * 0.08,
      ]
    } else {
      this.renderer.pointerStrength = 0
    }
    this.burst *= Math.exp(-dt * 5)

    this.renderer.frame(dt, this.simTime, this.activeCount())
    this.rafId = requestAnimationFrame(this.tick)
  }

  private async recoverFromDeviceLost(): Promise<void> {
    if (this.disposed) return
    this.pause()
    this.renderer = null
    this.modelRenderer = null
    try {
      await this.run()
    } catch {
      this.backend = 'poster'
      this.renderPoster()
    }
  }

  /** Static 2D-canvas fallback (F-002): never a white screen. */
  private renderPoster(): void {
    if (!this.canvas) return
    const draw = () => {
      const canvas = this.canvas!
      const dpr = Math.min(devicePixelRatio || 1, 2)
      canvas.width = Math.max(1, canvas.clientWidth * dpr)
      canvas.height = Math.max(1, canvas.clientHeight * dpr)
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const { width: w, height: h } = canvas
      const bgGrad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7)
      bgGrad.addColorStop(0, '#0b1023')
      bgGrad.addColorStop(1, '#04050c')
      ctx.fillStyle = bgGrad
      ctx.fillRect(0, 0, w, h)
      const colors = [this.colorA, this.colorB]
      for (let i = 0; i < 900; i++) {
        const t = Math.pow(Math.random(), 0.6)
        const arm = i % 3
        const a = arm * ((Math.PI * 2) / 3) + t * 5 + (Math.random() - 0.5) * 0.5
        const r = t * Math.min(w, h) * 0.42
        const x = w / 2 + Math.cos(a) * r
        const y = h / 2 + Math.sin(a) * r * 0.55
        ctx.fillStyle = colors[i % 2]
        ctx.globalAlpha = 0.25 + Math.random() * 0.55
        const s = (1.4 - t) * 2.2 * dpr
        ctx.beginPath()
        ctx.arc(x, y, Math.max(s, 0.5), 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(this.container)
    this.cleanups.push(() => ro.disconnect())
  }
}

export function yura(target: string | HTMLElement, options: YuraOptions = {}): YuraApp {
  return new YuraApp(target, options)
}
