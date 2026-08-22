/**
 * WGSL for the glTF/PBR path:
 *   env (procedural studio HDRI -> cubemap faces) + mip blits
 *   sky (background dome) + pbr (Cook-Torrance GGX + IBL)
 * Post processing reuses POST_WGSL from shaders.ts.
 */

export const ENV_WGSL = /* wgsl */ `
struct EnvParams {
  a: vec4<f32>, // x = face index
}
@group(0) @binding(0) var<uniform> U: EnvParams;

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

fn faceDir(face: i32, uv: vec2<f32>) -> vec3<f32> {
  let c = uv * 2.0 - vec2<f32>(1.0);
  switch face {
    case 0: { return vec3<f32>( 1.0, -c.y, -c.x); }
    case 1: { return vec3<f32>(-1.0, -c.y,  c.x); }
    case 2: { return vec3<f32>( c.x,  1.0,  c.y); }
    case 3: { return vec3<f32>( c.x, -1.0, -c.y); }
    case 4: { return vec3<f32>( c.x, -c.y,  1.0); }
    default: { return vec3<f32>(-c.x, -c.y, -1.0); }
  }
}

fn softbox(d: vec3<f32>, l: vec3<f32>, cutoff: f32, tint: vec3<f32>, power: f32) -> vec3<f32> {
  let a = dot(d, l);
  return tint * power * smoothstep(cutoff, cutoff + (1.0 - cutoff) * 0.7, a);
}

// Procedural studio HDRI: gradient dome + three softbox area lights.
// Zero assets, tuned for PBR speculars.
fn envColor(dIn: vec3<f32>) -> vec3<f32> {
  let d = normalize(dIn);
  let up = d.y;
  var c = mix(vec3<f32>(0.018, 0.018, 0.024), vec3<f32>(0.10, 0.115, 0.15), smoothstep(-1.0, 0.15, up));
  c = mix(c, vec3<f32>(0.035, 0.045, 0.075), smoothstep(0.2, 1.0, up));
  c += vec3<f32>(0.30, 0.26, 0.22) * exp(-abs(up + 0.02) * 12.0) * 0.5;
  c += softbox(d, normalize(vec3<f32>(-0.50, 0.50, -0.65)), 0.955, vec3<f32>(1.0, 0.92, 0.8), 30.0);
  c += softbox(d, normalize(vec3<f32>(0.70, 0.25, 0.65)), 0.972, vec3<f32>(0.45, 0.70, 1.0), 22.0);
  c += softbox(d, normalize(vec3<f32>(0.05, 0.95, 0.20)), 0.930, vec3<f32>(0.90, 0.95, 1.0), 7.0);
  return c;
}

@fragment
fn faceFS(in: FSOut) -> @location(0) vec4<f32> {
  let face = i32(U.a.x + 0.5);
  return vec4<f32>(envColor(faceDir(face, in.uv)), 1.0);
}
`

export const BLIT_WGSL = /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;

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

// Tent-filtered downsample: smooths the roughness mip chain.
@fragment
fn blitFS(in: FSOut) -> @location(0) vec4<f32> {
  let t = vec2<f32>(1.0) / vec2<f32>(textureDimensions(src, 0));
  var acc = textureSampleLevel(src, samp, in.uv + vec2<f32>(-0.75, -0.75) * t, 0.0).rgb;
  acc += textureSampleLevel(src, samp, in.uv + vec2<f32>(0.75, -0.75) * t, 0.0).rgb;
  acc += textureSampleLevel(src, samp, in.uv + vec2<f32>(-0.75, 0.75) * t, 0.0).rgb;
  acc += textureSampleLevel(src, samp, in.uv + vec2<f32>(0.75, 0.75) * t, 0.0).rgb;
  return vec4<f32>(acc * 0.25, 1.0);
}
`

export const SHADOW_WGSL = /* wgsl */ `
struct ShadowU {
  lightViewProj: mat4x4<f32>,
}
@group(0) @binding(0) var<uniform> S: ShadowU;
struct ObjectU {
  world: mat4x4<f32>,
}
@group(1) @binding(0) var<uniform> O: ObjectU;

@vertex
fn vs(@location(0) pos: vec3<f32>) -> @builtin(position) vec4<f32> {
  return S.lightViewProj * O.world * vec4<f32>(pos, 1.0);
}
`

export const PBR_WGSL = /* wgsl */ `
struct FrameU {
  viewProj: mat4x4<f32>,
  invViewProj: mat4x4<f32>,
  eye: vec4<f32>,          // xyz eye, w time
  light0: vec4<f32>,       // xyz dir-to-light, w intensity
  light0Color: vec4<f32>,
  light1: vec4<f32>,
  light1Color: vec4<f32>,
  params: vec4<f32>,       // x envIntensity, y maxEnvLod, z skyLod, w skyDim
  lightViewProj: mat4x4<f32>,
}
@group(0) @binding(0) var<uniform> F: FrameU;
@group(0) @binding(1) var envTex: texture_cube<f32>;
@group(0) @binding(2) var envSamp: sampler;
@group(0) @binding(3) var shadowMap: texture_depth_2d;
@group(0) @binding(4) var shadowSamp: sampler_comparison;

struct MaterialU {
  baseColor: vec4<f32>,
  mro: vec4<f32>,          // x metallic, y roughness, z occlusionStrength, w unused
  emissive: vec4<f32>,
}
@group(1) @binding(0) var<uniform> M: MaterialU;
@group(1) @binding(1) var matSamp: sampler;
@group(1) @binding(2) var baseTex: texture_2d<f32>;
@group(1) @binding(3) var mrTex: texture_2d<f32>;
@group(1) @binding(4) var normTex: texture_2d<f32>;
@group(1) @binding(5) var emisTex: texture_2d<f32>;
@group(1) @binding(6) var aoTex: texture_2d<f32>;

struct ObjectU {
  world: mat4x4<f32>,
}
@group(2) @binding(0) var<uniform> O: ObjectU;

struct VOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
}

@vertex
fn vs(
  @location(0) pos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
) -> VOut {
  var out: VOut;
  let wp = O.world * vec4<f32>(pos, 1.0);
  out.worldPos = wp.xyz;
  out.normal = normalize((O.world * vec4<f32>(normal, 0.0)).xyz);
  out.uv = uv;
  out.clip = F.viewProj * wp;
  return out;
}

// Screen-space cotangent frame: normal mapping without vertex tangents.
fn applyNormalMap(n: vec3<f32>, p: vec3<f32>, uv: vec2<f32>, mapN: vec3<f32>) -> vec3<f32> {
  let dp1 = dpdx(p);
  let dp2 = dpdy(p);
  let duv1 = dpdx(uv);
  let duv2 = dpdy(uv);
  let dp2perp = cross(dp2, n);
  let dp1perp = cross(n, dp1);
  let t = dp2perp * duv1.x + dp1perp * duv2.x;
  let b = dp2perp * duv1.y + dp1perp * duv2.y;
  let invmax = inverseSqrt(max(dot(t, t), max(dot(b, b), 1e-8)));
  return normalize(t * invmax * mapN.x + b * invmax * mapN.y + n * mapN.z);
}

fn dGGX(noh: f32, a: f32) -> f32 {
  let a2 = a * a;
  let d = noh * noh * (a2 - 1.0) + 1.0;
  return a2 / (3.14159265 * d * d + 1e-6);
}

fn fresnel(voh: f32, f0: vec3<f32>) -> vec3<f32> {
  return f0 + (vec3<f32>(1.0) - f0) * pow(clamp(1.0 - voh, 0.0, 1.0), 5.0);
}

fn vSmith(nov: f32, nol: f32, a: f32) -> f32 {
  return 0.5 / (mix(2.0 * nol * nov, nol + nov, a) + 1e-5);
}

// Karis analytic environment BRDF: no LUT needed.
fn envBRDF(f0: vec3<f32>, rough: f32, nov: f32) -> vec3<f32> {
  let c0 = vec4<f32>(-1.0, -0.0275, -0.572, 0.022);
  let c1 = vec4<f32>(1.0, 0.0425, 1.04, -0.04);
  let r = rough * c0 + c1;
  let a004 = min(r.x * r.x, exp2(-9.28 * nov)) * r.x + r.y;
  let ab = vec2<f32>(-1.04, 1.04) * a004 + r.zw;
  return f0 * ab.x + vec3<f32>(ab.y);
}

// 3x3 PCF via explicit-level compares (uniformity-safe).
fn shadowFactor(worldPos: vec3<f32>) -> f32 {
  let sp = F.lightViewProj * vec4<f32>(worldPos, 1.0);
  let ndc = sp.xyz / sp.w;
  let uv = vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  let inBounds =
    step(0.0, uv.x) * step(uv.x, 1.0) *
    step(0.0, uv.y) * step(uv.y, 1.0) *
    step(ndc.z, 1.0);
  let cuv = clamp(uv, vec2<f32>(0.001), vec2<f32>(0.999));
  var acc = 0.0;
  let texel = 1.0 / 2048.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      acc += textureSampleCompareLevel(
        shadowMap, shadowSamp,
        cuv + vec2<f32>(f32(x), f32(y)) * texel,
        ndc.z - 0.0018,
      );
    }
  }
  return mix(1.0, acc / 9.0, inBounds);
}

fn directLight(
  ldir: vec3<f32>, lcolor: vec3<f32>, intensity: f32,
  n: vec3<f32>, v: vec3<f32>, albedo: vec3<f32>, metallic: f32, rough: f32, f0: vec3<f32>,
) -> vec3<f32> {
  let l = normalize(ldir);
  let h = normalize(v + l);
  let nol = max(dot(n, l), 0.0);
  let nov = max(dot(n, v), 1e-4);
  let noh = max(dot(n, h), 0.0);
  let voh = max(dot(v, h), 0.0);
  let a = rough * rough;
  let f = fresnel(voh, f0);
  let spec = dGGX(noh, a) * vSmith(nov, nol, a) * f;
  let diff = albedo * (1.0 - metallic) * (vec3<f32>(1.0) - f) / 3.14159265;
  return (diff + spec) * lcolor * intensity * nol;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
  let baseSample = textureSample(baseTex, matSamp, in.uv);
  let albedo = (M.baseColor * baseSample).rgb;
  let mr = textureSample(mrTex, matSamp, in.uv);
  let metallic = clamp(M.mro.x * mr.b, 0.0, 1.0);
  let rough = clamp(M.mro.y * mr.g, 0.045, 1.0);
  let ao = mix(1.0, textureSample(aoTex, matSamp, in.uv).r, M.mro.z);

  var n = normalize(in.normal);
  let v = normalize(F.eye.xyz - in.worldPos);
  if (dot(n, v) < 0.0) { n = -n; }
  let mapN = textureSample(normTex, matSamp, in.uv).xyz * 2.0 - vec3<f32>(1.0);
  n = applyNormalMap(n, in.worldPos, in.uv, mapN);

  let nov = max(dot(n, v), 1e-4);
  let r = reflect(-v, n);
  let f0 = mix(vec3<f32>(0.04), albedo, metallic);

  // Iridescent mode (M.emissive.w > 0.5): lightless normal-space pastel
  // rainbow with a soft fresnel sheen — the flagship "soft anodized" look.
  if (M.emissive.w > 0.5) {
    let pastel = n * 0.5 + vec3<f32>(0.5);
    let sheen = pow(1.0 - nov, 3.0);
    let shI = shadowFactor(in.worldPos);
    let ic = pastel * (0.74 + 0.26 * shI) + vec3<f32>(sheen * 0.35);
    return vec4<f32>(ic, 1.0);
  }

  // IBL: irradiance from the deepest mip, specular from roughness-scaled lod.
  let envI = F.params.x;
  let maxLod = F.params.y;
  let irradiance = textureSampleLevel(envTex, envSamp, n, maxLod).rgb;
  let prefiltered = textureSampleLevel(envTex, envSamp, r, rough * (maxLod - 1.0)).rgb;
  var color = albedo * (1.0 - metallic) * irradiance * envI;
  color += prefiltered * envBRDF(f0, rough, nov) * envI;
  color *= ao;

  let sh = shadowFactor(in.worldPos);
  color += directLight(F.light0.xyz, F.light0Color.rgb, F.light0.w, n, v, albedo, metallic, rough, f0) * sh;
  color += directLight(F.light1.xyz, F.light1Color.rgb, F.light1.w, n, v, albedo, metallic, rough, f0) * (0.4 + 0.6 * sh);

  color += M.emissive.rgb * textureSample(emisTex, matSamp, in.uv).rgb;
  return vec4<f32>(color, 1.0);
}

// Unlit translucent: blob shadows and glow discs. M.mro.w > 0.5 enables a
// radial alpha falloff from the UV center.
@fragment
fn unlitFS(in: VOut) -> @location(0) vec4<f32> {
  var alpha = M.baseColor.a;
  if (M.mro.w > 0.5) {
    let d = length(in.uv - vec2<f32>(0.5)) * 2.0;
    alpha *= smoothstep(1.0, 0.15, d);
  }
  return vec4<f32>((M.baseColor.rgb + M.emissive.rgb) * alpha, alpha);
}

// Background dome: reconstruct the view ray, sample a soft env mip.
@vertex
fn skyVS(@builtin(vertex_index) vi: u32) -> VOut {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -3.0), vec2<f32>(3.0, 1.0), vec2<f32>(-1.0, 1.0),
  );
  var out: VOut;
  out.clip = vec4<f32>(p[vi], 0.999999, 1.0);
  out.worldPos = vec3<f32>(p[vi], 0.0);
  out.normal = vec3<f32>(0.0);
  out.uv = vec2<f32>(0.0);
  return out;
}

@fragment
fn skyFS(in: VOut) -> @location(0) vec4<f32> {
  let ndc = vec4<f32>(in.worldPos.xy, 1.0, 1.0);
  let ph = F.invViewProj * ndc;
  let dir = normalize(ph.xyz / ph.w - F.eye.xyz);
  let c = textureSampleLevel(envTex, envSamp, dir, F.params.z).rgb;
  return vec4<f32>(c * F.params.x * F.params.w, 1.0);
}
`

// Camera-facing FX sprites: instanced quads, additive HDR blending.
// Depth-tested against the mesh scene (no depth write) so bursts and trails
// composite correctly behind geometry; bright cores feed the bloom pass.
export const FX_WGSL = /* wgsl */ `
struct FxFrame {
  viewProj: mat4x4<f32>,
  right: vec4<f32>,
  up: vec4<f32>,
}
@group(0) @binding(0) var<uniform> F: FxFrame;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) corner: vec2<f32>,
  @location(1) color: vec4<f32>,
}

@vertex
fn vs(
  @builtin(vertex_index) vi: u32,
  @location(0) centerSize: vec4<f32>,
  @location(1) colorAlpha: vec4<f32>,
) -> VSOut {
  var corners = array<vec2<f32>, 4>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, 1.0),
  );
  let c = corners[vi];
  let world = centerSize.xyz + (F.right.xyz * c.x + F.up.xyz * c.y) * centerSize.w;
  var out: VSOut;
  out.pos = F.viewProj * vec4<f32>(world, 1.0);
  out.corner = c;
  out.color = colorAlpha;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let d2 = dot(in.corner, in.corner);
  let falloff = max(1.0 - d2, 0.0);
  // Soft round sprite with a hot core; alpha=0 keeps additive blending pure.
  let glow = falloff * falloff * (0.35 + 1.9 * falloff);
  return vec4<f32>(in.color.rgb * (in.color.a * glow * 2.2), 0.0);
}
`
