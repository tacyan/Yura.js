import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_BLEND_MODE,
  DEFAULT_TONE_MAPPING,
  GL_FUNC_ADD,
  GL_ONE,
  GL_ONE_MINUS_SRC_ALPHA,
  GL_ONE_MINUS_SRC_COLOR,
  glBlendSpec,
  gpuBlendState,
  resolveBlendMode,
  resolveToneMapping,
  toneMapFunctionName,
  toneMapSource,
  type BlendMode,
  type ToneMapping,
} from '../src/blend'
import { POST_WGSL, buildPostWgsl } from '../src/shaders'
import { COMPOSITE_FS, buildCompositeFs } from '../../renderer-webgl/src/shaders'

const BLEND_MODES: BlendMode[] = ['additive', 'alpha', 'screen']
const TONE_MODES: ToneMapping[] = ['aces', 'reinhard', 'linear']

describe('gpuBlendState (WebGPU mapper, full table)', () => {
  test('additive matches the historic hardcoded GPUBlendState exactly', () => {
    expect(gpuBlendState('additive')).toEqual({
      color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    })
  })

  test('alpha = premultiplied over', () => {
    expect(gpuBlendState('alpha')).toEqual({
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    })
  })

  test('screen = src + dst * (1 - srcColor)', () => {
    expect(gpuBlendState('screen')).toEqual({
      color: { srcFactor: 'one', dstFactor: 'one-minus-src', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    })
  })
})

describe('glBlendSpec (WebGL mapper, full table)', () => {
  test('GL enum literals carry the standard GLenum values', () => {
    expect(GL_ONE).toBe(1)
    expect(GL_ONE_MINUS_SRC_COLOR).toBe(0x0301)
    expect(GL_ONE_MINUS_SRC_ALPHA).toBe(0x0303)
    expect(GL_FUNC_ADD).toBe(0x8006)
  })

  test('additive matches the historic gl.blendFunc(gl.ONE, gl.ONE)', () => {
    expect(glBlendSpec('additive')).toEqual({ src: GL_ONE, dst: GL_ONE, eq: GL_FUNC_ADD })
  })

  test('alpha', () => {
    expect(glBlendSpec('alpha')).toEqual({
      src: GL_ONE,
      dst: GL_ONE_MINUS_SRC_ALPHA,
      eq: GL_FUNC_ADD,
    })
  })

  test('screen', () => {
    expect(glBlendSpec('screen')).toEqual({
      src: GL_ONE,
      dst: GL_ONE_MINUS_SRC_COLOR,
      eq: GL_FUNC_ADD,
    })
  })
})

describe('unknown-value fallbacks', () => {
  test('blend falls back to additive', () => {
    expect(DEFAULT_BLEND_MODE).toBe('additive')
    for (const bogus of ['multiply', 'ADDITIVE', '', undefined, null]) {
      expect(resolveBlendMode(bogus as string)).toBe('additive')
      expect(gpuBlendState(bogus as string)).toBe(gpuBlendState('additive'))
      expect(glBlendSpec(bogus as string)).toBe(glBlendSpec('additive'))
    }
  })

  test('tone mapping falls back to aces', () => {
    expect(DEFAULT_TONE_MAPPING).toBe('aces')
    for (const bogus of ['filmic', 'ACES', '', undefined, null]) {
      expect(resolveToneMapping(bogus as string)).toBe('aces')
      expect(toneMapSource(bogus as string, 'wgsl')).toBe(toneMapSource('aces', 'wgsl'))
      expect(toneMapSource(bogus as string, 'glsl')).toBe(toneMapSource('aces', 'glsl'))
    }
  })
})

describe('toneMapSource', () => {
  test('each mode/lang defines exactly one function, named toneMapFunctionName(mode)', () => {
    for (const mode of TONE_MODES) {
      const name = toneMapFunctionName(mode)
      const wgsl = toneMapSource(mode, 'wgsl')
      expect(wgsl.match(/\bfn\s+\w+\s*\(/g)?.length).toBe(1)
      expect(wgsl).toContain(`fn ${name}(x: vec3<f32>) -> vec3<f32>`)
      const glsl = toneMapSource(mode, 'glsl')
      expect(glsl.match(/\bvec3\s+\w+\s*\(vec3/g)?.length).toBe(1)
      expect(glsl).toContain(`vec3 ${name}(vec3 x)`)
    }
  })

  test('default (aces) WGSL is the exact historic chunk', () => {
    expect(toneMapSource(undefined, 'wgsl')).toBe(
      `fn aces(x: vec3<f32>) -> vec3<f32> {
  return clamp(
    (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14),
    vec3<f32>(0.0), vec3<f32>(1.0),
  );
}`,
    )
  })

  test('default (aces) GLSL is the exact historic chunk', () => {
    expect(toneMapSource(undefined, 'glsl')).toBe(
      `vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}`,
    )
  })

  test('default mode contains the aces polynomial constants in both langs', () => {
    for (const lang of ['wgsl', 'glsl'] as const) {
      const src = toneMapSource('aces', lang)
      for (const k of ['2.51', '0.03', '2.43', '0.59', '0.14']) expect(src).toContain(k)
    }
  })
})

describe('composed shaders', () => {
  test('WGSL: default build is byte-identical to POST_WGSL and calls aces', () => {
    expect(buildPostWgsl()).toBe(POST_WGSL)
    expect(buildPostWgsl('aces')).toBe(POST_WGSL)
    expect(POST_WGSL).toContain('c = aces(c);')
    expect(POST_WGSL).toContain('2.51')
  })

  test('GLSL: default build is byte-identical to COMPOSITE_FS and calls aces', () => {
    expect(buildCompositeFs()).toBe(COMPOSITE_FS)
    expect(buildCompositeFs('aces')).toBe(COMPOSITE_FS)
    expect(COMPOSITE_FS).toContain('c = aces(c);')
    expect(COMPOSITE_FS).toContain('2.51')
  })

  test('each tone mode composes exactly one tone function and one call site', () => {
    for (const mode of TONE_MODES) {
      const name = toneMapFunctionName(mode)
      const wgsl = buildPostWgsl(mode)
      expect(wgsl.match(new RegExp(`fn ${name}\\(`, 'g'))?.length).toBe(1)
      expect(wgsl).toContain(`c = ${name}(c);`)
      const glsl = buildCompositeFs(mode)
      expect(glsl.match(new RegExp(`vec3 ${name}\\(`, 'g'))?.length).toBe(1)
      expect(glsl).toContain(`c = ${name}(c);`)
    }
  })

  test('non-default modes drop the aces curve entirely', () => {
    for (const mode of ['reinhard', 'linear'] as const) {
      expect(buildPostWgsl(mode)).not.toContain('aces')
      expect(buildCompositeFs(mode)).not.toContain('aces')
      expect(buildPostWgsl(mode)).not.toContain('2.51')
      expect(buildCompositeFs(mode)).not.toContain('2.51')
    }
  })

  test('unknown tone mode composes the default (aces) shader', () => {
    expect(buildPostWgsl('bogus')).toBe(POST_WGSL)
    expect(buildCompositeFs('bogus')).toBe(COMPOSITE_FS)
  })

  test('blend mode list stays in sync with the mapper table', () => {
    for (const mode of BLEND_MODES) expect(resolveBlendMode(mode)).toBe(mode)
    for (const mode of TONE_MODES) expect(resolveToneMapping(mode)).toBe(mode)
  })
})
