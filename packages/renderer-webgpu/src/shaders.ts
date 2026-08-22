/**
 * WGSL sources for the particle pipeline:
 *   sim (compute)
 *   -> fade (trail decay on the HDR accumulation target)
 *   -> particles (additive quads into HDR)
 *   -> brightpass -> blur H/V (bloom) -> streak H x2 (anamorphic)
 *   -> composite (nebula + starfield + CA + tone map + vignette + grain)
 */

import { toneMapFunctionName, toneMapSource } from './blend'

// ---------------------------------------------------------------------------
// Curl-noise turbulence: a divergence-free vector field built from the
// ANALYTIC gradient of 3D value noise (no textures, pure function). The same
// builder emits both WGSL and GLSL so the two backends can never drift apart;
// every numeric constant lives here as a named export and reaches both
// languages through this single source. Locked by turbulence.test.ts.
// ---------------------------------------------------------------------------

/** Domain-folding scale of the lattice-corner hash (Hoskins hash13 family). */
export const CURL_HASH_SCALE = 0.1031
/** Additive decorrelation shift inside the lattice-corner hash. */
export const CURL_HASH_SHIFT = 31.32
/** Noise-space offset decorrelating the potential's Y component from X. */
export const CURL_OFFSET_Y = [31.341, 17.113, 47.529] as const
/** Noise-space offset decorrelating the potential's Z component from X and Y. */
export const CURL_OFFSET_Z = [12.972, 63.416, 88.513] as const
/** Drift speed of the turbulence field through noise space (phase = time * this). */
export const TURBULENCE_TIME_SCALE = 0.3
/** Default turbulence strength. 0 = off: legacy trajectories stay bit-identical. */
export const DEFAULT_TURBULENCE = 0
/** Default noise-space frequency of the curl turbulence field. */
export const DEFAULT_TURBULENCE_SCALE = 0.35

export type ShaderLang = 'wgsl' | 'glsl'

/** Formats a number as a float literal valid in both WGSL and GLSL ES 3.0. */
export const shaderFloatLiteral = (n: number): string => {
  const s = String(n)
  return /[.eE]/.test(s) ? s : `${s}.0`
}

const lit = shaderFloatLiteral
const vec3Type = (lang: ShaderLang): string => (lang === 'wgsl' ? 'vec3<f32>' : 'vec3')

/**
 * Gradient-based curl noise, emitted for either shader language:
 *   curlHash      – lattice-corner hash (fract/dot folding, sin-free)
 *   curlNoiseGrad – ANALYTIC gradient of trilinear value noise (iq's k0..k7
 *                   polynomial form; cubic smoothstep fade, C1 continuous)
 *   curlNoise     – curl of the potential (n(p), n(p+OY), n(p+OZ)), which is
 *                   divergence-free by construction.
 * The WGSL and GLSL outputs are token-for-token identical up to declaration
 * syntax (asserted by test).
 */
export function curlNoiseSource(lang: ShaderLang): string {
  const V = vec3Type(lang)
  const head = (ret: 'float' | 'vec3', name: string): string =>
    lang === 'wgsl'
      ? `fn ${name}(p: ${V}) -> ${ret === 'vec3' ? V : 'f32'} {`
      : `${ret} ${name}(vec3 p) {`
  const decl = (type: 'float' | 'vec3', name: string, expr: string): string =>
    lang === 'wgsl' ? `  let ${name} = ${expr};` : `  ${type} ${name} = ${expr};`
  const off = (o: readonly [number, number, number]): string =>
    `${V}(${lit(o[0])}, ${lit(o[1])}, ${lit(o[2])})`
  return [
    head('float', 'curlHash'),
    decl('vec3', 'q', `fract(p * ${lit(CURL_HASH_SCALE)})`),
    decl('vec3', 'r', `q + ${V}(dot(q, q.zyx + ${V}(${lit(CURL_HASH_SHIFT)})))`),
    `  return fract((r.x + r.y) * r.z);`,
    `}`,
    head('vec3', 'curlNoiseGrad'),
    decl('vec3', 'i', `floor(p)`),
    decl('vec3', 'f', `fract(p)`),
    decl('vec3', 'u', `f * f * (3.0 - 2.0 * f)`),
    decl('vec3', 'du', `6.0 * f * (1.0 - f)`),
    decl('float', 'n000', `curlHash(i)`),
    decl('float', 'n100', `curlHash(i + ${V}(1.0, 0.0, 0.0))`),
    decl('float', 'n010', `curlHash(i + ${V}(0.0, 1.0, 0.0))`),
    decl('float', 'n110', `curlHash(i + ${V}(1.0, 1.0, 0.0))`),
    decl('float', 'n001', `curlHash(i + ${V}(0.0, 0.0, 1.0))`),
    decl('float', 'n101', `curlHash(i + ${V}(1.0, 0.0, 1.0))`),
    decl('float', 'n011', `curlHash(i + ${V}(0.0, 1.0, 1.0))`),
    decl('float', 'n111', `curlHash(i + ${V}(1.0, 1.0, 1.0))`),
    decl('float', 'k1', `n100 - n000`),
    decl('float', 'k2', `n010 - n000`),
    decl('float', 'k3', `n001 - n000`),
    decl('float', 'k4', `n000 - n100 - n010 + n110`),
    decl('float', 'k5', `n000 - n010 - n001 + n011`),
    decl('float', 'k6', `n000 - n100 - n001 + n101`),
    decl('float', 'k7', `-n000 + n100 + n010 - n110 + n001 - n101 - n011 + n111`),
    `  return du * ${V}(`,
    `    k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z,`,
    `    k2 + k4 * u.x + k5 * u.z + k7 * u.z * u.x,`,
    `    k3 + k5 * u.y + k6 * u.x + k7 * u.x * u.y);`,
    `}`,
    head('vec3', 'curlNoise'),
    decl('vec3', 'gx', `curlNoiseGrad(p)`),
    decl('vec3', 'gy', `curlNoiseGrad(p + ${off(CURL_OFFSET_Y)})`),
    decl('vec3', 'gz', `curlNoiseGrad(p + ${off(CURL_OFFSET_Z)})`),
    `  return ${V}(gz.y - gy.z, gx.z - gz.x, gy.x - gx.y);`,
    `}`,
  ].join('\n')
}

/**
 * The guarded velocity increment shared by both sims. The `!= 0.0` branch is
 * uniform across the whole dispatch (no divergence cost) and guarantees the
 * default turbulence = 0 adds nothing at all: legacy trajectories stay
 * bit-identical and the noise evaluation is skipped entirely.
 */
export function turbulenceTermSource(lang: ShaderLang): string {
  const V = vec3Type(lang)
  const u =
    lang === 'wgsl'
      ? { strength: 'P.turbulence', scale: 'P.turbulenceScale', time: 'P.time' }
      : { strength: 'uTurbulence', scale: 'uTurbulenceScale', time: 'uTime' }
  return [
    `  if (${u.strength} != 0.0) {`,
    `    vel += curlNoise(pos * ${u.scale} + ${V}(${u.time} * ${lit(TURBULENCE_TIME_SCALE)})) * (${u.strength} * dt);`,
    `  }`,
  ].join('\n')
}

export const SIM_WGSL = /* wgsl */ `
struct SimParams {
  dt: f32,
  time: f32,
  morphT: f32,
  count: u32,
  pointer: vec4<f32>,       // xyz world position, w strength (0 = off)
  attraction: f32,
  damping: f32,
  noiseScale: f32,
  noiseStrength: f32,
  swirl: f32,
  maxSpeed: f32,
  boost: f32,               // extra turbulence during morph transitions
  // Per-particle morph stagger. |x| = spread (0 = uniform legacy morph);
  // the SIGN routes the delay coordinate to the morph's DESTINATION buffer:
  // + reads targetB.w (morphT rising to 1), - reads 1-targetA.w (falling to 0),
  // so the first character always lands first in either direction.
  morphSpread: f32,
  turbulence: f32,          // curl-noise strength (0 = off, bit-exact legacy)
  turbulenceScale: f32,     // noise-space frequency of the curl field
}

@group(0) @binding(0) var<uniform> P: SimParams;
@group(0) @binding(1) var<storage, read_write> positions: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> velocities: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> targetA: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> targetB: array<vec4<f32>>;

// Cheap trig flow field driven by noiseStrength (legacy look, kept as-is).
// Real divergence-free curl noise is the separate opt-in turbulence term below.
fn flowField(p: vec3<f32>, t: f32) -> vec3<f32> {
  return vec3<f32>(
    sin(p.y * 1.7 + t) + cos(p.z * 1.3 - t * 0.7),
    sin(p.z * 1.9 + t * 0.8) + cos(p.x * 1.1 + t * 0.6),
    sin(p.x * 1.3 - t * 0.9) + cos(p.y * 1.7 + t * 0.5),
  );
}

${curlNoiseSource('wgsl')}

@compute @workgroup_size(256)
fn sim(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= P.count) { return; }

  var pos = positions[i].xyz;
  var vel = velocities[i].xyz;

  // Defense in depth: a negative or huge dt must never reach the
  // integration below (see YuraApp.tick for the rAF timestamp hazard).
  let dt = clamp(P.dt, 0.0, 0.05);

  // NOTE: "target" is a reserved keyword in WGSL — do not rename this back.
  // Per-particle morph sweep: each particle's effective progress is the
  // global morphT stretched by (1 + spread) and offset by its delay
  // coordinate, so shapes assemble character-by-character. At spread 0 this
  // reduces to clamp(morphT, 0, 1) — bit-exact legacy behavior.
  let spread = abs(P.morphSpread);
  var delay = targetB[i].w;
  if (P.morphSpread < 0.0) { delay = 1.0 - targetA[i].w; }
  let sweepT = clamp(P.morphT * (1.0 + spread) - delay * spread, 0.0, 1.0);
  let k = smoothstep(0.0, 1.0, sweepT);
  let goal = mix(targetA[i].xyz, targetB[i].xyz, k);
  // Palette coordinate travels with the morph and rides in positions.w.
  let palette = mix(targetA[i].w, targetB[i].w, k);

  let attraction = P.attraction * (1.0 - 0.35 * P.boost);
  let noise = P.noiseStrength * (1.0 + 1.8 * P.boost);

  vel += (goal - pos) * attraction * dt;
  vel += flowField(pos * P.noiseScale, P.time * 0.4) * noise * dt;
  vel += vec3<f32>(-pos.z, 0.0, pos.x) * P.swirl * dt;
${turbulenceTermSource('wgsl')}

  if (P.pointer.w != 0.0) {
    let d = pos - P.pointer.xyz;
    let r2 = max(dot(d, d), 0.35);
    vel += (d / sqrt(r2)) * (P.pointer.w / r2) * dt;
  }

  let sp = length(vel);
  if (sp > P.maxSpeed) { vel *= P.maxSpeed / sp; }
  vel *= exp(-P.damping * dt);
  pos += vel * dt;

  positions[i] = vec4<f32>(pos, palette);
  velocities[i] = vec4<f32>(vel, 0.0);
}
`

export const RENDER_WGSL = /* wgsl */ `
struct RenderParams {
  viewProj: mat4x4<f32>,
  right: vec4<f32>,     // xyz camera right, w particle size
  up: vec4<f32>,        // xyz camera up, w hdr intensity
  colorA: vec4<f32>,
  colorB: vec4<f32>,
  colorHot: vec4<f32>,  // rgb hot/highlight color, w twinkle amount
  misc: vec4<f32>,      // x time, y speed->hot factor, z/w unused
}

@group(0) @binding(0) var<uniform> R: RenderParams;
@group(0) @binding(1) var<storage, read> positions: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> velocities: array<vec4<f32>>;

struct VOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) col: vec3<f32>,
}

@vertex
fn vs(@builtin(vertex_index) vid: u32) -> VOut {
  let i = vid / 6u;
  let corner = vid % 6u;
  var offs = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
  );
  let o = offs[corner];
  let p = positions[i].xyz;
  let w = positions[i].w;          // palette coordinate from the shape
  let v = velocities[i].xyz;

  let h = fract(f32(i) * 0.61803398875);
  let h2 = fract(f32(i) * 0.75487766625);
  var size = R.right.w * (0.6 + 0.8 * h);

  // Shape-driven gradient, pushed toward the hot color at high speed.
  let speedMix = clamp(length(v) * R.misc.y, 0.0, 1.0);
  var col = mix(R.colorA.rgb, R.colorB.rgb, clamp(w + (h - 0.5) * 0.18, 0.0, 1.0));
  col = mix(col, R.colorHot.rgb, speedMix * 0.85);

  // Twinkle: brightness shimmer, desynchronized per particle.
  let tw = 1.0 + R.colorHot.w * 0.45 * sin(R.misc.x * (2.0 + 4.0 * h2) + h2 * 40.0);
  col *= tw;

  // Hero sparkles: a sparse fraction of oversized bright stars adds depth.
  if (h2 > 0.995) {
    size *= 3.0;
    col *= 2.6;
  }

  let world = p + (R.right.xyz * o.x + R.up.xyz * o.y) * size;

  var out: VOut;
  out.clip = R.viewProj * vec4<f32>(world, 1.0);
  out.uv = o;
  out.col = col * R.up.w;
  return out;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
  let d2 = dot(in.uv, in.uv);
  if (d2 > 1.0) { discard; }
  let a = exp(-d2 * 3.0) * (1.0 - d2);
  return vec4<f32>(in.col * a, a);
}
`

/**
 * Post-chain WGSL with a selectable tone-mapping curve. The default ('aces')
 * composes to exactly the historic POST_WGSL text.
 */
export const buildPostWgsl = (toneMapping?: string): string => /* wgsl */ `
struct PostParams {
  a: vec4<f32>,
  b: vec4<f32>,
  c: vec4<f32>,
  d: vec4<f32>,
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<uniform> U: PostParams;
@group(0) @binding(3) var bloomTex: texture_2d<f32>;
@group(0) @binding(4) var streakTex: texture_2d<f32>;

struct FSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn fsVS(@builtin(vertex_index) vi: u32) -> FSOut {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -3.0), vec2<f32>(3.0, 1.0), vec2<f32>(-1.0, 1.0),
  );
  var out: FSOut;
  out.pos = vec4<f32>(p[vi], 0.0, 1.0);
  out.uv = vec2<f32>(p[vi].x * 0.5 + 0.5, 1.0 - (p[vi].y * 0.5 + 0.5));
  return out;
}

// Trail decay: multiplies the accumulation buffer by (1 - U.a.x).
// Pipeline blend: dst * (1 - srcAlpha).
@fragment
fn fadeFS(in: FSOut) -> @location(0) vec4<f32> {
  return vec4<f32>(0.0, 0.0, 0.0, U.a.x);
}

// U.a.x = threshold
@fragment
fn brightFS(in: FSOut) -> @location(0) vec4<f32> {
  let c = textureSample(src, samp, in.uv).rgb;
  let l = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
  let soft = max(l - U.a.x, 0.0);
  let f = soft / max(l, 1e-4);
  return vec4<f32>(c * f, 1.0);
}

// U.a.xy = blur direction premultiplied by texel size
@fragment
fn blurFS(in: FSOut) -> @location(0) vec4<f32> {
  let dir = U.a.xy;
  var acc = textureSample(src, samp, in.uv).rgb * 0.227027;
  acc += textureSample(src, samp, in.uv + dir * 1.3846154).rgb * 0.3162162;
  acc += textureSample(src, samp, in.uv - dir * 1.3846154).rgb * 0.3162162;
  acc += textureSample(src, samp, in.uv + dir * 3.2307692).rgb * 0.0702703;
  acc += textureSample(src, samp, in.uv - dir * 3.2307692).rgb * 0.0702703;
  return vec4<f32>(acc, 1.0);
}

${toneMapSource(toneMapping, 'wgsl')}

fn hash12(p: vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn vnoise(p: vec2<f32>) -> f32 {
  let ip = floor(p);
  let fp = fract(p);
  let u = fp * fp * (3.0 - 2.0 * fp);
  let a = hash12(ip);
  let b = hash12(ip + vec2<f32>(1.0, 0.0));
  let c = hash12(ip + vec2<f32>(0.0, 1.0));
  let d = hash12(ip + vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm(p0: vec2<f32>) -> f32 {
  var p = p0;
  var acc = 0.0;
  var amp = 0.5;
  for (var i = 0; i < 3; i++) {
    acc += vnoise(p) * amp;
    p = p * 2.03 + vec2<f32>(17.1, 9.7);
    amp *= 0.5;
  }
  return acc;
}

// U.a = (bloomStrength, exposure, vignette, grain)
// U.b = (time, aberration, streakStrength, nebulaAmount)
// U.c = (nebula tint A rgb, starsAmount)
// U.d = (nebula tint B rgb, aspect)
@fragment
fn compositeFS(in: FSOut) -> @location(0) vec4<f32> {
  let t = U.b.x;
  let sp = vec2<f32>(in.uv.x * U.d.w, in.uv.y);
  var c = vec3<f32>(0.0);

  // Deep-space nebula: two drifting FBM layers tinted by the scene palette.
  let n1 = fbm(sp * 3.0 + vec2<f32>(t * 0.010, 0.0));
  let n2 = fbm(sp * 5.0 - vec2<f32>(0.0, t * 0.008) + vec2<f32>(31.7, 11.3));
  c += (U.c.rgb * pow(n1, 2.2) + U.d.rgb * pow(n2, 2.6)) * (0.14 * U.b.w);

  // Procedural starfield with per-star twinkle.
  let sg = sp * 160.0;
  let cell = floor(sg);
  let f = fract(sg) - 0.5;
  let rn = hash12(cell);
  if (rn > 0.995) {
    let jitter = vec2<f32>(hash12(cell + 7.1), hash12(cell + 3.7)) - 0.5;
    let dstar = length(f - jitter * 0.7);
    let twk = 0.55 + 0.45 * sin(t * (1.5 + 3.0 * rn) + rn * 40.0);
    let bright = (rn - 0.995) / 0.005;
    let star = smoothstep(0.10, 0.0, dstar) * 0.9 + smoothstep(0.35, 0.0, dstar) * 0.15;
    c += vec3<f32>(0.7, 0.8, 1.0) * star * bright * twk * U.c.w;
  }

  // Scene with chromatic aberration that grows toward the edges.
  let off = (in.uv - vec2<f32>(0.5)) * U.b.y;
  c += vec3<f32>(
    textureSample(src, samp, in.uv + off).r,
    textureSample(src, samp, in.uv).g,
    textureSample(src, samp, in.uv - off).b,
  );

  c += textureSample(bloomTex, samp, in.uv).rgb * U.a.x;
  // Anamorphic streaks lean cool, like a lens flare.
  c += textureSample(streakTex, samp, in.uv).rgb * U.b.z * vec3<f32>(0.75, 0.85, 1.0);

  c *= U.a.y;
  c = ${toneMapFunctionName(toneMapping)}(c);
  let q = in.uv - vec2<f32>(0.5);
  c *= 1.0 - U.a.z * dot(q, q) * 2.0;
  c += (hash12(in.uv * 1024.0 + t) - 0.5) * U.a.w;
  c = pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.2));
  return vec4<f32>(c, 1.0);
}
`

/** Historic default post chain (ACES); byte-identical to pre-toneMapping builds. */
export const POST_WGSL = buildPostWgsl()
