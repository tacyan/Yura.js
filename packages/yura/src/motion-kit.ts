import type { MotionGlyph, TransitionRecipe } from './motions'

/**
 * Shared building blocks for the lyric-motion vocabulary: the seeded hash,
 * easing curves, and the small numeric helpers every recipe pack uses.
 *
 * Kept apart from motions.ts so the recipe packs (light, water, kinetic…)
 * can import them without a module cycle: motions.ts assembles the packs,
 * and the packs only need these pure functions plus type-only imports.
 */

/**
 * Deterministic 0..1 hash of up to three integers (a murmur-style finalizer).
 * The only source of "randomness" in the motion vocabulary. (Pure.)
 */
export function hash01(a: number, b = 0, c = 0): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x632be5ab, 0x165667b1) ^ Math.imul((c | 0) + 0x5bd1e995, 0x61c88647)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

// ------------------------------------------------------------------ numeric

export const TAU = Math.PI * 2
/** Clamps to 0..1; NaN clamps to 0 (Math.min/max would pass it through). */
export const clamp01 = (v: number): number => (Number.isNaN(v) ? 0 : Math.min(1, Math.max(0, v)))
export const frac = (v: number): number => v - Math.floor(v)
/** Centered ±0.5 hash. */
export const signedHash = (a: number, b: number, c: number): number => hash01(a, b, c) - 0.5
/** 0 → 1 → 0 bump over 0..1 (peaks at the middle). */
export const bump = (p: number): number => Math.sin(clamp01(p) * Math.PI)
/** Smooth 0..1 step between edges a and b. */
export const smooth = (a: number, b: number, v: number): number => {
  const t = clamp01((v - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/**
 * Smooth seeded noise in about -1..1 from a few incommensurate sines — for
 * candle flicker, caustic shimmer and water drift that must never repeat
 * visibly yet stay a pure function of time. (Pure.)
 */
export function drift(t: number, seed: number, salt: number): number {
  let v = 0
  for (let k = 1; k <= 3; k++) v += Math.sin(t * (0.7 * k + hash01(seed, k, salt) * 0.9) + hash01(seed, k, salt + 13) * TAU) / k
  return v / 1.83
}

// ------------------------------------------------------------------ easing

export const outCubic = (t: number): number => 1 - (1 - t) ** 3
export const outQuart = (t: number): number => 1 - (1 - t) ** 4
export const outExpo = (t: number): number => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t))
export const outSine = (t: number): number => Math.sin((clamp01(t) * Math.PI) / 2)
export const inCubic = (t: number): number => t * t * t
export const inQuad = (t: number): number => t * t
export const inExpo = (t: number): number => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10))
export const inOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
const BACK_OVERSHOOT = 1.70158
export const outBack = (t: number): number => {
  const u = t - 1
  return 1 + (BACK_OVERSHOOT + 1) * u * u * u + BACK_OVERSHOOT * u * u
}
export const inBack = (t: number): number => (BACK_OVERSHOOT + 1) * t * t * t - BACK_OVERSHOOT * t * t
export const outElastic = (t: number): number =>
  t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -10 * t) * Math.sin(((t * 10 - 0.75) * 2 * Math.PI) / 3) + 1
export const outBounce = (t: number): number => {
  const n = 7.5625
  const d = 2.75
  if (t < 1 / d) return n * t * t
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375
  return n * (t -= 2.625 / d) * t + 0.984375
}
/**
 * Damped oscillation that is exactly 0 at p = 1 (and at p = 0): ripples,
 * wobbles and springs that settle to rest without a final pop. (Pure.)
 */
export const ring = (p: number, cycles: number, decay = 4): number => {
  const q = clamp01(p)
  // `+ 0` turns the -0 at the ends into 0, so rest poses compare equal to identity.
  return Math.sin(q * cycles * TAU) * Math.exp(-q * decay) * (1 - q) + 0
}

// ------------------------------------------------------------------ glyph helpers

/** Offset of glyph i from the line's middle, in glyph slots (tracking / split effects). */
export const fromMiddle = (g: MotionGlyph): number => g.i - (g.n - 1) / 2
/** -1 left of the middle, +1 right of it, 0 for the middle glyph of an odd line. */
export const sideOf = (g: MotionGlyph): number => Math.sign(fromMiddle(g))
export const isBlank = (c: string): boolean => c.trim() === ''

/** Picks one character of `pool` for a moment of a phase; blanks stay blank. (Pure.) */
export function poolChar(pool: readonly string[], g: MotionGlyph, step: number, salt: number): string {
  if (isBlank(g.char)) return g.char
  return pool[Math.floor(hash01(g.seed, g.i * 131 + step, salt) * pool.length)]
}

/** The words for a recipe: Japanese name and what the viewer sees. */
export interface RecipeWords {
  ja: string
  desc: string
}

/** Builds an exit that plays an entrance backwards (same shape, reversed time and order). */
export function reversed(enter: TransitionRecipe, words: RecipeWords, order?: TransitionRecipe['order']): TransitionRecipe {
  return { ...words, order: order ?? enter.order, stagger: enter.stagger, origin: enter.origin, pose: (p, g) => enter.pose(1 - p, g) }
}
