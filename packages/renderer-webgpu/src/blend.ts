/**
 * Shared look-mode mappers used by both renderers:
 *   - particle blend modes -> GPUBlendState (WebGPU) / {src,dst,eq} (WebGL2)
 *   - tone-mapping curves  -> WGSL / GLSL shader chunks
 *
 * Unknown or missing values always resolve to the classic defaults
 * ('additive', 'aces') so existing look presets render bit-identically.
 */

export type BlendMode = 'additive' | 'alpha' | 'screen'
export type ToneMapping = 'aces' | 'reinhard' | 'linear'

export const DEFAULT_BLEND_MODE: BlendMode = 'additive'
export const DEFAULT_TONE_MAPPING: ToneMapping = 'aces'

export function resolveBlendMode(mode: string | undefined | null): BlendMode {
  return mode === 'alpha' || mode === 'screen' ? mode : DEFAULT_BLEND_MODE
}

export function resolveToneMapping(mode: string | undefined | null): ToneMapping {
  return mode === 'reinhard' || mode === 'linear' ? mode : DEFAULT_TONE_MAPPING
}

/** WebGL enums as literals so no GL context is needed (unit-testable). */
export const GL_ONE = 1
export const GL_ONE_MINUS_SRC_COLOR = 0x0301
export const GL_ONE_MINUS_SRC_ALPHA = 0x0303
export const GL_FUNC_ADD = 0x8006

/** Arguments for gl.blendFunc (src, dst) and gl.blendEquation (eq). */
export interface GLBlendSpec {
  src: number
  dst: number
  eq: number
}

/**
 * Particle fragments are premultiplied (rgb * a, a), so:
 *   additive: src + dst                  (classic HDR accumulation, default)
 *   alpha:    src + dst * (1 - srcAlpha) (premultiplied "over")
 *   screen:   src + dst * (1 - srcColor) (1 - (1-s)(1-d), never clips)
 */
const GPU_BLEND: Record<BlendMode, GPUBlendState> = {
  additive: {
    color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  },
  alpha: {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  },
  screen: {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  },
}

const GL_BLEND: Record<BlendMode, GLBlendSpec> = {
  additive: { src: GL_ONE, dst: GL_ONE, eq: GL_FUNC_ADD },
  alpha: { src: GL_ONE, dst: GL_ONE_MINUS_SRC_ALPHA, eq: GL_FUNC_ADD },
  // GL applies (1 - As) to the destination alpha for ONE_MINUS_SRC_COLOR,
  // matching the WebGPU alpha component above.
  screen: { src: GL_ONE, dst: GL_ONE_MINUS_SRC_COLOR, eq: GL_FUNC_ADD },
}

export function gpuBlendState(mode: string | undefined | null): GPUBlendState {
  return GPU_BLEND[resolveBlendMode(mode)]
}

export function glBlendSpec(mode: string | undefined | null): GLBlendSpec {
  return GL_BLEND[resolveBlendMode(mode)]
}

/**
 * Shader function name per tone-mapping mode. 'linear' avoids the bare name
 * "linear" (reserved/ambiguous in some shading languages).
 */
const TONE_FN: Record<ToneMapping, string> = {
  aces: 'aces',
  reinhard: 'reinhard',
  linear: 'linearTone',
}

export function toneMapFunctionName(mode: string | undefined | null): string {
  return TONE_FN[resolveToneMapping(mode)]
}

// The 'aces' chunks are byte-identical to the historic hardcoded shader text
// so the default look composes to exactly the same shader source.
const TONE_WGSL: Record<ToneMapping, string> = {
  aces: `fn aces(x: vec3<f32>) -> vec3<f32> {
  return clamp(
    (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14),
    vec3<f32>(0.0), vec3<f32>(1.0),
  );
}`,
  reinhard: `fn reinhard(x: vec3<f32>) -> vec3<f32> {
  return clamp(x / (x + vec3<f32>(1.0)), vec3<f32>(0.0), vec3<f32>(1.0));
}`,
  linear: `fn linearTone(x: vec3<f32>) -> vec3<f32> {
  return clamp(x, vec3<f32>(0.0), vec3<f32>(1.0));
}`,
}

const TONE_GLSL: Record<ToneMapping, string> = {
  aces: `vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}`,
  reinhard: `vec3 reinhard(vec3 x) {
  return clamp(x / (x + 1.0), 0.0, 1.0);
}`,
  linear: `vec3 linearTone(vec3 x) {
  return clamp(x, 0.0, 1.0);
}`,
}

/** Tone-map function source for the requested shading language. */
export function toneMapSource(mode: string | undefined | null, lang: 'wgsl' | 'glsl'): string {
  const m = resolveToneMapping(mode)
  return lang === 'wgsl' ? TONE_WGSL[m] : TONE_GLSL[m]
}
