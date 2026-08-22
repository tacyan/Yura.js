import { test, expect } from 'bun:test'
import { identity, lookAt, multiply, perspective, transform4, type Vec3 } from '@yura/core'
import type { ExternalCamera, RendererOptions } from '@yura/renderer-webgpu'
import {
  WebGL2ParticleRenderer,
  createResourceTracker,
  acquireZeroScratch,
} from '../src/renderer'

// ---------------------------------------------------------------------------
// Fake WebGL2 context (no GPU in bun): a Proxy that records every method call
// and hands back unique objects from create*(), mirroring the fake-DOM
// approach in packages/yura/test/scene.test.ts.
// ---------------------------------------------------------------------------

interface GLCall {
  name: string
  args: unknown[]
}

interface FakeGL {
  gl: WebGL2RenderingContext
  calls: GLCall[]
  /** All objects returned by create<Kind>() calls, per kind. */
  created: (kind: string) => object[]
  /** All objects passed to delete<Kind>() calls, per kind. */
  deleted: (kind: string) => object[]
  /** true when getShaderParameter/getProgramParameter should report failure. */
  failLink: { value: boolean }
}

function createFakeGL(): FakeGL {
  const calls: GLCall[] = []
  const failLink = { value: false }
  let nextId = 1
  const createdByKind = new Map<string, object[]>()
  const makeObj = (kind: string): object => {
    const obj = { kind, id: nextId++ }
    let list = createdByKind.get(kind)
    if (!list) {
      list = []
      createdByKind.set(kind, list)
    }
    list.push(obj)
    return obj
  }
  const constants = new Map<string, number>()
  let nextConst = 1
  const gl = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined
        // SCREAMING_CASE property => GL enum constant.
        if (/^[A-Z][A-Z0-9_]*$/.test(prop)) {
          if (!constants.has(prop)) constants.set(prop, nextConst++)
          return constants.get(prop)
        }
        return (...args: unknown[]) => {
          calls.push({ name: prop, args })
          switch (prop) {
            case 'getShaderParameter':
            case 'getProgramParameter':
              return !failLink.value
            case 'getExtension': {
              if (args[0] === 'WEBGL_lose_context') {
                return { loseContext: () => calls.push({ name: 'loseContext', args: [] }) }
              }
              return {} // EXT_color_buffer_float etc: present
            }
            case 'createShader':
              return makeObj('Shader')
            case 'createProgram':
              return makeObj('Program')
            case 'createBuffer':
              return makeObj('Buffer')
            case 'createVertexArray':
              return makeObj('VertexArray')
            case 'createTransformFeedback':
              return makeObj('TransformFeedback')
            case 'createTexture':
              return makeObj('Texture')
            case 'createFramebuffer':
              return makeObj('Framebuffer')
            case 'getUniformLocation':
              return makeObj('UniformLocation')
            case 'getShaderInfoLog':
            case 'getProgramInfoLog':
              return ''
            default:
              return undefined
          }
        }
      },
    },
  ) as unknown as WebGL2RenderingContext
  return {
    gl,
    calls,
    created: (kind) => createdByKind.get(kind) ?? [],
    deleted: (kind) =>
      calls.filter((c) => c.name === `delete${kind}`).map((c) => c.args[0] as object),
    failLink,
  }
}

interface FakeCanvas {
  canvas: HTMLCanvasElement
  listeners: Map<string, Array<(e: Event) => void>>
  added: Array<{ type: string; fn: (e: Event) => void }>
  removed: Array<{ type: string; fn: (e: Event) => void }>
}

function createFakeCanvas(gl: WebGL2RenderingContext): FakeCanvas {
  const listeners = new Map<string, Array<(e: Event) => void>>()
  const added: FakeCanvas['added'] = []
  const removed: FakeCanvas['removed'] = []
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => gl,
    addEventListener(type: string, fn: (e: Event) => void) {
      added.push({ type, fn })
      const list = listeners.get(type) ?? []
      list.push(fn)
      listeners.set(type, list)
    },
    removeEventListener(type: string, fn: (e: Event) => void) {
      removed.push({ type, fn })
      const list = listeners.get(type) ?? []
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    },
  } as unknown as HTMLCanvasElement
  return { canvas, listeners, added, removed }
}

const OPTS: RendererOptions = {
  count: 8,
  look: {
    exposure: 1,
    bloomStrength: 1,
    bloomThreshold: 1,
    vignette: 0,
    grain: 0,
    background: [0, 0, 0],
    particleSize: 1,
    intensity: 1,
    hot: [1, 1, 1],
    twinkle: 0,
    trail: 0.5,
    aberration: 0,
    streak: 0,
    nebula: 0,
    stars: 0,
  },
  motion: {
    attraction: 1,
    damping: 1,
    noiseScale: 1,
    noiseStrength: 1,
    swirl: 0.5,
    maxSpeed: 10,
    speedColorMix: 0.2,
  },
  colorA: [1, 0.5, 0.2],
  colorB: [0.2, 0.5, 1],
}

function makeRenderer() {
  const fake = createFakeGL()
  const fakeCanvas = createFakeCanvas(fake.gl)
  const r = WebGL2ParticleRenderer.create(fakeCanvas.canvas, OPTS)
  if (!r) throw new Error('expected renderer to be created against the fake GL')
  return { r, fake, fakeCanvas }
}

// ---------------------------------------------------------------------------
// 1. contextlost listener is removed on dispose
// ---------------------------------------------------------------------------

test('dispose removes the webglcontextlost listener it registered', () => {
  const { r, fakeCanvas } = makeRenderer()
  expect(fakeCanvas.added.length).toBe(1)
  expect(fakeCanvas.added[0].type).toBe('webglcontextlost')
  expect(fakeCanvas.listeners.get('webglcontextlost')!.length).toBe(1)

  r.dispose()
  expect(fakeCanvas.removed.length).toBe(1)
  expect(fakeCanvas.removed[0].type).toBe('webglcontextlost')
  // The very same function reference is removed, so the browser actually drops it.
  expect(fakeCanvas.removed[0].fn).toBe(fakeCanvas.added[0].fn)
  expect(fakeCanvas.listeners.get('webglcontextlost')!.length).toBe(0)

  r.dispose() // idempotent: no double-removal
  expect(fakeCanvas.removed.length).toBe(1)
})

// ---------------------------------------------------------------------------
// 2. shaders are detached + deleted after a successful link
// ---------------------------------------------------------------------------

test('every shader is detached and deleted once its program links', () => {
  const { fake } = makeRenderer()
  const createdShaders = fake.created('Shader')
  expect(createdShaders.length).toBe(12) // 6 programs x (vs + fs)
  const detached = fake.calls.filter((c) => c.name === 'detachShader')
  expect(detached.length).toBe(12)
  const deletedShaders = fake.deleted('Shader')
  expect(new Set(deletedShaders)).toEqual(new Set(createdShaders))
})

// ---------------------------------------------------------------------------
// 3. dispose deletes programs, VAOs, transform feedback, buffers, textures, FBOs
// ---------------------------------------------------------------------------

test('dispose deletes every created GL resource (programs/VAOs/TF included)', () => {
  const { r, fake } = makeRenderer()
  r.resize(64, 32) // creates hdr + 3 bloom render targets
  r.dispose()

  for (const kind of [
    'Program',
    'VertexArray',
    'TransformFeedback',
    'Buffer',
    'Texture',
    'Framebuffer',
  ]) {
    const created = fake.created(kind)
    const deleted = fake.deleted(kind)
    expect(created.length).toBeGreaterThan(0)
    expect(new Set(deleted)).toEqual(new Set(created))
  }
  // Exact inventory of the tracked kinds.
  expect(fake.created('Program').length).toBe(6)
  expect(fake.created('VertexArray').length).toBe(4)
  expect(fake.created('TransformFeedback').length).toBe(1)
  expect(fake.created('Buffer').length).toBe(6)
  expect(fake.created('Texture').length).toBe(4)
  expect(fake.created('Framebuffer').length).toBe(4)

  // Reverse creation order: programs (created last) go before buffers.
  const names = fake.calls.map((c) => c.name)
  const lastDeleteProgram = names.lastIndexOf('deleteProgram')
  const firstDeleteBuffer = names.indexOf('deleteBuffer')
  expect(lastDeleteProgram).toBeGreaterThanOrEqual(0)
  expect(lastDeleteProgram).toBeLessThan(firstDeleteBuffer)

  expect(names).toContain('loseContext')

  // Second dispose is a no-op: no double deletes.
  const deletes = names.filter((n) => n.startsWith('delete')).length
  r.dispose()
  expect(fake.calls.map((c) => c.name).filter((n) => n.startsWith('delete')).length).toBe(deletes)
})

test('a failed program link leaks nothing from create()', () => {
  const fake = createFakeGL()
  fake.failLink.value = true
  const fakeCanvas = createFakeCanvas(fake.gl)
  const origInfo = console.info // warnCode logs via console.info; keep the run quiet
  console.info = () => {}
  let r: WebGL2ParticleRenderer | null
  try {
    r = WebGL2ParticleRenderer.create(fakeCanvas.canvas, OPTS)
  } finally {
    console.info = origInfo
  }
  expect(r).toBeNull()
  // Constructor-made buffers/VAOs/TF are all released again.
  for (const kind of ['Buffer', 'VertexArray', 'TransformFeedback', 'Shader']) {
    expect(new Set(fake.deleted(kind))).toEqual(new Set(fake.created(kind)))
  }
  expect(fakeCanvas.added.length).toBe(0) // no listener left behind either
})

// ---------------------------------------------------------------------------
// 4. writePositions: shared zero scratch, no per-call allocation, no pollution
// ---------------------------------------------------------------------------

test('writePositions reuses one shared zero scratch instead of allocating per call', () => {
  const { r, fake } = makeRenderer()
  const data = new Float32Array(OPTS.count * 4)
  data.fill(123.5) // markedly non-zero positions

  const mark = fake.calls.length
  r.writePositions(data)
  r.writePositions(data)
  const subUploads = fake.calls
    .slice(mark)
    .filter((c) => c.name === 'bufferSubData')
    .map((c) => c.args[2] as Float32Array)

  // 2 calls x (pos + vel) x 2 ping-pong copies.
  expect(subUploads.length).toBe(8)
  const posUploads = subUploads.filter((v) => v === data)
  const zeroUploads = subUploads.filter((v) => v !== data)
  expect(posUploads.length).toBe(4) // position data passes through untouched
  expect(zeroUploads.length).toBe(4)
  for (const z of zeroUploads) {
    expect(z.length).toBe(data.length)
    expect(z.every((v) => v === 0)).toBe(true) // pollution check: still pristine zeros
  }
  // One shared backing store across all velocity resets — no per-call allocation.
  const buffers = new Set(zeroUploads.map((z) => z.buffer))
  expect(buffers.size).toBe(1)

  // A larger write still yields all-zero velocity resets of the right length.
  const big = new Float32Array(data.length * 2).fill(7)
  const mark2 = fake.calls.length
  r.writePositions(big)
  const bigZeros = fake.calls
    .slice(mark2)
    .filter((c) => c.name === 'bufferSubData')
    .map((c) => c.args[2] as Float32Array)
    .filter((v) => v !== big)
  expect(bigZeros.length).toBe(2)
  for (const z of bigZeros) {
    expect(z.length).toBe(big.length)
    expect(z.every((v) => v === 0)).toBe(true)
  }

  // Shrinking back down reuses the grown buffer rather than reallocating.
  const mark3 = fake.calls.length
  r.writePositions(data)
  const smallZeros = fake.calls
    .slice(mark3)
    .filter((c) => c.name === 'bufferSubData')
    .map((c) => c.args[2] as Float32Array)
    .filter((v) => v !== data)
  expect(smallZeros.length).toBe(2)
  for (const z of smallZeros) {
    expect(z.length).toBe(data.length)
    expect(z.every((v) => v === 0)).toBe(true)
    expect(z.buffer).toBe(bigZeros[0].buffer)
  }
})

test('acquireZeroScratch grows once, then serves subranges of the same buffer', () => {
  const big = acquireZeroScratch(1 << 20) // larger than anything else in this file
  expect(big.length).toBe(1 << 20)
  expect(big.every((v) => v === 0)).toBe(true)

  const small = acquireZeroScratch(10)
  expect(small.length).toBe(10)
  expect(small.buffer).toBe(big.buffer) // no reallocation for smaller requests

  const again = acquireZeroScratch(1 << 20)
  expect(again.buffer).toBe(big.buffer) // no reallocation for equal requests
  expect(again.every((v) => v === 0)).toBe(true) // never polluted by earlier use
})

// ---------------------------------------------------------------------------
// 5. createResourceTracker unit behavior
// ---------------------------------------------------------------------------

test('createResourceTracker destroys in reverse creation order and clears', () => {
  const tracker = createResourceTracker()
  const order: string[] = []
  const a = tracker.track('a', (x) => order.push(x))
  expect(a).toBe('a') // pass-through
  tracker.track('b', (x) => order.push(x))
  tracker.track('c', (x) => order.push(x))
  expect(tracker.size).toBe(3)

  tracker.disposeAll()
  expect(order).toEqual(['c', 'b', 'a'])
  expect(tracker.size).toBe(0)

  tracker.disposeAll() // idempotent
  expect(order).toEqual(['c', 'b', 'a'])
})

// ---------------------------------------------------------------------------
// 6. steady-state guard: frames create no new GL resources
// ---------------------------------------------------------------------------

test('frame() allocates no GL resources once the renderer is initialized', () => {
  const { r, fake } = makeRenderer()
  r.resize(64, 32)
  const createsBefore = fake.calls.filter((c) => c.name.startsWith('create')).length
  r.frame(0.016, 0.016, OPTS.count)
  r.frame(0.016, 0.032, OPTS.count)
  r.frame(0.016, 0.048, OPTS.count)
  const createsAfter = fake.calls.filter((c) => c.name.startsWith('create')).length
  expect(createsAfter).toBe(createsBefore)
})

// ---------------------------------------------------------------------------
// 7. webglcontextlost handler: preventDefault + onDeviceLost, muted by dispose
// ---------------------------------------------------------------------------

test('webglcontextlost preventDefaults and fires onDeviceLost, but not after dispose', () => {
  const { r, fakeCanvas } = makeRenderer()
  let lost = 0
  r.onDeviceLost = () => {
    lost++
  }
  const handler = fakeCanvas.listeners.get('webglcontextlost')![0]
  let prevented = 0
  const event = { preventDefault: () => prevented++ } as unknown as Event
  handler(event)
  // preventDefault keeps the context restorable; the app is told to fall back.
  expect(prevented).toBe(1)
  expect(lost).toBe(1)

  r.dispose()
  // dispose() unregistered the listener, but even a stale queued delivery to
  // the same function must not resurrect callbacks on a disposed renderer.
  handler(event)
  expect(prevented).toBe(2)
  expect(lost).toBe(1)
})

// ---------------------------------------------------------------------------
// 8. pointerToWorld: ray/plane intersection against the camera
// ---------------------------------------------------------------------------

test('pointerToWorld returns null before any frame (singular view-projection)', () => {
  const { r } = makeRenderer()
  // viewProj is still the zero matrix: determinant 0, invert() yields null.
  expect(r.pointerToWorld(0, 0)).toBeNull()
})

test('pointerToWorld hits the view-perpendicular plane through the swarm center', () => {
  const { r } = makeRenderer()
  r.resize(64, 32)
  // Drive the camera through the public externalCamera hook so eye/viewProj
  // are known values built from core's own math (no private state, no magic).
  const eye: Vec3 = [4, 2, 8]
  const viewProj = multiply(
    perspective(Math.PI / 3, 64 / 32, 0.1, 100),
    lookAt(eye, [0, 0, 0], [0, 1, 0]),
  )
  const camera: ExternalCamera = { viewProj, right: [1, 0, 0], up: [0, 1, 0], eye }
  r.externalCamera = camera
  r.frame(0.016, 0.016, OPTS.count)

  const [ndcX, ndcY] = [0.3, -0.4]
  const p = r.pointerToWorld(ndcX, ndcY)
  expect(p).not.toBeNull()
  const [wx, wy, wz] = p!

  // (1) The point lies on the plane through the origin (the default swarm
  // center) whose normal is the view direction eye - center = eye.
  const planeDist = (wx * eye[0] + wy * eye[1] + wz * eye[2]) / Math.hypot(...eye)
  expect(Math.abs(planeDist)).toBeLessThan(1e-3)

  // (2) The point lies on the picked ray: reprojecting it through the same
  // view-projection restores the input NDC coordinates.
  const h = transform4(viewProj, [wx, wy, wz, 1])
  expect(h[0] / h[3]).toBeCloseTo(ndcX, 3)
  expect(h[1] / h[3]).toBeCloseTo(ndcY, 3)
})

test('pointerToWorld returns null when the pick ray is parallel to the plane', () => {
  const { r } = makeRenderer()
  r.resize(64, 32)
  // Identity view-projection: every pick ray travels along +z. Putting the
  // eye on the x axis makes the plane normal (eye - center) perpendicular to
  // all rays, so no intersection exists.
  const camera: ExternalCamera = {
    viewProj: identity(),
    right: [1, 0, 0],
    up: [0, 1, 0],
    eye: [3, 0, 0],
  }
  r.externalCamera = camera
  r.frame(0.016, 0.016, OPTS.count)
  expect(r.pointerToWorld(0.25, 0.5)).toBeNull()
})
