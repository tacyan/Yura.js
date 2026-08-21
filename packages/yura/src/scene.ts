import { trsToMat4, eulerToQuat, type Vec3, type Vec4 } from '@yura/core'
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

export type ShapeName = 'sphere' | 'box' | 'torus' | 'knot' | 'cylinder' | 'plane' | 'disc'

/** Seconds a Space tap stays buffered waiting for a landing (jump buffer). */
const JUMP_BUFFER = 0.15
/** Seconds after leaving the ground a jump is still honoured (coyote time). */
const COYOTE_TIME = 0.1
/** Grounded bodies with |vy| below this settle to zero instead of micro-bouncing. */
const SLEEP_VY = 0.05

export interface SceneOptions {
  /** Y acceleration for dynamic bodies (e.g. -18). 0 disables gravity. */
  gravity?: number
  /** Half-size of the square play area; dynamic bodies bounce at the edge. */
  bounds?: number
  /** Bind global keyboard listeners (default true). Disable for embeds. */
  keyboard?: boolean
}

export interface AddOptions {
  radius?: number
  size?: number | [number, number, number]
  position?: [number, number, number]
  rotation?: [number, number, number]
  material?: MaterialLike
  /** 'dynamic' bodies get gravity, ground bounce, and friction. */
  body?: 'static' | 'dynamic'
  /** Solid objects push dynamic bodies out on contact. */
  solid?: boolean
  tag?: string
  /** Auto blob shadow that tracks the object on the ground plane. */
  shadow?: boolean
  /** Continuous rotation in rad/s. */
  spin?: [number, number, number]
  restitution?: number
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

export interface TextHandle {
  set(text: string): void
  remove(): void
}

export interface TrailHandle {
  /** Stops emitting; already-spawned particles fade out naturally. */
  stop(): void
}

export class SceneObject {
  position: [number, number, number]
  rotation: [number, number, number]
  scale: [number, number, number] = [1, 1, 1]
  velocity: [number, number, number] = [0, 0, 0]
  spin: [number, number, number]
  tag: string
  body: 'static' | 'dynamic'
  solid: boolean
  restitution: number
  /** Collision sphere radius (approximate for non-spheres). */
  radius: number
  alive = true

  /** @internal collider kind — cylinders collide radially in XZ, not as spheres. */
  collider: 'sphere' | 'cylinder' = 'sphere'
  /** @internal half-height of the cylinder collision band. */
  halfHeight = 0
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
    this.wantShadow = opts.shadow ?? false
    this.spawn = { position: [...this.position], rotation: [...this.rotation] }
  }

  onCollide(cb: (other: SceneObject) => void): this {
    this.collideCbs.push(cb)
    return this
  }

  /**
   * Attaches a glowing particle trail that follows this object.
   * One line of game code: `player.trail({ color: '#4cc9f0' })`.
   */
  trail(opts: TrailOptions = {}): TrailHandle {
    return this.scene.trail(this, opts)
  }

  remove(): void {
    if (!this.alive) return
    this.alive = false
    this.handle?.remove()
    this.shadowHandle?.remove()
    this.scene.forget(this)
  }
}

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

  /** -1..1 — A/D or arrow left/right. */
  get x(): number {
    return (this.key('KeyD') || this.key('ArrowRight') ? 1 : 0) - (this.key('KeyA') || this.key('ArrowLeft') ? 1 : 0)
  }

  /** -1..1 — W/S or arrow up/down (forward positive). */
  get y(): number {
    return (this.key('KeyW') || this.key('ArrowUp') ? 1 : 0) - (this.key('KeyS') || this.key('ArrowDown') ? 1 : 0)
  }

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
    if (!buffered && !this.key('Space')) return false
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

  /** @internal drop all held state — blur/tab-hide never delivers the keyups. */
  clearKeys(): void {
    this.keys.clear()
    this.prevKeys.clear()
    this.jumpEdgeAt = -Infinity
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

  /** @internal */
  endFrame(dt = 0): void {
    this.prevKeys = new Set(this.keys)
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
}

export class YuraScene {
  readonly input = new SceneInput()
  gravity: number
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
    mode: 'orbit', target: null, distance: 8, height: 3.5, smoothedEye: null, smoothedLook: null, dip: 0,
  }
  private removed: SceneObject[] = []
  private texts: HTMLElement[] = []

  /** Particle-FX pool behind burst/trail/celebrate. Pure logic — steps headless. */
  readonly fx = new FxPool(8192)
  private trails: Array<{ obj: SceneObject; emitter: FxTrailEmitter; active: boolean }> = []
  private fxInstances: Float32Array<ArrayBuffer> | null = null

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

  add(shape: ShapeName, opts: AddOptions = {}): SceneObject {
    const { geo, radius, collider, halfHeight } = buildShape(shape, opts)
    const obj = new SceneObject(this, geo, radius, opts)
    obj.collider = collider ?? 'sphere'
    obj.halfHeight = halfHeight ?? radius
    if (shape === 'plane') {
      this.groundY = obj.position[1]
      obj.radius = 0 // ground never sphere-collides
    }
    obj.rolls = shape === 'sphere' // dynamic spheres roll instead of sliding
    this.objects.push(obj)
    if (this.renderer) this.realize(obj)
    return obj
  }

  onUpdate(cb: (dt: number, input: SceneInput, time: number) => void): this {
    this.updateCbs.push(cb)
    return this
  }

  /** DOM HUD text — web-native, crisp, zero GPU cost. */
  text(initial: string, opts: { anchor?: 'top-left' | 'top' | 'top-right' } = {}): TextHandle {
    const el = document.createElement('div')
    const anchor = opts.anchor ?? 'top-left'
    const pos =
      anchor === 'top' ? 'left:50%;transform:translateX(-50%);' : anchor === 'top-right' ? 'right:18px;' : 'left:18px;'
    el.style.cssText =
      `position:absolute;top:14px;${pos}pointer-events:none;` +
      'font-family:ui-monospace,Menlo,monospace;font-size:15px;letter-spacing:0.14em;' +
      'color:#e2f4ff;text-shadow:0 0 12px rgba(56,189,248,0.8);z-index:10;'
    el.textContent = initial
    ;(this.container ?? document.body).appendChild(el)
    this.texts.push(el)
    return {
      set: (t: string) => {
        el.textContent = t
      },
      remove: () => el.remove(),
    }
  }

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
    if (this.keyboard) this.input.bind()
    for (const obj of this.objects) this.realize(obj)
    return () => {
      this.input.dispose()
      for (const el of this.texts) el.remove()
      this.texts = []
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
          // Fresh landing: record the downward speed for the camera's dip.
          if (!wasGrounded && obj.velocity[1] < -1) obj.impact = -obj.velocity[1]
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
              obj.position[axis] = Math.sign(obj.position[axis]) * limit
              obj.velocity[axis] = -obj.velocity[axis] * 0.5
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
          if (Math.abs(s.position[1] - cyl.position[1]) > cyl.halfHeight + s.radius) continue
          const dx = s.position[0] - cyl.position[0]
          const dz = s.position[2] - cyl.position[2]
          rr = cyl.radius + s.radius
          d2 = dx * dx + dz * dz
        } else {
          const dx = a.position[0] - b.position[0]
          const dy = a.position[1] - b.position[1]
          const dz = a.position[2] - b.position[2]
          rr = a.radius + b.radius
          d2 = dx * dx + dy * dy + dz * dz
        }
        if (d2 > rr * rr) continue
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
    this.renderer.cameraPose = { eye: [...e], target: [...l] }
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
  }
}
