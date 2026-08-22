import type { LookParams } from '@yura/renderer-webgpu'

/**
 * Looks are curated post/appearance settings (spec §7.2). Users apply them by
 * name and never have to balance bloom vs exposure themselves.
 */

/**
 * Filmic default: warm highlights, gentle bloom, soft vignette — the look
 * every particle app starts with.
 *
 * @example
 * yura('#hero').look(cinematic({ vignette: 0.4 })).run()
 */
export function cinematic(overrides: Partial<LookParams> = {}): LookParams {
  return {
    exposure: 1.0,
    bloomStrength: 0.6,
    bloomThreshold: 0.55,
    vignette: 0.6,
    grain: 0.025,
    background: [0.004, 0.004, 0.006],
    particleSize: 0.028,
    intensity: 0.32,
    hot: [1.0, 0.93, 0.82],
    twinkle: 0.35,
    trail: 0.22,
    aberration: 0.002,
    streak: 0.5,
    nebula: 0.6,
    stars: 0.7,
    ...overrides,
  }
}

/** Night-city glow: hard bloom, magenta-violet haze, visible chromatic aberration. */
export function cyberpunk(overrides: Partial<LookParams> = {}): LookParams {
  return {
    exposure: 1.15,
    bloomStrength: 1.2,
    bloomThreshold: 0.45,
    vignette: 0.75,
    grain: 0.025,
    background: [0.006, 0.003, 0.012],
    particleSize: 0.025,
    intensity: 0.34,
    hot: [1.0, 0.8, 1.0],
    twinkle: 0.4,
    trail: 0.4,
    aberration: 0.005,
    streak: 0.55,
    nebula: 1.0,
    stars: 0.55,
    ...overrides,
  }
}

/** Soft polar curtains: large particles, long trails, heavy nebula haze. */
export function aurora(overrides: Partial<LookParams> = {}): LookParams {
  return {
    exposure: 0.95,
    bloomStrength: 0.9,
    bloomThreshold: 0.4,
    vignette: 0.45,
    grain: 0.02,
    background: [0.002, 0.003, 0.006],
    particleSize: 0.04,
    intensity: 0.55,
    hot: [0.85, 1.0, 0.92],
    twinkle: 0.3,
    trail: 0.55,
    aberration: 0.0015,
    streak: 0.15,
    nebula: 1.1,
    stars: 0.7,
    ...overrides,
  }
}

/** Crisp cyan glow with strong twinkle over a dense starfield. */
export function neon(overrides: Partial<LookParams> = {}): LookParams {
  return {
    exposure: 1.1,
    bloomStrength: 0.9,
    bloomThreshold: 0.4,
    vignette: 0.65,
    grain: 0.02,
    background: [0.003, 0.004, 0.01],
    particleSize: 0.022,
    intensity: 0.3,
    hot: [0.85, 1.0, 1.0],
    twinkle: 0.5,
    trail: 0.3,
    aberration: 0.0035,
    streak: 0.35,
    nebula: 0.8,
    stars: 0.9,
    ...overrides,
  }
}

/** Tuned for glTF/PBR model rendering: subtle bloom, no trails. */
export function studio(overrides: Partial<LookParams> = {}): LookParams {
  return {
    exposure: 1.0,
    bloomStrength: 0.35,
    bloomThreshold: 1.0,
    vignette: 0.5,
    grain: 0.018,
    background: [0, 0, 0],
    particleSize: 0.022,
    intensity: 0.3,
    hot: [1, 1, 1],
    twinkle: 0,
    trail: 0,
    aberration: 0.002,
    streak: 0.45,
    nebula: 0.12,
    stars: 0.35,
    ...overrides,
  }
}

/**
 * 桜 (sakura) — Japanese spring dusk. Three-color palette: petal pink
 * (#f7c9d4-family, carried by `hot` lifted toward white), white (the soft
 * screen-blend glow core, which never clips), and pale gold (the twilight
 * haze tinted by `background` through the nebula). Restrained bloom and
 * Reinhard tone mapping keep highlights gentle.
 */
export function sakura(overrides: Partial<LookParams> = {}): LookParams {
  return {
    exposure: 0.95,
    bloomStrength: 0.45,
    bloomThreshold: 0.7,
    vignette: 0.4,
    grain: 0.02,
    background: [0.012, 0.009, 0.008],
    particleSize: 0.03,
    intensity: 0.34,
    hot: [1.0, 0.82, 0.85],
    twinkle: 0.25,
    trail: 0.3,
    aberration: 0.0015,
    streak: 0.2,
    nebula: 0.7,
    stars: 0.5,
    // Scene-mode FX depth-fade distance (world units): petals melt into
    // nearby geometry over ~2-3 sprite radii instead of hard-clipping.
    softParticles: 0.3,
    blendMode: 'screen',
    toneMapping: 'reinhard',
    ...overrides,
  }
}

/**
 * Registry of every curated look, keyed by the same names `.look()` accepts
 * as strings. Each factory takes `Partial<LookParams>` overrides.
 *
 * @example
 * app.look(looks.neon({ blendMode: 'alpha', toneMapping: 'reinhard' }))
 */
export const looks = { cinematic, cyberpunk, aurora, neon, studio, sakura }

/** A key of the `looks` registry — every name `.look()` accepts. */
export type LookName = keyof typeof looks
