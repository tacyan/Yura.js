import type { LookParams, MotionParams } from '@yura/renderer-webgpu'
import { YuraError, CODES } from '@yura/core'
import { looks } from './looks'
import { shapes, type ShapeSpec } from './shapes'

/**
 * Everything one preset configures at once — the bundle `.preset(name)`
 * applies: particle count, gradient colors, look, motion physics, and the
 * shape sequence the automatic cycle morphs through.
 */
export interface PresetConfig {
  /** Requested particle count. */
  particles: number
  /** Gradient start color (hex). */
  colorA: string
  /** Gradient end color (hex). */
  colorB: string
  /** Post/appearance settings. */
  look: LookParams
  /** Simulation physics params. */
  motion: MotionParams
  /** Shapes the automatic cycle morphs through, in order. */
  shapes: ShapeSpec[]
}

/** Baseline simulation physics every preset builds on. */
export const DEFAULT_MOTION: MotionParams = {
  attraction: 4.0,
  damping: 2.6,
  noiseScale: 0.14,
  noiseStrength: 0.6,
  swirl: 0.1,
  maxSpeed: 30,
  speedColorMix: 0.25,
}

const REGISTRY: Record<string, () => PresetConfig> = {
  'neon-galaxy': () => ({
    particles: 1_000_000,
    colorA: '#06b6d4',
    colorB: '#8b5cf6',
    look: looks.neon(),
    motion: {
      ...DEFAULT_MOTION,
      swirl: 0.12,
      damping: 2.8,
      noiseStrength: 0.55,
      // The default first screen shows the divergence-free curl field, not
      // the bare trig flow: 0.45 keeps galaxy arms alive as fluid wisps while
      // attraction 4 still pins the 'YURA' text morph (peak curl displacement
      // ~ turbulence/attraction ≈ 0.1 world units — shimmer, not smear).
      turbulence: 0.45,
    },
    shapes: [shapes.galaxy(), shapes.text('YURA'), shapes.vortex()],
  }),
  aurora: () => ({
    particles: 600_000,
    colorA: '#22d3ee',
    colorB: '#a78bfa',
    look: looks.aurora(),
    motion: {
      ...DEFAULT_MOTION,
      attraction: 1.2,
      noiseStrength: 3.2,
      noiseScale: 0.1,
      damping: 1.0,
      swirl: 0.05,
      // The showcase "whisper" value: with damping 1.0 the curl swirls fold
      // slowly through the trig flow like curtains, the strongest turbulence
      // of the set because aurora IS the fluid look. Default field scale
      // (0.35) keeps the billows curtain-broad.
      turbulence: 0.6,
    },
    shapes: [shapes.flow()],
  }),
  cinematic: () => ({
    particles: 800_000,
    colorA: '#f5d0a9',
    colorB: '#7dd3fc',
    look: looks.cinematic(),
    motion: {
      ...DEFAULT_MOTION,
      noiseStrength: 0.5,
      swirl: 0.08,
      // Barely-there dust-mote drift (equilibrium offset ≈ 0.2/4 = 0.05
      // world units): organic film breathing without disturbing the stately
      // sphere/galaxy compositions.
      turbulence: 0.2,
    },
    shapes: [shapes.sphere(), shapes.galaxy()],
  }),
  cyberpunk: () => ({
    particles: 1_000_000,
    colorA: '#f472b6',
    colorB: '#22d3ee',
    look: looks.cyberpunk(),
    motion: {
      ...DEFAULT_MOTION,
      noiseStrength: 0.8,
      swirl: 0.15,
      // A trace of interference, not fluid: 0.25 keeps the 'YURA' glyphs
      // legible (offset ≈ 0.25/4 ≈ 0.06 world units)…
      turbulence: 0.25,
      // …and sampling the curl field at 0.8 (vs default 0.35) more than
      // halves the vortex wavelength — broad billows become the fine electric
      // crackle a night city hums with.
      turbulenceScale: 0.8,
    },
    shapes: [shapes.text('YURA'), shapes.vortex(), shapes.galaxy()],
  }),
}

/**
 * Names of the built-in presets accepted by `.preset()` / `resolvePreset()`.
 *
 * @example
 * presetNames() // ['neon-galaxy', 'aurora', 'cinematic', 'cyberpunk']
 */
export function presetNames(): string[] {
  return Object.keys(REGISTRY)
}

/**
 * Looks up a preset by name and returns a fresh config (safe to mutate).
 * Throws a YuraError (UNKNOWN_PRESET) listing the available names otherwise.
 *
 * @example
 * const p = resolvePreset('aurora')
 * console.log(p.particles) // 600000
 */
export function resolvePreset(name: string): PresetConfig {
  const factory = REGISTRY[name]
  if (!factory) {
    throw new YuraError(
      CODES.UNKNOWN_PRESET,
      `Unknown preset "${name}". Available: ${presetNames().join(', ')}.`,
      `yura('#app').preset('${presetNames()[0]}').run()`,
    )
  }
  return factory()
}
