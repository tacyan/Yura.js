import { YuraError, CODES, warnCode } from '@yura/core'
import { hash01 } from './motions'
import { wrapTime } from './lyrics'
import {
  kineticLyrics,
  planKinetic,
  kineticDuration,
  type KineticInput,
  type KineticLine,
  type KineticRun,
  type KineticScheduler,
  type KineticElement,
  type PlannedLine,
} from './kinetic'
import { motions, type KineticMoodName } from './motions'
import { stageThemes, type StageThemeName, type StageScheme, type StageTheme, type WorldName, type DecorName, type CameraName, type TransitionName } from './stage-themes'
import {
  cameraAt,
  cameraMoves,
  stageTransitions,
  transitionAt,
  shakeAt,
  accentFlash,
  grainOffset,
  beatPulse,
  beatPhase,
  TRANSITION_SECONDS,
  type CameraPose,
} from './stage-motion'
import { stageDecor, decorMarkup, decorLive } from './stage-decor'
import { createStageWorld, stageWorlds, type ThreeNamespace, type StageWorld } from './stage-world'

/**
 * lyricStage — a complete lyric hero section from one call.
 *
 * Layers, back to front, all driven by one clock:
 *   world     a Three.js space (your THREE) the camera flies through, or a
 *             CSS backdrop when THREE is not supplied / WebGL is missing
 *   decor     graphic marks under and over the text (brackets, timecode…)
 *   lyrics    kineticLyrics: real DOM text with web-typography motion
 *   cut       a transition overlay at every line boundary
 *   texture   grain, scanlines, paper, vignette
 *   flash     accent hits
 *
 * Every line is a "cut": a new colour scheme from the theme, a camera move,
 * a transition in, and a kinetic entrance. The plan is pure and seeded
 * ({@link planStage}); the shell only renders it.
 */

// ------------------------------------------------------------------ plan

/** Per-line direction chosen by the planner. */
export interface StageCut {
  scheme: number
  camera: CameraName
  /** Transition INTO this line (at its start). */
  transition: TransitionName
  accent: boolean
}

export interface StagePlanOptions {
  /** Art direction. Default 'noir'. */
  theme?: StageThemeName
  seed?: number
  /** Override the theme's motion moods. */
  mood?: KineticMoodName | 'mix'
  /** Override the theme's world. */
  world?: WorldName
  /** Override the theme's decor (false = none). */
  decor?: readonly DecorName[] | false
  /** Force one camera move / transition for every line. */
  camera?: CameraName
  transition?: TransitionName
  every?: number
  loop?: boolean
  loopTail?: number
  enterDuration?: number
  exitDuration?: number
  reducedMotion?: boolean
}

export interface StagePlan {
  theme: StageTheme
  themeName: StageThemeName
  world: WorldName
  decor: readonly DecorName[]
  lines: PlannedLine[]
  cuts: StageCut[]
  /** Loop length in seconds (0 = not looping). */
  duration: number
}

const DEFAULT_THEME: StageThemeName = 'noir'
const DEFAULT_SEED = 1

function unknown(kind: string, name: string, names: string[]): YuraError {
  return new YuraError(
    CODES.UNKNOWN_MOTION,
    `Unknown stage ${kind} "${name}". Available: ${names.join(', ')}.`,
    `lyricStage('#hero', lines, { ${kind}: '${names[0]}' })`,
  )
}

function check(kind: string, name: string | undefined, table: object): void {
  if (name !== undefined && !Object.prototype.hasOwnProperty.call(table, name)) throw unknown(kind, name, Object.keys(table))
}

function pickFrom<T>(pool: readonly T[], seed: number, i: number, salt: number, avoid?: T): T {
  let k = Math.floor(hash01(seed, i, salt) * pool.length)
  if (pool.length > 1 && pool[k] === avoid) k = (k + 1) % pool.length
  return pool[k]
}

/**
 * Resolves a whole lyric stage from lines and options: the kinetic plan
 * (drawn from the theme's moods) plus a cut per line — a colour scheme that
 * always changes when the theme has more than one, a camera move that does
 * not repeat back to back, and a transition in (accent lines always flash).
 * Pure and deterministic in `seed`. Throws YURA-019 on unknown names.
 */
export function planStage(lines: readonly KineticInput[], opts: StagePlanOptions = {}): StagePlan {
  const themeName = opts.theme ?? DEFAULT_THEME
  check('theme', themeName, stageThemes)
  check('world', opts.world, stageWorlds)
  check('camera', opts.camera, cameraMoves)
  check('transition', opts.transition, stageTransitions)
  if (opts.decor) for (const d of opts.decor) check('decor', d, stageDecor)
  const theme: StageTheme = stageThemes[themeName]
  const seed = Number.isFinite(opts.seed) ? (opts.seed as number) : DEFAULT_SEED

  const planned = planKinetic(lines, {
    seed,
    ...(opts.mood ? { mood: opts.mood } : { moods: theme.moods }),
    every: opts.every,
    loop: opts.loop,
    loopTail: opts.loopTail,
    enterDuration: opts.enterDuration,
    exitDuration: opts.exitDuration,
    reducedMotion: opts.reducedMotion,
  })

  const cuts: StageCut[] = []
  let prevScheme = -1
  let prevCamera: CameraName | undefined
  planned.forEach((line, i) => {
    let scheme = Math.floor(hash01(seed, i, 201) * theme.schemes.length)
    if (theme.schemes.length > 1 && scheme === prevScheme) scheme = (scheme + 1) % theme.schemes.length
    const camera = opts.camera ?? pickFrom(theme.cameras, seed, i, 202, prevCamera)
    const transition: TransitionName = opts.reducedMotion
      ? 'cut'
      : (opts.transition ?? (i === 0 && !opts.loop ? 'cut' : line.accent ? 'flash' : pickFrom(theme.transitions, seed, i, 203)))
    cuts.push({ scheme, camera, transition, accent: line.accent })
    prevScheme = scheme
    prevCamera = camera
  })

  return {
    theme,
    themeName,
    world: opts.world ?? theme.world,
    decor: opts.decor === false ? [] : (opts.decor ?? theme.decor),
    lines: planned,
    cuts,
    duration: kineticDuration(planned),
  }
}

/** Seconds a scroll-scrubbed stage spans: the last line's start plus one line's worth of hold. (Pure.) */
export function lyricSpanOf(plan: StagePlan, hold = 3): number {
  const last = plan.lines[plan.lines.length - 1]
  if (!last) return 0
  return Number.isFinite(last.end) ? last.end : last.start + hold
}

/** Index of the line on screen at `t` (-1 before the first). Lines are sorted. (Pure.) */
export function activeLine(plan: StagePlan, t: number): number {
  let k = -1
  for (let i = 0; i < plan.lines.length; i++) if (plan.lines[i].start <= t) k = i
  return k
}

/**
 * The cut transition covering `t`, if any: each line's incoming transition is
 * centred on its start. In a loop the first line's is its wrap-around. (Pure.)
 */
export function transitionState(plan: StagePlan, t: number): { name: TransitionName; p: number; seed: number } | null {
  const half = TRANSITION_SECONDS / 2
  for (let i = 0; i < plan.lines.length; i++) {
    const s = plan.lines[i].start
    if (t > s - half && t < s + half && (i > 0 || plan.duration > 0)) {
      const name = plan.cuts[i].transition
      if (name === 'cut') return null
      return { name, p: (t - (s - half)) / TRANSITION_SECONDS, seed: plan.lines[i].seed }
    }
  }
  // Wrap-around: the loop end leads into line 0.
  if (plan.duration > 0 && plan.lines.length && t > plan.duration - half) {
    const name = plan.cuts[0].transition
    if (name !== 'cut') return { name, p: (t - (plan.duration - half)) / TRANSITION_SECONDS, seed: plan.lines[0].seed }
  }
  return null
}

/** CSS custom properties for a scheme + theme type. (Pure.) */
export function schemeVars(s: StageScheme, theme: StageTheme): Record<string, string> {
  return {
    '--yura-bg': s.bg,
    '--yura-fg': s.fg,
    '--yura-sub': s.sub,
    '--yura-accent': s.accent,
    '--yura-accent2': s.accent2,
    '--yura-dim': s.dim,
    '--yura-split-a': s.ghostA,
    '--yura-split-b': s.ghostB,
    '--yura-display': theme.fonts.display,
    '--yura-serif': theme.fonts.serif,
    '--yura-mono': theme.fonts.mono,
  }
}

// ------------------------------------------------------------------ fit

/** Share of the stage a lyric row may span along its reading axis. */
const FIT_SHARE = 0.84
/** Lyric size in stage base units (em of the stage root). */
const LYRIC_EM = 4.6
/** Stage base size as a share of the stage's shorter side. */
const BASE_SHARE = 0.02

/**
 * Font-size multiplier that fits a line's longest row inside the stage
 * (width for horizontal layouts, height for tategaki). Oversized-crop layouts
 * are meant to overflow and are never shrunk. (Pure.)
 */
export function fitScale(line: PlannedLine, width: number, height: number): number {
  if (line.layout === 'giant' || !(width > 0 && height > 0)) return 1
  const layout = motions.layout[line.layout] as { fontScale?: number }
  const base = Math.min(width, height) * BASE_SHARE
  const glyphPx = base * LYRIC_EM * (layout.fontScale ?? 1)
  const longest = Math.max(1, ...line.rows)
  const room = (line.layout === 'vertical' ? height : width) * FIT_SHARE
  return Math.min(1, room / (longest * glyphPx))
}

// ------------------------------------------------------------------ shell

export interface StageOptions extends StagePlanOptions {
  /** Your THREE namespace (`import * as THREE from 'three'`). Omit for a CSS backdrop. */
  three?: ThreeNamespace
  /** Beats per minute for pulses, beat zooms and holds. Default 120. */
  bpm?: number
  /** Sync to a media element (its currentTime is the clock; looping is off unless set). */
  audio?: { currentTime: number }
  /** Custom timeline clock in seconds (wins over `audio`). */
  clock?: () => number
  title?: string
  artist?: string
  /** Grain / scanline / paper / vignette overlay. Default true. */
  texture?: boolean
  /** Camera follows the pointer a little. Default true. */
  parallax?: boolean
  /** 'live' (default): lines are announced. 'hidden': the stage is decorative (provide the text elsewhere). */
  a11y?: 'live' | 'hidden'
  /** Upper bound for the 3D canvas pixel ratio (the device ratio is read at runtime). Default 2. */
  maxPixelRatio?: number
  /** Frame scheduler / document — injectable for tests and offline rendering. */
  scheduler?: KineticScheduler
  document?: StageDocument
}

export interface StageRun {
  readonly element: KineticElement
  readonly plan: StagePlan
  /** True when a Three.js world is rendering (false = CSS backdrop). */
  readonly has3D: boolean
  stop(): void
  seek(t: number): void
  /** Draw the stage at second `t` now (frame-exact export). */
  render(t: number): void
}

/** The DOM surface the stage uses — real documents satisfy it. */
export interface StageDocument {
  createElement(tag: string): KineticElement & { innerHTML?: string; querySelectorAll?(sel: string): ArrayLike<KineticElement> }
  querySelector?(sel: string): KineticElement | null
}

const MAX_PIXEL_RATIO = 2
const MAX_FRAME_DT = 0.1
const PARALLAX_UNITS = 1.2
const PARALLAX_EASE = 4
const FALLBACK_FRAME_MS = 16
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
const GRAIN_TILE =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")"
const PAPER_TILE =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400'><filter id='p'><feTurbulence type='fractalNoise' baseFrequency='0.035' numOctaves='4' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(%23p)'/></svg>\")"

type Styled = KineticElement & { innerHTML?: string; querySelectorAll?(sel: string): ArrayLike<KineticElement>; getAttribute?(n: string): string | null }

function css(el: KineticElement, props: Record<string, string>): void {
  const style = el.style as Record<string, string> & { setProperty?(k: string, v: string): void }
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('--')) {
      if (typeof style.setProperty === 'function') style.setProperty(k, v)
      else style[k] = v
    } else style[k] = v
  }
}

function defaultScheduler(): KineticScheduler {
  if (typeof requestAnimationFrame === 'function') return { request: (cb) => requestAnimationFrame(cb), cancel: (h) => cancelAnimationFrame(h) }
  return { request: (cb) => setTimeout(cb, FALLBACK_FRAME_MS) as unknown as number, cancel: (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>) }
}

function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia(REDUCED_MOTION_QUERY).matches
  } catch {
    return false
  }
}

/**
 * Mounts a full lyric stage inside `target` (selector or element; it should
 * have a size — a stage with no height gets a 16:9 aspect ratio).
 *
 * ```ts
 * import * as THREE from 'three'
 * lyricStage('#hero', ['君の声が', { text: '夜を照らす', accent: true }], { three: THREE, theme: 'synthwave', bpm: 128 })
 * ```
 */
export function lyricStage(target: string | Element | KineticElement, lines: readonly KineticInput[], opts: StageOptions = {}): StageRun {
  const doc = opts.document ?? (typeof document !== 'undefined' ? (document as unknown as StageDocument) : undefined)
  const host = (typeof target === 'string' ? (doc?.querySelector?.(target) ?? null) : target) as (KineticElement & Partial<HTMLElement>) | null
  if (!doc || !host) {
    throw new YuraError(CODES.TARGET_NOT_FOUND, `Target "${String(target)}" not found in the document.`, `lyricStage(document.querySelector('#hero'), lines)`)
  }
  const reduced = opts.reducedMotion ?? prefersReducedMotion()
  const loop = opts.loop ?? !opts.audio
  const plan = planStage(lines, { ...opts, loop, reducedMotion: reduced })
  const theme = plan.theme
  const scheduler = opts.scheduler ?? defaultScheduler()
  const make = (tag = 'div'): Styled => doc.createElement(tag) as Styled

  // Host must be a positioned box with a size.
  try {
    const cs = typeof getComputedStyle === 'function' ? getComputedStyle(host as unknown as Element) : null
    if (cs && cs.position === 'static') css(host, { position: 'relative' })
    if (cs && (host as HTMLElement).clientHeight === 0) css(host, { aspectRatio: '16 / 9' })
  } catch {
    // Non-DOM host (tests): leave it alone.
  }

  const layer = (z: number, extra: Record<string, string> = {}): Styled => {
    const el = make()
    css(el, { position: 'absolute', inset: '0', zIndex: String(z), pointerEvents: 'none', ...extra })
    return el
  }
  const root = make()
  root.setAttribute('class', 'yura-stage')
  css(root, {
    position: 'absolute',
    inset: '0',
    overflow: 'hidden',
    background: 'var(--yura-bg)',
    color: 'var(--yura-fg)',
    contain: 'strict',
    fontFamily: theme.fonts.lyric === 'serif' ? theme.fonts.serif : theme.fonts.display,
  })
  if (opts.a11y === 'hidden') root.setAttribute('aria-hidden', 'true')
  const shake = layer(0, { willChange: 'transform' })
  const backdrop = layer(0)
  const decorBack = layer(1)
  // A soft halo in the background colour keeps the words legible over any world.
  const textHost = layer(2, { fontWeight: String(theme.fonts.weight), textShadow: '0 0 0.3em var(--yura-bg), 0 0 1em var(--yura-bg)' })
  const decorFront = layer(3)
  const cut = layer(4, { opacity: '0' })
  const texture = layer(5)
  const flash = layer(6, { background: 'var(--yura-flash, #ffffff)', opacity: '0' })
  for (const d of [backdrop, decorBack, decorFront, texture]) d.setAttribute('aria-hidden', 'true')
  shake.appendChild(backdrop)
  shake.appendChild(decorBack)
  shake.appendChild(textHost)
  shake.appendChild(decorFront)
  root.appendChild(shake)
  root.appendChild(cut)
  root.appendChild(texture)
  root.appendChild(flash)
  host.appendChild(root)

  // Texture layers (static CSS; only the grain position moves).
  const grain = layer(0, { backgroundImage: GRAIN_TILE, opacity: String(theme.texture.grain * 0.14), mixBlendMode: 'overlay' })
  const tex = opts.texture !== false
  if (tex) {
    texture.appendChild(grain)
    if (theme.texture.paper > 0) texture.appendChild(layer(0, { backgroundImage: PAPER_TILE, opacity: String(theme.texture.paper * 0.22), mixBlendMode: 'multiply' }))
    if (theme.texture.scan > 0)
      texture.appendChild(layer(0, { backgroundImage: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.5) 0 0.07em, transparent 0.07em 0.21em)', opacity: String(theme.texture.scan * 0.45) }))
    if (theme.texture.vignette > 0)
      texture.appendChild(layer(0, { background: `radial-gradient(ellipse at 50% 50%, transparent 52%, rgba(0,0,0,${theme.texture.vignette * 0.75}) 100%)` }))
  }

  // World: Three.js when given (and WebGL works), else a CSS backdrop.
  let world: StageWorld | null = null
  if (opts.three) {
    try {
      const canvas = make('canvas') as unknown as HTMLCanvasElement
      css(canvas as unknown as KineticElement, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block' })
      backdrop.appendChild(canvas as unknown as KineticElement)
      world = createStageWorld(opts.three, canvas, {
        name: plan.world,
        seed: plan.lines[0]?.seed ?? DEFAULT_SEED,
        lines: plan.lines.map((l) => l.text),
        fonts: theme.fonts,
        createCanvas: () => make('canvas') as unknown as HTMLCanvasElement,
      })
    } catch (e) {
      world = null
      warnCode(CODES.STAGE_3D_FALLBACK, `The Three.js world could not start (${e instanceof Error ? e.message : String(e)}); using the CSS backdrop.`)
    }
  }
  const glow = layer(0, { background: 'radial-gradient(circle at 50% 55%, var(--yura-dim) 0%, transparent 62%)' })
  const sweep = layer(0, { background: 'conic-gradient(from 0deg at 50% 50%, transparent 0 70%, var(--yura-accent) 78%, transparent 86%)', opacity: '0.08', inset: '-50%' })
  if (!world) {
    backdrop.appendChild(glow)
    backdrop.appendChild(sweep)
  }

  // Lyrics: kineticLyrics driven frame-by-frame by this stage's clock.
  let stageW = 0
  let stageH = 0
  const kinetic: KineticRun = kineticLyrics(textHost, lines, {
    seed: opts.seed,
    ...(opts.mood ? { mood: opts.mood } : { moods: theme.moods }),
    every: opts.every,
    loop,
    loopTail: opts.loopTail,
    enterDuration: opts.enterDuration,
    exitDuration: opts.exitDuration,
    bpm: opts.bpm,
    reducedMotion: reduced,
    size: `${LYRIC_EM}em`,
    document: doc,
    scheduler: { request: () => 0, cancel: () => {} },
    lineScale: (line) => fitScale(line, stageW, stageH),
  })
  if (opts.a11y === 'hidden') kinetic.element.setAttribute('aria-hidden', 'true')

  // Size: the base unit tracks the stage's shorter side, measured at runtime.
  const measure = (): void => {
    const el = host as unknown as HTMLElement
    const w = el.clientWidth ?? 0
    const h = el.clientHeight ?? 0
    if (!(w > 0 && h > 0)) return
    stageW = w
    stageH = h
    css(root, { fontSize: `${Math.min(w, h) * BASE_SHARE}px` })
    const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1
    world?.resize(w, h, Math.min(dpr, opts.maxPixelRatio ?? MAX_PIXEL_RATIO))
  }
  measure()
  let resizeObs: { disconnect(): void } | null = null
  if (typeof ResizeObserver === 'function' && typeof (host as HTMLElement).getBoundingClientRect === 'function') {
    const ro = new ResizeObserver(measure)
    ro.observe(host as unknown as Element)
    resizeObs = ro
  }

  // Visibility: skip rendering while the stage is off screen.
  let onScreen = true
  let visObs: { disconnect(): void } | null = null
  if (typeof IntersectionObserver === 'function' && typeof (host as HTMLElement).getBoundingClientRect === 'function') {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) onScreen = e.isIntersecting
    })
    io.observe(host as unknown as Element)
    visObs = io
  }

  // Pointer parallax.
  let aimX = 0
  let aimY = 0
  let camX = 0
  let camY = 0
  const onPointer = (e: { clientX: number; clientY: number }): void => {
    const r = (host as HTMLElement).getBoundingClientRect?.()
    if (!r || !(r.width > 0 && r.height > 0)) return
    aimX = ((e.clientX - r.left) / r.width - 0.5) * 2
    aimY = ((e.clientY - r.top) / r.height - 0.5) * 2
  }
  const parallax = opts.parallax !== false && !reduced && typeof (host as HTMLElement).addEventListener === 'function'
  if (parallax) (host as HTMLElement).addEventListener('pointermove', onPointer as unknown as EventListener, { passive: true })

  // Per-line state.
  let current = -2
  let liveEls: { el: KineticElement; kind: string }[] = []
  const lineTexts = plan.lines.map((l) => l.text)
  const enterLine = (i: number): void => {
    current = i
    const k = Math.max(i, 0)
    const cutInfo = plan.cuts[k]
    const scheme = theme.schemes[cutInfo?.scheme ?? 0]
    css(root, schemeVars(scheme, theme))
    world?.setScheme(scheme)
    world?.setLine(i, lineTexts[k] ?? '')
    const m = decorMarkup(plan.decor, {
      index: k + 1,
      total: plan.lines.length,
      text: lineTexts[k] ?? '',
      title: opts.title ?? '',
      artist: opts.artist ?? '',
      seed: plan.lines[k]?.seed ?? DEFAULT_SEED,
    })
    decorBack.innerHTML = m.back
    decorFront.innerHTML = m.front
    liveEls = []
    for (const layerEl of [decorBack, decorFront]) {
      const found = layerEl.querySelectorAll?.('[data-yura-live]') ?? []
      for (let j = 0; j < found.length; j++) {
        const el = found[j] as Styled
        liveEls.push({ el, kind: el.getAttribute?.('data-yura-live') ?? '' })
      }
    }
  }

  const totalSpan = (): number => {
    if (plan.duration > 0) return plan.duration
    const last = plan.lines[plan.lines.length - 1]
    return last ? last.start + (opts.every ?? 3.5) : 1
  }

  let lastT = 0
  const draw = (t: number): void => {
    const dt = Math.min(Math.max(t - lastT, 0), MAX_FRAME_DT)
    lastT = t
    const i = activeLine(plan, t)
    if (i !== current) enterLine(i)
    const k = Math.max(i, 0)
    const line = plan.lines[k]
    const cutInfo = plan.cuts[k]
    const local = line ? Math.max(0, t - line.start) : 0
    const span = line && Number.isFinite(line.end) ? line.end - line.start : (opts.every ?? 3.5)
    const u = span > 0 ? Math.min(1, local / span) : 1
    const pulse = reduced ? 0 : beatPulse(t, opts.bpm)

    // Text.
    kinetic.render(t)

    // Camera + world.
    const cam: CameraPose = cameraAt(cutInfo?.camera ?? 'float', u, local, { beat: reduced ? 0 : beatPhase(t, opts.bpm), seed: line?.seed, accent: cutInfo?.accent, reducedMotion: reduced })
    if (parallax) {
      const e = Math.min(1, dt * PARALLAX_EASE)
      camX += (aimX - camX) * e
      camY += (aimY - camY) * e
      cam.x += camX * PARALLAX_UNITS
      cam.y -= camY * PARALLAX_UNITS * 0.6
    }
    if (world) world.frame({ t: reduced ? 0 : t, dt: reduced ? 0 : dt, pulse, camera: cam })
    else if (!reduced) css(sweep, { transform: `rotate(${((t * 12) % 360).toFixed(2)}deg)` })

    // Transition overlay.
    const tr = transitionState(plan, t)
    const f = tr ? transitionAt(tr.name, tr.p, tr.seed) : null
    css(cut, f ? { opacity: String(f.opacity), background: f.background, clipPath: f.clipPath, transform: f.transform } : { opacity: '0' })

    // Accent hits.
    const hit = cutInfo?.accent && !reduced ? local : -1
    const sh = shakeAt(hit, line?.seed)
    css(shake, { transform: sh.x || sh.y ? `translate(${sh.x.toFixed(3)}em, ${sh.y.toFixed(3)}em) rotate(${sh.rotate.toFixed(3)}deg)` : 'none' })
    css(flash, { opacity: String(Math.round(accentFlash(hit) * 1000) / 1000) })

    // Grain + live decor.
    if (tex && !reduced) {
      const [gx, gy] = grainOffset(t)
      css(grain, { backgroundPosition: `${gx}% ${gy}%` })
    }
    const progress = t / totalSpan()
    for (const { el, kind } of liveEls) {
      const lf = decorLive(kind, t, progress, pulse)
      if (lf.text !== undefined && el.textContent !== lf.text) el.textContent = lf.text
      if (lf.transform !== undefined) css(el, { transform: lf.transform })
      if (lf.opacity !== undefined) css(el, { opacity: lf.opacity })
    }
  }

  // Clock.
  const wall = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000
  let origin = wall()
  const now = (): number => {
    const raw = opts.clock ? opts.clock() : opts.audio ? opts.audio.currentTime : wall() - origin
    const t = Number.isFinite(raw) ? raw : 0
    return loop && plan.duration > 0 ? wrapTime(t, plan.duration) : t
  }

  let stopped = false
  let handle: number | null = null
  const frame = (): void => {
    if (stopped) return
    // Background tabs need no check: the browser already stops rAF there.
    if (onScreen) draw(now())
    handle = scheduler.request(frame)
  }
  draw(now())
  handle = scheduler.request(frame)

  return {
    element: root,
    plan,
    has3D: world !== null,
    stop() {
      if (stopped) return
      stopped = true
      if (handle !== null) scheduler.cancel(handle)
      resizeObs?.disconnect()
      visObs?.disconnect()
      if (parallax) (host as HTMLElement).removeEventListener?.('pointermove', onPointer as unknown as EventListener)
      kinetic.stop()
      world?.dispose()
      root.remove()
    },
    seek(t: number) {
      if (!stopped && !opts.clock && !opts.audio && Number.isFinite(t)) origin = wall() - Math.max(0, t)
    },
    render(t: number) {
      if (!stopped) draw(t)
    },
  }
}

// ------------------------------------------------------------------ custom element

const STAGE_TAG = 'yura-lyric-stage'
/** Visually hidden but readable by assistive tech (the source lyrics stay in the page). */
const SR_ONLY = 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0'

/**
 * Reads lyric lines from an element's children: each child element is a line
 * (`data-at`, `data-accent`, `data-enter` / `data-hold` / `data-exit` /
 * `data-layout`); with no child elements, each non-empty text line is one.
 * A trailing `<br>`-free "\n" inside a child adds a row. (Pure over the given nodes.)
 */
export function readLyricNodes(
  children: ArrayLike<{ textContent: string | null; getAttribute(name: string): string | null; hasAttribute(name: string): boolean }>,
  fallbackText: string,
): KineticLine[] {
  const out: KineticLine[] = []
  for (let i = 0; i < children.length; i++) {
    const c = children[i]
    const text = (c.textContent ?? '').trim()
    if (!text) continue
    const line: KineticLine = { text }
    const at = Number.parseFloat(c.getAttribute('data-at') ?? '')
    if (Number.isFinite(at)) line.at = at
    if (c.hasAttribute('data-accent')) line.accent = true
    for (const phase of ['enter', 'hold', 'exit', 'layout'] as const) {
      const v = c.getAttribute(`data-${phase}`)
      if (v) (line as unknown as Record<string, string>)[phase] = v
    }
    out.push(line)
  }
  if (out.length) return out
  return fallbackText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((text) => ({ text }))
}

/** Attribute → option readers for the custom element. (Pure.) */
export function stageOptionsFromAttributes(get: (name: string) => string | null): StagePlanOptions & { bpm?: number; title?: string; artist?: string } {
  const num = (n: string): number | undefined => {
    const v = Number.parseFloat(get(n) ?? '')
    return Number.isFinite(v) ? v : undefined
  }
  const str = <T extends string>(n: string): T | undefined => (get(n) || undefined) as T | undefined
  const loopAttr = get('loop')
  const decorAttr = get('decor')
  const decor: readonly DecorName[] | false | undefined =
    decorAttr === null ? undefined : decorAttr.trim() === 'none' ? false : (decorAttr.split(/[\s,]+/).filter(Boolean) as DecorName[])
  return {
    ...(decor !== undefined ? { decor } : {}),
    theme: str<StageThemeName>('theme'),
    world: str<WorldName>('world'),
    mood: str<KineticMoodName | 'mix'>('mood'),
    camera: str<CameraName>('camera'),
    transition: str<TransitionName>('transition'),
    seed: num('seed'),
    bpm: num('bpm'),
    every: num('every'),
    title: get('song') ?? undefined,
    artist: get('artist') ?? undefined,
    ...(loopAttr !== null ? { loop: loopAttr !== 'false' } : {}),
  }
}

/**
 * Registers `<yura-lyric-stage>` — a drop-in lyric hero for any page:
 *
 * ```html
 * <yura-lyric-stage theme="synthwave" bpm="128" song="Song" artist="Artist">
 *   <p>君の声が</p>
 *   <p data-accent>夜を照らす</p>
 * </yura-lyric-stage>
 * ```
 *
 * Pass your THREE namespace to get the 3D world. The source lines stay in
 * the page (visually hidden) for search engines and screen readers; the
 * stage itself is decorative. Attributes: theme, world, mood, camera,
 * transition, decor (space-separated names, or "none"), seed, bpm, every, loop, song, artist, audio (a selector of an
 * <audio>/<video> to sync to). Changing an attribute rebuilds the stage.
 */
export function defineLyricStage(opts: { three?: ThreeNamespace; tag?: string } = {}): CustomElementConstructor | undefined {
  if (typeof customElements === 'undefined' || typeof HTMLElement === 'undefined') return undefined
  const tag = opts.tag ?? STAGE_TAG
  const existing = customElements.get(tag)
  if (existing) return existing
  injectDefaultStyle(tag)

  class LyricStageElement extends HTMLElement {
    static observedAttributes = ['theme', 'world', 'mood', 'camera', 'transition', 'decor', 'seed', 'bpm', 'every', 'loop', 'song', 'artist', 'audio']
    private run: StageRun | null = null
    private lines: KineticLine[] = []
    /** Set by yuraSite for [data-yura-scrub] sections: the stage then plays with the scroll. */
    scrubClock?: () => number

    /** Seconds from the first line to the end of the last one (what a scrub maps the scroll onto). */
    get lyricSpan(): number {
      return this.run ? lyricSpanOf(this.run.plan) : 0
    }

    connectedCallback(): void {
      if (!this.lines.length) {
        this.lines = readLyricNodes(
          Array.from(this.children) as unknown as ArrayLike<{ textContent: string | null; getAttribute(n: string): string | null; hasAttribute(n: string): boolean }>,
          this.textContent ?? '',
        )
        for (const c of Array.from(this.children)) (c as HTMLElement).style.cssText += `;${SR_ONLY}`
        if (!this.children.length) {
          const src = document.createElement('div')
          src.style.cssText = SR_ONLY
          src.textContent = this.textContent ?? ''
          this.textContent = ''
          this.appendChild(src)
        }
      }
      this.start()
    }

    disconnectedCallback(): void {
      this.run?.stop()
      this.run = null
    }

    attributeChangedCallback(): void {
      if (this.run) this.start()
    }

    private start(): void {
      this.run?.stop()
      const base = stageOptionsFromAttributes((n) => this.getAttribute(n))
      const audioSel = this.getAttribute('audio')
      const audio = audioSel ? (document.querySelector(audioSel) as HTMLMediaElement | null) : null
      try {
        const scrub = this.scrubClock ? { clock: this.scrubClock, loop: false } : {}
        this.run = lyricStage(this, this.lines, { ...base, three: opts.three, a11y: 'hidden', ...(audio ? { audio } : {}), ...scrub })
      } catch (e) {
        this.run = null
        console.error(e)
      }
    }
  }
  customElements.define(tag, LyricStageElement)
  return LyricStageElement
}

function injectDefaultStyle(tag: string): void {
  if (typeof document === 'undefined' || document.querySelector(`style[data-yura-stage="${tag}"]`)) return
  const style = document.createElement('style')
  style.setAttribute('data-yura-stage', tag)
  // :where() keeps specificity at zero, so any page CSS overrides these defaults.
  style.textContent = `:where(${tag}){display:block;position:relative;aspect-ratio:16/9;overflow:hidden;background:#000}`
  document.head.appendChild(style)
}
