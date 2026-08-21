import { hexToLinear } from '@yura/core'
import type { SceneMaterial } from '@yura/renderer-webgpu'

/**
 * Curated material presets (spec §7.1: users never balance metal/rough by
 * hand). Strings name a preset; functions parameterize one with a color.
 */

const BLACK: [number, number, number] = [0, 0, 0]

function solid(
  color: [number, number, number, number],
  metallic: number,
  roughness: number,
  emissive: [number, number, number] = BLACK,
): SceneMaterial {
  return { color, metallic, roughness, emissive }
}

export const materialPresets: Record<string, SceneMaterial> = {
  chrome: solid([0.85, 0.87, 0.9, 1], 1, 0.07),
  gold: solid([1.0, 0.56, 0.09, 1], 1, 0.16),
  copper: solid([0.9, 0.28, 0.13, 1], 1, 0.24),
  obsidian: solid([0.02, 0.02, 0.03, 1], 0.4, 0.15),
  pearl: solid([0.9, 0.88, 0.85, 1], 0.1, 0.35),
  rubber: solid([0.03, 0.03, 0.035, 1], 0, 0.9),
  checker: { color: [1, 1, 1, 1], metallic: 0, roughness: 0.75, emissive: BLACK, pattern: 'checker' },
  grid: { color: [1, 1, 1, 1], metallic: 0.1, roughness: 0.4, emissive: BLACK, pattern: 'grid' },
}

/** Matte diffuse surface in any color. */
export function matte(hex: string): SceneMaterial {
  return solid([...hexToLinear(hex), 1], 0, 0.85)
}

/** Glossy plastic in any color. */
export function plastic(hex: string): SceneMaterial {
  return solid([...hexToLinear(hex), 1], 0, 0.3)
}

/** Tinted metal in any color. */
export function metal(hex: string, roughness = 0.2): SceneMaterial {
  return solid([...hexToLinear(hex), 1], 1, roughness)
}

/** Self-illuminated — blooms with the HDR pipeline. */
export function neon(hex: string, strength = 4): SceneMaterial {
  const c = hexToLinear(hex)
  return {
    color: [c[0] * 0.15, c[1] * 0.15, c[2] * 0.15, 1],
    metallic: 0,
    roughness: 0.6,
    emissive: [c[0] * strength, c[1] * strength, c[2] * strength],
  }
}

export type MaterialLike = SceneMaterial | keyof typeof materialPresets | (string & {})

export function resolveMaterial(m: MaterialLike | undefined): SceneMaterial {
  if (!m) return materialPresets.pearl
  if (typeof m === 'string') {
    const preset = materialPresets[m]
    if (preset) return { ...preset }
    if (m.startsWith('#')) return plastic(m)
    return materialPresets.pearl
  }
  return m
}

export const materials = { ...materialPresets, matte, plastic, metal, neon }
