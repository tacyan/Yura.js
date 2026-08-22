import { test, expect } from 'bun:test'
import { lookAt, multiply, transform4, type Vec3, type Vec4 } from '@yura/core'
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

import { YuraThreeLayer, morphStep, type YuraLayerOptions } from '../src/three'
import { eases, type Ease } from '../src/app'

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
  externalCamera: unknown = null
  wroteA = 0
  wroteB = 0
  resize(): void {}
  writeTargetA(): void {
    this.wroteA++
  }
  writeTargetB(): void {
    this.wroteB++
  }
  frame(): void {}
  dispose(): void {}
}

const flatSpec = () => ({
  kind: 'test',
  generate: (n: number) => new Float32Array(n * 4),
})

function makeLayer(opts: YuraLayerOptions = {}): { layer: YuraThreeLayer; renderer: FakeRenderer } {
  const renderer = new FakeRenderer()
  const host = { clientWidth: 640, clientHeight: 360, offsetLeft: 0, offsetTop: 0 }
  const camera = {
    projectionMatrix: { elements: glPerspective(Math.PI / 3, 16 / 9, 0.1, 200) },
    matrixWorldInverse: { elements: lookAt([0, 0, 20], [0, 0, 0], [0, 1, 0]) },
  }
  const layer = new YuraThreeLayer(
    renderer as unknown as LayerRenderer,
    'webgpu',
    { style: {} } as unknown as HTMLCanvasElement,
    host as unknown as HTMLCanvasElement,
    camera,
    opts,
  )
  return { layer, renderer }
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
