import { test, expect } from 'bun:test'
import { lookAt, multiply, transform4, QualityGovernor, type Vec3, type Vec4 } from '@yura/core'
import {
  glProjectionToWebGPU,
  fovAspectFromProjection,
  eyeFromView,
  worldPositionOf,
  composeSwarmCamera,
  YURA_SHAPE_RADIUS,
} from '../src/three'

// The DOM-free math of the Three.js adapter: matrix conversion (Three's
// column-major GL projection -> Yura's WebGPU convention), fov/aspect
// extraction, and world-position tracking.

/** Column-major WebGL/Three.js-style perspective (NDC depth -1..1). */
function glPerspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovY / 2)
  const m = new Float32Array(16)
  m[0] = f / aspect
  m[5] = f
  m[10] = -(far + near) / (far - near)
  m[11] = -1
  m[14] = -(2 * far * near) / (far - near)
  return m
}

function ndc(m: Float32Array, p: Vec3): Vec3 {
  const h = transform4(m, [p[0], p[1], p[2], 1] as Vec4)
  return [h[0] / h[3], h[1] / h[3], h[2] / h[3]]
}

test('glProjectionToWebGPU remaps GL clip depth [-1,1] to WebGPU [0,1]', () => {
  const near = 0.5
  const far = 100
  const gl = glPerspective(Math.PI / 3, 16 / 9, near, far)
  const gpu = glProjectionToWebGPU(gl)

  // Near plane: GL z_ndc = -1 -> WebGPU 0. Far plane: 1 -> 1.
  expect(ndc(gl, [0, 0, -near])[2]).toBeCloseTo(-1, 4)
  expect(ndc(gpu, [0, 0, -near])[2]).toBeCloseTo(0, 4)
  expect(ndc(gl, [0, 0, -far])[2]).toBeCloseTo(1, 3)
  expect(ndc(gpu, [0, 0, -far])[2]).toBeCloseTo(1, 3)

  // x/y are untouched.
  const p: Vec3 = [1.2, -0.7, -10]
  expect(ndc(gpu, p)[0]).toBeCloseTo(ndc(gl, p)[0], 5)
  expect(ndc(gpu, p)[1]).toBeCloseTo(ndc(gl, p)[1], 5)
})

test('fovAspectFromProjection recovers fov and aspect', () => {
  const fov = (60 * Math.PI) / 180
  const { fovY, aspect } = fovAspectFromProjection(glPerspective(fov, 1.5, 0.1, 200))
  expect(fovY).toBeCloseTo(fov, 5)
  expect(aspect).toBeCloseTo(1.5, 5)
})

test('eyeFromView recovers the camera position from a rigid view matrix', () => {
  const eye: Vec3 = [3, -4, 5.5]
  const view = lookAt(eye, [0.5, 1, -2], [0, 1, 0])
  const got = eyeFromView(view)
  expect(got[0]).toBeCloseTo(eye[0], 4)
  expect(got[1]).toBeCloseTo(eye[1], 4)
  expect(got[2]).toBeCloseTo(eye[2], 4)
})

test('worldPositionOf reads the translation column of matrixWorld', () => {
  const m = new Float32Array(16)
  m[0] = m[5] = m[10] = m[15] = 1
  m[12] = 7
  m[13] = -2
  m[14] = 3.25
  expect(worldPositionOf(m)).toEqual([7, -2, 3.25])
})

test('composeSwarmCamera projects the swarm origin exactly where the anchor sits', () => {
  const proj = glPerspective(Math.PI / 4, 16 / 9, 0.1, 500)
  const view = lookAt([8, 6, 12], [0, 0, 0], [0, 1, 0])
  const anchor: Vec3 = [2, 1.5, -3]
  const cam = composeSwarmCamera(proj, view, anchor, 0.5)

  // Reference: the anchor through the plain (depth-converted) proj * view.
  const ref = ndc(multiply(glProjectionToWebGPU(proj), view), anchor)
  const got = ndc(cam.viewProj, [0, 0, 0])
  expect(got[0]).toBeCloseTo(ref[0], 4)
  expect(got[1]).toBeCloseTo(ref[1], 4)
  expect(got[2]).toBeCloseTo(ref[2], 4)
})

test('composeSwarmCamera bakes uniform scale into local offsets', () => {
  const proj = glPerspective(Math.PI / 3, 1, 0.1, 500)
  const view = lookAt([0, 4, 20], [0, 0, 0], [0, 1, 0])
  const anchor: Vec3 = [-1, 2, 0]
  const s = 0.25
  const cam = composeSwarmCamera(proj, view, anchor, s)

  // Local point [4,0,0] must land where world point anchor + [4s,0,0] lands.
  const ref = ndc(multiply(glProjectionToWebGPU(proj), view), [anchor[0] + 4 * s, anchor[1], anchor[2]])
  const got = ndc(cam.viewProj, [4, 0, 0])
  expect(got[0]).toBeCloseTo(ref[0], 4)
  expect(got[1]).toBeCloseTo(ref[1], 4)
  expect(got[2]).toBeCloseTo(ref[2], 4)
})

test('composeSwarmCamera billboard axes are unit-length view rotation rows', () => {
  const view = lookAt([5, 2, 9], [1, 0, -1], [0, 1, 0])
  const cam = composeSwarmCamera(glPerspective(1, 1, 0.1, 100), view, [0, 0, 0], 3)
  const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2])
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  expect(len(cam.right)).toBeCloseTo(1, 5)
  expect(len(cam.up)).toBeCloseTo(1, 5)
  expect(dot(cam.right, cam.up)).toBeCloseTo(0, 5)
  // Scale must NOT leak into the axes (particles scale via viewProj instead).
  expect(cam.right[0]).toBeCloseTo(view[0], 5)
  expect(cam.right[1]).toBeCloseTo(view[4], 5)
  expect(cam.right[2]).toBeCloseTo(view[8], 5)
})

test('composeSwarmCamera maps the eye into swarm-local space', () => {
  const eye: Vec3 = [10, 5, -4]
  const anchor: Vec3 = [2, 2, 2]
  const s = 0.5
  const view = lookAt(eye, anchor, [0, 1, 0])
  const cam = composeSwarmCamera(glPerspective(1, 1.2, 0.1, 100), view, anchor, s)
  expect(cam.eye[0]).toBeCloseTo((eye[0] - anchor[0]) / s, 3)
  expect(cam.eye[1]).toBeCloseTo((eye[1] - anchor[1]) / s, 3)
  expect(cam.eye[2]).toBeCloseTo((eye[2] - anchor[2]) / s, 3)
})

test('composeSwarmCamera passes fovY and sizeScale through for WebGL sizing', () => {
  const fov = (50 * Math.PI) / 180
  const cam = composeSwarmCamera(
    glPerspective(fov, 2, 0.1, 100),
    lookAt([0, 0, 10], [0, 0, 0], [0, 1, 0]),
    [0, 0, 0],
    0.4,
  )
  expect(cam.fovY!).toBeCloseTo(fov, 5)
  expect(cam.sizeScale!).toBeCloseTo(0.4, 6)
  expect(YURA_SHAPE_RADIUS).toBe(11)
})

// ---------------------------------------------------------------------------
// Morph timing options (hold / morph / ease), shared with the app's `eases`
// registry. The layer itself runs DOM-free here: stub ResizeObserver, fake
// renderer/host/canvas, and a deterministic performance.now clock.
// ---------------------------------------------------------------------------

import { YuraThreeLayer, yuraLayer, morphStep, type YuraLayerOptions } from '../src/three'
import { eases, type Ease } from '../src/app'
import { DEFAULT_MOTION } from '../src/presets'
import type { MotionParams, ExternalCamera } from '@yura/renderer-webgpu'

const g = globalThis as unknown as { ResizeObserver?: unknown }
if (!g.ResizeObserver) {
  g.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
}

type LayerRenderer = ConstructorParameters<typeof YuraThreeLayer>[0]

class FakeRenderer {
  count = 1000
  morphT = 0
  morphBoost = 0
  // Real renderers hold the preset's MotionParams and read this field every
  // frame when uploading the sim uniforms (turbulence included).
  motion: MotionParams = { ...DEFAULT_MOTION }
  externalCamera: unknown = null
  wroteA = 0
  wroteB = 0
  frames = 0
  disposedCount = 0
  resize(): void {}
  writeTargetA(): void {
    this.wroteA++
  }
  writeTargetB(): void {
    this.wroteB++
  }
  frame(): void {
    this.frames++
  }
  dispose(): void {
    this.disposedCount++
  }
}

const flatSpec = () => ({
  kind: 'test',
  generate: (n: number) => new Float32Array(n * 4),
})

// The projection/view pair every fake layer camera uses, hoisted so tests can
// derive the expected composed swarm camera from the very same matrices.
const LAYER_PROJ = glPerspective(Math.PI / 3, 16 / 9, 0.1, 200)
const LAYER_VIEW = lookAt([0, 0, 20], [0, 0, 0], [0, 1, 0])

interface FakeLayerCanvas {
  style: Record<string, string>
  removed: number
  remove(): void
}

function makeLayer(
  opts: YuraLayerOptions = {},
  count = 1000,
): { layer: YuraThreeLayer; renderer: FakeRenderer; canvas: FakeLayerCanvas } {
  const renderer = new FakeRenderer()
  renderer.count = count
  const canvas: FakeLayerCanvas = {
    style: {},
    removed: 0,
    remove(): void {
      this.removed++
    },
  }
  const host = { clientWidth: 640, clientHeight: 360, offsetLeft: 0, offsetTop: 0 }
  const camera = {
    projectionMatrix: { elements: LAYER_PROJ },
    matrixWorldInverse: { elements: LAYER_VIEW },
  }
  const layer = new YuraThreeLayer(
    renderer as unknown as LayerRenderer,
    'webgpu',
    canvas as unknown as HTMLCanvasElement,
    host as unknown as HTMLCanvasElement,
    camera,
    opts,
  )
  return { layer, renderer, canvas }
}

/** Run `fn` under a controllable performance.now (milliseconds). */
async function withClock(fn: (set: (ms: number) => void) => Promise<void>): Promise<void> {
  const own = Object.getOwnPropertyDescriptor(performance, 'now')
  let t = 0
  Object.defineProperty(performance, 'now', { configurable: true, value: () => t })
  try {
    await fn((ms) => {
      t = ms
    })
  } finally {
    if (own) Object.defineProperty(performance, 'now', own)
    else delete (performance as unknown as { now?: unknown }).now
  }
}

// sync()'s very first frame uses a fixed 16.6ms dt; later frames cap at 1/30s.
const DT0 = 16.6 / 1000
const DT_CAP = 1 / 30

test('morphStep reproduces the legacy fixed transition and runs both directions', () => {
  const half = morphStep(1.3, 2.6, eases.cubic, 0)
  expect(half.morphT).toBeCloseTo(eases.cubic(0.5), 6)
  expect(half.boost).toBeCloseTo(1, 6)
  expect(half.done).toBe(false)
  // Departing endpoint 1 runs the same clock 1 -> 0.
  expect(morphStep(1.3, 2.6, eases.cubic, 1).morphT).toBeCloseTo(1 - eases.cubic(0.5), 6)
  const end = morphStep(2.6, 2.6, eases.cubic, 0)
  expect(end.morphT).toBe(1)
  expect(end.done).toBe(true)
})

test('yuraLayer defaults are unchanged: 2.6s cubic morphs, hold 3.2s', async () => {
  await withClock(async (set) => {
    const { layer, renderer } = makeLayer()
    expect(layer.holdSeconds).toBe(3.2)
    expect(makeLayer({ hold: 5 }).layer.holdSeconds).toBe(5)
    await layer.morphTo(flatSpec())
    expect(renderer.wroteB).toBe(1)
    set(0)
    layer.sync()
    expect(renderer.morphT).toBeGreaterThan(0)
    expect(renderer.morphT).toBeCloseTo(eases.cubic(DT0 / 2.6), 6)
  })
})

test('layer-level morph/ease options drive morphTo transitions', async () => {
  await withClock(async (set) => {
    const { layer, renderer } = makeLayer({ morph: 0.1, ease: 'linear' })
    await layer.morphTo(flatSpec())
    set(0)
    layer.sync()
    expect(renderer.morphT).toBeCloseTo(DT0 / 0.1, 4)
    expect(renderer.morphBoost).toBeGreaterThan(0)
    set(100)
    layer.sync()
    expect(renderer.morphT).toBeCloseTo((DT0 + DT_CAP) / 0.1, 4)
    set(200)
    layer.sync()
    expect(renderer.morphT).toBeCloseTo((DT0 + 2 * DT_CAP) / 0.1, 4)
    set(300)
    layer.sync()
    expect(renderer.morphT).toBe(1)
    expect(renderer.morphBoost).toBe(0)
  })
})

test('morphTo duration/ease override applies to that transition only', async () => {
  await withClock(async (set) => {
    const { layer, renderer } = makeLayer({ morph: 0.1, ease: 'linear' })
    await layer.morphTo(flatSpec(), { duration: 0.05, ease: (t) => t * t })
    set(0)
    layer.sync()
    expect(renderer.morphT).toBeCloseTo((DT0 / 0.05) ** 2, 4)
    set(100)
    layer.sync()
    expect(renderer.morphT).toBeCloseTo(((DT0 + DT_CAP) / 0.05) ** 2, 4)
    set(200)
    layer.sync()
    expect(renderer.morphT).toBe(1)
    // The next morphTo reverts to the layer-level 0.1s linear, running 1 -> 0.
    await layer.morphTo(flatSpec())
    expect(renderer.wroteA).toBe(1)
    set(300)
    layer.sync()
    expect(renderer.morphT).toBeCloseTo(1 - DT_CAP / 0.1, 4)
  })
})

test('unknown ease names are rejected with the available names', async () => {
  expect(() => makeLayer({ ease: 'bogus' as unknown as Ease })).toThrow(/Unknown ease "bogus"/)
  const { layer } = makeLayer()
  await expect(layer.morphTo(flatSpec(), { ease: 'nope' as unknown as Ease })).rejects.toThrow(
    /cubic/,
  )
})

// ---------------------------------------------------------------------------
// Particle physics (MotionParams) exposure. The renderers read their public
// `motion` field every frame when uploading sim uniforms (uTurbulence /
// simF32[16..17]), so pinning layer -> renderer.motion pins the whole path;
// renderer -> shader is locked by renderer-webgpu's turbulence.test.ts.
// ---------------------------------------------------------------------------

test('by default the layer leaves the renderer motion params untouched', () => {
  const { renderer } = makeLayer()
  expect(renderer.motion).toEqual({ ...DEFAULT_MOTION })
})

test('the motion option merges physics over the renderer params at construction', () => {
  const { renderer } = makeLayer({ motion: { turbulence: 0.9, damping: 9 } })
  expect(renderer.motion.turbulence).toBe(0.9)
  expect(renderer.motion.damping).toBe(9)
  // Untouched fields keep the preset values.
  expect(renderer.motion.swirl).toBe(DEFAULT_MOTION.swirl)
  expect(renderer.motion.attraction).toBe(DEFAULT_MOTION.attraction)
})

test('layer.motion() live-retunes renderer physics, accumulating like app.motion()', () => {
  const { layer, renderer } = makeLayer()
  expect(layer.motion({ turbulence: 1.5 })).toBe(layer) // chainable
  expect(renderer.motion.turbulence).toBe(1.5)
  layer.motion({ turbulenceScale: 0.5, swirl: 0.3 })
  expect(renderer.motion.turbulence).toBe(1.5) // earlier tweak survives
  expect(renderer.motion.turbulenceScale).toBe(0.5)
  expect(renderer.motion.swirl).toBe(0.3)
  expect(renderer.motion.damping).toBe(DEFAULT_MOTION.damping)
})

// ---------------------------------------------------------------------------
// Anchoring: attach / detach / at / setRadius. Expected cameras are derived
// with the already-verified composeSwarmCamera over the same LAYER matrices.
// ---------------------------------------------------------------------------

function translationMatrix(x: number, y: number, z: number): Float32Array {
  const m = new Float32Array(16)
  m[0] = m[5] = m[10] = m[15] = 1
  m[12] = x
  m[13] = y
  m[14] = z
  return m
}

test('attach() anchors the swarm at the object world position plus the offset', () => {
  const { layer, renderer } = makeLayer({ radius: 3, position: [1, 2, 3] })
  const scale = 3 / YURA_SHAPE_RADIUS
  const obj = { matrixWorld: { elements: translationMatrix(7, -2, 4) } }

  expect(layer.attach(obj)).toBe(layer)
  layer.sync()
  expect(renderer.externalCamera).toEqual(
    composeSwarmCamera(LAYER_PROJ, LAYER_VIEW, [7 + 1, -2 + 2, 4 + 3], scale),
  )

  // at() replaces the offset; the attached object still contributes.
  expect(layer.at(-4, 0.5, 2)).toBe(layer)
  layer.sync()
  expect(renderer.externalCamera).toEqual(
    composeSwarmCamera(LAYER_PROJ, LAYER_VIEW, [7 - 4, -2 + 0.5, 4 + 2], scale),
  )

  // detach() leaves only the offset anchor behind.
  expect(layer.detach()).toBe(layer)
  layer.sync()
  expect(renderer.externalCamera).toEqual(
    composeSwarmCamera(LAYER_PROJ, LAYER_VIEW, [-4, 0.5, 2], scale),
  )
})

test('setRadius() rescales the swarm; sync(camera) uses the override camera', () => {
  const { layer, renderer } = makeLayer() // default radius 6 world units
  layer.sync()
  expect((renderer.externalCamera as ExternalCamera).sizeScale).toBe(6 / YURA_SHAPE_RADIUS)

  expect(layer.setRadius(9)).toBe(layer)
  layer.sync()
  expect(renderer.externalCamera).toEqual(
    composeSwarmCamera(LAYER_PROJ, LAYER_VIEW, [0, 0, 0], 9 / YURA_SHAPE_RADIUS),
  )

  // A camera passed to sync() wins over the construction-time camera.
  const proj2 = glPerspective(Math.PI / 4, 2, 0.1, 100)
  const view2 = lookAt([5, 5, 5], [0, 0, 0], [0, 1, 0])
  layer.sync({ projectionMatrix: { elements: proj2 }, matrixWorldInverse: { elements: view2 } })
  expect(renderer.externalCamera).toEqual(
    composeSwarmCamera(proj2, view2, [0, 0, 0], 9 / YURA_SHAPE_RADIUS),
  )
})

// ---------------------------------------------------------------------------
// stats + the quality-governor constructor branches.
// ---------------------------------------------------------------------------

test('stats reports the backend, a smoothed integer fps, and the governed count', async () => {
  await withClock(async (set) => {
    const { layer, renderer } = makeLayer()
    const frac0 = new QualityGovernor().current().frac
    const s0 = layer.stats
    expect(s0.backend).toBe('webgpu')
    expect(Number.isInteger(s0.fps)).toBe(true)
    expect(s0.particles).toBe(Math.floor(renderer.count * frac0))

    // Steady 4ms frames: the fps EMA converges to 1000/4.
    for (let i = 1; i <= 200; i++) {
      set(i * 4)
      layer.sync()
    }
    expect(layer.stats.fps).toBe(Math.round(1000 / 4))
    expect(layer.stats.particles).toBe(Math.floor(renderer.count * frac0))
  })
})

test('auto quality pre-drops the governor for 300k+ swarms; quality high pins it', () => {
  const frac0 = new QualityGovernor().current().frac
  const g2 = new QualityGovernor()
  g2.setLevel(2)
  const frac2 = g2.current().frac
  expect(frac2).toBeLessThan(frac0) // sanity: the branches are observable

  const auto = makeLayer({}, 300_000)
  expect(auto.layer.stats.particles).toBe(Math.floor(300_000 * frac2))

  const high = makeLayer({ quality: 'high' }, 300_000)
  expect(high.layer.stats.particles).toBe(Math.floor(300_000 * frac0))
})

// ---------------------------------------------------------------------------
// dispose(): idempotent teardown that freezes sync/morphTo.
// ---------------------------------------------------------------------------

test('dispose() tears down once and freezes sync() and morphTo()', async () => {
  const { layer, renderer, canvas } = makeLayer()
  layer.sync()
  const framesBefore = renderer.frames
  expect(framesBefore).toBe(1)

  layer.dispose()
  expect(renderer.disposedCount).toBe(1)
  expect(canvas.removed).toBe(1)
  layer.dispose() // second call is a no-op
  expect(renderer.disposedCount).toBe(1)
  expect(canvas.removed).toBe(1)

  expect(layer.sync()).toBe(layer)
  expect(renderer.frames).toBe(framesBefore) // no frame after dispose

  const writesBefore = renderer.wroteA + renderer.wroteB
  expect(await layer.morphTo(flatSpec())).toBe(layer)
  expect(renderer.wroteA + renderer.wroteB).toBe(writesBefore)
})

// ---------------------------------------------------------------------------
// yuraLayer(): full factory over a fake DOM + Proxy-backed WebGL2 context,
// following the fake-GL recipe from renderer-webgl's own tests.
// ---------------------------------------------------------------------------

function createFakeGL(): { gl: WebGL2RenderingContext; calls: string[] } {
  const calls: string[] = []
  const constants = new Map<string, number>()
  let nextConst = 1
  let nextId = 1
  const gl = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined
        if (/^[A-Z][A-Z0-9_]*$/.test(prop)) {
          if (!constants.has(prop)) constants.set(prop, nextConst++)
          return constants.get(prop)
        }
        return (...args: unknown[]) => {
          calls.push(prop)
          switch (prop) {
            case 'getShaderParameter':
            case 'getProgramParameter':
              return true
            case 'getExtension':
              return args[0] === 'WEBGL_lose_context' ? { loseContext: () => {} } : {}
            case 'createShader':
            case 'createProgram':
            case 'createBuffer':
            case 'createVertexArray':
            case 'createTransformFeedback':
            case 'createTexture':
            case 'createFramebuffer':
            case 'getUniformLocation':
              return { id: nextId++ }
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
  return { gl, calls }
}

interface DomStage {
  gl: WebGL2RenderingContext
  calls: string[]
  overlay: {
    style: Record<string, string>
    attrs: Record<string, string>
    removed: number
    width: number
    height: number
    getContext: (kind: string) => unknown
    setAttribute: (name: string, value: string) => void
    addEventListener: () => void
    removeEventListener: () => void
    remove: () => void
  }
  parent: {
    style: Record<string, string>
    inserted: Array<{ node: unknown; ref: unknown }>
    insertBefore: (node: unknown, ref: unknown) => void
  }
  host: {
    parentElement: unknown
    nextSibling: unknown
    clientWidth: number
    clientHeight: number
    offsetLeft: number
    offsetTop: number
  }
  nextSibling: unknown
}

function createDomStage(opts: { webgl2?: boolean; parentPosition?: string } = {}): DomStage {
  const { gl, calls } = createFakeGL()
  const overlay: DomStage['overlay'] = {
    style: {},
    attrs: {},
    removed: 0,
    width: 0,
    height: 0,
    getContext: (kind: string) => (kind === 'webgl2' && opts.webgl2 !== false ? gl : null),
    setAttribute(name: string, value: string) {
      overlay.attrs[name] = value
    },
    addEventListener() {},
    removeEventListener() {},
    remove() {
      overlay.removed++
    },
  }
  const parent: DomStage['parent'] = {
    style: {},
    inserted: [],
    insertBefore(node: unknown, ref: unknown) {
      parent.inserted.push({ node, ref })
    },
  }
  const nextSibling = { marker: 'host-next-sibling' }
  const host: DomStage['host'] = {
    parentElement: parent,
    nextSibling,
    clientWidth: 640,
    clientHeight: 360,
    offsetLeft: 8,
    offsetTop: 16,
  }
  const stage: DomStage = { gl, calls, overlay, parent, host, nextSibling }
  domStubs.set(stage, {
    document: {
      createElement: (tag: string) => {
        if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`)
        return overlay
      },
      body: parent,
    },
    getComputedStyle: () => ({ position: opts.parentPosition ?? 'static' }),
  })
  return stage
}

const domStubs = new WeakMap<DomStage, { document: unknown; getComputedStyle: unknown }>()

async function withDom(stage: DomStage, fn: () => Promise<void>): Promise<void> {
  const globals = globalThis as Record<string, unknown>
  const stubs = domStubs.get(stage)!
  const prevDocument = globals.document
  const prevGetComputedStyle = globals.getComputedStyle
  globals.document = stubs.document
  globals.getComputedStyle = stubs.getComputedStyle
  try {
    await fn()
  } finally {
    if (prevDocument === undefined) delete globals.document
    else globals.document = prevDocument
    if (prevGetComputedStyle === undefined) delete globals.getComputedStyle
    else globals.getComputedStyle = prevGetComputedStyle
  }
}

function countingSpec(): {
  kind: string
  requested: number[]
  generate: (n: number) => Float32Array<ArrayBuffer>
} {
  const spec = {
    kind: 'test',
    requested: [] as number[],
    generate(n: number): Float32Array<ArrayBuffer> {
      spec.requested.push(n)
      return new Float32Array(n * 4)
    },
  }
  return spec
}

const threeCamera = () => ({
  projectionMatrix: { elements: LAYER_PROJ },
  matrixWorldInverse: { elements: LAYER_VIEW },
})

test('yuraLayer builds a WebGL2 overlay wired next to the host canvas', async () => {
  const stage = createDomStage()
  await withDom(stage, async () => {
    const spec = countingSpec()
    const layer = await yuraLayer(
      { domElement: stage.host as unknown as HTMLCanvasElement },
      threeCamera(),
      {
        backend: 'webgl2',
        particles: 257.7,
        shape: spec,
        radius: 4,
        blend: 'plus-lighter',
        zIndex: '7',
        look: 'aurora',
        atmosphere: true,
      },
    )
    const count = Math.max(1, Math.floor(257.7))
    expect(layer).toBeInstanceOf(YuraThreeLayer)
    expect(layer.backend).toBe('webgl2')
    expect(spec.requested).toEqual([count])

    // Overlay canvas wiring.
    expect(stage.overlay.attrs['aria-hidden']).toBe('true')
    expect(stage.overlay.style.cssText).toContain('pointer-events:none')
    expect(stage.overlay.style.mixBlendMode).toBe('plus-lighter')
    expect(stage.overlay.style.zIndex).toBe('7')
    expect(stage.parent.style.position).toBe('relative') // static parent got promoted
    expect(stage.parent.inserted).toEqual([{ node: stage.overlay, ref: stage.nextSibling }])

    // Both morph targets were seeded with the initial shape.
    expect(stage.calls.filter((c) => c === 'bufferSubData').length).toBe(2)

    // The layer constructor sized the drawing buffer from host x dpr x governor res
    // and pinned the css box onto the host's box.
    const level0 = new QualityGovernor().current()
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2)
    expect(stage.overlay.width).toBe(Math.max(1, Math.floor(stage.host.clientWidth * dpr * level0.res)))
    expect(stage.overlay.height).toBe(Math.max(1, Math.floor(stage.host.clientHeight * dpr * level0.res)))
    expect(stage.overlay.style.left).toBe(`${stage.host.offsetLeft}px`)
    expect(stage.overlay.style.top).toBe(`${stage.host.offsetTop}px`)
    expect(stage.overlay.style.width).toBe(`${stage.host.clientWidth}px`)
    expect(stage.overlay.style.height).toBe(`${stage.host.clientHeight}px`)
    expect(layer.stats.particles).toBe(Math.floor(count * level0.frac))

    // The real WebGL2 renderer accepts a full sync + dispose round trip.
    expect(layer.sync()).toBe(layer)
    layer.dispose()
    expect(stage.overlay.removed).toBe(1)
  })
})

test('yuraLayer default backend falls back to WebGL2 when WebGPU is unavailable', async () => {
  const stage = createDomStage({ parentPosition: 'relative' })
  const prevInfo = console.info
  console.info = () => {} // acquireWebGPU warns YURA-001 (via console.info) in this DOM-less runtime
  try {
    await withDom(stage, async () => {
      const spec = countingSpec()
      const layer = await yuraLayer(
        { domElement: stage.host as unknown as HTMLCanvasElement },
        threeCamera(),
        { particles: 32, shape: spec },
      )
      expect(layer.backend).toBe('webgl2')
      expect(spec.requested).toEqual([32])
      expect(stage.overlay.style.mixBlendMode).toBe('screen') // default blend
      expect('zIndex' in stage.overlay.style).toBe(false) // no zIndex option, none set
      expect(stage.parent.style.position).toBeUndefined() // already positioned parent untouched
      layer.dispose()
    })
  } finally {
    console.info = prevInfo
  }
})

test('yuraLayer throws and removes its canvas when no GPU backend exists', async () => {
  const stage = createDomStage({ webgl2: false })
  await withDom(stage, async () => {
    await expect(
      yuraLayer(
        { domElement: stage.host as unknown as HTMLCanvasElement },
        threeCamera(),
        { backend: 'webgl2', particles: 8, shape: flatSpec() },
      ),
    ).rejects.toThrow(/neither WebGPU nor WebGL2/)
    expect(stage.overlay.removed).toBe(1)
  })
})
