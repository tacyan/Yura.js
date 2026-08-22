export interface QualityLevel {
  /** Render-resolution scale relative to CSS pixels x devicePixelRatio. */
  res: number
  /** Fraction of the requested particle count actually simulated + drawn. */
  frac: number
}

/**
 * From best to worst. The governor walks down under load, back up when idle.
 * Resolution is the main lever (fill-bound HDR + additive overdraw); the
 * particle fraction never falls below ~1/5 or the picture starves to black
 * even with intensity compensation.
 */
export const DEFAULT_LEVELS: QualityLevel[] = [
  { res: 1.0, frac: 1.0 },
  { res: 0.85, frac: 1.0 },
  { res: 0.75, frac: 0.85 },
  { res: 0.7, frac: 0.65 },
  { res: 0.6, frac: 0.5 },
  { res: 0.55, frac: 0.35 },
  { res: 0.5, frac: 0.28 },
  { res: 0.42, frac: 0.22 },
]

/**
 * Frame-budget feedback controller (F-006). Watches an EMA of frame time and
 * steps through quality levels with hysteresis so it never oscillates.
 *
 * Climbing back up probes the better level and backs off exponentially when
 * the probe fails. The climb threshold sits just above the budget (not far
 * below it) because rAF deltas are vsync-quantized: on a 60 Hz display an
 * idle frame still reads ~16.7 ms, so a "well under budget" test would keep
 * quality pinned down forever.
 */
export class QualityGovernor {
  level = 0
  enabled = true

  private ema = 16.7
  private framesSinceChange = 0
  private goodFrames = 0
  private clockMs = 0
  private blockedUntil = 0
  private climbBackoffMs = 4000
  private lastClimbAt = -Infinity

  constructor(
    private readonly levels: QualityLevel[] = DEFAULT_LEVELS,
    private readonly budgetMs = 17.2,
  ) {
    // An empty level list would make current() undefined and poison every
    // consumer of res/frac; fall back to the defaults instead.
    if (this.levels.length === 0) this.levels = DEFAULT_LEVELS
  }

  current(): QualityLevel {
    return this.levels[this.level]
  }

  get frameMs(): number {
    return this.ema
  }

  /** Feed one frame's duration in ms. Returns true when the level changed. */
  update(dtMs: number): boolean {
    if (!this.enabled) return false
    // NaN/Infinity would pollute the EMA (and clock) forever; skip the frame.
    if (!Number.isFinite(dtMs)) return false
    this.clockMs += dtMs
    // Cap one frame's contribution: a single 100+ ms hitch (GC, background
    // shape generation) must not read as sustained GPU load, while a real
    // 40 ms steady state still sits far over budget and steps down.
    this.ema = this.ema * 0.92 + Math.min(dtMs, 40) * 0.08
    this.framesSinceChange++
    if (this.framesSinceChange < 30) return false

    if (this.ema > this.budgetMs * 1.12 && this.level < this.levels.length - 1) {
      this.level++
      // A drop soon after a climb means the probe failed: back off harder.
      // A drop out of the blue resets the backoff to its base.
      this.climbBackoffMs =
        this.clockMs - this.lastClimbAt < 5000
          ? Math.min(this.climbBackoffMs * 2, 60_000)
          : 4000
      this.blockedUntil = this.clockMs + this.climbBackoffMs
      // Fresh measurement for the new level: keeping the old level's polluted
      // EMA cascades drops straight past the equilibrium level.
      this.ema = this.budgetMs
      this.framesSinceChange = 0
      this.goodFrames = 0
      return true
    }
    if (this.ema < this.budgetMs * 1.05 && this.clockMs >= this.blockedUntil) {
      this.goodFrames++
      if (this.goodFrames > 240 && this.level > 0) {
        this.level--
        this.lastClimbAt = this.clockMs
        this.ema = this.budgetMs
        this.framesSinceChange = 0
        this.goodFrames = 0
        return true
      }
    } else {
      this.goodFrames = 0
    }
    return false
  }

  setLevel(level: number): void {
    if (Number.isNaN(level)) level = 0
    this.level = Math.max(0, Math.min(this.levels.length - 1, level))
    this.framesSinceChange = 0
    this.goodFrames = 0
  }
}
