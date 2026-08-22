/**
 * Yura × Three.js adapter (zero-dependency).
 *
 * Composites Yura's GPU particle swarm over an existing Three.js scene:
 *
 *   const fx = await yuraLayer(renderer, camera, { preset: 'neon-galaxy' })
 *   fx.attach(mesh)          // swarm follows a Three object
 *   // in your render loop:
 *   fx.sync()                // reads the Three camera, renders the overlay
 *
 * This module never imports 'three' — it reads the small structural surface
 * it needs (matrix `elements` arrays, `renderer.domElement`) via duck types,
 * so it adds zero dependencies and works with any Three.js version.
 *
 * How it works: an overlay canvas is absolutely positioned over
 * `renderer.domElement` (pointer-events: none) and blended with CSS
 * `mix-blend-mode` (default 'screen'), which makes the overlay's black
 * background transparent and its additive HDR particles glow over the scene.
 * Each sync() the Three camera's projection/view matrices are converted to
 * Yura's convention and pushed into the renderer's external-camera hook, so
 * the swarm sits correctly in the 3D world and tracks camera motion 1:1.
 *
 * Future work: real depth compositing (reading Three's depth buffer so scene
 * geometry occludes particles). v1 is a screen-blended overlay, which is
 * order-independent and already looks great for glows, galaxies and auras.
 */
import {
  acquireWebGPU,
  hexToLinear,
  multiply,
  QualityGovernor,
  YuraError,
  CODES,
  type Vec3,
} from '@yura/core'
import {
  WebGPUParticleRenderer,
  type ExternalCamera,
  type LookParams,
} from '@yura/renderer-webgpu'
import { WebGL2ParticleRenderer } from '@yura/renderer-webgl'
import { resolvePreset } from './presets'
import { looks as lookRegistry, type LookName } from './looks'
import { shapes as shapeRegistry, type ShapeSpec } from './shapes'
import { eases, type Ease, type EaseFn, type MotionTimingOptions, type MorphNowOptions } from './app'

// ---------------------------------------------------------------------------
// Structural (duck) types for the bits of Three.js we read. No 'three' import.
// ---------------------------------------------------------------------------

export interface Mat4Like {
  /** Column-major 4x4, same layout as THREE.Matrix4#elements. */
  elements: ArrayLike<number>
}

export interface ThreeCameraLike {
  projectionMatrix: Mat4Like
  matrixWorldInverse: Mat4Like
}

export interface ThreeRendererLike {
  domElement: HTMLCanvasElement
}

export interface ThreeObject3DLike {
  matrixWorld: Mat4Like
}

// ---------------------------------------------------------------------------
// Pure math (exported for tests — no DOM, no GPU).
// ---------------------------------------------------------------------------

/** Nominal radius (world units) of Yura's built-in shapes (galaxy ≈ 11). */
export const YURA_SHAPE_RADIUS = 11

/**
 * Convert a WebGL-convention projection matrix (NDC depth -1..1, what Three
 * produces) to WebGPU convention (depth 0..1): z' = (z + w) / 2.
 */
export function glProjectionToWebGPU(m: ArrayLike<number>): Float32Array {
  const out = new Float32Array(16)
  for (let i = 0; i < 16; i++) out[i] = m[i]
  for (let c = 0; c < 4; c++) {
    const z = c * 4 + 2
    const w = c * 4 + 3
    out[z] = 0.5 * (m[z] + m[w])
  }
  return out
}

/** Extract vertical fov (radians) and aspect from a perspective projection. */
export function fovAspectFromProjection(m: ArrayLike<number>): { fovY: number; aspect: number } {
  const fovY = 2 * Math.atan(1 / m[5])
  return { fovY, aspect: m[5] / m[0] }
}

/** Camera world position from a rigid view matrix (eye = -R^T * t). */
export function eyeFromView(v: ArrayLike<number>): Vec3 {
  return [
    -(v[0] * v[12] + v[1] * v[13] + v[2] * v[14]),
    -(v[4] * v[12] + v[5] * v[13] + v[6] * v[14]),
    -(v[8] * v[12] + v[9] * v[13] + v[10] * v[14]),
  ]
}

/** World position of an object from its matrixWorld elements. */
export function worldPositionOf(matrixWorld: ArrayLike<number>): Vec3 {
  return [matrixWorld[12], matrixWorld[13], matrixWorld[14]]
}

/**
 * Build the external-camera packet that places Yura's swarm (local space,
 * shapes ≈ radius 11 around origin) at `anchor` with uniform `scale` inside
 * the Three world seen by (proj, view).
 *
 * viewProj = webgpuProj * view * translate(anchor) * uniformScale(scale),
 * all column-major. Billboard right/up are the view matrix's rotation rows
 * (unit length, so particle sprites scale linearly with `scale`), and the
 * eye is mapped into swarm-local space for pointer-plane math.
 */
export function composeSwarmCamera(
  proj: ArrayLike<number>,
  view: ArrayLike<number>,
  anchor: Vec3,
  scale: number,
): ExternalCamera {
  const v = new Float32Array(16)
  for (let i = 0; i < 16; i++) v[i] = view[i]

  // vm = view * translate(anchor) * scale(s): scale columns 0..2, re-derive col 3.
  const vm = new Float32Array(16)
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 4; r++) vm[c * 4 + r] = v[c * 4 + r] * scale
  }
  const [ax, ay, az] = anchor
  for (let r = 0; r < 4; r++) {
    vm[12 + r] = v[r] * ax + v[4 + r] * ay + v[8 + r] * az + v[12 + r]
  }

  const viewProj = multiply(glProjectionToWebGPU(proj), vm)

  const norm = (x: number, y: number, z: number): Vec3 => {
    const l = Math.hypot(x, y, z) || 1
    return [x / l, y / l, z / l]
  }
  const right = norm(v[0], v[4], v[8])
  const up = norm(v[1], v[5], v[9])

  const eyeWorld = eyeFromView(v)
  const eye: Vec3 = [
    (eyeWorld[0] - ax) / scale,
    (eyeWorld[1] - ay) / scale,
    (eyeWorld[2] - az) / scale,
  ]

  const { fovY } = fovAspectFromProjection(proj)
  return { viewProj, right, up, eye, fovY, sizeScale: scale }
}

// ---------------------------------------------------------------------------
// The layer.
// ---------------------------------------------------------------------------

export interface YuraLayerOptions extends MotionTimingOptions {
  /** Yura preset name ('neon-galaxy', 'aurora', 'cinematic', 'cyberpunk'). */
  preset?: string
  /** Particle count override (presets default to 600k–1M). */
  particles?: number
  /** Two-stop color gradient, e.g. ['#06b6d4', '#8b5cf6']. */
  gradient?: [string, string]
  /** Look name or full LookParams override. */
  look?: LookName | LookParams
  /** Initial shape (ShapeSpec or a string rendered as particle text). */
  shape?: ShapeSpec | string
  /** Approximate world-space radius of the swarm in your scene's units. Default 6. */
  radius?: number
  /** Static swarm position in Three world space (until attach()). Default origin. */
  position?: [number, number, number]
  /** CSS blend of the overlay. 'screen' (default) keeps black transparent. */
  blend?: 'screen' | 'plus-lighter' | 'normal'
  /** Keep the preset's nebula/stars background haze. Default false (clean overlay). */
  atmosphere?: boolean
  /** 'auto' (default) tries WebGPU then falls back to WebGL2. */
  backend?: 'auto' | 'webgpu' | 'webgl2'
  /** Adaptive quality governor. 'auto' (default) or 'high' (never degrade). */
  quality?: 'auto' | 'high'
  /** z-index for the overlay canvas, if your stacking context needs it. */
  zIndex?: string
  /**
   * Reserved: seconds a shape would hold before an automatic cycle morphs on
   * (the layer has no automatic cycle yet). Accepted for `.motion()` parity;
   * exposed as `layer.holdSeconds`. Default 3.2.
   */
  hold?: number
  /** Seconds a `morphTo` transition takes. Default 2.6 (the legacy constant). */
  morph?: number
  /** Easing for `morphTo` transitions: an `eases` name or a custom curve. Default 'cubic'. */
  ease?: Ease
}

/** Per-call overrides for ONE `morphTo` transition — the `duration`/`ease` slice of the app's `MorphNowOptions`. */
export type YuraLayerMorphOptions = Pick<MorphNowOptions, 'duration' | 'ease'>

// Defaults mirror the app's choreography constants (hold 3.2s, morph 2.6s,
// cubic) — the curves themselves come from the shared `eases` registry.
const DEFAULT_HOLD_SECONDS = 3.2
const DEFAULT_MORPH_SECONDS = 2.6
/** Floor for morph durations — keeps `timer / duration` finite (≈ instant). */
const MIN_MORPH_SECONDS = 1e-4
const MAX_DT = 1 / 30

function resolveEase(e: Ease): EaseFn {
  if (typeof e === 'function') return e
  const fn = (eases as Record<string, EaseFn | undefined>)[e]
  if (!fn) {
    throw new YuraError(
      CODES.UNKNOWN_EASE,
      `Unknown ease "${String(e)}". Available: ${Object.keys(eases).join(', ')}.`,
      `yuraLayer(renderer, camera, { ease: 'expo' })  // or pass any f(0)=0, f(1)=1 function`,
    )
  }
  return fn
}

/** One computed step of a morph transition (pure math, exported for tests). */
export interface MorphStep {
  /** Global morph parameter for the renderer (0 = target A, 1 = target B). */
  morphT: number
  /** Transition-energy hump, sin²(πk) — 0 at both endpoints. */
  boost: number
  /** True once the transition has reached its destination. */
  done: boolean
}

/**
 * The morph timing used by `YuraThreeLayer.sync()`: `timer` seconds into a
 * transition `seconds` long, shaped by `ease`, departing from endpoint `pos`
 * (0 runs the morph parameter 0 → 1, 1 runs it 1 → 0).
 */
export function morphStep(timer: number, seconds: number, ease: EaseFn, pos: 0 | 1): MorphStep {
  const k = Math.min(timer / seconds, 1)
  const e = ease(k)
  return {
    morphT: pos === 0 ? e : 1 - e,
    boost: Math.sin(Math.PI * k) ** 2,
    done: k >= 1,
  }
}

export class YuraThreeLayer {
  /** The overlay canvas (already inserted above renderer.domElement). */
  readonly canvas: HTMLCanvasElement
  readonly backend: 'webgpu' | 'webgl2'

  private renderer: WebGPUParticleRenderer | WebGL2ParticleRenderer
  private host: HTMLCanvasElement
  private camera: ThreeCameraLike
  private governor = new QualityGovernor()
  private cleanups: Array<() => void> = []

  private target: ThreeObject3DLike | null = null
  private offset: Vec3
  private scale: number
  private count: number

  private lastNow: number | null = null
  private time = 0
  private fpsEma = 60
  private disposed = false

  private morphPos: 0 | 1 = 0
  private morphTimer = 0
  private morphActive = false

  // Layer-level morph choreography (from YuraLayerOptions) plus the values in
  // force for the CURRENT transition (per-call morphTo overrides land here).
  private morphSeconds: number
  private morphEase: EaseFn
  private activeMorphSeconds: number
  private activeMorphEase: EaseFn

  /** The `hold` option (reserved: the layer has no automatic cycle yet). */
  readonly holdSeconds: number

  /** @internal — use yuraLayer(). */
  constructor(
    renderer: WebGPUParticleRenderer | WebGL2ParticleRenderer,
    backend: 'webgpu' | 'webgl2',
    canvas: HTMLCanvasElement,
    host: HTMLCanvasElement,
    camera: ThreeCameraLike,
    opts: YuraLayerOptions,
  ) {
    this.renderer = renderer
    this.backend = backend
    this.canvas = canvas
    this.host = host
    this.camera = camera
    this.count = renderer.count
    this.offset = (opts.position ?? [0, 0, 0]) as Vec3
    this.scale = (opts.radius ?? 6) / YURA_SHAPE_RADIUS
    this.holdSeconds = opts.hold !== undefined ? Math.max(opts.hold, 0) : DEFAULT_HOLD_SECONDS
    this.morphSeconds =
      opts.morph !== undefined ? Math.max(opts.morph, MIN_MORPH_SECONDS) : DEFAULT_MORPH_SECONDS
    this.morphEase = opts.ease !== undefined ? resolveEase(opts.ease) : eases.cubic
    this.activeMorphSeconds = this.morphSeconds
    this.activeMorphEase = this.morphEase
    if (opts.quality === 'high') this.governor.enabled = false
    else if (this.count >= 300_000) this.governor.setLevel(2)

    const applyResolution = () => {
      const dpr = Math.min(globalThis.devicePixelRatio || 1, 2)
      const res = this.governor.current().res
      this.place()
      this.renderer.resize(
        Math.max(1, this.host.clientWidth * dpr * res),
        Math.max(1, this.host.clientHeight * dpr * res),
      )
    }
    this.applyResolution = applyResolution
    const ro = new ResizeObserver(applyResolution)
    ro.observe(host)
    this.cleanups.push(() => ro.disconnect())
    applyResolution()
  }

  private applyResolution: () => void

  /** Keep the overlay canvas glued to the Three canvas's box. */
  private place(): void {
    const c = this.canvas.style
    c.left = `${this.host.offsetLeft}px`
    c.top = `${this.host.offsetTop}px`
    c.width = `${this.host.clientWidth}px`
    c.height = `${this.host.clientHeight}px`
  }

  /** Follow a Three object's world position (plus any position offset). */
  attach(object: ThreeObject3DLike): this {
    this.target = object
    return this
  }

  /** Stop following; the swarm stays at the position option. */
  detach(): this {
    this.target = null
    return this
  }

  /** Move the swarm's anchor (world space; added to the attached object). */
  at(x: number, y: number, z: number): this {
    this.offset = [x, y, z]
    return this
  }

  /** Resize the swarm to roughly `radius` world units. */
  setRadius(radius: number): this {
    this.scale = radius / YURA_SHAPE_RADIUS
    return this
  }

  /**
   * Morph the swarm into a new shape (or particle text for a string).
   * `duration`/`ease` override the layer-level timing for THIS transition
   * only (the same shape as the app's `morphNow` options); omitted fields
   * fall back to the `yuraLayer` options, whose defaults reproduce the
   * historical fixed 2.6s cubic transition exactly.
   */
  async morphTo(shape: ShapeSpec | string, opts: YuraLayerMorphOptions = {}): Promise<this> {
    const spec = typeof shape === 'string' ? shapeRegistry.text(shape) : shape
    const data = await Promise.resolve(spec.generate(this.count))
    if (this.disposed) return this
    if (this.morphActive) {
      // Snap the in-flight morph to its destination before starting anew.
      this.morphPos = this.morphPos === 0 ? 1 : 0
      this.renderer.morphT = this.morphPos
      this.morphActive = false
    }
    if (this.morphPos === 0) this.renderer.writeTargetB(data)
    else this.renderer.writeTargetA(data)
    this.activeMorphSeconds =
      opts.duration !== undefined ? Math.max(opts.duration, MIN_MORPH_SECONDS) : this.morphSeconds
    this.activeMorphEase = opts.ease !== undefined ? resolveEase(opts.ease) : this.morphEase
    this.morphTimer = 0
    this.morphActive = true
    return this
  }

  /**
   * Call once per frame from your Three render loop, before or after
   * renderer.render(). Reads the Three camera matrices (and the attached
   * object's matrixWorld), advances the simulation, renders the overlay.
   */
  sync(camera: ThreeCameraLike = this.camera): this {
    if (this.disposed) return this
    const now = performance.now()
    const dtMs = this.lastNow === null ? 16.6 : Math.max(now - this.lastNow, 0)
    this.lastNow = now
    const dt = Math.min(dtMs / 1000, MAX_DT)
    this.time += dt
    this.fpsEma = this.fpsEma * 0.95 + (1000 / Math.max(dtMs, 0.1)) * 0.05
    if (this.governor.update(dtMs)) this.applyResolution()

    if (this.morphActive) {
      this.morphTimer += dt
      const step = morphStep(this.morphTimer, this.activeMorphSeconds, this.activeMorphEase, this.morphPos)
      this.renderer.morphT = step.morphT
      this.renderer.morphBoost = step.done ? 0 : step.boost
      if (step.done) {
        this.morphPos = this.morphPos === 0 ? 1 : 0
        this.morphActive = false
      }
    }

    const anchor: Vec3 = this.target
      ? ((p) => [p[0] + this.offset[0], p[1] + this.offset[1], p[2] + this.offset[2]] as Vec3)(
          worldPositionOf(this.target.matrixWorld.elements),
        )
      : this.offset
    this.renderer.externalCamera = composeSwarmCamera(
      camera.projectionMatrix.elements,
      camera.matrixWorldInverse.elements,
      anchor,
      this.scale,
    )

    const frac = this.governor.current().frac
    this.renderer.frame(dt, this.time, Math.max(1, Math.floor(this.count * frac)))
    return this
  }

  get stats(): { backend: string; fps: number; particles: number } {
    return {
      backend: this.backend,
      fps: Math.round(this.fpsEma),
      particles: Math.floor(this.count * this.governor.current().frac),
    }
  }

  /** Remove the overlay and release all GPU resources. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const c of this.cleanups) c()
    this.cleanups = []
    this.renderer.dispose()
    this.canvas.remove()
  }
}

/**
 * Create a Yura particle layer over an existing Three.js renderer.
 *
 *   const fx = await yuraLayer(renderer, camera, { preset: 'aurora', radius: 4 })
 *   fx.attach(mesh)
 *   // per frame: fx.sync()
 */
export async function yuraLayer(
  threeRenderer: ThreeRendererLike,
  threeCamera: ThreeCameraLike,
  options: YuraLayerOptions = {},
): Promise<YuraThreeLayer> {
  const host = threeRenderer.domElement
  const preset = resolvePreset(options.preset ?? 'neon-galaxy')

  let look: LookParams
  if (typeof options.look === 'string') look = lookRegistry[options.look]()
  else look = options.look ?? preset.look
  if (!options.atmosphere) {
    // A clean overlay: no opaque background wash under the blend mode.
    look = { ...look, background: [0, 0, 0] as Vec3, nebula: 0, stars: 0, vignette: 0, grain: 0 }
  }

  const count = Math.max(1, Math.floor(options.particles ?? preset.particles))
  const [colorA, colorB] = options.gradient ?? [preset.colorA, preset.colorB]
  const rendererOpts = {
    count,
    look,
    motion: preset.motion,
    colorA: hexToLinear(colorA),
    colorB: hexToLinear(colorB),
  }

  // Overlay canvas above the Three canvas, click-through, additive blend.
  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'position:absolute;pointer-events:none;display:block;'
  canvas.style.mixBlendMode = options.blend ?? 'screen'
  if (options.zIndex !== undefined) canvas.style.zIndex = options.zIndex
  canvas.setAttribute('aria-hidden', 'true')
  const parent = host.parentElement ?? document.body
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative'
  parent.insertBefore(canvas, host.nextSibling)

  let renderer: WebGPUParticleRenderer | WebGL2ParticleRenderer | null = null
  let backend: 'webgpu' | 'webgl2' = 'webgpu'
  const gpu = options.backend === 'webgl2' ? null : await acquireWebGPU()
  if (gpu) {
    renderer = await WebGPUParticleRenderer.create(canvas, gpu.device, rendererOpts)
  } else {
    renderer = WebGL2ParticleRenderer.create(canvas, rendererOpts)
    backend = 'webgl2'
  }
  if (!renderer) {
    canvas.remove()
    throw new Error(
      'yuraLayer: neither WebGPU nor WebGL2 with float color buffers is available.',
    )
  }

  const shape = options.shape ?? preset.shapes[0]
  const spec = typeof shape === 'string' ? shapeRegistry.text(shape) : shape
  const data = await Promise.resolve(spec.generate(count))
  renderer.writeTargetA(data)
  renderer.writeTargetB(data)

  return new YuraThreeLayer(renderer, backend, canvas, host, threeCamera, options)
}
