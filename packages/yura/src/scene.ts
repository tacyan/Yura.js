import { CODES, trsToMat4, eulerToQuat, warnCode, YuraError, type Vec3, type Vec4 } from '@yura/core'
import {
  meshes,
  type MeshGeometry,
  type MeshHandle,
  type WebGPUModelRenderer,
} from '@yura/renderer-webgpu'
import { resolveMaterial, type MaterialLike } from './materials'
import {
  FxPool,
  FxTrailEmitter,
  FX_FLOATS,
  type BurstOptions,
  type TrailOptions,
  type CelebrateOptions,
} from './fx'

/**
 * The game layer (spec: "ゲームも作れる最小コード"). Procedural meshes + PBR
 * materials + a tiny physics/collision/input/camera kit. A complete playable
 * game fits in ~40 lines of user code.
 */

/** Every procedural mesh {@link YuraScene.add} can build — no assets needed. */
export const SHAPE_NAMES = ['sphere', 'box', 'torus', 'knot', 'cylinder', 'plane', 'disc'] as const

/** Name of a procedural scene mesh ('sphere', 'box', 'torus', 'knot', 'cylinder', 'plane', 'disc'). */
export type ShapeName = (typeof SHAPE_NAMES)[number]

/** Seconds a Space tap stays buffered waiting for a landing (jump buffer). */
const JUMP_BUFFER = 0.15
/** Seconds after leaving the ground a jump is still honoured (coyote time). */
const COYOTE_TIME = 0.1
/** Grounded bodies with |vy| below this settle to zero instead of micro-bouncing. */
const SLEEP_VY = 0.05
/** Virtual stick: drag distance (CSS px) for full deflection. */
const STICK_RADIUS = 64
/** Virtual stick: drags shorter than this (CSS px) read as zero. */
const STICK_DEAD_ZONE = 8
/** A press shorter than this (seconds) with little movement is a tap = jump. */
const TAP_MAX_TIME = 0.2
/** A press that travelled further than this (CSS px) is a drag, not a tap. */
const TAP_MAX_MOVE = 12
/** Gamepad stick dead zone (normalized units). */
const PAD_DEAD_ZONE = 0.15

/**
 * Virtual-stick mapping: pointer offset from drag start (CSS px, screen
 * coords — +dy is down) → axes in -1..1 (game coords — +y is forward/up).
 * Offsets inside the dead zone read as zero; deflection ramps linearly to
 * full at `radius` and clamps beyond it.
 */
export function stickAxes(
  dx: number,
  dy: number,
  radius = STICK_RADIUS,
  deadZone = STICK_DEAD_ZONE,
): { x: number; y: number } {
  const mag = Math.hypot(dx, dy)
  if (mag <= deadZone) return { x: 0, y: 0 }
  const scale = Math.min(1, (mag - deadZone) / (radius - deadZone)) / mag
  return { x: dx * scale, y: -dy * scale }
}

/** Tap-vs-drag: a quick press that barely moved is a tap (= jump intent). */
export function isTap(durationSec: number, movedPx: number, maxTime = TAP_MAX_TIME, maxMove = TAP_MAX_MOVE): boolean {
  return durationSec < maxTime && movedPx < maxMove
}

/** Combine one axis across input sources — the largest magnitude wins. */
export function combineAxes(...values: number[]): number {
  let out = 0
  for (const v of values) if (Math.abs(v) > Math.abs(out)) out = v
  return out
}

/** Radial gamepad dead zone: below `dz` reads zero, above rescales to 0..1. */
export function padDeadZone(value: number, dz = PAD_DEAD_ZONE): number {
  const a = Math.abs(value)
  if (a <= dz) return 0
  return Math.sign(value) * Math.min(1, (a - dz) / (1 - dz))
}

/** Minimal shape of a navigator.getGamepads() entry (testable snapshot). */
export interface GamepadSnapshot {
  axes: ReadonlyArray<number>
  buttons: ReadonlyArray<{ pressed: boolean }>
  connected?: boolean
}

/**
 * Fold a getGamepads() array into one reading: left stick → x/y with dead
 * zone (largest magnitude across pads wins), A/cross held → jump.
 */
export function readGamepads(
  pads: Iterable<GamepadSnapshot | null> | null | undefined,
): { x: number; y: number; jump: boolean } {
  let x = 0
  let y = 0
  let jump = false
  if (pads) {
    for (const gp of pads) {
      if (!gp || gp.connected === false) continue
      x = combineAxes(x, padDeadZone(gp.axes[0] ?? 0))
      y = combineAxes(y, padDeadZone(-(gp.axes[1] ?? 0)))
      if (gp.buttons[0]?.pressed) jump = true
    }
  }
  return { x, y, jump }
}

/**
 * Arena-boundary resolution for one axis: past the limit the position clamps
 * to the wall and any outward velocity is zeroed (inward velocity survives).
 * Reflecting instead (-v * bounce) fights a held stick and vibrates the ball.
 */
export function clampToBounds(position: number, velocity: number, limit: number): { position: number; velocity: number } {
  if (Math.abs(position) <= limit) return { position, velocity }
  const side = position > 0 ? 1 : -1
  return { position: side * limit, velocity: velocity * side > 0 ? 0 : velocity }
}

/**
 * Closest distance from point `p` to the segment `a`→`b`, plus the segment
 * parameter t (0..1) of that closest point. Pure math behind the CCD sweep.
 */
export function segmentPointDistance(a: Vec3, b: Vec3, p: Vec3): { distance: number; t: number } {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const dz = b[2] - a[2]
  const len2 = dx * dx + dy * dy + dz * dz
  const t =
    len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy + (p[2] - a[2]) * dz) / len2)) : 0
  return { distance: Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1], a[2] + dz * t - p[2]), t }
}

/**
 * Distance in the XZ plane from segment `a`→`b` to the vertical axis through
 * `p` (Y ignored), plus the parameter t of the closest approach — the swept
 * counterpart of the cylinder collider's radial test.
 */
export function segmentAxisDistanceXZ(a: Vec3, b: Vec3, p: Vec3): { distance: number; t: number } {
  const dx = b[0] - a[0]
  const dz = b[2] - a[2]
  const len2 = dx * dx + dz * dz
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[2] - a[2]) * dz) / len2)) : 0
  return { distance: Math.hypot(a[0] + dx * t - p[0], a[2] + dz * t - p[2]), t }
}

/**
 * Swept-sphere time of impact: earliest t (0..1) along `a`→`b` where the
 * moving center first comes within `radius` of `center`, or -1 for a miss.
 * Starting inside the radius reports t = 0 (the discrete-overlap case).
 */
export function sweptSphereTOI(a: Vec3, b: Vec3, center: Vec3, radius: number): number {
  const fx = a[0] - center[0]
  const fy = a[1] - center[1]
  const fz = a[2] - center[2]
  const c = fx * fx + fy * fy + fz * fz - radius * radius
  if (c <= 0) return 0
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const dz = b[2] - a[2]
  const len2 = dx * dx + dy * dy + dz * dz
  if (len2 === 0) return -1
  const half = fx * dx + fy * dy + fz * dz
  const disc = half * half - len2 * c
  if (disc < 0) return -1
  const t = (-half - Math.sqrt(disc)) / len2
  return t >= 0 && t <= 1 ? t : -1
}

/**
 * Time of impact against a vertical cylinder: earliest t (0..1) along
 * `a`→`b` where the XZ distance to the axis through `center` first reaches
 * `radius` while the Y offset is inside `band` (half-height + sphere radius).
 * A radial touch above/below the band falls through to the first band-edge
 * crossing that is still radially inside (entering through a cap). -1 = miss.
 */
export function sweptCylinderTOI(a: Vec3, b: Vec3, center: Vec3, radius: number, band: number): number {
  const dx = b[0] - a[0]
  const dz = b[2] - a[2]
  const dy = b[1] - a[1]
  const fx = a[0] - center[0]
  const fz = a[2] - center[2]
  const fy = a[1] - center[1]
  const c = fx * fx + fz * fz - radius * radius
  let t0 = -1
  if (c <= 0) {
    t0 = 0 // already radially inside at the start
  } else {
    const len2 = dx * dx + dz * dz
    if (len2 > 0) {
      const half = fx * dx + fz * dz
      const disc = half * half - len2 * c
      if (disc >= 0) {
        const t = (-half - Math.sqrt(disc)) / len2
        if (t >= 0 && t <= 1) t0 = t
      }
    }
  }
  if (t0 < 0) return -1
  if (Math.abs(fy + dy * t0) <= band) return t0
  if (dy !== 0) {
    const edge = dy < 0 ? band : -band // the band edge the motion enters through
    const t = (edge - fy) / dy
    const x = fx + dx * t
    const z = fz + dz * t
    if (t >= t0 && t <= 1 && x * x + z * z <= radius * radius + 1e-9) return t
  }
  return -1
}

/** World setup for {@link YuraApp.scene} / {@link YuraApp.game}. */
export interface SceneOptions {
  /** Y acceleration for dynamic bodies (e.g. -18). 0 disables gravity. */
  gravity?: number
  /** Half-size of the square play area; dynamic bodies bounce at the edge. */
  bounds?: number
  /** Bind global keyboard listeners (default true). Disable for embeds. */
  keyboard?: boolean
}

/** Per-object options for {@link YuraScene.add}. */
export interface AddOptions {
  /** Radius for round shapes (sphere, torus, knot, disc). */
  radius?: number
  /** Extent for box/plane/cylinder: uniform, or [width, height, depth]. */
  size?: number | [number, number, number]
  /** Initial world position [x, y, z]. Default origin. */
  position?: [number, number, number]
  /** Initial Euler rotation in radians. */
  rotation?: [number, number, number]
  /** Material preset name, '#hex' color, or a full SceneMaterial. */
  material?: MaterialLike
  /** 'dynamic' bodies get gravity, ground bounce, and friction. */
  body?: 'static' | 'dynamic'
  /** Solid objects push dynamic bodies out on contact. */
  solid?: boolean
  /** Free-form label for lookups: `each(tag)`, `count(tag)`, collision filters. */
  tag?: string
  /** Auto blob shadow that tracks the object on the ground plane. */
  shadow?: boolean
  /** Continuous rotation in rad/s. */
  spin?: [number, number, number]
  /** Ground-bounce energy retention, 0..1. Default 0.35. */
  restitution?: number
  /**
   * Collision radius override (visuals unchanged). Give pickups a generous
   * hit area — e.g. a 0.26-radius orb with hitRadius 0.6 feels fair to grab.
   */
  hitRadius?: number
}

/**
 * Axis-angle rotation increment for a sphere of `radius` rolling with
 * horizontal velocity (vx, vz). Axis = up x v (so the mesh rotates the way a
 * real ball rolls), angle = distance / radius. Pure — unit-tested headless.
 */
export function rollDelta(
  vx: number,
  vz: number,
  radius: number,
  dt: number,
): { axis: Vec3; angle: number } {
  const speed = Math.hypot(vx, vz)
  if (speed < 1e-6 || radius <= 0 || dt <= 0) return { axis: [0, 0, 0], angle: 0 }
  return { axis: [vz / speed, 0, -vx / speed], angle: (speed / radius) * dt }
}

/** q ⊗ p (Hamilton product), [x,y,z,w] order. */
function quatMul(q: Vec4, p: Vec4): Vec4 {
  return [
    q[3] * p[0] + q[0] * p[3] + q[1] * p[2] - q[2] * p[1],
    q[3] * p[1] - q[0] * p[2] + q[1] * p[3] + q[2] * p[0],
    q[3] * p[2] + q[0] * p[1] - q[1] * p[0] + q[2] * p[3],
    q[3] * p[3] - q[0] * p[0] - q[1] * p[1] - q[2] * p[2],
  ]
}

/** Premultiplies a world-space axis-angle rotation onto q, renormalized in place. */
function rotateQuat(q: Vec4, axis: Vec3, angle: number): void {
  const s = Math.sin(angle / 2)
  const r = quatMul([axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)], q)
  const n = Math.hypot(r[0], r[1], r[2], r[3]) || 1
  for (let i = 0; i < 4; i++) q[i] = r[i] / n
}

/**
 * Pure camera-follow goal (unit-tested headless): speed widens distance and
 * height a little, velocity adds a capped look-ahead, and a landing `dip`
 * (0..~0.45) lowers the eye. The caller smooths both points over time, which
 * keeps the result motion-sickness-safe.
 */
export function cameraFollowGoal(
  pos: readonly number[],
  vel: readonly number[],
  base: { distance: number; height: number },
  dip = 0,
): { eye: Vec3; look: Vec3 } {
  const speed = Math.hypot(vel[0], vel[2])
  const widen = Math.min(speed * 0.035, 0.3) // up to +30% at high speed
  const clamp = (v: number) => Math.max(-1.6, Math.min(1.6, v))
  return {
    eye: [pos[0], pos[1] + base.height * (1 + widen * 0.6) - dip, pos[2] + base.distance * (1 + widen)],
    look: [pos[0] + clamp(vel[0] * 0.22), pos[1] + 0.5 - dip * 0.5, pos[2] + clamp(vel[2] * 0.22)],
  }
}

/** Minimal collider view of a solid object, as seen by the occlusion cast. */
export interface OcclusionSolid {
  position: readonly number[]
  radius: number
  halfHeight?: number
  collider?: 'sphere' | 'cylinder'
}

const OCCLUSION_PROBE = 0.25
const OCCLUSION_MARGIN = 0.4
const OCCLUSION_SAMPLES = 24

/**
 * Sampled sphere-cast from the look-target toward the desired eye against
 * solid colliders. Returns the distance along that ray the eye may sit at:
 * the full look→eye distance when clear, else the first blocked sample's
 * distance minus `margin` (clamped to >= 0) so the camera rests just in
 * front of the occluder instead of inside it.
 */
export function occludedEyeDistance(
  look: readonly number[],
  eye: readonly number[],
  solids: ReadonlyArray<OcclusionSolid>,
  probe = OCCLUSION_PROBE,
  margin = OCCLUSION_MARGIN,
  samples = OCCLUSION_SAMPLES,
): number {
  const dx = eye[0] - look[0]
  const dy = eye[1] - look[1]
  const dz = eye[2] - look[2]
  const dist = Math.hypot(dx, dy, dz)
  if (dist < 1e-6 || solids.length === 0) return dist
  for (let i = 1; i <= samples; i++) {
    const k = i / samples
    const px = look[0] + dx * k
    const py = look[1] + dy * k
    const pz = look[2] + dz * k
    for (const s of solids) {
      const hit =
        s.collider === 'cylinder'
          ? Math.abs(py - s.position[1]) <= (s.halfHeight ?? s.radius) + probe &&
            Math.hypot(px - s.position[0], pz - s.position[2]) <= s.radius + probe
          : Math.hypot(px - s.position[0], py - s.position[1], pz - s.position[2]) <= s.radius + probe
      if (hit) return Math.max(0, k * dist - margin)
    }
  }
  return dist
}

/**
 * Eases the camera's occlusion pull-in amount toward `target` with an
 * exponential approach — faster when pulling in (an obstacle just appeared)
 * than when releasing, so the correction never pops in either direction.
 */
export function easeOcclusion(current: number, target: number, dt: number, rateIn = 12, rateOut = 5): number {
  const rate = target > current ? rateIn : rateOut
  return current + (target - current) * (1 - Math.exp(-rate * dt))
}

/** Handle to a HUD text element created by {@link YuraScene.text}. */
export interface TextHandle {
  /** Replace the displayed text. */
  set(text: string): void
  /** Remove the element permanently. */
  remove(): void
}

/** Handle to a particle trail started by `obj.trail()` / `scene.trail()`. */
export interface TrailHandle {
  /** Stops emitting; already-spawned particles fade out naturally. */
  stop(): void
}

/**
 * One object living in a {@link YuraScene}: a procedural mesh plus its
 * physics state. Mutate `position` / `velocity` / `spin` directly from
 * `onUpdate` — the simulation and renderer read them every tick.
 *
 * @example
 * const player = scene.add('sphere', { radius: 0.45, body: 'dynamic' })
 * player.onCollide((other) => { if (other.tag === 'orb') other.remove() })
 */
export class SceneObject {
  /** World position [x, y, z] — write to teleport. */
  position: [number, number, number]
  /** Euler rotation in radians. */
  rotation: [number, number, number]
  /** Per-axis scale multiplier. */
  scale: [number, number, number] = [1, 1, 1]
  /** World velocity in units/s — the usual steering knob for dynamic bodies. */
  velocity: [number, number, number] = [0, 0, 0]
  /** Continuous rotation in rad/s. */
  spin: [number, number, number]
  /** Free-form label used by `each(tag)` / `count(tag)` and collision logic. */
  tag: string
  /** 'dynamic' bodies get gravity, ground bounce, and friction. */
  body: 'static' | 'dynamic'
  /** Solid objects push dynamic bodies out on contact. */
  solid: boolean
  /** Ground-bounce energy retention, 0..1. */
  restitution: number
  /** Collision sphere radius (approximate for non-spheres). */
  radius: number
  /** Pair-collision radius — defaults to `radius`; override for generous pickups. */
  hitRadius: number
  /** False once removed — dead objects skip simulation, rendering, and callbacks. */
  alive = true

  /** @internal collider kind — cylinders collide radially in XZ, not as spheres. */
  collider: 'sphere' | 'cylinder' = 'sphere'
  /** @internal half-height of the cylinder collision band. */
  halfHeight = 0
  /** @internal position at the start of this tick's integration — the CCD sweep origin. */
  prevPosition: Vec3 | null = null
  /** @internal raw ground contact this frame (no coyote grace). */
  groundedNow = false
  /** @internal sim-time stamp of the most recent ground contact. */
  groundedAt = -Infinity
  /** @internal spheres roll: mesh spin derived from horizontal velocity. */
  rolls = false
  /** @internal accumulated rolling orientation (world-space). */
  rollQuat: Vec4 | null = null
  /** @internal downward speed of the latest fresh landing; camera consumes it. */
  impact = 0
  /** @internal spawn-state snapshot restored by scene.reset(). */
  spawn: { position: Vec3; rotation: Vec3 }

  /** True on ground contact — held ~100ms after leaving (coyote time) while not moving up. */
  get grounded(): boolean {
    if (this.groundedNow) return true
    return this.velocity[1] <= 0 && this.scene.simTime - this.groundedAt <= COYOTE_TIME
  }
  set grounded(v: boolean) {
    this.groundedNow = v
    if (v) this.groundedAt = this.scene.simTime
  }

  /** @internal */ geo: MeshGeometry
  /** @internal */ matLike: MaterialLike | undefined
  /** @internal */ handle: MeshHandle | null = null
  /** @internal */ shadowHandle: MeshHandle | null = null
  /** @internal */ wantShadow: boolean
  /** @internal */ collideCbs: Array<(other: SceneObject) => void> = []
  /** @internal */ landCbs: Array<(intensity: number) => void> = []
  /** @internal */ scene: YuraScene

  constructor(scene: YuraScene, geo: MeshGeometry, radius: number, opts: AddOptions) {
    this.scene = scene
    this.geo = geo
    this.matLike = opts.material
    this.position = opts.position ? [...opts.position] : [0, 0, 0]
    this.rotation = opts.rotation ? [...opts.rotation] : [0, 0, 0]
    this.spin = opts.spin ? [...opts.spin] : [0, 0, 0]
    this.tag = opts.tag ?? ''
    this.body = opts.body ?? 'static'
    this.solid = opts.solid ?? false
    this.restitution = opts.restitution ?? 0.35
    this.radius = radius
    this.hitRadius = opts.hitRadius ?? radius
    this.wantShadow = opts.shadow ?? false
    this.spawn = { position: [...this.position], rotation: [...this.rotation] }
  }

  /** Fires when this object touches another (both callbacks run, once per contact pair). */
  onCollide(cb: (other: SceneObject) => void): this {
    this.collideCbs.push(cb)
    return this
  }

  /**
   * Fires exactly once per fresh ground contact with the landing's downward
   * speed — the same impact detection the camera dip consumes, not a copy.
   * One line of game code: `ball.onLand((i) => sfx.land(i))`.
   */
  onLand(cb: (intensity: number) => void): this {
    this.landCbs.push(cb)
    return this
  }

  /**
   * Attaches a glowing particle trail that follows this object.
   * One line of game code: `player.trail({ color: '#4cc9f0' })`.
   */
  trail(opts: TrailOptions = {}): TrailHandle {
    return this.scene.trail(this, opts)
  }

  /** Remove from the scene (mesh, shadow, physics). `scene.reset()` restores it at spawn. */
  remove(): void {
    if (!this.alive) return
    this.alive = false
    this.handle?.remove()
    this.shadowHandle?.remove()
    this.scene.forget(this)
  }
}

/**
 * Unified game input — keyboard (WASD/arrows), touch (drag = virtual stick,
 * quick tap = jump), and gamepad — merged so the largest magnitude wins.
 * Read `x` / `y` / `jump` inside {@link YuraScene.onUpdate}; nothing to wire up.
 *
 * @example
 * scene.onUpdate((dt, input) => {
 *   player.velocity[0] += input.x * 26 * dt
 *   if (input.jump && player.grounded) player.velocity[1] = 8.5
 * })
 */
export class SceneInput {
  private keys = new Set<string>()
  private prevKeys = new Set<string>()
  private cleanupFns: Array<() => void> = []
  /** Frame clock (seconds) advanced by endFrame — drives the jump buffer. */
  private clock = 0
  /** Clock stamp of the latest Space keydown edge; -Infinity = no pending intent. */
  private jumpEdgeAt = -Infinity
  /** @internal set by the scene each frame: a grounded dynamic body can jump now. */
  jumpEligible: boolean | null = null

  /** Pointer id currently driving the virtual stick; null = no drag active. */
  private stickId: number | null = null
  private stickStartX = 0
  private stickStartY = 0
  private stickStartAt = 0
  private stickMoved = 0
  private stickX = 0
  private stickY = 0
  /** Latest gamepad reading (dead-zoned) and held state for edge detection. */
  private padX = 0
  private padY = 0
  private padJump = false

  /** -1..1 — keyboard, touch-drag stick, or gamepad; largest magnitude wins. */
  get x(): number {
    const kb =
      (this.key('KeyD') || this.key('ArrowRight') ? 1 : 0) - (this.key('KeyA') || this.key('ArrowLeft') ? 1 : 0)
    return combineAxes(kb, this.stickX, this.padX)
  }

  /** -1..1 (forward positive) — keyboard, touch, or gamepad; largest wins. */
  get y(): number {
    const kb = (this.key('KeyW') || this.key('ArrowUp') ? 1 : 0) - (this.key('KeyS') || this.key('ArrowDown') ? 1 : 0)
    return combineAxes(kb, this.stickY, this.padY)
  }

  /** True while the key with this KeyboardEvent.code (e.g. 'KeyW', 'Space') is held. */
  key(code: string): boolean {
    return this.keys.has(code)
  }

  /** True only on the frame the key goes down. */
  pressed(code: string): boolean {
    return this.keys.has(code) && !this.prevKeys.has(code)
  }

  /**
   * Jump intent, consumed on use. A Space tap is buffered for ~150ms so it
   * survives a within-frame press/release and lands the jump on the first
   * frame the body can actually take off; holding Space keeps the intent
   * alive, so a held key re-jumps on each landing. While the scene reports no
   * jump-capable body (airborne past coyote time), reading this returns false
   * WITHOUT consuming the buffer — the tap still fires on landing.
   */
  get jump(): boolean {
    const buffered = this.clock - this.jumpEdgeAt <= JUMP_BUFFER
    if (!buffered && !this.key('Space') && !this.padJump) return false
    if (this.jumpEligible === false) return false
    this.jumpEdgeAt = -Infinity
    return true
  }

  /** @internal raw keydown edge (also the headless-test entry point). */
  keyDown(code: string, repeat = false): void {
    if (code === 'Space' && !repeat && !this.keys.has(code)) this.jumpEdgeAt = this.clock
    this.keys.add(code)
  }

  /** @internal raw keyup edge (also the headless-test entry point). */
  keyUp(code: string): void {
    this.keys.delete(code)
  }

  /**
   * @internal pointer edge (also the headless-test entry point). The first
   * pointer becomes the virtual stick; any additional pointer while the stick
   * drags is an immediate jump edge (second-finger tap).
   */
  pointerDown(id: number, x: number, y: number): void {
    if (this.stickId === null) {
      this.stickId = id
      this.stickStartX = x
      this.stickStartY = y
      this.stickStartAt = this.clock
      this.stickMoved = 0
      this.stickX = 0
      this.stickY = 0
    } else if (id !== this.stickId) {
      this.jumpEdgeAt = this.clock
    }
  }

  /** @internal drag update for the stick pointer — maps offset to axes. */
  pointerMove(id: number, x: number, y: number): void {
    if (id !== this.stickId) return
    const dx = x - this.stickStartX
    const dy = y - this.stickStartY
    this.stickMoved = Math.max(this.stickMoved, Math.hypot(dx, dy))
    const a = stickAxes(dx, dy)
    this.stickX = a.x
    this.stickY = a.y
  }

  /** @internal release: a quick, small press was a tap = jump; drag just ends. */
  pointerUp(id: number): void {
    if (id !== this.stickId) return
    if (isTap(this.clock - this.stickStartAt, this.stickMoved)) this.jumpEdgeAt = this.clock
    this.stickId = null
    this.stickX = 0
    this.stickY = 0
  }

  /** @internal cancelled pointer drops the stick without a tap. */
  pointerCancel(id: number): void {
    if (id !== this.stickId) return
    this.stickId = null
    this.stickX = 0
    this.stickY = 0
  }

  /**
   * @internal feed one gamepad reading (also the headless-test entry point).
   * A rising jump edge lands in the shared jump buffer; holding the button
   * keeps the intent alive exactly like a held Space.
   */
  applyPad(reading: { x: number; y: number; jump: boolean }): void {
    this.padX = reading.x
    this.padY = reading.y
    if (reading.jump && !this.padJump) this.jumpEdgeAt = this.clock
    this.padJump = reading.jump
  }

  /** @internal drop all held state — blur/tab-hide never delivers the keyups. */
  clearKeys(): void {
    this.keys.clear()
    this.prevKeys.clear()
    this.jumpEdgeAt = -Infinity
    this.stickId = null
    this.stickX = 0
    this.stickY = 0
    this.padX = 0
    this.padY = 0
    this.padJump = false
  }

  /** @internal */
  bind(): void {
    const down = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault()
      this.keyDown(e.code, e.repeat)
    }
    const up = (e: KeyboardEvent) => this.keyUp(e.code)
    const blur = () => this.clearKeys()
    const vis = () => {
      if (document.visibilityState === 'hidden') this.clearKeys()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', vis)
    this.cleanupFns.push(() => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      document.removeEventListener('visibilitychange', vis)
    })
  }

  /**
   * @internal touch/mouse drag = virtual stick, quick tap = jump. Bound to
   * the scene container so page scroll and text selection stay untouched
   * elsewhere; pointer capture keeps a drag alive when it leaves the canvas.
   */
  bindPointer(el: HTMLElement): void {
    const prevTouchAction = el.style.touchAction
    el.style.touchAction = 'none'
    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') e.preventDefault()
      try {
        el.setPointerCapture?.(e.pointerId)
      } catch {
        /* capture is a nicety — a plain drag still works without it */
      }
      this.pointerDown(e.pointerId, e.clientX, e.clientY)
    }
    const move = (e: PointerEvent) => this.pointerMove(e.pointerId, e.clientX, e.clientY)
    const up = (e: PointerEvent) => this.pointerUp(e.pointerId)
    const cancel = (e: PointerEvent) => this.pointerCancel(e.pointerId)
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', cancel)
    this.cleanupFns.push(() => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', cancel)
      el.style.touchAction = prevTouchAction
    })
  }

  /** @internal */
  endFrame(dt = 0): void {
    this.prevKeys = new Set(this.keys)
    if (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function') {
      this.applyPad(readGamepads(navigator.getGamepads()))
    }
    this.clock += dt
  }

  /** @internal */
  dispose(): void {
    for (const fn of this.cleanupFns) fn()
    this.cleanupFns = []
  }
}

interface CameraState {
  mode: 'orbit' | 'follow'
  target: SceneObject | null
  distance: number
  height: number
  smoothedEye: Vec3 | null
  smoothedLook: Vec3 | null
  /** Landing-dip amount (decays each frame). */
  dip: number
  /** Eased occlusion pull-in distance (eye toward look when blocked). */
  occlusion: number
}

/**
 * HUD text metadata — the source of truth an element is (re)built from, so
 * text survives detach/re-attach cycles (WebGPU device recovery re-runs
 * attach after the old cleanup removed every element).
 */
interface TextRecord {
  content: string
  anchor: 'top-left' | 'top' | 'top-right'
  el: HTMLElement | null
}

/**
 * The zero-asset 3D game kit behind `yura(sel).scene()` / `.game()`:
 * procedural PBR primitives, physics-lite, unified input, follow camera,
 * HUD text, and GPU particle FX — a playable game in ~40 lines.
 *
 * @example
 * yura('#game').game({ gravity: -22, bounds: 12 }, (scene) => {
 *   scene.add('plane', { size: 24, material: 'checker' })
 *   const player = scene.add('sphere', { radius: 0.45, body: 'dynamic' })
 *   scene.camera.follow(player)
 * })
 */
export class YuraScene {
  /** Unified keyboard/touch/gamepad input, also handed to every onUpdate callback. */
  readonly input = new SceneInput()
  /** Y acceleration for dynamic bodies (from SceneOptions.gravity). */
  gravity: number
  /** Half-size of the square play area; 0 = unbounded. */
  bounds: number
  private keyboard: boolean
  /** @internal sim clock (seconds) — drives coyote time; set each step. */
  simTime = 0

  private objects: SceneObject[] = []
  private updateCbs: Array<(dt: number, input: SceneInput, time: number) => void> = []
  private renderer: WebGPUModelRenderer | null = null
  private container: HTMLElement | null = null
  private groundY: number | null = null
  private cam: CameraState = {
    mode: 'orbit', target: null, distance: 8, height: 3.5, smoothedEye: null, smoothedLook: null, dip: 0, occlusion: 0,
  }
  private removed: SceneObject[] = []
  private texts: TextRecord[] = []

  /** Particle-FX pool behind burst/trail/celebrate. Pure logic — steps headless. */
  readonly fx = new FxPool(8192)
  private trails: Array<{ obj: SceneObject; emitter: FxTrailEmitter; active: boolean }> = []
  private fxInstances: Float32Array<ArrayBuffer> | null = null

  /**
   * Camera control: `follow(obj)` tracks an object with exponential
   * smoothing (plus landing dip and occlusion pull-in); `orbit()` hands
   * control back to pointer orbiting.
   */
  readonly camera = {
    follow: (obj: SceneObject, opts: { distance?: number; height?: number } = {}): void => {
      this.cam.mode = 'follow'
      this.cam.target = obj
      this.cam.distance = opts.distance ?? 8
      this.cam.height = opts.height ?? 3.5
    },
    orbit: (): void => {
      this.cam.mode = 'orbit'
      if (this.renderer) this.renderer.cameraPose = null
    },
  }

  constructor(opts: SceneOptions = {}) {
    this.gravity = opts.gravity ?? 0
    this.bounds = opts.bounds ?? 0
    this.keyboard = opts.keyboard ?? true
  }

  /**
   * Add a procedural mesh to the scene. 'plane' becomes the ground; dynamic
   * spheres roll on it automatically.
   *
   * @example
   * scene.add('plane', { size: 24, material: 'checker' })
   * const orb = scene.add('sphere', { radius: 0.26, material: materials.neon('#22d3ee'), tag: 'orb' })
   */
  add(shape: ShapeName, opts: AddOptions = {}): SceneObject {
    const { geo, radius, collider, halfHeight } = buildShape(shape, opts)
    const obj = new SceneObject(this, geo, radius, opts)
    obj.collider = collider ?? 'sphere'
    obj.halfHeight = halfHeight ?? radius
    if (shape === 'plane') {
      if (this.groundY !== null) {
        warnCode(
          CODES.GROUND_REPLACED,
          `add('plane') called again: the ground height moves from y=${this.groundY} to y=${obj.position[1]}. ` +
            `The earlier plane keeps rendering but no longer acts as the ground.`,
        )
      }
      this.groundY = obj.position[1]
      obj.radius = 0 // ground never sphere-collides
    }
    obj.rolls = shape === 'sphere' // dynamic spheres roll instead of sliding
    this.objects.push(obj)
    if (this.renderer) this.realize(obj)
    return obj
  }

  /**
   * Game-logic callback run every fixed simulation tick (1/60 s) with the
   * step dt, the merged input, and the sim clock — put steering, jumping,
   * and scoring here.
   */
  onUpdate(cb: (dt: number, input: SceneInput, time: number) => void): this {
    this.updateCbs.push(cb)
    return this
  }

  /**
   * DOM HUD text — web-native, crisp, zero GPU cost. The handle owns metadata
   * (current content + anchor), so the element can be rebuilt with its latest
   * text after device recovery; `set` keeps working across re-attach.
   */
  text(initial: string, opts: { anchor?: 'top-left' | 'top' | 'top-right' } = {}): TextHandle {
    const rec: TextRecord = { content: initial, anchor: opts.anchor ?? 'top-left', el: null }
    this.texts.push(rec)
    this.mountText(rec)
    return {
      set: (t: string) => {
        rec.content = t
        if (rec.el) rec.el.textContent = t
      },
      remove: () => {
        rec.el?.remove()
        rec.el = null
        this.texts = this.texts.filter((r) => r !== rec)
      },
    }
  }

  private mountText(rec: TextRecord): void {
    if (rec.el || typeof document === 'undefined') return
    const el = document.createElement('div')
    const pos =
      rec.anchor === 'top'
        ? 'left:50%;transform:translateX(-50%);'
        : rec.anchor === 'top-right'
          ? 'right:18px;'
          : 'left:18px;'
    el.style.cssText =
      `position:absolute;top:14px;${pos}pointer-events:none;` +
      'font-family:ui-monospace,Menlo,monospace;font-size:15px;letter-spacing:0.14em;' +
      'color:#e2f4ff;text-shadow:0 0 12px rgba(56,189,248,0.8);z-index:10;'
    el.textContent = rec.content
    ;(this.container ?? document.body).appendChild(el)
    rec.el = el
  }

  /** @internal (re)creates HUD elements from metadata — attach / recovery. */
  mountTexts(): void {
    for (const rec of this.texts) this.mountText(rec)
  }

  /** @internal removes HUD elements but keeps metadata for the next attach. */
  unmountTexts(): void {
    for (const rec of this.texts) {
      rec.el?.remove()
      rec.el = null
    }
  }

  /** Number of live objects in the scene. */
  get objectCount(): number {
    return this.objects.length
  }

  /** Iterate live objects, optionally filtered by tag. */
  each(tag: string | null, cb: (obj: SceneObject, index: number) => void): void {
    let i = 0
    for (const o of [...this.objects]) {
      if (o.alive && (tag === null || o.tag === tag)) cb(o, i++)
    }
  }

  /** Count live objects with a tag. */
  count(tag: string): number {
    let n = 0
    for (const o of this.objects) if (o.alive && o.tag === tag) n++
    return n
  }

  /**
   * Fires a radial particle burst at `position` — the one-liner for collect
   * flashes, explosions, and impacts:
   * `orb.onCollide(() => scene.burst(orb.position, { color: '#ffd166' }))`.
   */
  burst(position: readonly [number, number, number] | Vec3, opts: BurstOptions = {}): this {
    this.fx.burst(position, opts)
    return this
  }

  /**
   * Attaches a glowing particle trail that follows `obj` until stopped or the
   * object is removed. Also available as `obj.trail(opts)`.
   */
  trail(obj: SceneObject, opts: TrailOptions = {}): TrailHandle {
    const entry = { obj, emitter: new FxTrailEmitter(this.fx, opts), active: true }
    this.trails.push(entry)
    return {
      stop: () => {
        entry.active = false
      },
    }
  }

  /**
   * Fireworks-like multi-burst win celebration:
   * `if (score === total) scene.celebrate()`.
   */
  celebrate(opts: CelebrateOptions = {}): this {
    this.fx.celebrate(opts)
    return this
  }

  /** @internal called by YuraApp once the GPU renderer exists. */
  attach(renderer: WebGPUModelRenderer, container: HTMLElement): () => void {
    this.renderer = renderer
    this.container = container
    renderer.shadowArea = this.bounds > 0 ? this.bounds * 1.25 + 2 : 14
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative'
    if (this.keyboard) {
      this.input.bind()
      this.input.bindPointer(container)
    }
    for (const obj of this.objects) this.realize(obj)
    this.mountTexts()
    return () => {
      this.input.dispose()
      this.unmountTexts()
    }
  }

  /** @internal */
  forget(obj: SceneObject): void {
    this.objects = this.objects.filter((o) => o !== obj)
    this.removed.push(obj)
  }

  /**
   * One-line "play again": every object (removed ones included) returns to its
   * spawn position at rest, particles clear, and the camera's landing dip
   * resets. HUD text, callbacks, trails, and camera follow all survive.
   */
  reset(): this {
    for (const obj of this.removed) {
      obj.alive = true
      obj.handle = null
      obj.shadowHandle = null
      this.objects.push(obj)
      if (this.renderer) this.realize(obj)
    }
    this.removed = []
    for (const obj of this.objects) {
      obj.position = [...obj.spawn.position]
      obj.rotation = [...obj.spawn.rotation]
      obj.velocity = [0, 0, 0]
      obj.rollQuat = null
      obj.groundedNow = false
      obj.groundedAt = -Infinity
      obj.impact = 0
    }
    this.fx.clear()
    this.cam.dip = 0
    this.cam.occlusion = 0
    return this
  }

  /** @internal one simulation step; safe to run headless (tests). */
  step(dt: number, time: number): void {
    this.simTime = time
    // Jump gating for the input's buffered intent: while nothing can take off
    // (airborne past coyote), input.jump must not consume the buffered tap.
    let jumpable = false
    for (const o of this.objects) {
      if (o.alive && o.body === 'dynamic' && o.grounded) {
        jumpable = true
        break
      }
    }
    this.input.jumpEligible = jumpable
    for (const cb of this.updateCbs) cb(dt, this.input, time)

    const ground = this.groundY
    for (const obj of this.objects) {
      if (!obj.alive) continue
      obj.rotation[0] += obj.spin[0] * dt
      obj.rotation[1] += obj.spin[1] * dt
      obj.rotation[2] += obj.spin[2] * dt
      if (obj.body === 'dynamic') {
        // CCD sweep origin: where this body sat before this tick's motion.
        const prev = (obj.prevPosition ??= [0, 0, 0])
        prev[0] = obj.position[0]
        prev[1] = obj.position[1]
        prev[2] = obj.position[2]
        // Sleep threshold: a resting body stays at rest instead of re-gaining
        // gravity every frame and sinking/popping a few mm below the ground.
        if (obj.groundedNow && Math.abs(obj.velocity[1]) < SLEEP_VY) {
          obj.velocity[1] = 0
        } else {
          obj.velocity[1] += this.gravity * dt
        }
        obj.position[0] += obj.velocity[0] * dt
        obj.position[1] += obj.velocity[1] * dt
        obj.position[2] += obj.velocity[2] * dt
        // Rolling: dynamic spheres derive mesh spin from horizontal velocity,
        // so they roll across the floor instead of sliding. Zero game code.
        if (obj.rolls) {
          const { axis, angle } = rollDelta(obj.velocity[0], obj.velocity[2], obj.radius, dt)
          if (angle > 0) rotateQuat((obj.rollQuat ??= [0, 0, 0, 1]), axis, angle)
        }
        const wasGrounded = obj.groundedNow
        obj.grounded = false
        const clearance = obj.collider === 'cylinder' ? obj.halfHeight : obj.radius
        if (ground !== null && obj.position[1] - clearance <= ground) {
          obj.position[1] = ground + clearance
          // Fresh landing: record the downward speed for the camera's dip
          // and fire onLand listeners from the same single detection.
          if (!wasGrounded && obj.velocity[1] < -1) {
            obj.impact = -obj.velocity[1]
            for (const cb of obj.landCbs) cb(obj.impact)
          }
          if (obj.velocity[1] < 0) {
            obj.velocity[1] = Math.abs(obj.velocity[1]) > 1 ? -obj.velocity[1] * obj.restitution : 0
          }
          obj.grounded = true
          const f = Math.exp(-2.2 * dt)
          obj.velocity[0] *= f
          obj.velocity[2] *= f
        }
        if (this.bounds > 0) {
          for (const axis of [0, 2] as const) {
            const limit = this.bounds - obj.radius
            if (Math.abs(obj.position[axis]) > limit) {
              const r = clampToBounds(obj.position[axis], obj.velocity[axis], limit)
              obj.position[axis] = r.position
              obj.velocity[axis] = r.velocity
            }
          }
        }
      }
    }

    // Collisions: callbacks + push-out vs solid objects. Cylinders collide as
    // true vertical cylinders (radial XZ, inside their height band); every
    // other pair keeps the sphere-sphere path.
    const objs = this.objects
    for (let i = 0; i < objs.length; i++) {
      const a = objs[i]
      if (!a.alive || a.radius === 0) continue
      for (let j = i + 1; j < objs.length; j++) {
        const b = objs[j]
        if (!b.alive || b.radius === 0) continue
        const cyl =
          a.collider === 'cylinder' ? (b.collider === 'cylinder' ? null : a) : b.collider === 'cylinder' ? b : null
        let rr: number
        let d2: number
        if (cyl) {
          const s = cyl === a ? b : a
          rr = cyl.hitRadius + s.hitRadius
          if (Math.abs(s.position[1] - cyl.position[1]) > cyl.halfHeight + s.hitRadius) {
            d2 = Infinity // outside the height band: no radial contact right now
          } else {
            const dx = s.position[0] - cyl.position[0]
            const dz = s.position[2] - cyl.position[2]
            d2 = dx * dx + dz * dz
          }
        } else {
          const dx = a.position[0] - b.position[0]
          const dy = a.position[1] - b.position[1]
          const dz = a.position[2] - b.position[2]
          rr = a.hitRadius + b.hitRadius
          d2 = dx * dx + dy * dy + dz * dz
        }
        if (d2 > rr * rr) {
          // Discrete miss. Swept-sphere CCD: a fast dynamic body may have
          // crossed the other collider entirely between ticks — test the
          // capsule from its pre-integration position to where it is now.
          const dyn0 = a.body === 'dynamic' ? a : b.body === 'dynamic' ? b : null
          const prev = dyn0?.prevPosition
          if (!dyn0 || !prev) continue
          const mx = dyn0.position[0] - prev[0]
          const my = dyn0.position[1] - prev[1]
          const mz = dyn0.position[2] - prev[2]
          const minR = Math.min(a.hitRadius, b.hitRadius)
          // Fast path: small per-tick travel cannot tunnel — keep the discrete result.
          if (mx * mx + my * my + mz * mz < 0.25 * minR * minR) continue
          const target = dyn0 === a ? b : a
          const toi = cyl
            ? sweptCylinderTOI(prev, dyn0.position, target.position, rr, cyl.halfHeight + (cyl === a ? b : a).hitRadius)
            : sweptSphereTOI(prev, dyn0.position, target.position, rr)
          if (toi < 0) continue
          if (target.solid) {
            // Rewind the body to the time-of-impact contact; the shared
            // response below applies the normal push-out/bounce from there.
            dyn0.position[0] = prev[0] + mx * toi
            dyn0.position[1] = prev[1] + my * toi
            dyn0.position[2] = prev[2] + mz * toi
            const dx = dyn0.position[0] - target.position[0]
            const dy = dyn0.position[1] - target.position[1]
            const dz = dyn0.position[2] - target.position[2]
            d2 = cyl ? dx * dx + dz * dz : dx * dx + dy * dy + dz * dz
          }
          // Non-solid sweep hits (orb pickups) fire callbacks below and keep
          // the integrated position — the body passed through the trigger.
        }
        for (const cb of a.collideCbs) cb(b)
        for (const cb of b.collideCbs) cb(a)
        const dyn = a.body === 'dynamic' ? a : b.body === 'dynamic' ? b : null
        const other = dyn === a ? b : a
        if (dyn && other.solid && dyn.alive && other.alive) {
          const d = Math.sqrt(d2) || 1e-4
          const nx = (dyn.position[0] - other.position[0]) / d
          const ny = cyl ? 0 : (dyn.position[1] - other.position[1]) / d
          const nz = (dyn.position[2] - other.position[2]) / d
          const push = rr - d
          dyn.position[0] += nx * push
          dyn.position[1] += ny * push
          dyn.position[2] += nz * push
          const vn = dyn.velocity[0] * nx + dyn.velocity[1] * ny + dyn.velocity[2] * nz
          if (vn < 0) {
            const k = -(1 + 0.4) * vn
            dyn.velocity[0] += nx * k
            dyn.velocity[1] += ny * k
            dyn.velocity[2] += nz * k
          }
        }
      }
    }

    this.stepFx(dt)
    this.updateCamera(dt)
    this.syncWorlds()
    this.input.endFrame(dt)
  }

  /** Emit trails at their objects, advance the pool, hand sprites to the GPU. */
  private stepFx(dt: number): void {
    let prune = false
    for (const t of this.trails) {
      if (!t.active || !t.obj.alive) {
        prune = true
        continue
      }
      t.emitter.step(dt, t.obj.position, t.obj.velocity)
    }
    if (prune) this.trails = this.trails.filter((t) => t.active && t.obj.alive)
    this.fx.step(dt)
    if (!this.renderer) return
    if (!this.fxInstances) this.fxInstances = new Float32Array(this.fx.capacity * FX_FLOATS)
    this.renderer.setFX(this.fxInstances, this.fx.writeInstances(this.fxInstances))
  }

  private updateCamera(dt: number): void {
    if (!this.renderer) return
    const cam = this.cam
    if (cam.mode !== 'follow' || !cam.target || !cam.target.alive) return
    // Landing dip: absorb the target's impact, then decay it fast but smoothly.
    if (cam.target.impact > 0) {
      cam.dip = Math.min(cam.dip + cam.target.impact * 0.035, 0.45)
      cam.target.impact = 0
    }
    cam.dip *= Math.exp(-6 * dt)
    const goal = cameraFollowGoal(cam.target.position, cam.target.velocity, cam, cam.dip)
    if (!cam.smoothedEye) cam.smoothedEye = [...goal.eye]
    if (!cam.smoothedLook) cam.smoothedLook = [...goal.look]
    const ke = 1 - Math.exp(-dt * 5)
    const kl = 1 - Math.exp(-dt * 9)
    const e = cam.smoothedEye
    const l = cam.smoothedLook
    for (let i = 0; i < 3; i++) {
      e[i] += (goal.eye[i] - e[i]) * ke
      l[i] += (goal.look[i] - l[i]) * kl
    }
    // Occlusion: cast look → eye against solids; if blocked, ease the eye in
    // toward the look-target so pillars/knot never hide the ball (no popping —
    // the correction distance itself is eased both in and out).
    const solids: OcclusionSolid[] = []
    for (const o of this.objects) {
      if (o.alive && o.solid && o.radius > 0 && o !== cam.target) solids.push(o)
    }
    const dist = Math.hypot(e[0] - l[0], e[1] - l[1], e[2] - l[2])
    const allowed = occludedEyeDistance(l, e, solids)
    cam.occlusion = easeOcclusion(cam.occlusion, Math.max(0, dist - allowed), dt)
    const eye: Vec3 = [...e]
    if (cam.occlusion > 1e-4 && dist > 1e-6) {
      const k = cam.occlusion / dist
      for (let i = 0; i < 3; i++) eye[i] += (l[i] - e[i]) * k
    }
    this.renderer.cameraPose = { eye, target: [...l] }
  }

  private realize(obj: SceneObject): void {
    if (!this.renderer || obj.handle) return
    obj.handle = this.renderer.addMesh(obj.geo, resolveMaterial(obj.matLike), { shadow: obj.wantShadow })
    if (obj.wantShadow) {
      obj.shadowHandle = this.renderer.addMesh(meshes.disc(1, 32), {
        color: [0, 0, 0, 0.42],
        metallic: 0,
        roughness: 1,
        emissive: [0, 0, 0],
        unlit: true,
        fade: true,
      })
    }
    this.syncObject(obj)
  }

  private syncObject(obj: SceneObject): void {
    if (!obj.handle) return
    const e = eulerToQuat(obj.rotation[0], obj.rotation[1], obj.rotation[2])
    const q = obj.rollQuat ? quatMul(obj.rollQuat, e) : e
    obj.handle.setWorld(trsToMat4(obj.position, q, obj.scale))
    if (obj.shadowHandle) {
      const g = this.groundY ?? 0
      const h = Math.max(obj.position[1] - obj.radius - g, 0)
      const s = obj.radius * 1.7 * Math.max(1 - h * 0.16, 0.3)
      obj.shadowHandle.setWorld(
        trsToMat4([obj.position[0], g + 0.02, obj.position[2]], [0, 0, 0, 1], [s, 1, s]),
      )
    }
  }

  private syncWorlds(): void {
    for (const obj of this.objects) {
      if (obj.alive) this.syncObject(obj)
    }
  }
}

function buildShape(
  shape: ShapeName,
  opts: AddOptions,
): { geo: MeshGeometry; radius: number; collider?: 'cylinder'; halfHeight?: number } {
  const size = opts.size
  const s3: [number, number, number] = Array.isArray(size) ? size : [size ?? 1, size ?? 1, size ?? 1]
  switch (shape) {
    case 'sphere': {
      const r = opts.radius ?? 0.5
      return { geo: meshes.sphere(r), radius: r }
    }
    case 'box':
      return { geo: meshes.box(s3[0], s3[1], s3[2]), radius: Math.hypot(s3[0], s3[1], s3[2]) * 0.35 }
    case 'torus': {
      const r = opts.radius ?? 1
      return { geo: meshes.torus(r, r * 0.35), radius: r * 1.2 }
    }
    case 'knot': {
      const r = opts.radius ?? 1
      return { geo: meshes.torusKnot(r, r * 0.3), radius: r * 1.3 }
    }
    case 'cylinder':
      // Collision radius matches the visual radius (s3[0]/2), not the sphere
      // bound — the radial push-out happens only inside the height band.
      return { geo: meshes.cylinder(s3[0] / 2, s3[1]), radius: s3[0] / 2, collider: 'cylinder', halfHeight: s3[1] / 2 }
    case 'plane':
      return { geo: meshes.plane(s3[0], Math.max(2, Math.round(s3[0] / 2))), radius: 0 }
    case 'disc': {
      const r = opts.radius ?? 1
      return { geo: meshes.disc(r), radius: r }
    }
    default:
      // TS makes this unreachable, but plain-JS callers can pass any string
      // and would otherwise die on `Cannot destructure` at the call site.
      throw new YuraError(
        CODES.UNKNOWN_SHAPE,
        `Unknown shape "${String(shape)}". Available: ${SHAPE_NAMES.join(', ')}.`,
        `scene.add('sphere', { radius: 0.5 })`,
      )
  }
}
