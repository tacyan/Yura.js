/**
 * Per-frame exposure/trail compensation math shared by BOTH particle
 * backends (WebGPU and WebGL2). Single source of truth: the two renderers
 * used to carry byte-identical copies of these formulas, which meant a tweak
 * to one silently drifted the other's look. Every constant and operation here
 * is exactly the code both renderers previously inlined, in the same order,
 * so extraction is bit-exact (IEEE-754 double ops are deterministic).
 *
 * Pure module: no GPU types, no DOM, no state — safe to unit-test headlessly.
 */

/**
 * Trails below this persistence (seconds) are treated as "off": the fade
 * pass clears fully (fadeAlpha 1) and no trail compensation is applied.
 */
export const TRAIL_OFF_THRESHOLD = 0.02

/** Gain applied to fadeAlpha when deriving the trail intensity compensation. */
export const TRAIL_COMP_GAIN = 1.4

/** Floor of the trail intensity compensation (long trails never dim below this). */
export const TRAIL_COMP_FLOOR = 0.06

/**
 * Exponent of the survivor-brightening curve when the quality governor sheds
 * particles (matches perceived total light rather than linear energy).
 */
export const COUNT_COMP_EXPONENT = 0.7

/** Cap on survivor brightening so tiny active counts cannot blow out. */
export const COUNT_COMP_MAX = 4

/** Inputs to {@link computeFrameComp}; all raw values, clamping happens inside. */
export interface FrameCompInput {
  /** Trail persistence in seconds (raw `look.trail`; negative treated as 0). */
  trail: number
  /** Frame delta time in seconds. */
  dt: number
  /** Full configured particle count (the renderer's allocation). */
  count: number
  /** Active particle count actually simulated/drawn this frame (>= 1). */
  activeCount: number
  /** Raw text-readability damping factor (clamped to [0, 1]; 1 = neutral). */
  textDamp: number
}

/** Per-frame compensation factors derived by {@link computeFrameComp}. */
export interface FrameComp {
  /**
   * Trail decay alpha for the fade pass, framerate-independent:
   * 1 - exp(-dt / trail), or 1 when trails are off.
   */
  fadeAlpha: number
  /**
   * Particle intensity compensation for trail accumulation, so steady-state
   * HDR levels stay comparable across trail lengths. 1 when trails are off.
   */
  trailComp: number
  /**
   * Survivor brightening when the governor sheds particles:
   * min((count / activeCount)^0.7, 4) — keeps total light comparable.
   */
  countComp: number
  /**
   * Text-readability damping clamped to [0, 1]. Multiplies particle
   * intensity, bloom strength, and streak strength; 1 is a bit-exact no-op.
   */
  damp: number
}

/**
 * Compute the per-frame exposure/trail compensation factors.
 *
 * Both backends consume the results identically:
 * - fade pass alpha        <- fadeAlpha
 * - particle intensity     <- look.intensity * trailComp * countComp * damp
 * - bloom strength         <- look.bloomStrength * damp
 * - streak strength        <- look.streak * damp
 * (The multiplications stay in the callers, preserving the original
 * left-to-right operation order, so results are bit-identical.)
 */
export function computeFrameComp(input: FrameCompInput): FrameComp {
  // Trail decay per frame, framerate-independent. Compensate particle
  // intensity so steady-state accumulation stays in a sane HDR range.
  const trail = Math.max(input.trail, 0)
  // A non-finite dt has no meaningful decay curve, and NaN would flow into the
  // fade pass and paint the whole frame as undefined. Fall back to the
  // trails-off branch (full clear). A NaN trail already lands here, because
  // `NaN > TRAIL_OFF_THRESHOLD` is false.
  const trailOn = trail > TRAIL_OFF_THRESHOLD && Number.isFinite(input.dt)
  const fadeAlpha = trailOn ? 1 - Math.exp(-input.dt / trail) : 1
  const trailComp = trailOn
    ? Math.min(Math.max(fadeAlpha * TRAIL_COMP_GAIN, TRAIL_COMP_FLOOR), 1)
    : 1
  // When the governor sheds particles, brighten the survivors so the total
  // light on screen stays comparable — otherwise low levels fade to black.
  // A zero configured count divided by a zero active count is NaN, which
  // Math.pow and Math.min both pass straight through into particle intensity.
  // Infinity is already handled by the COUNT_COMP_MAX clamp, so only NaN needs
  // the neutral fallback — every finite input stays bit-identical.
  const ratio = input.count / input.activeCount
  const countComp = Number.isNaN(ratio)
    ? 1
    : Math.min(Math.pow(ratio, COUNT_COMP_EXPONENT), COUNT_COMP_MAX)
  // Text-readability damping (1 = bit-exact neutral, see field docs). NaN reads
  // as neutral rather than surviving the clamp it is supposed to obey.
  const damp = Number.isNaN(input.textDamp) ? 1 : Math.min(Math.max(input.textDamp, 0), 1)
  return { fadeAlpha, trailComp, countComp, damp }
}
