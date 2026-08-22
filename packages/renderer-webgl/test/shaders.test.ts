import { test, expect } from 'bun:test'
import type { RendererOptions } from '@yura/renderer-webgpu'
import { RENDER_VS } from '../src/shaders'
import { WebGL2ParticleRenderer } from '../src/renderer'

// ---------------------------------------------------------------------------
// 1. Shader-string contract: the point-size cap is a uniform, not a literal.
//    Locks the WebGPU-parity fix (F-002): close-up particles must keep
//    growing up to the device limit instead of freezing at 64px.
// ---------------------------------------------------------------------------

test('RENDER_VS clamps gl_PointSize with the uMaxPointSize uniform', () => {
  expect(RENDER_VS).toContain('uMaxPointSize')
  // The exact clamp expression: same numerator, 1px floor kept (sub-pixel
  // vanishing guard), literal ceiling replaced by the uniform.
  expect(RENDER_VS).toContain(
    'gl_PointSize = clamp(size / max(gl_Position.w, 0.1), 1.0, uMaxPointSize);',
  )
})

test('RENDER_VS no longer hardcodes the 64px ceiling', () => {
  expect(RENDER_VS).not.toContain('64.0')
})

// ---------------------------------------------------------------------------
// 2. Renderer wiring against a fake GL (no GPU in bun): a Proxy that records
//    every call, mirroring renderer.test.ts. Extended here to answer
//    getParameter(ALIASED_POINT_SIZE_RANGE) and to remember which uniform
//    location was handed out for which uniform name.
// ---------------------------------------------------------------------------

interface GLCall {
  name: string
  args: unknown[]
}

interface FakeGL {
  gl: WebGL2RenderingContext
  calls: GLCall[]
  /** Location object handed out by getUniformLocation for a uniform name. */
  uniformLocation: (name: string) => object | undefined
  /** What getParameter(ALIASED_POINT_SIZE_RANGE) returns. */
  pointSizeRange: { value: unknown }
}

function createFakeGL(pointSizeRangeValue: unknown): FakeGL {
  const calls: GLCall[] = []
  const pointSizeRange = { value: pointSizeRangeValue }
  let nextId = 1
  const locByName = new Map<string, object>()
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
              return true
            case 'getParameter':
              if (args[0] === constants.get('ALIASED_POINT_SIZE_RANGE')) {
                return pointSizeRange.value
              }
              return undefined
            case 'getExtension':
              if (args[0] === 'WEBGL_lose_context') return { loseContext: () => {} }
              return {} // EXT_color_buffer_float etc: present
            case 'createShader':
            case 'createProgram':
            case 'createBuffer':
            case 'createVertexArray':
            case 'createTransformFeedback':
            case 'createTexture':
            case 'createFramebuffer':
              return { kind: prop, id: nextId++ }
            case 'getUniformLocation': {
              const name = args[1] as string
              let loc = locByName.get(name)
              if (!loc) {
                loc = { uniform: name, id: nextId++ }
                locByName.set(name, loc)
              }
              return loc
            }
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
  return { gl, calls, uniformLocation: (name) => locByName.get(name), pointSizeRange }
}

function createFakeCanvas(gl: WebGL2RenderingContext): HTMLCanvasElement {
  return {
    width: 0,
    height: 0,
    getContext: () => gl,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as HTMLCanvasElement
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

/** All uniform1f values uploaded to the uMaxPointSize location. */
function maxPointSizeUploads(fake: FakeGL): unknown[] {
  const loc = fake.uniformLocation('uMaxPointSize')
  return fake.calls
    .filter((c) => c.name === 'uniform1f' && c.args[0] === loc)
    .map((c) => c.args[1])
}

test('init queries ALIASED_POINT_SIZE_RANGE once and uploads its max as uMaxPointSize', () => {
  const fake = createFakeGL(new Float32Array([1, 2048]))
  const r = WebGL2ParticleRenderer.create(createFakeCanvas(fake.gl), OPTS)
  if (!r) throw new Error('expected renderer to be created against the fake GL')

  // Queried exactly once, at initialization — never per frame.
  const rangeConst = (fake.gl as unknown as Record<string, number>).ALIASED_POINT_SIZE_RANGE
  const queries = () =>
    fake.calls.filter((c) => c.name === 'getParameter' && c.args[0] === rangeConst)
  expect(queries().length).toBe(1)

  r.resize(64, 32)
  r.frame(0.016, 0.016, OPTS.count)
  r.frame(0.016, 0.032, OPTS.count)
  expect(queries().length).toBe(1)

  // The device maximum reaches the shader as the uMaxPointSize uniform.
  const uploads = maxPointSizeUploads(fake)
  expect(uploads.length).toBe(2) // once per frame, alongside uSizePx
  expect(uploads.every((v) => v === 2048)).toBe(true)
  r.dispose()
})

test('an unusable ALIASED_POINT_SIZE_RANGE falls back to the historic 64px cap', () => {
  for (const bad of [undefined, null, new Float32Array([0, 0]), new Float32Array([1, NaN])]) {
    const fake = createFakeGL(bad)
    const r = WebGL2ParticleRenderer.create(createFakeCanvas(fake.gl), OPTS)
    if (!r) throw new Error('expected renderer to be created against the fake GL')
    r.resize(64, 32)
    r.frame(0.016, 0.016, OPTS.count)
    expect(maxPointSizeUploads(fake)).toEqual([64])
    r.dispose()
  }
})
