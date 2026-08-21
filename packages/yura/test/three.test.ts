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
