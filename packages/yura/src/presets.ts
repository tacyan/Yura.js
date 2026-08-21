import type { LookParams, MotionParams } from '@yura/renderer-webgpu'
import { YuraError, CODES } from '@yura/core'
import { looks } from './looks'
import { shapes, type ShapeSpec } from './shapes'

export interface PresetConfig {
  particles: number
  colorA: string
  colorB: string
  look: LookParams
  motion: MotionParams
  shapes: ShapeSpec[]
}

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
    motion: { ...DEFAULT_MOTION, swirl: 0.12, damping: 2.8, noiseStrength: 0.55 },
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
    },
    shapes: [shapes.flow()],
  }),
  cinematic: () => ({
    particles: 800_000,
    colorA: '#f5d0a9',
    colorB: '#7dd3fc',
    look: looks.cinematic(),
    motion: { ...DEFAULT_MOTION, noiseStrength: 0.5, swirl: 0.08 },
    shapes: [shapes.sphere(), shapes.galaxy()],
  }),
  cyberpunk: () => ({
    particles: 1_000_000,
    colorA: '#f472b6',
    colorB: '#22d3ee',
    look: looks.cyberpunk(),
    motion: { ...DEFAULT_MOTION, noiseStrength: 0.8, swirl: 0.15 },
    shapes: [shapes.text('YURA'), shapes.vortex(), shapes.galaxy()],
  }),
}

export function presetNames(): string[] {
  return Object.keys(REGISTRY)
}

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
