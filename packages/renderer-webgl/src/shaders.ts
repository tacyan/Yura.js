/**
 * GLSL ES 3.0 sources for the WebGL2 fallback (F-002):
 * transform-feedback particle sim + point sprites + the same HDR post chain
 * (fade trails, bloom, streaks, nebula, tone map) ported from WGSL.
 */

import { toneMapFunctionName, toneMapSource } from '@yura/renderer-webgpu'
// Deep relative import: the curl-noise builder and its named constants live in
// the WebGPU package's shaders module (single source of truth for both
// backends) but are not re-exported by that package's root index.
import { curlNoiseSource, turbulenceTermSource } from '@yura/renderer-webgpu'
// Shared attractor builder from the WebGPU package root (single source of truth).
import { attractorTermSource, ATTRACTOR_ARRAY_VEC4S } from '@yura/renderer-webgpu'
// Per-sprite bokeh DoF: the same single-source builders the WGSL render
// shader embeds, shared via the WebGPU package root.
import {
  dofVertexTermSource,
  dofSpriteProfileSource,
} from '@yura/renderer-webgpu'

// Re-exported so renderer.ts (and tests) take the defaults from the same
// single source the WGSL backend uses.
export { DEFAULT_TURBULENCE, DEFAULT_TURBULENCE_SCALE } from '@yura/renderer-webgpu'
export {
  DEFAULT_DOF_FOCUS,
  DEFAULT_DOF_STRENGTH,
  DOF_DEPTH_EPSILON,
  SPRITE_CORE_FALLOFF,
} from '@yura/renderer-webgpu'
export {
  MAX_ATTRACTORS,
  ATTRACTOR_VEC4S,
  ATTRACTOR_RADIUS2_SLOT,
  ATTRACTOR_ARRAY_VEC4S,
  DEFAULT_ATTRACTOR_RADIUS,
  ATTRACTOR_DIST_EPSILON,
  packAttractors,
} from '@yura/renderer-webgpu'
export type { AttractorParams } from '@yura/renderer-webgpu'

export const SIM_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec4 aPos;
layout(location = 1) in vec4 aVel;
layout(location = 2) in vec4 aTA;
layout(location = 3) in vec4 aTB;
uniform float uDt, uTime, uMorphT, uAttraction, uDamping, uNoiseScale, uNoiseStrength, uSwirl, uMaxSpeed, uBoost, uMorphSpread, uTurbulence, uTurbulenceScale;
uniform vec4 uPointer;
uniform vec4 uAttractors[${ATTRACTOR_ARRAY_VEC4S}]; // vec4 pairs: [pos.xyz, strength], [radius^2, 0, 0, 0]
uniform int uAttractorCount;
out vec4 tfPos;
out vec4 tfVel;

vec3 flowField(vec3 p, float t) {
  return vec3(
    sin(p.y * 1.7 + t) + cos(p.z * 1.3 - t * 0.7),
    sin(p.z * 1.9 + t * 0.8) + cos(p.x * 1.1 + t * 0.6),
    sin(p.x * 1.3 - t * 0.9) + cos(p.y * 1.7 + t * 0.5));
}

${curlNoiseSource('glsl')}

void main() {
  vec3 pos = aPos.xyz;
  vec3 vel = aVel.xyz;
  // Defense in depth: a negative or huge dt must never reach the
  // integration (see YuraApp.tick for the rAF timestamp hazard).
  float dt = clamp(uDt, 0.0, 0.05);
  // Per-particle morph sweep (mirrors the WGSL sim): |uMorphSpread| is the
  // stagger spread, its sign routes the delay coordinate to the morph's
  // destination buffer (+ = aTB.w, - = 1-aTA.w). Spread 0 reduces to
  // clamp(uMorphT, 0, 1) — bit-exact legacy behavior.
  float spread = abs(uMorphSpread);
  float delay = uMorphSpread < 0.0 ? 1.0 - aTA.w : aTB.w;
  float sweepT = clamp(uMorphT * (1.0 + spread) - delay * spread, 0.0, 1.0);
  float k = smoothstep(0.0, 1.0, sweepT);
  vec3 goal = mix(aTA.xyz, aTB.xyz, k);
  float palette = mix(aTA.w, aTB.w, k);
  float attraction = uAttraction * (1.0 - 0.35 * uBoost);
  float noiseS = uNoiseStrength * (1.0 + 1.8 * uBoost);
  vel += (goal - pos) * attraction * dt;
  vel += flowField(pos * uNoiseScale, uTime * 0.4) * noiseS * dt;
  vel += vec3(-pos.z, 0.0, pos.x) * uSwirl * dt;
${turbulenceTermSource('glsl')}
${attractorTermSource('glsl')}
  if (uPointer.w != 0.0) {
    vec3 d0 = pos - uPointer.xyz;
    float r2 = max(dot(d0, d0), 0.35);
    vel += (d0 / sqrt(r2)) * (uPointer.w / r2) * dt;
  }
  float sp = length(vel);
  if (sp > uMaxSpeed) vel *= uMaxSpeed / sp;
  vel *= exp(-uDamping * dt);
  pos += vel * dt;
  tfPos = vec4(pos, palette);
  tfVel = vec4(vel, 0.0);
  gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`

export const RENDER_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec4 aPos;
layout(location = 1) in vec4 aVel;
uniform mat4 uViewProj;
uniform float uSizePx, uIntensity, uSpeedColorMix, uTime, uTwinkle, uMaxPointSize, uDofFocus, uDofStrength;
uniform vec3 uColorA, uColorB, uColorHot;
out vec3 vCol;
out float vCoc;

void main() {
  gl_Position = uViewProj * vec4(aPos.xyz, 1.0);
  float i = float(gl_VertexID);
  float h = fract(i * 0.61803398875);
  float h2 = fract(i * 0.75487766625);
  float size = uSizePx * (0.6 + 0.8 * h);
  float speedMix = clamp(length(aVel.xyz) * uSpeedColorMix, 0.0, 1.0);
  vec3 col = mix(uColorA, uColorB, clamp(aPos.w + (h - 0.5) * 0.18, 0.0, 1.0));
  col = mix(col, uColorHot, speedMix * 0.85);
  col *= 1.0 + uTwinkle * 0.45 * sin(uTime * (2.0 + 4.0 * h2) + h2 * 40.0);
  if (h2 > 0.995) { size *= 3.0; col *= 2.6; }
${dofVertexTermSource('glsl')}
  // Upper clamp is the device's ALIASED_POINT_SIZE_RANGE[1] (wired by the
  // renderer as uMaxPointSize) so close-up particles keep growing like the
  // WebGPU billboards. Lower bound stays 1px to avoid sub-pixel vanishing.
  // Known constraint: a DoF-inflated size clamps here too, so very large
  // bokeh discs saturate at the device's point-size limit.
  gl_PointSize = clamp(size / max(gl_Position.w, 0.1), 1.0, uMaxPointSize);
  vCol = col * uIntensity;
  vCoc = coc;
}
`

export const RENDER_FS = /* glsl */ `#version 300 es
precision highp float;
in vec3 vCol;
in float vCoc;
out vec4 o;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(c, c);
  if (d2 > 1.0) discard;
${dofSpriteProfileSource('glsl')}
  o = vec4(col * a, a);
}
`

export const FS_TRIANGLE_VS = /* glsl */ `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 p = vec2[3](vec2(-1.0, -3.0), vec2(3.0, 1.0), vec2(-1.0, 1.0))[gl_VertexID];
  gl_Position = vec4(p, 0.0, 1.0);
  vUv = p * 0.5 + 0.5;
}
`

export const FADE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform float uFade;
out vec4 o;
void main() { o = vec4(0.0, 0.0, 0.0, uFade); }
`

export const BRIGHT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform float uThreshold;
out vec4 o;
void main() {
  vec3 c = texture(uSrc, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float soft = max(l - uThreshold, 0.0);
  o = vec4(c * (soft / max(l, 1e-4)), 1.0);
}
`

export const BLUR_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uDir;
out vec4 o;
void main() {
  vec3 acc = texture(uSrc, vUv).rgb * 0.227027;
  acc += texture(uSrc, vUv + uDir * 1.3846154).rgb * 0.3162162;
  acc += texture(uSrc, vUv - uDir * 1.3846154).rgb * 0.3162162;
  acc += texture(uSrc, vUv + uDir * 3.2307692).rgb * 0.0702703;
  acc += texture(uSrc, vUv - uDir * 3.2307692).rgb * 0.0702703;
  o = vec4(acc, 1.0);
}
`

/**
 * Composite GLSL with a selectable tone-mapping curve. The default ('aces')
 * composes to exactly the historic COMPOSITE_FS text.
 */
export const buildCompositeFs = (toneMapping?: string): string => /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uStreak;
uniform float uBloomStrength, uExposure, uVignette, uGrain, uTime, uAberration, uStreakStrength, uNebula, uStars, uAspect;
uniform vec3 uTintA, uTintB;
out vec4 outColor;

${toneMapSource(toneMapping, 'glsl')}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 ip = floor(p), fp = fract(p);
  vec2 u = fp * fp * (3.0 - 2.0 * fp);
  float a = hash12(ip), b = hash12(ip + vec2(1, 0)), c = hash12(ip + vec2(0, 1)), d = hash12(ip + vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float acc = 0.0, amp = 0.5;
  for (int i = 0; i < 3; i++) {
    acc += vnoise(p) * amp;
    p = p * 2.03 + vec2(17.1, 9.7);
    amp *= 0.5;
  }
  return acc;
}

void main() {
  float t = uTime;
  vec2 sp = vec2(vUv.x * uAspect, vUv.y);
  vec3 c = vec3(0.0);
  float n1 = fbm(sp * 3.0 + vec2(t * 0.010, 0.0));
  float n2 = fbm(sp * 5.0 - vec2(0.0, t * 0.008) + vec2(31.7, 11.3));
  c += (uTintA * pow(n1, 2.2) + uTintB * pow(n2, 2.6)) * (0.14 * uNebula);
  vec2 sg = sp * 160.0;
  vec2 cell = floor(sg);
  vec2 f = fract(sg) - 0.5;
  float rn = hash12(cell);
  if (rn > 0.995) {
    vec2 jitter = vec2(hash12(cell + 7.1), hash12(cell + 3.7)) - 0.5;
    float dstar = length(f - jitter * 0.7);
    float twk = 0.55 + 0.45 * sin(t * (1.5 + 3.0 * rn) + rn * 40.0);
    float bright = (rn - 0.995) / 0.005;
    float star = smoothstep(0.10, 0.0, dstar) * 0.9 + smoothstep(0.35, 0.0, dstar) * 0.15;
    c += vec3(0.7, 0.8, 1.0) * star * bright * twk * uStars;
  }
  vec2 off = (vUv - 0.5) * uAberration;
  c += vec3(
    texture(uScene, vUv + off).r,
    texture(uScene, vUv).g,
    texture(uScene, vUv - off).b);
  c += texture(uBloom, vUv).rgb * uBloomStrength;
  c += texture(uStreak, vUv).rgb * uStreakStrength * vec3(0.75, 0.85, 1.0);
  c *= uExposure;
  c = ${toneMapFunctionName(toneMapping)}(c);
  vec2 q = vUv - 0.5;
  c *= 1.0 - uVignette * dot(q, q) * 2.0;
  c += (hash12(vUv * 1024.0 + t) - 0.5) * uGrain;
  c = pow(max(c, 0.0), vec3(1.0 / 2.2));
  outColor = vec4(c, 1.0);
}
`

/** Historic default composite (ACES); byte-identical to pre-toneMapping builds. */
export const COMPOSITE_FS = buildCompositeFs()
