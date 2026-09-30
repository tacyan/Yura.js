import type { ShapeSpec } from 'yura'

const TAU = Math.PI * 2
const GOLDEN_RATIO = (1 + Math.sqrt(5)) / 2
const frac = (value: number) => value - Math.floor(value)

/** Surface sampling happens once per morph. Frames stay entirely on the GPU. */
export function sculpture(kind: 'orbit' | 'bloom' | 'wave'): ShapeSpec {
  return {
    kind: `atelier-${kind}`,
    generate(count) {
      const positions = new Float32Array(count * 4)
      for (let i = 0; i < count; i++) {
        const u = i / count
        const v = frac(i / GOLDEN_RATIO)
        const a = u * TAU
        const b = v * TAU
        let x: number, y: number, z: number
        if (kind === 'orbit') {
          const twist = b + a * 3
          const radius = 6.1 + 2.2 * Math.cos(twist)
          x = radius * Math.cos(a)
          y = radius * Math.sin(a)
          z = 2.2 * Math.sin(twist) + 1.2 * Math.sin(a * 3)
        } else if (kind === 'bloom') {
          const latitude = Math.acos(1 - 2 * u)
          const radius = 6.5 + 1.1 * Math.sin(b * 6 + latitude * 4)
          x = radius * Math.sin(latitude) * Math.cos(b)
          y = radius * Math.cos(latitude)
          z = radius * Math.sin(latitude) * Math.sin(b)
        } else {
          x = (u - 0.5) * 17
          y = 2.4 * Math.sin(a * 2 + b * 0.6) + (v - 0.5) * 4
          z = (v - 0.5) * 10
        }
        const tilt = 0.35
        positions[i * 4] = x
        positions[i * 4 + 1] = y * Math.cos(tilt) - z * Math.sin(tilt)
        positions[i * 4 + 2] = y * Math.sin(tilt) + z * Math.cos(tilt)
        positions[i * 4 + 3] = v
      }
      return positions
    },
  }
}
