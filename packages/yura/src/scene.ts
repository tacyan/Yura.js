import { trsToMat4, eulerToQuat, type Vec3 } from '@yura/core'
import {
  meshes,
  type MeshGeometry,
  type MeshHandle,
  type WebGPUModelRenderer,
} from '@yura/renderer-webgpu'
import { resolveMaterial, type MaterialLike } from './materials'

/**
 * The game layer (spec: "ゲームも作れる最小コード"). Procedural meshes + PBR
 * materials + a tiny physics/collision/input/camera kit. A complete playable
 * game fits in ~40 lines of user code.
 */

export type ShapeName = 'sphere' | 'box' | 'torus' | 'knot' | 'cylinder' | 'plane' | 'disc'

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

export interface TextHandle {
  set(text: string): void
  remove(): void
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
  grounded = false
  alive = true

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
  }

  onCollide(cb: (other: SceneObject) => void): this {
    this.collideCbs.push(cb)
    return this
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

  get jump(): boolean {
    return this.pressed('Space')
  }

  /** @internal */
  bind(): void {
    const down = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault()
      this.keys.add(e.code)
    }
    const up = (e: KeyboardEvent) => this.keys.delete(e.code)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    this.cleanupFns.push(() => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    })
  }

  /** @internal */
  endFrame(): void {
    this.prevKeys = new Set(this.keys)
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
}

export class YuraScene {
  readonly input = new SceneInput()
  gravity: number
  bounds: number
  private keyboard: boolean

  private objects: SceneObject[] = []
  private updateCbs: Array<(dt: number, input: SceneInput, time: number) => void> = []
  private renderer: WebGPUModelRenderer | null = null
  private container: HTMLElement | null = null
  private groundY: number | null = null
  private cam: CameraState = { mode: 'orbit', target: null, distance: 8, height: 3.5, smoothedEye: null }
  private texts: HTMLElement[] = []

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
    const { geo, radius } = buildShape(shape, opts)
    const obj = new SceneObject(this, geo, radius, opts)
    if (shape === 'plane') {
      this.groundY = obj.position[1]
      obj.radius = 0 // ground never sphere-collides
    }
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
  }

  /** @internal one simulation step; safe to run headless (tests). */
  step(dt: number, time: number): void {
    for (const cb of this.updateCbs) cb(dt, this.input, time)

    const ground = this.groundY
    for (const obj of this.objects) {
      if (!obj.alive) continue
      obj.rotation[0] += obj.spin[0] * dt
      obj.rotation[1] += obj.spin[1] * dt
      obj.rotation[2] += obj.spin[2] * dt
      if (obj.body === 'dynamic') {
        obj.velocity[1] += this.gravity * dt
        obj.position[0] += obj.velocity[0] * dt
        obj.position[1] += obj.velocity[1] * dt
        obj.position[2] += obj.velocity[2] * dt
        obj.grounded = false
        if (ground !== null && obj.position[1] - obj.radius <= ground) {
          obj.position[1] = ground + obj.radius
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

    // Sphere-sphere collisions: callbacks + push-out vs solid objects.
    const objs = this.objects
    for (let i = 0; i < objs.length; i++) {
      const a = objs[i]
      if (!a.alive || a.radius === 0) continue
      for (let j = i + 1; j < objs.length; j++) {
        const b = objs[j]
        if (!b.alive || b.radius === 0) continue
        const dx = a.position[0] - b.position[0]
        const dy = a.position[1] - b.position[1]
        const dz = a.position[2] - b.position[2]
        const rr = a.radius + b.radius
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 > rr * rr) continue
        for (const cb of a.collideCbs) cb(b)
        for (const cb of b.collideCbs) cb(a)
        const dyn = a.body === 'dynamic' ? a : b.body === 'dynamic' ? b : null
        const other = dyn === a ? b : a
        if (dyn && other.solid && dyn.alive && other.alive) {
          const d = Math.sqrt(d2) || 1e-4
          const nx = (dyn.position[0] - other.position[0]) / d
          const ny = (dyn.position[1] - other.position[1]) / d
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

    this.updateCamera(dt)
    this.syncWorlds()
    this.input.endFrame()
  }

  private updateCamera(dt: number): void {
    if (!this.renderer) return
    if (this.cam.mode !== 'follow' || !this.cam.target || !this.cam.target.alive) return
    const t = this.cam.target.position
    const desired: Vec3 = [t[0], t[1] + this.cam.height, t[2] + this.cam.distance]
    if (!this.cam.smoothedEye) this.cam.smoothedEye = [...desired]
    const k = 1 - Math.exp(-dt * 5)
    const e = this.cam.smoothedEye
    e[0] += (desired[0] - e[0]) * k
    e[1] += (desired[1] - e[1]) * k
    e[2] += (desired[2] - e[2]) * k
    this.renderer.cameraPose = { eye: [...e], target: [t[0], t[1] + 0.5, t[2]] }
  }

  private realize(obj: SceneObject): void {
    if (!this.renderer || obj.handle) return
    obj.handle = this.renderer.addMesh(obj.geo, resolveMaterial(obj.matLike))
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
    const q = eulerToQuat(obj.rotation[0], obj.rotation[1], obj.rotation[2])
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

function buildShape(shape: ShapeName, opts: AddOptions): { geo: MeshGeometry; radius: number } {
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
      return { geo: meshes.cylinder(s3[0] / 2, s3[1]), radius: Math.max(s3[0] / 2, s3[1] / 2) }
    case 'plane':
      return { geo: meshes.plane(s3[0], Math.max(2, Math.round(s3[0] / 2))), radius: 0 }
    case 'disc': {
      const r = opts.radius ?? 1
      return { geo: meshes.disc(r), radius: r }
    }
  }
}
