import { YuraError, CODES } from '@yura/core'
import { segmentGraphemes } from './shapes'
import { normalizeLines, orderLines, wrapTime } from './lyrics'
import {
  motions,
  kineticMoods,
  kineticCatalog,
  identityPose,
  composePose,
  glyphRank,
  glyphProgress,
  hash01,
  ACCENT_ENTERS,
  ACCENT_HOLD,
  type GlyphPose,
  type MotionGlyph,
  type MotionPhase,
  type EnterName,
  type HoldName,
  type ExitName,
  type LayoutName,
  type KineticMoodName,
  type TransitionRecipe,
} from './motions'

/**
 * DOM lyric motion: the same timed-lyric input as {@link lyrics}, rendered as
 * real text — split into per-grapheme spans and animated with CSS transform,
 * opacity, filter and clip-path — using the web-typography vocabulary in
 * `motions.ts`. Selectable, accessible, crisp at any resolution, and happy
 * to sit on top of a particle canvas.
 *
 * Structure mirrors lyrics.ts: a pure core (planKinetic → framePoses →
 * poseToStyle) that tests drive frame by frame, and one impure shell
 * (kineticLyrics) that owns the DOM and the clock.
 */

// ------------------------------------------------------------------ input

/** One timed line for {@link kineticLyrics}; any motion field overrides the planner. */
export interface KineticLine {
  text: string
  /** Seconds from timeline start. Omit to auto-time `every` seconds after the previous line. */
  at?: number
  enter?: EnterName
  hold?: HoldName
  exit?: ExitName
  layout?: LayoutName
  /** A決め line (hook, chorus head): drawn from the loud accent entrances with a beat pulse. */
  accent?: boolean
}

/** A kinetic line, or bare text — sugar for `{ text }`. */
export type KineticInput = KineticLine | string

/** Planner knobs shared by {@link planKinetic} and {@link kineticLyrics}. */
export interface KineticPlanOptions {
  /** Which mood the planner draws from. 'mix' draws each line from any mood. Default 'calm'. */
  mood?: KineticMoodName | 'mix'
  /** A pool of moods: each line draws its mood from here (overrides `mood`). */
  moods?: readonly KineticMoodName[]
  /** Seed for every choice and every per-glyph random. Same seed → same video. Default 1. */
  seed?: number
  /** Force one recipe for every line (a line's own field still wins). */
  enter?: EnterName
  hold?: HoldName
  exit?: ExitName
  layout?: LayoutName
  /** Seconds between auto-timed lines. Default 3.5. */
  every?: number
  /** Seconds an entrance takes (capped to a share of short lines). Default 0.9. */
  enterDuration?: number
  /** Seconds an exit takes (capped likewise). Default 0.6. */
  exitDuration?: number
  /** Loop the timeline: the last line exits and the run wraps after `loopTail`. */
  loop?: boolean
  /** Seconds the last line holds before a loop wraps. Default 3.2. */
  loopTail?: number
  /** Map every motion to its quietest form (fade / still). Default false. */
  reducedMotion?: boolean
}

/** One line after planning: timing and the resolved recipe names. */
export interface PlannedLine {
  text: string
  /** Graphemes in reading order ('\n' row breaks removed). */
  glyphs: string[]
  /** Glyph count of each '\n'-separated row. */
  rows: number[]
  /** Seconds: arrives at `start`, is gone at `end` (Infinity = holds forever). */
  start: number
  end: number
  enterDuration: number
  exitDuration: number
  enter: EnterName
  hold: HoldName
  exit: ExitName
  layout: LayoutName
  accent: boolean
  /** Per-line seed (derived from the run seed and the line index). */
  seed: number
}

const DEFAULT_EVERY = 3.5
const DEFAULT_ENTER_S = 0.9
const DEFAULT_EXIT_S = 0.6
const DEFAULT_TAIL = 3.2
const DEFAULT_SEED = 1
/** Short lines give the entrance at most this share of their on-screen time… */
const ENTER_SHARE_MAX = 0.45
/** …and the exit at most this share, so a line always gets a readable hold. */
const EXIT_SHARE_MAX = 0.3
/** Default tempo for beat-locked holds when no bpm is given. */
export const DEFAULT_BPM = 120
const SECONDS_PER_MINUTE = 60
const SALT_PLAN = 101
const SALT_LINE_SEED = 102

/** Seconds, finite and non-negative — anything else falls back. */
function seconds(v: number | undefined, fallback: number): number {
  return v !== undefined && Number.isFinite(v) && v >= 0 ? v : fallback
}

function assertName(phase: MotionPhase, name: string | undefined): void {
  if (name === undefined) return
  if (!Object.prototype.hasOwnProperty.call(motions[phase], name)) {
    const names = Object.keys(motions[phase])
    throw new YuraError(
      CODES.UNKNOWN_MOTION,
      `Unknown ${phase} motion "${String(name)}". Available: ${names.join(', ')}.`,
      `kineticLyrics('#stage', lines, { ${phase}: '${names[0]}' })  // or see kineticCatalog()`,
    )
  }
}

function assertMood(mood: string): void {
  if (mood !== 'mix' && !Object.prototype.hasOwnProperty.call(kineticMoods, mood)) {
    throw new YuraError(
      CODES.UNKNOWN_MOTION,
      `Unknown kinetic mood "${mood}". Available: ${[...Object.keys(kineticMoods), 'mix'].join(', ')}.`,
      `kineticLyrics('#stage', lines, { mood: 'calm' })`,
    )
  }
}

/** Seeded pick from a pool, re-rolling once to avoid repeating `avoid`. */
function pick<T>(pool: readonly T[], seed: number, line: number, salt: number, avoid?: T): T {
  let k = Math.floor(hash01(seed, line, SALT_PLAN + salt) * pool.length)
  if (pool.length > 1 && pool[k] === avoid) k = (k + 1) % pool.length
  return pool[k]
}

/**
 * Resolves timing and a recipe for every phase of every line. Line fields
 * beat run-level overrides, which beat the mood's seeded draw; consecutive
 * lines never repeat the same entrance when the pool allows. Pure and
 * deterministic in `seed`. Throws YURA-019 on an unknown recipe or mood.
 */
export function planKinetic(lines: readonly KineticInput[], opts: KineticPlanOptions = {}): PlannedLine[] {
  const moodName = opts.mood ?? 'calm'
  assertMood(moodName)
  for (const m of opts.moods ?? []) assertMood(m)
  for (const phase of ['enter', 'hold', 'exit', 'layout'] as const) assertName(phase, opts[phase])
  const seed = Number.isFinite(opts.seed) ? (opts.seed as number) : DEFAULT_SEED
  const every = seconds(opts.every, DEFAULT_EVERY)
  const enterS = seconds(opts.enterDuration, DEFAULT_ENTER_S)
  const exitS = seconds(opts.exitDuration, DEFAULT_EXIT_S)
  const tail = seconds(opts.loopTail, DEFAULT_TAIL)
  const pool: readonly KineticMoodName[] =
    opts.moods && opts.moods.length ? opts.moods : moodName === 'mix' ? (Object.keys(kineticMoods) as KineticMoodName[]) : [moodName]

  const normalized = normalizeLines(
    lines.map((l) => (typeof l === 'string' ? { text: l } : l)),
    every,
  ) as (KineticLine & { at: number })[]
  const ordered = orderLines(normalized) as (KineticLine & { at: number })[]

  let prevEnter: EnterName | undefined
  return ordered.map((line, i) => {
    for (const phase of ['enter', 'hold', 'exit', 'layout'] as const) assertName(phase, line[phase])
    const mood = kineticMoods[pool.length === 1 ? pool[0] : pick(pool, seed, i, 0)]
    const accent = line.accent === true
    const start = Number.isFinite(line.at) ? line.at : 0
    const next = ordered[i + 1]
    const end = next ? Math.max(next.at, start) : opts.loop ? start + tail : Infinity
    const span = Number.isFinite(end) ? end - start : Infinity

    let enter: EnterName = line.enter ?? opts.enter ?? pick(accent ? ACCENT_ENTERS : mood.enter, seed, i, 1, prevEnter)
    let hold: HoldName = line.hold ?? opts.hold ?? (accent ? ACCENT_HOLD : pick(mood.hold, seed, i, 2))
    let exit: ExitName = line.exit ?? opts.exit ?? pick(mood.exit, seed, i, 3)
    const layout: LayoutName = line.layout ?? opts.layout ?? (accent ? 'center' : pick(mood.layout, seed, i, 4))
    if (opts.reducedMotion) {
      enter = 'fade'
      hold = 'still'
      exit = 'fade'
    }
    prevEnter = enter

    const rowsText = line.text.split('\n')
    const rowGlyphs = rowsText.map((r) => segmentGraphemes(r))
    return {
      text: line.text,
      glyphs: rowGlyphs.flat(),
      rows: rowGlyphs.map((r) => r.length),
      start,
      end,
      enterDuration: Math.min(enterS, span * ENTER_SHARE_MAX),
      exitDuration: Number.isFinite(end) ? Math.min(exitS, span * EXIT_SHARE_MAX) : 0,
      enter,
      hold,
      exit,
      layout,
      accent,
      seed: Math.floor(hash01(seed, i, SALT_LINE_SEED) * 0x7fffffff),
    }
  })
}

/** Loop length of a plan (0 when not looping or empty). (Pure.) */
export function kineticDuration(plan: readonly PlannedLine[]): number {
  const last = plan[plan.length - 1]
  return last && Number.isFinite(last.end) ? last.end : 0
}

// ------------------------------------------------------------------ frame

function transition(recipe: TransitionRecipe, p: number, g: MotionGlyph): Partial<GlyphPose> {
  const rank = glyphRank(recipe.order ?? 'ltr', g.i, g.n, g.seed)
  return recipe.pose(glyphProgress(p, rank, recipe.stagger ?? 0.5), { ...g, rank })
}

/**
 * Every glyph's pose for one line at timeline second `t`, or null when the
 * line is off screen (before `start`, at or after `end`). The layout offset,
 * entrance or exit, and hold compose in that order; the hold runs from the
 * moment the line starts so it blends through the entrance. (Pure.)
 */
export function framePoses(line: PlannedLine, t: number, bpm = DEFAULT_BPM): GlyphPose[] | null {
  if (!Number.isFinite(t) || t < line.start || t >= line.end) return null
  const local = t - line.start
  const beat = SECONDS_PER_MINUTE / (Number.isFinite(bpm) && bpm > 0 ? bpm : DEFAULT_BPM)
  const enter = motions.enter[line.enter]
  const hold = motions.hold[line.hold]
  const exit = motions.exit[line.exit]
  const layout = motions.layout[line.layout] as { offset?: (g: MotionGlyph) => { x: number; y: number } }
  const exitFrom = line.end - line.exitDuration
  const n = line.glyphs.length

  return line.glyphs.map((char, i) => {
    const g: MotionGlyph = { i, n, seed: line.seed, char, rank: n <= 1 ? 0 : i / (n - 1) }
    const pose = identityPose()
    if (layout.offset) composePose(pose, layout.offset(g))
    if (local < line.enterDuration) composePose(pose, transition(enter, local / line.enterDuration, g))
    else if (line.exitDuration > 0 && t >= exitFrom) composePose(pose, transition(exit, (t - exitFrom) / line.exitDuration, g))
    composePose(pose, hold.pose(local, g, beat))
    return pose
  })
}

/** Which phase a line is in at second `t` (null = off screen). (Pure.) */
export function phaseAt(line: PlannedLine, t: number): 'enter' | 'hold' | 'exit' | null {
  if (!Number.isFinite(t) || t < line.start || t >= line.end) return null
  if (t - line.start < line.enterDuration) return 'enter'
  if (line.exitDuration > 0 && t >= line.end - line.exitDuration) return 'exit'
  return 'hold'
}

/** Default pivot for glyph transforms. */
const CENTER_ORIGIN = '50% 50%'

/**
 * The transform-origin glyphs need at second `t`: the active transition's
 * pivot (hinges and flips), else the hold's, else the glyph center. (Pure.)
 */
export function originAt(line: PlannedLine, t: number): string {
  const phase = phaseAt(line, t)
  const holdOrigin = (motions.hold[line.hold] as { origin?: string }).origin
  if (phase === 'enter') return (motions.enter[line.enter] as TransitionRecipe).origin ?? holdOrigin ?? CENTER_ORIGIN
  if (phase === 'exit') return (motions.exit[line.exit] as TransitionRecipe).origin ?? holdOrigin ?? CENTER_ORIGIN
  return holdOrigin ?? CENTER_ORIGIN
}

// ------------------------------------------------------------------ CSS

/** Inline style strings for one glyph (the exact values kineticLyrics writes). */
export interface GlyphStyle {
  transform: string
  opacity: string
  filter: string
  clipPath: string
  textShadow: string
}

/** Default tints for the chromatic split ghosts — overridable per page via CSS variables. */
const SPLIT_A = 'var(--yura-split-a, #ff2a6d)'
const SPLIT_B = 'var(--yura-split-b, #22d3ee)'
/** Below this, a value is treated as zero (keeps idle glyphs at transform: none). */
const EPS = 1e-4

const num = (v: number): string => {
  const r = Math.round((Number.isFinite(v) ? v : 0) * 10000) / 10000
  return String(Object.is(r, -0) ? 0 : r)
}
const on = (v: number): boolean => Number.isFinite(v) && Math.abs(v) > EPS

/**
 * Serializes a pose into inline CSS. Identity parts are omitted, so an idle
 * glyph writes `none` everywhere and the browser can skip compositing it.
 * Non-finite fields collapse to their rest value instead of reaching CSS.
 * (Pure.)
 */
export function poseToStyle(pose: GlyphPose): GlyphStyle {
  const t: string[] = []
  if (on(pose.x) || on(pose.y)) t.push(`translate(${num(pose.x)}em, ${num(pose.y)}em)`)
  if (on(pose.tx) || on(pose.ty)) t.push(`translate(${num(pose.tx)}%, ${num(pose.ty)}%)`)
  if (on(pose.rx)) t.push(`rotateX(${num(pose.rx)}deg)`)
  if (on(pose.ry)) t.push(`rotateY(${num(pose.ry)}deg)`)
  if (on(pose.rotate)) t.push(`rotate(${num(pose.rotate)}deg)`)
  if (on(pose.skew)) t.push(`skewX(${num(pose.skew)}deg)`)
  const sx = (Number.isFinite(pose.scale) ? pose.scale : 1) * (Number.isFinite(pose.sx) ? pose.sx : 1)
  const sy = (Number.isFinite(pose.scale) ? pose.scale : 1) * (Number.isFinite(pose.sy) ? pose.sy : 1)
  if (on(sx - 1) || on(sy - 1)) t.push(sx === sy ? `scale(${num(sx)})` : `scale(${num(sx)}, ${num(sy)})`)

  const opacity = Number.isFinite(pose.opacity) ? Math.min(1, Math.max(0, pose.opacity)) : 1
  const clipOn = pose.clip.some(on)
  const shadows: string[] = []
  if (on(pose.glow) && pose.glow > 0) shadows.push(`0 0 ${num(pose.glow)}em currentColor`)
  if (on(pose.split)) shadows.push(`${num(pose.split)}em 0 ${SPLIT_A}`, `${num(-pose.split)}em 0 ${SPLIT_B}`)
  return {
    transform: t.length ? t.join(' ') : 'none',
    opacity: num(opacity),
    filter: on(pose.blur) && pose.blur > 0 ? `blur(${num(pose.blur)}em)` : 'none',
    clipPath: clipOn ? `inset(${pose.clip.map((c) => `${num(c)}%`).join(' ')})` : 'none',
    textShadow: shadows.length ? shadows.join(', ') : 'none',
  }
}

// ------------------------------------------------------------------ DOM shell

/** Minimal DOM surface kineticLyrics touches — real elements satisfy it; tests pass fakes. */
export interface KineticElement {
  style: Record<string, string> | CSSStyleDeclaration
  appendChild(child: KineticElement): unknown
  remove(): void
  setAttribute(name: string, value: string): void
  textContent: string | null
}
interface KineticDocument {
  createElement(tag: string): KineticElement
  querySelector?(sel: string): KineticElement | null
}

/** Frame scheduler (requestAnimationFrame-shaped). Injectable for tests and offline export. */
export interface KineticScheduler {
  request(cb: () => void): number
  cancel(handle: number): void
}

/** Options for {@link kineticLyrics}: the planner knobs plus rendering and clock. */
export interface KineticOptions extends KineticPlanOptions {
  /** Base font size as any CSS length. Default '8vmin' (scales with the viewport). */
  size?: string
  /** CSS font-family / weight for the lyric text. Inherited from the target when omitted. */
  font?: string
  weight?: string | number
  color?: string
  /** Beats per minute for beat-locked holds (pulse / hop). Default 120. */
  bpm?: number
  /** Omit to follow the OS prefers-reduced-motion setting; true/false forces it. */
  reducedMotion?: boolean
  /** Timeline clock in seconds — e.g. `() => audio.currentTime` to sync to a song. */
  clock?: () => number
  /** Frame scheduler. Default: requestAnimationFrame (setTimeout where absent). */
  scheduler?: KineticScheduler
  /** Document to build elements with (defaults to the global one). */
  document?: KineticDocument
  /** Per-line font-size multiplier, read when a line mounts (fit long lines to their box). */
  lineScale?: (line: PlannedLine) => number
}

/** Handle to a running DOM lyric timeline. */
export interface KineticRun {
  /** The overlay element holding the lines. */
  readonly element: KineticElement
  /** The resolved per-line plan (timing and recipe names). */
  readonly plan: readonly PlannedLine[]
  /** Stop the frame loop and remove the overlay. */
  stop(): void
  /** Jump the built-in clock to `t` seconds (no effect with a custom `clock`). */
  seek(t: number): void
  /** Draw the timeline at second `t` right now (frame-exact export, custom loops). */
  render(t: number): void
}

const FALLBACK_FRAME_MS = 16
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
const DEFAULT_SIZE = '8vmin'
/** Perspective for 3D flips, in em so it scales with the text. */
const PERSPECTIVE = '6em'

function defaultScheduler(): KineticScheduler {
  if (typeof requestAnimationFrame === 'function') {
    return { request: (cb) => requestAnimationFrame(cb), cancel: (h) => cancelAnimationFrame(h) }
  }
  return {
    request: (cb) => setTimeout(cb, FALLBACK_FRAME_MS) as unknown as number,
    cancel: (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>),
  }
}

function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia(REDUCED_MOTION_QUERY).matches
  } catch {
    return false
  }
}

function setStyle(el: KineticElement, props: Readonly<Record<string, string>>): void {
  const style = el.style as Record<string, string>
  for (const [k, v] of Object.entries(props)) style[k] = v
}

interface MountedLine {
  el: KineticElement
  glyphs: KineticElement[]
  /** Last written style per glyph — unchanged frames skip the DOM entirely. */
  last: (GlyphStyle & { char: string })[]
  origin: string
}

/**
 * Plays timed lyric lines as animated DOM text inside `target` (a selector or
 * element). Lines mount when they arrive and unmount when they leave, so the
 * DOM stays small for a song of any length. Each line carries an aria-label
 * with its plain text while the per-glyph spans are aria-hidden.
 *
 * ```ts
 * kineticLyrics('#stage', ['君の声が', { text: '夜を照らす', accent: true }], { mood: 'pop' })
 * ```
 */
export function kineticLyrics(
  target: string | Element | KineticElement,
  lines: readonly KineticInput[],
  opts: KineticOptions = {},
): KineticRun {
  const doc = opts.document ?? (typeof document !== 'undefined' ? (document as unknown as KineticDocument) : undefined)
  const host = typeof target === 'string' ? (doc?.querySelector?.(target) ?? null) : (target as KineticElement)
  if (!doc || !host) {
    throw new YuraError(
      CODES.TARGET_NOT_FOUND,
      `Target "${String(target)}" not found in the document.`,
      `kineticLyrics(document.querySelector('#stage'), lines)`,
    )
  }
  const reduced = opts.reducedMotion ?? prefersReducedMotion()
  const plan = planKinetic(lines, { ...opts, reducedMotion: reduced })
  const duration = kineticDuration(plan)
  const scheduler = opts.scheduler ?? defaultScheduler()

  const root = doc.createElement('div')
  root.setAttribute('class', 'yura-kinetic')
  root.setAttribute('aria-live', 'polite')
  setStyle(root, {
    position: 'absolute',
    inset: '0',
    overflow: 'hidden',
    pointerEvents: 'none',
    fontSize: opts.size ?? DEFAULT_SIZE,
    lineHeight: '1.25',
    ...(opts.font ? { fontFamily: opts.font } : {}),
    ...(opts.weight !== undefined ? { fontWeight: String(opts.weight) } : {}),
    ...(opts.color ? { color: opts.color } : {}),
  })
  host.appendChild(root)

  const mounted = new Map<number, MountedLine>()
  const lineScaleOf = (line: PlannedLine): number => {
    const k = opts.lineScale ? opts.lineScale(line) : 1
    return Number.isFinite(k) && k > 0 ? k : 1
  }

  const mount = (index: number): MountedLine => {
    const line = plan[index]
    const layout = motions.layout[line.layout] as { box: Record<string, string>; fontScale?: number }
    const el = doc.createElement('div')
    el.setAttribute('aria-label', line.text)
    setStyle(el, {
      position: 'absolute',
      inset: '0',
      display: 'flex',
      perspective: PERSPECTIVE,
      fontSize: `${(layout.fontScale ?? 1) * lineScaleOf(line)}em`,
      ...layout.box,
    })
    const block = doc.createElement('div')
    block.setAttribute('aria-hidden', 'true')
    el.appendChild(block)
    const glyphs: KineticElement[] = []
    let g = 0
    line.rows.forEach((count) => {
      const row = doc.createElement('div')
      setStyle(row, { whiteSpace: 'pre' })
      for (let k = 0; k < count; k++, g++) {
        const span = doc.createElement('span')
        span.textContent = line.glyphs[g]
        setStyle(span, { display: 'inline-block', willChange: 'transform, opacity' })
        row.appendChild(span)
        glyphs.push(span)
      }
      block.appendChild(row)
    })
    root.appendChild(el)
    const m: MountedLine = { el, glyphs, last: [], origin: '' }
    mounted.set(index, m)
    return m
  }

  const render = (t: number): void => {
    for (let i = 0; i < plan.length; i++) {
      const poses = framePoses(plan[i], t, opts.bpm)
      const m = mounted.get(i)
      if (!poses) {
        if (m) {
          m.el.remove()
          mounted.delete(i)
        }
        continue
      }
      const line = m ?? mount(i)
      const origin = originAt(plan[i], t)
      if (origin !== line.origin) {
        for (const span of line.glyphs) setStyle(span, { transformOrigin: origin })
        line.origin = origin
      }
      poses.forEach((pose, k) => {
        const s = { ...poseToStyle(pose), char: pose.char ?? plan[i].glyphs[k] }
        const prev = line.last[k]
        const span = line.glyphs[k]
        if (!prev || prev.char !== s.char) span.textContent = s.char
        if (!prev || prev.transform !== s.transform || prev.opacity !== s.opacity || prev.filter !== s.filter || prev.clipPath !== s.clipPath || prev.textShadow !== s.textShadow) {
          // An idle glyph clears its text-shadow rather than writing 'none', so a halo
          // the page (or lyricStage) sets on an ancestor still reaches the text.
          setStyle(span, { transform: s.transform, opacity: s.opacity, filter: s.filter, clipPath: s.clipPath, textShadow: s.textShadow === 'none' ? '' : s.textShadow })
        }
        line.last[k] = s
      })
    }
  }

  let stopped = false
  let handle: number | null = null
  const wall = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000
  let origin = wall()
  const now = (): number => {
    const raw = opts.clock ? opts.clock() : wall() - origin
    const t = Number.isFinite(raw) ? raw : 0
    return opts.loop && duration > 0 ? wrapTime(t, duration) : t
  }
  const frame = (): void => {
    if (stopped) return
    render(now())
    handle = scheduler.request(frame)
  }
  handle = scheduler.request(frame)

  return {
    element: root,
    plan,
    stop() {
      stopped = true
      if (handle !== null) scheduler.cancel(handle)
      handle = null
      root.remove()
      mounted.clear()
    },
    seek(t: number) {
      if (!stopped && !opts.clock && Number.isFinite(t)) origin = wall() - Math.max(t, 0)
    },
    render(t: number) {
      if (!stopped) render(t)
    },
  }
}

export { motions, kineticMoods, kineticCatalog }
