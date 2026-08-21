import { text as textShape, sphere, vortex, type ShapeSpec, type TextAlign } from './shapes'
import type { YuraApp, SweepDirection } from './app'

/**
 * Lyric-motion timeline: a few lines of text with start times become an
 * After-Effects-style kinetic typography run — each line's particles
 * assemble character-by-character (via morphNow's sweep), hold crisp, then
 * dissolve or explode into the next line.
 *
 * The scheduling core (ordering, timing table, interstitial insertion,
 * loop wrap, catch-up collapse) is pure and exported for tests; only
 * lyrics() itself touches the app and the wall clock.
 */

export interface LyricLine {
  text: string
  /** Seconds from timeline start. */
  at: number
  /** Per-line overrides (fall back to the run options). */
  sweep?: number
  direction?: SweepDirection
  /** Replace the text shape entirely (e.g. a logo image shape). */
  shape?: ShapeSpec
}

export interface LyricsOptions {
  /** CSS font shorthand forwarded to shapes.text (weight rides inside). */
  font?: string
  /** Entrance styling. Default 'assemble'. 'rain' = random glitter assembly. */
  style?: 'assemble' | 'rain' | 'explode'
  /** 0..1 character stagger forwarded to morphNow. Default 0.7 (0.9 for rain). */
  sweep?: number
  /** Line exit: morph straight to the next line, or blast apart first. */
  out?: 'dissolve' | 'explode'
  loop?: boolean
  /** Seconds the last line holds before a loop wraps. Default 3.2. */
  loopTail?: number
  /** Seconds an explode interstitial leads the next line. Default 0.9. */
  interstitialLead?: number
  /** Forwarded to shapes.text. */
  letterSpacing?: number
  lineGap?: number
  align?: TextAlign
  worldWidth?: number
}

export interface LyricsRun {
  stop(): void
  seek(t: number): void
}

export interface LyricEvent {
  /** Seconds from timeline start. */
  time: number
  kind: 'line' | 'interstitial'
  /** Index into the ordered lines ('interstitial': the upcoming line). */
  line: number
}

const DEFAULT_LEAD = 0.9
const DEFAULT_TAIL = 3.2

/** Stable sort of lyric lines by start time. (Pure; exported for tests.) */
export function orderLines(lines: LyricLine[]): LyricLine[] {
  return lines
    .map((line, i) => ({ line, i }))
    .sort((a, b) => a.line.at - b.line.at || a.i - b.i)
    .map((e) => e.line)
}

/**
 * Timing table for a lyric run: one 'line' event per line (sorted by `at`),
 * plus — for 'explode' exits — a scatter interstitial shortly before each
 * following line. The interstitial leads the line by `lead` seconds but never
 * fires before the midpoint of the gap (or at all when lines coincide).
 * (Pure; exported for tests.)
 */
export function buildTimeline(
  lines: LyricLine[],
  opts: { out?: 'dissolve' | 'explode'; lead?: number } = {},
): LyricEvent[] {
  const out = opts.out ?? 'dissolve'
  const lead = opts.lead ?? DEFAULT_LEAD
  const ordered = orderLines(lines)
  const events: LyricEvent[] = []
  ordered.forEach((line, i) => {
    if (out === 'explode' && i > 0) {
      const prev = ordered[i - 1]
      const t = Math.max(line.at - lead, (prev.at + line.at) / 2)
      if (t > prev.at && t < line.at) events.push({ time: t, kind: 'interstitial', line: i })
    }
    events.push({ time: line.at, kind: 'line', line: i })
  })
  return events
}

/** Loop length: last event plus a tail hold. (Pure; exported for tests.) */
export function timelineDuration(events: LyricEvent[], tail = DEFAULT_TAIL): number {
  return events.length ? events[events.length - 1].time + tail : 0
}

/** Wraps a timeline clock into [0, duration). (Pure; exported for tests.) */
export function wrapTime(t: number, duration: number): number {
  if (duration <= 0) return 0
  return ((t % duration) + duration) % duration
}

/**
 * Advances the cursor past every event due at `now` and names the single
 * event to fire (-1 = none). When several are overdue (background-tab
 * throttling, a seek), stale ones collapse: only the NEWEST due event fires,
 * which is exactly the timeline state at `now`. (Pure; exported for tests.)
 */
export function advanceCursor(
  events: LyricEvent[],
  cursor: number,
  now: number,
): { cursor: number; fire: number } {
  let c = Math.max(cursor, 0)
  let fire = -1
  while (c < events.length && events[c].time <= now) {
    fire = c
    c++
  }
  return { cursor: c, fire }
}

/**
 * Runs a lyric timeline against a live app. Timing is wall-clock
 * (performance.now deltas) on a self-correcting setTimeout loop, so a
 * throttled background tab catches up to the correct line on return instead
 * of replaying every missed morph.
 */
export function lyrics(app: YuraApp, lines: LyricLine[], opts: LyricsOptions = {}): LyricsRun {
  const style = opts.style ?? 'assemble'
  const out = opts.out ?? (style === 'explode' ? 'explode' : 'dissolve')
  const sweep = opts.sweep ?? (style === 'rain' ? 0.9 : 0.7)
  const direction: SweepDirection = style === 'rain' ? 'random' : 'ltr'
  const ordered = orderLines(lines)
  const events = buildTimeline(ordered, { out, lead: opts.interstitialLead })
  const duration = timelineDuration(events, opts.loopTail)
  const textOpts = {
    font: opts.font,
    letterSpacing: opts.letterSpacing,
    lineGap: opts.lineGap,
    align: opts.align,
    worldWidth: opts.worldWidth,
  }

  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let cursor = 0
  /** Wall-clock second that corresponds to timeline t = 0. */
  let origin = performance.now() / 1000

  const fire = (ev: LyricEvent): void => {
    const line = ordered[ev.line]
    if (ev.kind === 'line') {
      void app.morphNow(line.shape ?? textShape(line.text, textOpts), {
        sweep: line.sweep ?? sweep,
        direction: line.direction ?? direction,
      })
    } else {
      // Brief blast between lines: alternate a light-tornado and a shell
      // burst so consecutive explosions read differently.
      const blast =
        ev.line % 2 === 1 ? vortex({ height: 15, radius: 9 }) : sphere({ radius: 12 })
      void app.morphNow(blast, { sweep: 0.25, direction: 'random' })
    }
  }

  const tick = (): void => {
    if (stopped) return
    let now = performance.now() / 1000 - origin
    if (opts.loop && duration > 0 && now >= duration) {
      const wrapped = wrapTime(now, duration)
      origin += now - wrapped
      now = wrapped
      cursor = 0
    }
    const step = advanceCursor(events, cursor, now)
    cursor = step.cursor
    if (step.fire !== -1) fire(events[step.fire])
    if (cursor >= events.length) {
      if (!opts.loop || duration <= 0) return // finished; the last line holds
      timer = setTimeout(tick, Math.min(Math.max(duration - now, 0.02), 0.25) * 1000)
      return
    }
    const delay = Math.min(Math.max(events[cursor].time - now, 0.02), 0.25)
    timer = setTimeout(tick, delay * 1000)
  }

  timer = setTimeout(tick, 0)

  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
    },
    seek(t: number) {
      if (stopped) return
      const target = opts.loop && duration > 0 ? wrapTime(t, duration) : Math.max(t, 0)
      origin = performance.now() / 1000 - target
      const step = advanceCursor(events, 0, target)
      cursor = step.cursor
      if (step.fire !== -1) fire(events[step.fire])
      if (timer) clearTimeout(timer)
      timer = setTimeout(tick, 20)
    },
  }
}
