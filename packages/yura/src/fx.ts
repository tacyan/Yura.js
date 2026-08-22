import { hexToLinear, type Vec3 } from '@yura/core'

// Pure particle-FX logic: emitter math, pooled stepping, lifetimes.
// No DOM, no GPU — fully unit-testable. The scene packs the pool into
// camera-facing sprite instances each frame and hands them to the renderer.

/** Floats per packed FX sprite instance: x, y, z, size, r, g, b, alpha. */
export const FX_FLOATS = 8

/** Random source in [0, 1). Inject a seeded generator for deterministic tests. */
export type FxRandom = () => number

/** Options for a radial particle burst (collect flashes, explosions, impacts). */
export interface BurstOptions {
  /** Hex color or palette to pick from per particle. Default golden spark. */
  color?: string | string[]
  /** Number of particles to spawn. Default 80. */
  count?: number
  /** Peak outward speed in world units/s. Default 6. */
  speed?: number
  /** Mean particle lifetime in seconds (jittered per particle). Default 0.9. */
  life?: number
  /** Mean sprite radius in world units. Default 0.16. */
  size?: number
  /** Downward acceleration applied to particles. Default -6. */
  gravity?: number
  /** HDR brightness multiplier — values above 1 feed the bloom pass. Default 2. */
  intensity?: number
  /**
   * Emission direction. When set (or when `spread` is set), particles emit in a
   * cone around this vector instead of the default full sphere. Zero/invalid
   * vectors fall back to +Y.
   */
  direction?: [number, number, number]
  /**
   * Cone half-angle in radians around `direction`. 0 sends every particle
   * exactly along `direction`; Math.PI approximates the full sphere.
   * Default 0 when `direction` is given. Ignored when both are omitted.
   */
  spread?: number
  /**
   * Emission source shape. Particles spawn at a random offset inside the shape
   * (scaled by `radius`) instead of a single point. Default: point emission.
   */
  shape?: 'sphere' | 'disc' | 'box'
  /** Extent of `shape` in world units (sphere/disc radius, box half-size). Default 1. */
  radius?: number
  /**
   * End color reached at the end of each particle's life. Interpolated linearly
   * from the start color by t = age / life in writeInstances. A hex string, or a
   * linear-RGB triple (multiplied by `intensity`). Default: no color shift.
   */
  colorEnd?: string | [number, number, number]
  /**
   * Linear velocity damping per second: each step applies
   * v *= max(0, 1 - drag * dt) on top of the built-in exponential damping.
   * Default 0 (no extra damping).
   */
  drag?: number
}

/** Options for a following trail behind a moving object. */
export interface TrailOptions {
  /** Hex color or palette to pick from per particle. Default light cyan. */
  color?: string | string[]
  /** Particles emitted per second. Default 90. */
  rate?: number
  /** Mean particle lifetime in seconds. Default 0.45. */
  life?: number
  /** Mean sprite radius in world units. Default 0.11. */
  size?: number
  /** Positional jitter radius around the emitter. Default 0.12. */
  jitter?: number
  /** HDR brightness multiplier. Default 1.6. */
  intensity?: number
}

/** Options for a fireworks-like multi-burst celebration. */
export interface CelebrateOptions {
  /** Palette; each burst picks one color. Default a festive five-color set. */
  colors?: string[]
  /** Number of bursts. Default 8. */
  bursts?: number
  /** Seconds between bursts. Default 0.16. */
  interval?: number
  /** Particles per burst. Default 90. */
  count?: number
  /** Peak outward speed per burst. Default 7. */
  speed?: number
  /** Mean particle lifetime in seconds. Default 1.1. */
  life?: number
  /** Horizontal placement radius for burst centers. Default 3.5. */
  radius?: number
  /** Vertical [min, max] placement range for burst centers. Default [2.5, 5]. */
  height?: [number, number]
}

const CELEBRATE_PALETTE = ['#ff5d8f', '#ffd166', '#06d6a0', '#4cc9f0', '#c77dff']

interface PendingBurst {
  t: number
  position: Vec3
  opts: BurstOptions
}

/** Returns `v` when it is a finite number, otherwise `fallback`. */
function fin(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function resolvePalette(color: string | string[] | undefined, fallback: string): Vec3[] {
  const list = color === undefined ? [fallback] : Array.isArray(color) ? color : [color]
  const resolved = list.length ? list : [fallback]
  return resolved.map((c) => hexToLinear(c))
}

/**
 * Fixed-capacity particle pool. Spawning past capacity recycles the oldest
 * slots (round-robin) so FX can never grow unbounded; dead particles free
 * their slot immediately via swap-removal.
 */
export class FxPool {
  /** Maximum simultaneous particles. */
  readonly capacity: number

  private px: Float32Array
  private py: Float32Array
  private pz: Float32Array
  private vx: Float32Array
  private vy: Float32Array
  private vz: Float32Array
  private age: Float32Array
  private life: Float32Array
  private size: Float32Array
  private cr: Float32Array
  private cg: Float32Array
  private cb: Float32Array
  private grav: Float32Array
  private drag: Float32Array
  private ldrag: Float32Array
  private er: Float32Array
  private eg: Float32Array
  private eb: Float32Array

  private count = 0
  private cursor = 0
  private pending: PendingBurst[] = []
  private rng: FxRandom

  constructor(capacity = 8192, rng: FxRandom = Math.random) {
    this.capacity = Math.max(1, Math.floor(capacity))
    this.rng = rng
    const n = this.capacity
    this.px = new Float32Array(n)
    this.py = new Float32Array(n)
    this.pz = new Float32Array(n)
    this.vx = new Float32Array(n)
    this.vy = new Float32Array(n)
    this.vz = new Float32Array(n)
    this.age = new Float32Array(n)
    this.life = new Float32Array(n)
    this.size = new Float32Array(n)
    this.cr = new Float32Array(n)
    this.cg = new Float32Array(n)
    this.cb = new Float32Array(n)
    this.grav = new Float32Array(n)
    this.drag = new Float32Array(n)
    this.ldrag = new Float32Array(n)
    this.er = new Float32Array(n)
    this.eg = new Float32Array(n)
    this.eb = new Float32Array(n)
  }

  /** Number of currently live particles. */
  get alive(): number {
    return this.count
  }

  /** Spawns a radial burst at `position`. */
  burst(position: Readonly<Vec3> | readonly number[], opts: BurstOptions = {}): void {
    const count = Math.max(1, Math.floor(fin(opts.count, 80)))
    const speed = fin(opts.speed, 6)
    const life = fin(opts.life, 0.9)
    const size = fin(opts.size, 0.16)
    const gravity = fin(opts.gravity, -6)
    const intensity = fin(opts.intensity, 2)
    const dragLin = Math.max(fin(opts.drag, 0), 0)
    const palette = resolvePalette(opts.color, '#ffd166')
    const bx = fin(position[0], 0)
    const by = fin(position[1], 0)
    const bz = fin(position[2], 0)

    // Optional cone emission: normalized axis + Frisvad orthonormal basis.
    const cone = opts.direction !== undefined || opts.spread !== undefined
    let nx = 0, ny = 1, nz = 0
    let t1x = 1, t1y = 0, t1z = 0
    let t2x = 0, t2y = 0, t2z = 1
    let cosSpread = 1
    if (cone) {
      const d = opts.direction
      const dx = fin(d?.[0], 0)
      const dy = fin(d?.[1], d === undefined ? 1 : 0)
      const dz = fin(d?.[2], 0)
      const len = Math.hypot(dx, dy, dz)
      if (len > 1e-8) {
        nx = dx / len
        ny = dy / len
        nz = dz / len
      }
      const sgn = nz >= 0 ? 1 : -1
      const ac = -1 / (sgn + nz)
      const bb = nx * ny * ac
      t1x = 1 + sgn * nx * nx * ac
      t1y = sgn * bb
      t1z = -sgn * nx
      t2x = bb
      t2y = sgn + ny * ny * ac
      t2z = -ny
      cosSpread = Math.cos(Math.min(Math.max(fin(opts.spread, 0), 0), Math.PI))
    }

    // Optional volumetric source shape.
    const shape = opts.shape
    const shapeR = Math.max(fin(opts.radius, 1), 0)

    // Optional end color (linear-RGB), interpolated over each particle's life.
    const ce = opts.colorEnd
    const endCol: Vec3 | null =
      typeof ce === 'string'
        ? hexToLinear(ce)
        : Array.isArray(ce)
          ? [fin(ce[0], 0), fin(ce[1], 0), fin(ce[2], 0)]
          : null

    for (let i = 0; i < count; i++) {
      let ux: number, uy: number, uz: number
      if (cone) {
        // Uniform direction on the spherical cap of half-angle `spread`.
        const cosT = 1 - this.rng() * (1 - cosSpread)
        const sinT = Math.sqrt(Math.max(1 - cosT * cosT, 0))
        const phi = this.rng() * Math.PI * 2
        const cp = Math.cos(phi) * sinT
        const sp = Math.sin(phi) * sinT
        ux = t1x * cp + t2x * sp + nx * cosT
        uy = t1y * cp + t2y * sp + ny * cosT
        uz = t1z * cp + t2z * sp + nz * cosT
      } else {
        // Uniform direction on the unit sphere.
        const y = this.rng() * 2 - 1
        const a = this.rng() * Math.PI * 2
        const r = Math.sqrt(Math.max(1 - y * y, 0))
        ux = r * Math.cos(a)
        uy = y
        uz = r * Math.sin(a)
      }
      const s = speed * (0.35 + 0.65 * this.rng())
      const c = palette[Math.floor(this.rng() * palette.length) % palette.length]
      let ox = 0, oy = 0, oz = 0
      if (shape === 'sphere') {
        const sy = this.rng() * 2 - 1
        const sa = this.rng() * Math.PI * 2
        const sr = Math.sqrt(Math.max(1 - sy * sy, 0))
        const rad = shapeR * Math.cbrt(this.rng())
        ox = sr * Math.cos(sa) * rad
        oy = sy * rad
        oz = sr * Math.sin(sa) * rad
      } else if (shape === 'disc') {
        const rad = shapeR * Math.sqrt(this.rng())
        const sa = this.rng() * Math.PI * 2
        ox = Math.cos(sa) * rad
        oz = Math.sin(sa) * rad
      } else if (shape === 'box') {
        ox = (this.rng() * 2 - 1) * shapeR
        oy = (this.rng() * 2 - 1) * shapeR
        oz = (this.rng() * 2 - 1) * shapeR
      }
      const end = endCol ?? c
      this.spawn(
        bx + ox, by + oy, bz + oz,
        ux * s, uy * s, uz * s,
        life * (0.7 + 0.45 * this.rng()),
        size * (0.7 + 0.6 * this.rng()),
        c[0] * intensity, c[1] * intensity, c[2] * intensity,
        gravity,
        1.5,
        dragLin,
        end[0] * intensity, end[1] * intensity, end[2] * intensity,
      )
    }
  }

  /** Schedules a fireworks-like sequence of bursts processed by step(). */
  celebrate(opts: CelebrateOptions = {}): void {
    const bursts = Math.max(1, Math.floor(opts.bursts ?? 8))
    const interval = Math.max(0, opts.interval ?? 0.16)
    const radius = opts.radius ?? 3.5
    const [hMin, hMax] = opts.height ?? [2.5, 5]
    const palette = opts.colors && opts.colors.length ? opts.colors : CELEBRATE_PALETTE
    for (let i = 0; i < bursts; i++) {
      const color = palette[Math.floor(this.rng() * palette.length) % palette.length]
      this.pending.push({
        t: i * interval,
        position: [
          (this.rng() * 2 - 1) * radius,
          hMin + this.rng() * Math.max(hMax - hMin, 0),
          (this.rng() * 2 - 1) * radius,
        ],
        opts: {
          color,
          count: opts.count ?? 90,
          speed: opts.speed ?? 7,
          life: opts.life ?? 1.1,
          size: 0.15,
          gravity: -5,
          intensity: 2.5,
        },
      })
    }
  }

  /** Advances timers and particle physics by `dt` seconds; retires dead particles. */
  step(dt: number): void {
    if (this.pending.length) {
      const keep: PendingBurst[] = []
      for (const p of this.pending) {
        p.t -= dt
        if (p.t <= 0) this.burst(p.position, p.opts)
        else keep.push(p)
      }
      this.pending = keep
    }
    const damp = (d: number) => Math.exp(-d * dt)
    for (let i = this.count - 1; i >= 0; i--) {
      this.age[i] += dt
      if (this.age[i] >= this.life[i]) {
        this.swapRemove(i)
        continue
      }
      this.vy[i] += this.grav[i] * dt
      const f = damp(this.drag[i])
      this.vx[i] *= f
      this.vy[i] *= f
      this.vz[i] *= f
      // Optional linear drag: v *= max(0, 1 - drag * dt). No-op at drag = 0.
      const q = Math.max(1 - this.ldrag[i] * dt, 0)
      this.vx[i] *= q
      this.vy[i] *= q
      this.vz[i] *= q
      this.px[i] += this.vx[i] * dt
      this.py[i] += this.vy[i] * dt
      this.pz[i] += this.vz[i] * dt
    }
  }

  /**
   * Packs live particles as FX_FLOATS-sized sprite instances
   * (x, y, z, size, r, g, b, alpha) into `out`. Returns the instance count.
   */
  writeInstances(out: Float32Array): number {
    const n = Math.min(this.count, Math.floor(out.length / FX_FLOATS))
    for (let i = 0; i < n; i++) {
      const t = Math.min(Math.max(this.age[i] / this.life[i], 0), 1)
      const fade = 1 - t
      const o = i * FX_FLOATS
      out[o] = this.px[i]
      out[o + 1] = this.py[i]
      out[o + 2] = this.pz[i]
      out[o + 3] = this.size[i] * (0.55 + 0.45 * fade)
      // Lerp start → end color by life fraction (end === start by default).
      out[o + 4] = this.cr[i] + (this.er[i] - this.cr[i]) * t
      out[o + 5] = this.cg[i] + (this.eg[i] - this.cg[i]) * t
      out[o + 6] = this.cb[i] + (this.eb[i] - this.cb[i]) * t
      out[o + 7] = fade * fade
    }
    return n
  }

  /** Removes all particles and pending bursts. */
  clear(): void {
    this.count = 0
    this.cursor = 0
    this.pending = []
  }

  /** @internal Spawns one particle, recycling the round-robin slot when full. */
  spawn(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number, size: number,
    r: number, g: number, b: number,
    gravity: number, drag: number,
    dragLin = 0, endR = r, endG = g, endB = b,
  ): void {
    let i: number
    if (this.count < this.capacity) {
      i = this.count++
    } else {
      i = this.cursor
      this.cursor = (this.cursor + 1) % this.capacity
    }
    this.px[i] = fin(x, 0)
    this.py[i] = fin(y, 0)
    this.pz[i] = fin(z, 0)
    this.vx[i] = fin(vx, 0)
    this.vy[i] = fin(vy, 0)
    this.vz[i] = fin(vz, 0)
    this.age[i] = 0
    this.life[i] = Math.max(fin(life, 1e-3), 1e-3)
    this.size[i] = fin(size, 0)
    this.cr[i] = fin(r, 0)
    this.cg[i] = fin(g, 0)
    this.cb[i] = fin(b, 0)
    this.grav[i] = fin(gravity, 0)
    this.drag[i] = fin(drag, 0)
    this.ldrag[i] = Math.max(fin(dragLin, 0), 0)
    this.er[i] = fin(endR, 0)
    this.eg[i] = fin(endG, 0)
    this.eb[i] = fin(endB, 0)
  }

  /** Injected rng, shared with emitters bound to this pool. */
  random(): number {
    return this.rng()
  }

  private swapRemove(i: number): void {
    const last = --this.count
    if (i !== last) {
      this.px[i] = this.px[last]
      this.py[i] = this.py[last]
      this.pz[i] = this.pz[last]
      this.vx[i] = this.vx[last]
      this.vy[i] = this.vy[last]
      this.vz[i] = this.vz[last]
      this.age[i] = this.age[last]
      this.life[i] = this.life[last]
      this.size[i] = this.size[last]
      this.cr[i] = this.cr[last]
      this.cg[i] = this.cg[last]
      this.cb[i] = this.cb[last]
      this.grav[i] = this.grav[last]
      this.drag[i] = this.drag[last]
      this.ldrag[i] = this.ldrag[last]
      this.er[i] = this.er[last]
      this.eg[i] = this.eg[last]
      this.eb[i] = this.eb[last]
    }
    if (this.cursor >= this.count) this.cursor = 0
  }
}

/**
 * Continuous emitter that drops fading sparks behind a moving position.
 * Emission is rate-based with a fractional accumulator, so counts are exact
 * regardless of frame timing.
 */
export class FxTrailEmitter {
  private pool: FxPool
  private palette: Vec3[]
  private rate: number
  private life: number
  private size: number
  private jitter: number
  private intensity: number
  private acc = 0

  constructor(pool: FxPool, opts: TrailOptions = {}) {
    this.pool = pool
    this.palette = resolvePalette(opts.color, '#7dd3fc')
    this.rate = Math.max(0, opts.rate ?? 90)
    this.life = opts.life ?? 0.45
    this.size = opts.size ?? 0.11
    this.jitter = opts.jitter ?? 0.12
    this.intensity = opts.intensity ?? 1.6
  }

  /** Emits `rate * dt` particles (accumulated) at `position`, drifting against `velocity`. */
  step(dt: number, position: Readonly<Vec3> | readonly number[], velocity: Readonly<Vec3> | readonly number[]): void {
    this.acc += this.rate * dt
    let n = Math.floor(this.acc)
    this.acc -= n
    const rng = () => this.pool.random()
    while (n-- > 0) {
      const j = this.jitter
      const c = this.palette[Math.floor(rng() * this.palette.length) % this.palette.length]
      this.pool.spawn(
        position[0] + (rng() * 2 - 1) * j,
        position[1] + (rng() * 2 - 1) * j,
        position[2] + (rng() * 2 - 1) * j,
        -velocity[0] * 0.2 + (rng() * 2 - 1) * 0.4,
        -velocity[1] * 0.2 + (rng() * 2 - 1) * 0.4,
        -velocity[2] * 0.2 + (rng() * 2 - 1) * 0.4,
        this.life * (0.7 + 0.45 * rng()),
        this.size * (0.7 + 0.6 * rng()),
        c[0] * this.intensity, c[1] * this.intensity, c[2] * this.intensity,
        0,
        2.5,
      )
    }
  }
}
