import {
  YuraError,
  CODES,
  warnCode,
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
  MAX_ATTRACTORS,
  type AttractorParams,
  type LookParams,
  type MotionParams,
} from '@yura/renderer-webgpu'
import { WebGL2ParticleRenderer } from '@yura/renderer-webgl'
import { resolvePreset, DEFAULT_MOTION } from './presets'
import { looks as lookRegistry, type LookName } from './looks'
import { shapes as shapeRegistry, type ShapeSpec } from './shapes'
import { YuraScene, type SceneOptions } from './scene'
import { lyrics as runLyrics, type LyricLine, type LyricsOptions, type LyricsRun } from './lyrics'

/**
 * Construction options for {@link yura} / {@link YuraApp}.
 *
 * @example
 * yura('#hero', { quality: 'high', backend: 'webgpu' }).run()
 */
export interface YuraOptions {
  /** 'auto' adapts to the frame budget, 'high' pins max quality, 'low' starts conservative. */
  quality?: 'auto' | 'high' | 'low'
  /** Force a rendering backend ('webgl2' is particles-only). Default 'auto'. */
  backend?: 'auto' | 'webgpu' | 'webgl2'
}

/**
 * Live performance snapshot from {@link YuraApp.stats}. Format it as a
 * one-line HUD string with {@link formatStats}.
 */
export interface YuraStats {
  /** Active rendering backend ('webgpu', 'webgl2', or 'poster'). */
  backend: Backend
  /** Smoothed frames per second. */
  fps: number
  /** Frame time in milliseconds (one decimal). */
  frameMs: number
  /** Particles actually simulated after quality governing (0 in model/scene mode). */
  particles: number
  /** Particle count requested via `.particles()` or the preset. */
  requestedParticles: number
  /** Render resolution multiplier the quality governor applied (1 = full). */
  resolutionScale: number
  /** Current quality-governor step (higher = more aggressive degradation). */
  qualityLevel: number
}

const HOLD_SECONDS = 3.2
const MORPH_SECONDS = 2.6
const MAX_DT = 1 / 30

/** Floor for morph durations — keeps `timer / duration` finite (≈ instant). */
const MIN_MORPH_SECONDS = 1e-4

/**
 * Warn code emitted when scene() replaces a live scene. Numbered in the CODES
 * sequence (next free slot after UNKNOWN_EASE = YURA-015) but defined here
 * Registered in CODES (@yura/core) as SCENE_REPLACED.
 */
export const SCENE_REPLACED_CODE = CODES.SCENE_REPLACED

/** Setup callback for {@link YuraApp.game}: receives the fresh scene; may be async. */
export type GameSetup = (scene: YuraScene) => void | Promise<void>

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

/** An easing curve: f(0) = 0 and f(1) = 1 (values may overshoot in between). */
export type EaseFn = (t: number) => number

/**
 * Named easing curves for morph choreography. Every curve satisfies
 * f(0) = 0 and f(1) = 1; all but `back` stay monotone inside [0, 1]
 * (`back` overshoots past 1 and springs back — that is its point).
 */
export const eases = {
  /** The classic smooth in-out — the default, identical to the legacy curve. */
  cubic: easeInOutCubic as EaseFn,
  /** Dramatic in-out: near-still at both ends, a rush through the middle. */
  expo: ((t) =>
    t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2) as EaseFn,
  /** Overshoots the target and springs back — snappy design-reel arrivals. */
  back: ((t) => {
    const c1 = 1.70158
    const c3 = c1 + 1
    const u = t - 1
    return 1 + c3 * u * u * u + c1 * u * u
  }) as EaseFn,
  /** Hermite smoothstep — gentler shoulders than cubic, a GPU classic. */
  smooth: ((t) => t * t * (3 - 2 * t)) as EaseFn,
  /** No easing — constant speed. */
  linear: ((t) => t) as EaseFn,
} satisfies Record<string, EaseFn>

/** A key of the `eases` registry. */
export type EaseName = keyof typeof eases

/** An easing, referenced by registry name or supplied as a custom curve. */
export type Ease = EaseName | EaseFn

function resolveEase(e: Ease): EaseFn {
  if (typeof e === 'function') return e
  const fn = (eases as Record<string, EaseFn | undefined>)[e]
  if (!fn) {
    throw new YuraError(
      CODES.UNKNOWN_EASE,
      `Unknown ease "${String(e)}". Available: ${Object.keys(eases).join(', ')}.`,
      `app.motion({ ease: 'expo' })  // or pass any f(0)=0, f(1)=1 function`,
    )
  }
  return fn
}

/**
 * Timing knobs for the morph choreography, accepted by `.motion()` alongside
 * the physics params. Omitted fields keep their current values; the defaults
 * reproduce the historical fixed constants exactly (hold 3.2s, morph 2.6s,
 * cubic easing).
 */
export interface MotionTimingOptions {
  /** Seconds a shape holds before the automatic cycle morphs on. Default 3.2. */
  hold?: number
  /** Seconds a morph transition takes. Default 2.6. */
  morph?: number
  /** Easing for morph transitions: an `eases` name or a custom curve. Default 'cubic'. */
  ease?: Ease
}

/**
 * Options for {@link YuraApp.interactive}. Passing an object (instead of a
 * boolean) turns pointer reactivity on and configures how the cursor couples
 * to the simulation.
 */
export interface InteractiveOptions {
  /**
   * Cursor gravity: the pointer's world position is injected every frame as
   * one `motion.attractors` gravity well of this strength. Positive pulls
   * particles toward the cursor, negative pushes them away. Omit to keep the
   * classic hover/click force field only (exact legacy behavior).
   */
  gravity?: number
}

/**
 * Composes the per-frame attractor list the renderer simulates while cursor
 * gravity is active: the pointer well leads, the user's `.motion({ attractors })`
 * follow, clamped to the sims' MAX_ATTRACTORS uniform capacity. The pointer
 * takes the head slot so a live cursor force never silently vanishes behind a
 * full static list. Pure — `base` is never mutated (exported for tests).
 */
export function withPointerAttractor(
  base: readonly AttractorParams[] | undefined,
  position: Vec3,
  strength: number,
): AttractorParams[] {
  // Copy the position so the packed attractor never aliases pointer state
  // that keeps moving after this frame.
  const pointer: AttractorParams = { position: [position[0], position[1], position[2]], strength }
  return [pointer, ...(base ?? [])].slice(0, MAX_ATTRACTORS)
}

/** Travel direction of a morph sweep across the target's coordinate ordering. */
export type SweepDirection = 'ltr' | 'rtl' | 'center' | 'random'

/** Per-call options for {@link YuraApp.morphNow} — sweep staggering plus one-off timing overrides. */
export interface MorphNowOptions {
  /**
   * 0..1 per-particle stagger: how much of the morph is spent sweeping across
   * the target's delay/palette coordinate (characters, for text shapes).
   * 0 (default) = uniform morph, exactly the previous behavior.
   */
  sweep?: number
  /** Where the sweep starts. Default 'ltr' (reading order). */
  direction?: SweepDirection
  /** Reserved for lyric scheduling; unused by morphNow itself. */
  hold?: number
  /**
   * Seconds THIS transition takes. Default: the app-level morph duration
   * (2.6s, or whatever `.motion({ morph })` set).
   */
  duration?: number
  /** Easing for THIS transition (an `eases` name or a custom curve). Default: the app-level ease. */
  ease?: Ease
}

/**
 * TS mirror of the shader sweep math (WGSL sim / GLSL SIM_VS): a particle's
 * effective morph progress given the global morphT, its 0..1 delay
 * coordinate, and the stagger spread. Spread 0 collapses to clamp(morphT).
 * (Pure; exported for tests.)
 */
export function sweepProgress(morphT: number, delayCoord: number, spread: number): number {
  const s = Math.min(Math.abs(spread), 1)
  const e = morphT * (1 + s) - delayCoord * s
  return Math.min(Math.max(e, 0), 1)
}

/**
 * Click-to-aim: yaw/pitch delta that swings the orbit camera so the clicked
 * canvas point moves toward center — same direction a drag of that point to
 * center would take. Deltas scale with the click's offset from center and
 * cap at ±0.7 (yaw) / ±0.45 (pitch) rad per click. (Pure; exported for tests.)
 */
export function clickAimDelta(
  x: number,
  y: number,
  width: number,
  height: number,
): { yaw: number; pitch: number } {
  if (width <= 0 || height <= 0) return { yaw: 0, pitch: 0 }
  const nx = Math.min(Math.max(x / width - 0.5, -0.5), 0.5)
  const ny = Math.min(Math.max(y / height - 0.5, -0.5), 0.5)
  return { yaw: -nx * 1.4 + 0, pitch: -ny * 0.9 + 0 } // +0 normalizes -0
}

/**
 * Bakes a sweep direction into a generated shape's delay/palette coordinates
 * (data[i*4+3]) in place. 'rtl' inverts reading order, 'center' radiates from
 * the middle outward, 'random' assigns a deterministic per-particle hash
 * (glitter assembly). Note the coordinate doubles as the color-gradient
 * position, so redirecting the sweep redirects the gradient too — an
 * intentional trade-off that keeps the particle layout at 16 bytes.
 * (Pure; exported for tests.)
 */
export function applySweepDirection(
  data: Float32Array<ArrayBuffer>,
  direction: SweepDirection,
): Float32Array<ArrayBuffer> {
  if (direction === 'ltr') return data
  for (let i = 3; i < data.length; i += 4) {
    const w = data[i]
    if (direction === 'rtl') data[i] = 1 - w
    else if (direction === 'center') data[i] = Math.abs(w * 2 - 1)
    else {
      const h = Math.sin((i + 1) * 12.9898) * 43758.5453
      data[i] = h - Math.floor(h)
    }
  }
  return data
}

// ---------------------------------------------------------------- text damping
//
// A text morph target packs the whole swarm into thin glyph strokes. Under
// additive accumulation the per-pixel HDR sums explode, and a high-bloom look
// (bloom + anamorphic streak) smears every line into a solid overexposed bar.
// The fix is a runtime damping factor the app eases per frame and both
// renderers apply to particle intensity, bloom strength, and streak strength.
// At 1 (neutral) the renderer math multiplies by exactly 1.0 — bit-exact with
// the undamped pipeline — so non-text moments keep the look untouched.

/** Neutral damping factor — multiplying by it is a bit-exact no-op. */
export const TEXT_DAMP_NEUTRAL = 1
/** Particle count at which TEXT_DAMP_AT_REF applies (density reference). */
export const TEXT_DAMP_REF_COUNT = 250_000
/** Damping factor at the reference count while text is held. */
export const TEXT_DAMP_AT_REF = 0.35
/** Damping floor — even ludicrous swarms keep some glow. */
export const TEXT_DAMP_MIN = 0.06
/** Exponential ease rate (per second) toward the damping target. */
export const TEXT_DAMP_RATE = 5
/** Snap distance: once this close, land exactly on the target. */
const TEXT_DAMP_EPS = 0.002

/**
 * Damping target for the current morph destination (pure; exported for
 * tests). 1 (neutral) when no text target is active. While text is active
 * the factor is density-aware: brightness accumulation grows roughly with
 * count^0.7 (the renderer's own countComp exponent), so heavier swarms damp
 * harder and glyph strokes stay distinct in every look.
 */
export function textDampTarget(textActive: boolean, particleCount: number): number {
  if (!textActive) return TEXT_DAMP_NEUTRAL
  const density = Math.max(particleCount, 1) / TEXT_DAMP_REF_COUNT
  const f = TEXT_DAMP_AT_REF / Math.pow(density, 0.7)
  return Math.min(Math.max(f, TEXT_DAMP_MIN), TEXT_DAMP_NEUTRAL)
}

/**
 * Frame-rate-independent exponential approach toward `target` (pure;
 * exported for tests). Monotonic, never overshoots, and SNAPS onto the
 * target once within TEXT_DAMP_EPS so releasing text restores the factor to
 * exactly 1 — bit-exact neutral — in finite time.
 */
export function easeDampFactor(
  current: number,
  target: number,
  dt: number,
  rate = TEXT_DAMP_RATE,
): number {
  const k = 1 - Math.exp(-Math.max(dt, 0) * rate)
  const next = current + (target - current) * k
  return Math.abs(next - target) < TEXT_DAMP_EPS ? target : next
}

/** What `prefers-reduced-motion` means for one run mode. */
export interface ReducedMotionPolicy {
  /** Start the rAF loop at all? */
  runLoop: boolean
  /** Keep non-essential idle motion (auto-rotate / camera sway)? */
  idleSway: boolean
}

/**
 * Reduced-motion policy per run mode (pure; exported for tests).
 *
 * - `'scene'` (game kit): the game loop ALWAYS runs. Freezing a game leaves
 *   dead controls, which is a bug, not an accessibility feature. Reduced
 *   motion instead tones down non-essential motion: idle auto-rotate /
 *   camera sway is disabled while player-driven movement stays intact.
 * - `'particles'` / `'model'`: purely decorative ambient animation — honor
 *   the preference literally by settling to a single static frame (no loop).
 */
export function reducedMotionPolicy(
  mode: 'particles' | 'model' | 'scene',
  reduced: boolean,
): ReducedMotionPolicy {
  if (!reduced) return { runLoop: true, idleSway: true }
  return { runLoop: mode === 'scene', idleSway: false }
}

/**
 * Runs every registered cleanup exactly once and returns the fresh empty list
 * to store back. The input array is emptied before the first call, so a
 * cleanup that re-enters (or a concurrent drain) can never double-fire a
 * teardown, and a throwing cleanup never blocks the rest — device-loss
 * recovery must proceed past one broken listener. (Exported for tests.)
 */
export function drainCleanups(cleanups: Array<() => void>): Array<() => void> {
  for (const c of cleanups.splice(0)) {
    try {
      c()
    } catch {
      // One failing teardown must not abort recovery or leak the rest.
    }
  }
  return []
}

/**
 * Nulls every SceneObject's mesh handles so the scene's realize() re-registers
 * them on a fresh renderer after GPU device loss. Handles into a lost device
 * are dead: without this, attach() sees non-null handles, skips
 * re-registration, and the recovered canvas stays permanently blank.
 * (Exported for tests.)
 */
export function resetSceneHandles(scene: YuraScene | null): void {
  scene?.each(null, (obj) => {
    obj.handle = null
    obj.shadowHandle = null
  })
}

/** Fixed physics timestep for the scene path (seconds per sim tick). */
export const SCENE_FIXED_DT = 1 / 60
/** Max sim ticks per rendered frame (spiral-of-death guard). */
export const SCENE_MAX_STEPS = 5
/** Real-dt spike clamp (seconds) — tab switches, debugger pauses, GC stalls. */
export const SCENE_MAX_FRAME_DT = 0.25

/**
 * Fixed-timestep accumulator for the scene simulation. The variable-dt Euler
 * integrator made jump apex height framerate-dependent and turned sub-30fps
 * machines into slow motion (dt clamped to 1/30). Instead: accumulate real
 * frame time (spikes clamped), run zero or more fixed 1/60s ticks per rendered
 * frame, carry the fractional remainder. Past the step cap the excess time is
 * dropped so a stall never snowballs. (Exported for tests.)
 */
export class FixedStepAccumulator {
  private acc = 0

  constructor(
    readonly stepDt: number = SCENE_FIXED_DT,
    readonly maxSteps: number = SCENE_MAX_STEPS,
    readonly maxFrameDt: number = SCENE_MAX_FRAME_DT,
  ) {}

  /** Fractional sim time (seconds) carried into the next frame. */
  get remainder(): number {
    return this.acc
  }

  /**
   * Feed one rendered frame's real dt (seconds); returns how many fixed
   * ticks of `stepDt` the simulation should run this frame.
   */
  advance(realDt: number): number {
    this.acc += Math.min(Math.max(realDt, 0), this.maxFrameDt)
    // Epsilon absorbs float drift so a steady 60fps feed yields 1 tick/frame.
    let ticks = Math.floor(this.acc / this.stepDt + 1e-6)
    if (ticks > this.maxSteps) {
      ticks = this.maxSteps
      this.acc = 0 // drop time beyond the cap — never try to catch it up
    } else {
      this.acc = Math.max(this.acc - ticks * this.stepDt, 0)
    }
    return ticks
  }

  reset(): void {
    this.acc = 0
  }
}

/** Fallback texture-dimension limit when no GPU device is available to ask. */
export const FALLBACK_MAX_TEXTURE_DIM = 8192

/**
 * Clamps a requested canvas backing size to the device's 2D texture limit,
 * preserving aspect ratio. Oversized canvases (huge monitors x dpr x scale)
 * otherwise fail texture allocation outright. (Pure, exported for tests.)
 */
export function clampCanvasSize(
  width: number,
  height: number,
  maxDim: number = FALLBACK_MAX_TEXTURE_DIM,
): { width: number; height: number } {
  const w = Math.max(width, 0)
  const h = Math.max(height, 0)
  const longest = Math.max(w, h)
  if (longest <= maxDim) return { width: w, height: h }
  const k = maxDim / longest
  return {
    width: Math.min(w * k, maxDim),
    height: Math.min(h * k, maxDim),
  }
}

/** The subset of MediaQueryList the DPR watcher needs (injectable in tests). */
export interface DprMediaQuery {
  addEventListener(type: 'change', listener: () => void): void
  removeEventListener(type: 'change', listener: () => void): void
}

/**
 * Watches devicePixelRatio changes (window dragged to a different-DPI
 * monitor, browser zoom). A `(resolution: Ndppx)` media query only fires when
 * the ratio moves AWAY from N, so after every change the listener must be
 * re-registered against the NEW ratio. Returns a disposer that removes the
 * currently registered listener. (Exported for tests via injected fakes.)
 */
export function watchDprChanges(
  matchMediaFn: (query: string) => DprMediaQuery,
  getDpr: () => number,
  onChange: () => void,
): () => void {
  let disposed = false
  let removeCurrent: () => void = () => {}
  const register = (): void => {
    const mql = matchMediaFn(`(resolution: ${getDpr()}dppx)`)
    const handler = (): void => {
      removeCurrent()
      if (disposed) return
      onChange()
      register()
    }
    mql.addEventListener('change', handler)
    removeCurrent = () => mql.removeEventListener('change', handler)
  }
  register()
  return () => {
    disposed = true
    removeCurrent()
  }
}

/**
 * One-line HUD text for `YuraStats` — the exact string the demos used to
 * assemble by hand (pure; exported so `hud.textContent = formatStats(app.stats)`
 * is the whole integration).
 */
export function formatStats(stats: YuraStats): string {
  const k = (n: number): string => `${(n / 1000).toFixed(0)}k`
  return (
    `${stats.backend} · ${stats.fps} fps (${stats.frameMs} ms) · ` +
    `${k(stats.particles)} / ${k(stats.requestedParticles)} particles · ` +
    `res ×${stats.resolutionScale} · Q${stats.qualityLevel}`
  )
}

/** Ring capacity backing `YuraApp.frames()` — a 4s sparkline window at 60fps. */
export const FRAME_RING_CAPACITY = 240

/**
 * Fixed-capacity ring buffer of recent frame times (pure bookkeeping; exported
 * for tests and for demos that want their own sparkline source).
 */
export class FrameRing {
  private buf: number[]
  /** Next write slot. */
  private head = 0
  private count = 0

  constructor(readonly capacity: number = FRAME_RING_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`FrameRing capacity must be a positive integer, got ${capacity}`)
    }
    this.buf = new Array<number>(capacity)
  }

  get size(): number {
    return this.count
  }

  push(v: number): void {
    this.buf[this.head] = v
    this.head = (this.head + 1) % this.capacity
    if (this.count < this.capacity) this.count++
  }

  /** The last `n` pushed values, oldest → newest (fewer while still filling). */
  last(n: number = this.capacity): number[] {
    const take = Math.min(Math.max(Math.floor(n), 0), this.count)
    const out = new Array<number>(take)
    for (let i = 0; i < take; i++) {
      out[i] = this.buf[(this.head - take + i + this.capacity) % this.capacity]
    }
    return out
  }
}

/**
 * Interval bookkeeping behind `YuraApp.onStats()` (exported for tests). Each
 * `start()` returns an idempotent stop function; `stopAll()` is the dispose
 * hook — a stop handle used after `stopAll()` is a harmless no-op.
 */
export class StatsTicker {
  private timers = new Set<ReturnType<typeof setInterval>>()

  start(fn: () => void, intervalMs: number): () => void {
    const id = setInterval(fn, intervalMs)
    this.timers.add(id)
    return () => {
      if (!this.timers.delete(id)) return
      clearInterval(id)
    }
  }

  stopAll(): void {
    for (const id of this.timers) clearInterval(id)
    this.timers.clear()
  }
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
  /**
   * Physics values the user set explicitly via `.motion()`. `preset()`
   * re-applies them on top of the preset's motion so an explicit
   * `.motion({ turbulence: 0.8 })` survives a later `.preset('aurora')`
   * instead of being silently discarded (mirrors `shapeOverridden`).
   */
  private userMotion: Partial<MotionParams> = {}
  /**
   * The look the user set explicitly via `.look()`. `preset()` keeps it
   * instead of swapping in the preset's look, so
   * `.look(looks.sakura()).preset('aurora')` works in either order
   * (mirrors `userMotion`; look() always supplies a whole LookParams,
   * so retention is the full value rather than a per-key merge).
   */
  private userLook: LookParams | null = null
  private shapeSeq: ShapeSpec[] = [shapeRegistry.galaxy()]
  private shapeOverridden = false
  /** Pointer reactivity ships ON — the zero-config path is the flagship path. */
  private pointerEnabled = true
  /**
   * Cursor-gravity strength from `.interactive({ gravity })`, or null for the
   * classic pointer force field only. Deliberately NOT part of userMotion:
   * the injection is a per-frame dynamic composition (see tick), never a
   * sticky physics value that preset() would re-apply.
   */
  private pointerGravity: number | null = null
  private qualityMode: 'auto' | 'high' | 'low'
  private backendOpt: 'auto' | 'webgpu' | 'webgl2'

  private shapeData: Float32Array<ArrayBuffer>[] = []
  private morph = { pos: 0 as 0 | 1, phase: 'hold' as 'hold' | 'move', timer: 0, nextShape: 2 }
  /** App-level morph choreography — `.motion({ hold, morph, ease })` retunes these. */
  private holdSeconds = HOLD_SECONDS
  private morphSeconds = MORPH_SECONDS
  private morphEase: EaseFn = eases.cubic
  /** Timing of the transition currently in flight (morphNow can override per call). */
  private activeMorphSeconds = MORPH_SECONDS
  private activeMorphEase: EaseFn = eases.cubic
  /** Set by morphNow(): halts the automatic shape cycle on arrival. */
  private morphPinned = false
  /** ShapeSpec.kind currently living in [targetA, targetB] — mirrors every
   * writeTargetA/B call so text destinations are detectable per frame. */
  private targetKinds: [string, string] = ['galaxy', 'galaxy']
  /** Eased text-readability damping factor (1 = neutral). */
  private textDamp = TEXT_DAMP_NEUTRAL

  private rafId = 0
  private running = false
  private visible = true
  private disposed = false
  /** True while recoverFromDeviceLost() is in flight (re-entrancy guard). */
  private recovering = false
  private lastTime = 0
  private simTime = 0
  private fpsEma = 60
  /** Fixed-timestep accumulator — scene path only. */
  private sceneAccum = new FixedStepAccumulator()
  /** Scene sim clock: advances by SCENE_FIXED_DT per tick, never by frame dt. */
  private sceneSimTime = 0
  /** Device's real 2D texture limit, captured when the GPU is acquired. */
  private maxTextureDim = FALLBACK_MAX_TEXTURE_DIM

  private pointerNdc: [number, number] | null = null
  /** 1 right after a click, decaying — drives the shockwave burst. */
  private burst = 0
  private cleanups: Array<() => void> = []
  /** Recent frame times (ms) — fed by tick(), read by frames(). */
  private frameRing = new FrameRing()
  /** onStats() interval bookkeeping — stopped wholesale in dispose(). */
  private statsTicker = new StatsTicker()

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
    // Zero config IS the flagship config: `yura('#hero').run()` starts as the
    // full neon-galaxy experience. Any later .preset/.look/.shape/.particles
    // call overrides these exactly as before.
    this.preset('neon-galaxy')
  }

  /** Requested particle count (floored, min 1). The governor may simulate fewer under load. */
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
   *
   * Calling scene() again replaces the live scene: the previous scene is
   * detached first — its registered cleanups run and its GPU handles are
   * reset — so nothing from the old game silently keeps running or leaking.
   */
  scene(opts: SceneOptions = {}): YuraScene {
    if (this.sceneObj) {
      warnCode(
        SCENE_REPLACED_CODE,
        `scene() called again: the previous scene was detached (listeners removed, GPU handles reset). ` +
          `It stops receiving updates — call run() to start the new scene.`,
      )
      this.cleanups = drainCleanups(this.cleanups)
      resetSceneHandles(this.sceneObj)
    }
    this.sceneObj = new YuraScene(opts)
    return this.sceneObj
  }

  /**
   * The shortest path from zero to a running game:
   * `scene(opts)` → `setup(scene)` (sync or async) → `run()`, in one call.
   *
   *   yura('#game').game({ gravity: -20 }, (s) => {
   *     const hero = s.add('sphere', { radius: 0.5, body: 'dynamic' })
   *     s.camera.follow(hero)
   *   })
   *
   * Resolves with the scene once run() has started the loop.
   */
  game(setup?: GameSetup): Promise<YuraScene>
  game(opts: SceneOptions, setup?: GameSetup): Promise<YuraScene>
  async game(
    optsOrSetup: SceneOptions | GameSetup = {},
    maybeSetup?: GameSetup,
  ): Promise<YuraScene> {
    const setup = typeof optsOrSetup === 'function' ? optsOrSetup : maybeSetup
    const opts = typeof optsOrSetup === 'function' ? {} : optsOrSetup
    const scene = this.scene(opts)
    if (setup) await setup(scene)
    await this.run()
    return scene
  }

  /**
   * Two-stop color gradient, swept along each shape's palette coordinate
   * (core → rim for a galaxy, character order for text).
   *
   * @example
   * yura('#stage').gradient('#22d3ee', '#f472b6').run()
   */
  gradient(a: string, b: string): this {
    this.colorA = a
    this.colorB = b
    return this
  }

  /**
   * Apply a curated look by name or as full LookParams. Explicit looks are
   * sticky: a later `.preset()` keeps them. Unknown names throw a YuraError
   * (UNKNOWN_LOOK) listing the available looks.
   *
   * @example
   * yura('#hero').look('cyberpunk').run()
   */
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
    this.userLook = this.lookParams
    this.lookExplicit = true
    return this
  }

  /**
   * Motion physics plus morph choreography in one call. The physics fields
   * merge into the simulation params exactly as before; `hold`, `morph`
   * and `ease` retune the shape-cycle timing at runtime. All optional —
   * omitted knobs keep their current values.
   *
   * Explicitly-set physics fields are sticky: a later `.preset()` swaps its
   * own motion defaults in but keeps every key you set here, so
   * `.motion({ turbulence: 0.8 }).preset('aurora')` works in either order.
   */
  motion(m: Partial<MotionParams> & MotionTimingOptions): this {
    const { hold, morph, ease, ...physics } = m
    if (hold !== undefined) this.holdSeconds = Math.max(hold, 0)
    if (morph !== undefined) this.morphSeconds = Math.max(morph, MIN_MORPH_SECONDS)
    if (ease !== undefined) this.morphEase = resolveEase(ease)
    this.userMotion = { ...this.userMotion, ...physics }
    this.motionParams = { ...this.motionParams, ...physics }
    return this
  }

  /** Render a single shape (a ShapeSpec, or a string rendered as particle text). */
  shape(s: ShapeSpec | string): this {
    this.shapeSeq = [this.toShape(s)]
    this.shapeOverridden = true
    return this
  }

  /**
   * The sequence the automatic cycle morphs through (strings become text).
   * After `.shape()`, the explicit shape stays first and the sequence follows.
   *
   * @example
   * yura('#hero').morphTo([shapes.galaxy(), 'YURA', shapes.vortex()]).run()
   */
  morphTo(seq: Array<ShapeSpec | string>): this {
    const rest = seq.map((s) => this.toShape(s))
    this.shapeSeq = this.shapeOverridden ? [this.shapeSeq[0], ...rest] : rest.length ? rest : this.shapeSeq
    return this
  }

  /**
   * Apply a named preset — particles, gradient, look, motion, and shape
   * sequence in one call (see `presetNames()`). Values set explicitly via
   * `.motion()` / `.look()` / `.shape()` survive the swap.
   *
   * @example
   * yura('#hero').preset('cyberpunk').run()
   */
  preset(name: string): this {
    const p = resolvePreset(name)
    this.particleCount = p.particles
    this.colorA = p.colorA
    this.colorB = p.colorB
    // The preset look applies only when the user never pinned one through
    // .look() — an explicit look survives preset swaps, see userLook.
    this.lookParams = this.userLook ?? p.look
    // Preset motion replaces preset-era values, but keys the user set
    // explicitly through .motion() win — see userMotion.
    this.motionParams = { ...p.motion, ...this.userMotion }
    if (!this.shapeOverridden) this.shapeSeq = p.shapes
    return this
  }

  /**
   * Pointer reactivity. ON by default — call `.interactive(false)` for a
   * purely ambient background that ignores the cursor.
   *
   * Pass an options object to give the cursor gravity:
   * `.interactive({ gravity: 40 })` injects the pointer's world position
   * every frame as a `motion.attractors` well (positive pulls, negative
   * repels) alongside any attractors set via `.motion()`. A boolean call
   * only toggles reactivity and leaves the gravity configuration alone;
   * an object call without `gravity` restores the classic force field.
   */
  interactive(on: boolean | InteractiveOptions = true): this {
    if (typeof on === 'boolean') {
      this.pointerEnabled = on
      return this
    }
    this.pointerEnabled = true
    this.pointerGravity = on.gravity ?? null
    return this
  }

  /**
   * Morph the running swarm to a new shape right now (strings become text).
   * The automatic shape cycle pauses on the new shape until the app is
   * reconfigured. Before run(), behaves like .shape() (options are dropped).
   *
   * `sweep` staggers particles by their delay/palette coordinate so text
   * shapes assemble character-by-character; `direction` re-aims the sweep.
   * Defaults reproduce the previous uniform morph exactly.
   */
  async morphNow(s: ShapeSpec | string, opts: MorphNowOptions = {}): Promise<this> {
    return this.morphNowImpl(s, opts)
  }

  /**
   * A lyric video in one call: `app.lyrics([{ text: '君の声が', at: 0 }, …])`.
   * Sugar for the standalone `lyrics(app, lines, opts)`.
   */
  lyrics(lines: LyricLine[], opts: LyricsOptions = {}): LyricsRun {
    return runLyrics(this, lines, opts)
  }

  private async morphNowImpl(s: ShapeSpec | string, opts: MorphNowOptions = {}): Promise<this> {
    const spec = this.toShape(s)
    if (!this.renderer) {
      this.shape(spec)
      return this
    }
    const data = await Promise.resolve(spec.generate(this.particleCount))
    if (this.disposed || !this.renderer) return this
    const direction = opts.direction ?? 'ltr'
    if (direction !== 'ltr') applySweepDirection(data, direction)
    const m = this.morph
    // Mid-flight: adopt the nearer endpoint as the new origin so the goal
    // interpolation barely snaps (the swarm itself always moves smoothly).
    if (m.phase === 'move') {
      const k = Math.min(m.timer / this.activeMorphSeconds, 1)
      const e = this.activeMorphEase(k)
      const t = m.pos === 0 ? e : 1 - e
      m.pos = t > 0.5 ? (m.pos === 0 ? 1 : 0) : m.pos
    }
    if (m.pos === 0) this.renderer.writeTargetB(data)
    else this.renderer.writeTargetA(data)
    this.targetKinds[m.pos === 0 ? 1 : 0] = spec.kind
    // Per-particle sweep: the sign routes the shader to the DESTINATION
    // buffer's delay coordinate (+ = targetB, - = targetA). 0 = uniform.
    const spread = Math.min(Math.max(opts.sweep ?? 0, 0), 1)
    this.renderer.morphSpread = m.pos === 0 ? spread : -spread
    this.renderer.morphT = m.pos
    // Per-call duration/ease apply to THIS transition only; the app-level
    // choreography (.motion) is untouched and defaults are exactly it.
    this.activeMorphSeconds =
      opts.duration !== undefined ? Math.max(opts.duration, MIN_MORPH_SECONDS) : this.morphSeconds
    this.activeMorphEase = opts.ease !== undefined ? resolveEase(opts.ease) : this.morphEase
    m.phase = 'move'
    m.timer = 0
    this.morphPinned = true
    return this
  }

  /** Alias kept for spec §8.1 parity. */
  reactToPointer(): this {
    return this.interactive()
  }

  /** Live performance snapshot — backend, fps, particle counts, quality level. */
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

  /**
   * HUD sugar (F-HUD): invoke `cb` every `intervalMs` with fresh stats plus
   * the `formatStats` one-liner, so a demo HUD is
   * `app.onStats((_, text) => { hud.textContent = text })`. Returns a stop
   * function; every subscription also stops automatically on dispose().
   */
  onStats(cb: (stats: YuraStats, text: string) => void, intervalMs = 500): () => void {
    if (this.disposed) return () => {}
    return this.statsTicker.start(() => {
      if (this.disposed) return
      const s = this.stats
      cb(s, formatStats(s))
    }, intervalMs)
  }

  /** The last `n` frame times in ms, oldest → newest (sparkline feed). */
  frames(n = 120): readonly number[] {
    return this.frameRing.last(n)
  }

  /**
   * Mount the canvas, acquire the GPU, and start the render loop — the one
   * async step where everything configured so far comes to life. Falls back
   * WebGPU → WebGL2 → static poster, so it never leaves a white screen.
   *
   * @example
   * await yura('#hero').preset('aurora').run()
   */
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
    if (gpu) {
      this.maxTextureDim = gpu.device.limits?.maxTextureDimension2D ?? FALLBACK_MAX_TEXTURE_DIM
    }

    if (gpu && this.sceneObj) {
      return this.runScene(gpu.device)
    }
    if (gpu && this.modelUrl) {
      return this.runModel(gpu.device)
    }
    if (!gpu && this.sceneObj) {
      // A game cannot degrade to the decorative particle poster — dead
      // controls behind pretty dots reads as "broken". Say why, in-DOM.
      this.backend = 'poster'
      this.renderSceneUnsupported()
      return this
    }
    if (!gpu && this.modelUrl) {
      // PBR model path is WebGPU-only for now; keep the no-white-screen promise.
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
    // Time-to-wow: spawn the swarm ON the first shape (with a breath of
    // jitter for a settle-in shimmer) instead of a distant shell that takes
    // ~10 seconds to fly in. Frame one is already the finished picture.
    const seeded = new Float32Array(first.length)
    for (let i = 0; i < first.length; i += 4) {
      seeded[i] = first[i] + (Math.random() * 2 - 1) * 1.4
      seeded[i + 1] = first[i + 1] + (Math.random() * 2 - 1) * 1.4
      seeded[i + 2] = first[i + 2] + (Math.random() * 2 - 1) * 1.4
      seeded[i + 3] = first[i + 3]
    }
    this.renderer.writePositions(seeded)
    this.morph = { pos: 0, phase: 'hold', timer: 0, nextShape: 2 }
    this.targetKinds = [this.shapeSeq[0].kind, this.shapeSeq[0].kind]
    // First frame may already rest on a text shape (e.g. the cyberpunk
    // preset): start at the damped level directly — no visible pop.
    this.textDamp = textDampTarget(this.shapeSeq[0].kind === 'text', this.particleCount)
    this.renderer.textDamp = this.textDamp
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

    if (!reducedMotionPolicy('particles', prefersReducedMotion()).runLoop) {
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

  /** Stop the render loop; the last frame stays on screen. Reversed by resume(). */
  pause(): void {
    this.running = false
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
  }

  /** Restart the loop after pause(). No-op while running or after dispose(). */
  resume(): void {
    if (this.disposed || this.running) return
    this.running = true
    this.lastTime = performance.now()
    this.rafId = requestAnimationFrame(this.tick)
  }

  /** Tear down permanently: stop the loop, release GPU resources, remove the canvas. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pause()
    this.statsTicker.stopAll()
    this.cleanups = drainCleanups(this.cleanups)
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

    // Reduced motion must NOT freeze the game — dead controls are a bug, not
    // an accessibility feature. The loop always runs; only non-essential idle
    // motion (auto-rotate / camera sway) is toned down. See
    // reducedMotionPolicy() for the full policy.
    if (!reducedMotionPolicy('scene', prefersReducedMotion()).idleSway) {
      this.modelRenderer.autoRotate = 0
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

    if (!reducedMotionPolicy('model', prefersReducedMotion()).runLoop) {
      // A11y: a decorative model viewer settles to one static frame.
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
    let panning = false
    let lastX = 0
    let lastY = 0
    let downX = 0
    let downY = 0
    let downAt = 0
    const onDown = (e: PointerEvent) => {
      dragging = true
      panning = e.button === 2 || e.shiftKey
      lastX = downX = e.clientX
      lastY = downY = e.clientY
      downAt = performance.now()
      el.setPointerCapture?.(e.pointerId)
    }
    const onMove = (e: PointerEvent) => {
      if (!dragging || !this.modelRenderer) return
      if (panning) this.modelRenderer.panBy(-(e.clientX - lastX), e.clientY - lastY)
      else this.modelRenderer.rotateBy((e.clientX - lastX) * 0.006, (e.clientY - lastY) * 0.006)
      lastX = e.clientX
      lastY = e.clientY
    }
    const onUp = (e: PointerEvent) => {
      if (dragging && !panning && this.modelRenderer) {
        // A quick, still press is a CLICK: aim the camera at that spot.
        const moved = Math.hypot(e.clientX - downX, e.clientY - downY)
        if (moved < 6 && performance.now() - downAt < 250) {
          const rect = el.getBoundingClientRect()
          const d = clickAimDelta(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height)
          const r = this.modelRenderer
          r.aimTo(r.yaw + d.yaw, r.pitch + d.pitch)
        }
      }
      dragging = false
      panning = false
    }
    const onLeave = () => {
      dragging = false
      panning = false
    }
    const onDbl = () => this.modelRenderer?.resetView()
    const onCtx = (e: Event) => e.preventDefault() // right-drag pans
    const onWheel = (e: WheelEvent) => {
      if (!this.modelRenderer) return
      e.preventDefault()
      this.modelRenderer.zoomBy(1 + e.deltaY * 0.001)
    }
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointerleave', onLeave)
    el.addEventListener('dblclick', onDbl)
    el.addEventListener('contextmenu', onCtx)
    el.addEventListener('wheel', onWheel, { passive: false })
    this.cleanups.push(() => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointerleave', onLeave)
      el.removeEventListener('dblclick', onDbl)
      el.removeEventListener('contextmenu', onCtx)
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
      if (idx === 1) {
        this.renderer.writeTargetB(data)
        this.targetKinds[1] = this.shapeSeq[1].kind
      }
    }
  }

  /** Kind of the shape the swarm is morphing toward (or resting on). */
  private morphDestKind(): string {
    const m = this.morph
    // During a move the destination is the BACK buffer (pos 0 → targetB);
    // at rest the current shape is the front buffer the swarm sits on.
    if (m.phase === 'move') return this.targetKinds[m.pos === 0 ? 1 : 0]
    return this.targetKinds[m.pos]
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
    const size = clampCanvasSize(
      this.canvas.clientWidth * dpr * scale,
      this.canvas.clientHeight * dpr * scale,
      this.maxTextureDim,
    )
    target.resize(size.width, size.height)
  }

  private observeResize(): void {
    const ro = new ResizeObserver(() => this.applyResolution())
    ro.observe(this.container)
    this.cleanups.push(() => ro.disconnect())
    // ResizeObserver misses monitor-DPI changes (CSS size is unchanged), so
    // the canvas stayed blurry after a drag to another screen. Watch the
    // current dpr via matchMedia and re-render at the new density.
    if (typeof matchMedia === 'function') {
      this.cleanups.push(
        watchDprChanges(
          (q) => matchMedia(q),
          () => devicePixelRatio || 1,
          () => this.applyResolution(),
        ),
      )
    }
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
      if (!this.morphPinned && m.timer >= this.holdSeconds) {
        // The automatic cycle always morphs uniformly (legacy behavior);
        // only explicit morphNow({ sweep }) staggers particles.
        this.renderer.morphSpread = 0
        this.activeMorphSeconds = this.morphSeconds
        this.activeMorphEase = this.morphEase
        m.phase = 'move'
        m.timer = 0
      }
      return
    }
    const k = Math.min(m.timer / this.activeMorphSeconds, 1)
    const e = this.activeMorphEase(k)
    this.renderer.morphT = m.pos === 0 ? e : 1 - e
    // Extra turbulence mid-flight turns transitions into comet swarms.
    this.renderer.morphBoost = Math.sin(Math.PI * k) ** 2
    if (k >= 1) {
      m.pos = m.pos === 0 ? 1 : 0
      if (!this.morphPinned) {
        // Arrived at the far buffer. Preload the next shape into the buffer we left.
        const idx = m.nextShape % this.shapeData.length
        const next = this.shapeData[idx]
        const nextKind = this.shapeSeq[idx]?.kind ?? 'unknown'
        if (m.pos === 1) {
          this.renderer.writeTargetA(next)
          this.targetKinds[0] = nextKind
        } else {
          this.renderer.writeTargetB(next)
          this.targetKinds[1] = nextKind
        }
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
    this.frameRing.push(dtMs)

    if (this.governor.update(dtMs)) this.applyResolution()

    if (this.modelRenderer) {
      if (this.sceneObj) {
        // Fixed-timestep physics: identical jump arcs at any framerate. Feed
        // REAL frame dt (the accumulator clamps spikes itself — the MAX_DT
        // render clamp would reintroduce slow motion below 30fps). Multiple
        // ticks per frame are safe for input: step() ends with
        // input.endFrame(), so pressed() edges are consumed by the first tick
        // and the time-stamped jump buffer self-consumes on first read.
        const ticks = this.sceneAccum.advance(dtMs / 1000)
        for (let i = 0; i < ticks; i++) {
          this.sceneSimTime += SCENE_FIXED_DT
          this.sceneObj.step(SCENE_FIXED_DT, this.sceneSimTime)
        }
      }
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
        // Cursor gravity (.interactive({ gravity })): hand the renderer a
        // fresh motion snapshot with the pointer well composed in front of
        // the user's attractors. Composing on a COPY of motionParams keeps
        // the injection fully dynamic — motionParams/userMotion never see
        // the pointer entry, so preset() sticky-merges stay untouched.
        if (this.pointerGravity !== null) {
          this.renderer.motion = {
            ...this.motionParams,
            attractors: withPointerAttractor(
              this.motionParams.attractors,
              world,
              this.pointerGravity,
            ),
          }
        }
      }
      this.renderer.parallax = [
        this.renderer.parallax[0] * 0.92 + this.pointerNdc[0] * 0.08,
        this.renderer.parallax[1] * 0.92 + this.pointerNdc[1] * 0.08,
      ]
    } else {
      this.renderer.pointerStrength = 0
      // Pointer gone: hand back the un-injected params so the cursor well
      // disappears with the cursor. Only gravity mode ever touches
      // renderer.motion — default behavior is byte-identical to before.
      if (this.pointerGravity !== null) this.renderer.motion = this.motionParams
    }
    this.burst *= Math.exp(-dt * 5)

    // Text readability: ease the damping factor toward text-safe while the
    // morph destination is a text shape, back to exactly 1 on release.
    this.textDamp = easeDampFactor(
      this.textDamp,
      textDampTarget(this.morphDestKind() === 'text', this.particleCount),
      dt,
    )
    this.renderer.textDamp = this.textDamp

    this.renderer.frame(dt, this.simTime, this.activeCount())
    this.rafId = requestAnimationFrame(this.tick)
  }

  /**
   * GPU device loss (driver reset, GPU switch, backgrounded tab reclaim):
   * tear down everything the previous run registered, then re-run on a fresh
   * device. Two invariants keep repeated recoveries sound:
   *
   * 1. `cleanups` is drained BEFORE run() installs fresh listeners, so
   *    keyboard/resize/visibility handlers never accumulate per recovery.
   * 2. Scene mesh handles are nulled so the scene's realize() re-registers
   *    every mesh (and shadow) on the new renderer — stale handles into the
   *    lost device would otherwise leave the canvas permanently blank.
   */
  private async recoverFromDeviceLost(): Promise<void> {
    if (this.disposed || this.recovering) return
    this.recovering = true
    this.pause()
    this.cleanups = drainCleanups(this.cleanups)
    resetSceneHandles(this.sceneObj)
    this.renderer = null
    this.modelRenderer = null
    try {
      await this.run()
    } catch {
      this.backend = 'poster'
      this.renderPoster()
    } finally {
      this.recovering = false
    }
  }

  /**
   * Shown when a scene/game is configured but WebGPU is unavailable. Unlike
   * the decorative particle poster, a game cannot honestly degrade to a
   * static image — dead controls would read as "broken" — so render an
   * explicit in-DOM notice (readable by screen readers; the canvas itself is
   * aria-hidden) styled to match the library's night-sky aesthetic.
   */
  private renderSceneUnsupported(): void {
    const overlay = document.createElement('div')
    overlay.setAttribute('role', 'status')
    overlay.style.cssText =
      'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;' +
      'justify-content:center;gap:12px;padding:24px;text-align:center;box-sizing:border-box;' +
      'background:radial-gradient(ellipse at 50% 45%,#0b1023 0%,#04050c 100%);' +
      'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#e2e8f0;'
    const badge = document.createElement('div')
    badge.style.cssText =
      'width:44px;height:44px;border-radius:50%;opacity:0.9;' +
      `background:linear-gradient(135deg,${this.colorA},${this.colorB});` +
      'box-shadow:0 0 36px rgba(139,92,246,0.4);'
    const title = document.createElement('div')
    title.textContent = 'This game needs WebGPU'
    title.style.cssText = 'font-size:1.05rem;font-weight:600;letter-spacing:0.01em;'
    const hint = document.createElement('div')
    hint.textContent = 'Try Chrome or Edge 113+ (or another WebGPU-enabled browser).'
    hint.style.cssText = 'font-size:0.85rem;opacity:0.65;max-width:34ch;line-height:1.5;'
    overlay.append(badge, title, hint)
    this.container.appendChild(overlay)
    this.cleanups.push(() => overlay.remove())
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

/**
 * Entry point: create a chainable {@link YuraApp} bound to a container
 * element (CSS selector or node). Nothing renders until `.run()` — zero
 * config already is the flagship neon-galaxy experience.
 *
 * @example
 * import { yura } from 'yurayura'
 * yura('#hero').run() // a cursor-reactive million-particle galaxy
 */
export function yura(target: string | HTMLElement, options: YuraOptions = {}): YuraApp {
  return new YuraApp(target, options)
}
