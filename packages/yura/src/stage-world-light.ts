import { hash01 } from './motion-kit'
import type { Placement, ThreeNamespace, WorldFrame } from './stage-world'

/**
 * Light and water worlds for {@link lyricStage}: a sea at dusk with a sun
 * glint path, a sunlit sea floor under moving caustics and rising bubbles,
 * aurora curtains, cathedral light shafts — and `void`, the pure black a
 * projection-mapping surface wants (black is "no light" on a wall).
 *
 * The look lives in GLSL, but every number the shaders animate with comes
 * from a table in this file that the TypeScript mirrors 1:1: the sea's
 * height field is generated *from* {@link OCEAN_WAVES} and also evaluated
 * by {@link oceanHeight}, so the water the camera sees and the water the
 * tests measure are the same function. Colours arrive as plain sRGB (not
 * THREE.Color), so they render identically whether or not the page has
 * three's colour management switched on.
 */

// ------------------------------------------------------------------ colour

/** `#rrggbb` (or `#rgb`) → sRGB floats 0..1; anything unparseable is black. (Pure.) */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [0, 0, 0]
  const h = m[1].length === 3 ? Array.from(m[1], (c) => c + c).join('') : m[1]
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number]
}

// ------------------------------------------------------------------ ocean

/** One travelling sine in the sea's height field (world units, seconds). */
export interface OceanWave {
  /** Unit-ish direction in the xz plane. */
  dx: number
  dz: number
  /** Peak height. */
  amp: number
  /** Crest-to-crest distance. */
  len: number
  /** Crest speed, units per second. */
  speed: number
}

/** The sea: a long swell, two cross swells and a fine chop. */
export const OCEAN_WAVES: readonly OceanWave[] = [
  { dx: 0.2, dz: 1, amp: 0.32, len: 26, speed: 2.6 },
  { dx: 0.9, dz: 0.45, amp: 0.16, len: 12, speed: 1.9 },
  { dx: -0.7, dz: 0.7, amp: 0.09, len: 6.5, speed: 1.4 },
  { dx: 0.35, dz: -0.95, amp: 0.045, len: 2.3, speed: 0.9 },
  { dx: -0.2, dz: 1, amp: 0.02, len: 1.1, speed: 0.6 },
]
/** Upper bound of |height| — the sum of every wave's amplitude. */
export const OCEAN_MAX_HEIGHT = OCEAN_WAVES.reduce((s, w) => s + w.amp, 0)

const waveTerms = (w: OceanWave): { k: number; nx: number; nz: number; omega: number } => {
  const l = Math.hypot(w.dx, w.dz) || 1
  const k = (Math.PI * 2) / w.len
  return { k, nx: w.dx / l, nz: w.dz / l, omega: k * w.speed }
}

/** Sea height at (x, z) and time t — the same sum the vertex shader evaluates. (Pure.) */
export function oceanHeight(x: number, z: number, t: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(t)) return 0
  let h = 0
  for (const w of OCEAN_WAVES) {
    const { k, nx, nz, omega } = waveTerms(w)
    h += w.amp * Math.sin(k * (nx * x + nz * z) - omega * t)
  }
  return h
}

const glf = (v: number): string => {
  const s = String(Math.round(v * 1e6) / 1e6)
  return s.includes('.') || s.includes('e') ? s : `${s}.0`
}

/**
 * GLSL for the sea's height and slope, generated from {@link OCEAN_WAVES}
 * so shader and TypeScript can never drift apart. Defines
 * `float oceanH(vec2 p, float t, out vec2 slope)`. (Pure.)
 */
export function oceanGLSL(): string {
  const body = OCEAN_WAVES.map((w) => {
    const { k, nx, nz, omega } = waveTerms(w)
    return (
      `  ph = ${glf(k)} * dot(vec2(${glf(nx)}, ${glf(nz)}), p) - ${glf(omega)} * t;\n` +
      `  h += ${glf(w.amp)} * sin(ph);\n` +
      `  slope += ${glf(w.amp * k)} * cos(ph) * vec2(${glf(nx)}, ${glf(nz)});`
    )
  }).join('\n')
  return `float oceanH(vec2 p, float t, out vec2 slope) {\n  float h = 0.0;\n  float ph;\n  slope = vec2(0.0);\n${body}\n  return h;\n}`
}

// ------------------------------------------------------------------ bubbles / shafts / curtains

/** Vertical span bubbles rise through before wrapping to the floor. */
export const BUBBLE_SPAN = 24
/** Floor the bubbles rise from (world y). */
const BUBBLE_FLOOR = -9

/** Rising bubbles: position, size (sx), rise speed (spin) and wobble phase (r). (Pure.) */
export function bubbleLayout(seed: number, count = 160): Placement[] {
  return Array.from({ length: count }, (_, i) => {
    const z = -30 + hash01(seed, i, 81) * 34
    let x = (hash01(seed, i, 82) - 0.5) * 48
    // Keep the column in front of the words clear.
    if (z > -8 && Math.abs(x) < 7) x = x < 0 ? x - 7 : x + 7
    return { x, y: hash01(seed, i, 83) * BUBBLE_SPAN, z, sx: 0.06 + hash01(seed, i, 84) * 0.22, sy: 1, sz: 1, spin: 0.7 + hash01(seed, i, 85) * 1.6, r: hash01(seed, i, 86) }
  })
}

/** A bubble at time t: rises with its speed, wobbles, wraps back to the floor. (Pure.) */
export function bubbleAt(b: Placement, t: number): { x: number; y: number; z: number } {
  const tt = Number.isFinite(t) ? t : 0
  const rise = b.y + tt * b.spin
  const y = BUBBLE_FLOOR + (((rise % BUBBLE_SPAN) + BUBBLE_SPAN) % BUBBLE_SPAN)
  return { x: b.x + Math.sin(tt * 1.7 + b.r * 6.28) * 0.25, y, z: b.z }
}

/** Light shafts fanning down from a source: angle in `spin` (radians), width in `sx`, length in `sy`. (Pure.) */
export function shaftLayout(seed: number, count = 14): Placement[] {
  return Array.from({ length: count }, (_, i) => {
    const u = count <= 1 ? 0.5 : i / (count - 1)
    return {
      x: (u - 0.5) * 30 + (hash01(seed, i, 91) - 0.5) * 3,
      y: 0,
      z: -34 + hash01(seed, i, 92) * 16,
      sx: 1.2 + hash01(seed, i, 93) * 3.2,
      sy: 46 + hash01(seed, i, 94) * 24,
      sz: 1,
      spin: (u - 0.5) * 0.9 + (hash01(seed, i, 95) - 0.5) * 0.12,
      r: hash01(seed, i, 96),
    }
  })
}

/** Aurora curtains: depth, height, sway phase. (Pure.) */
export function curtainLayout(seed: number, count = 4): Placement[] {
  return Array.from({ length: count }, (_, i) => ({
    x: (hash01(seed, i, 71) - 0.5) * 20,
    y: 13 + hash01(seed, i, 72) * 5,
    z: -34 - i * 9,
    sx: 70 + hash01(seed, i, 73) * 30,
    sy: 16 + hash01(seed, i, 74) * 10,
    sz: 1,
    spin: 0.2 + hash01(seed, i, 75) * 0.25,
    r: hash01(seed, i, 76),
  }))
}

// ------------------------------------------------------------------ GLSL

const GLSL_HASH = `
vec2 yuraH2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}`

/**
 * Caustics as the edge network of drifting cells: light gathers where two
 * cells meet (F2 − F1 small), exactly where refracted rays converge on a
 * pool floor. Two octaves, one domain warp.
 */
export const CAUSTIC_GLSL = `${GLSL_HASH}
float yuraCells(vec2 p, float t) {
  vec2 g = floor(p);
  vec2 f = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 r = 0.5 + 0.45 * sin(t * 0.9 + 6.2831853 * yuraH2(g + o));
      float d = length(o + r - f);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  return d2 - d1;
}
float yuraCaustic(vec2 p, float t) {
  p += 0.55 * vec2(sin(p.y * 0.9 + t * 0.5), cos(p.x * 0.8 - t * 0.45));
  float a = exp(-yuraCells(p, t) * 14.0);
  float b = exp(-yuraCells(p * 1.9 + 3.1, t * 1.3) * 18.0);
  // Where both octaves' filaments cross, light pools into the bright knots real caustics have.
  return a * 0.7 + b * 0.45 + a * b * 1.6;
}`

const WORLD_VERT = `
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`

const OCEAN_VERT = `
uniform float uTime;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vCrest;
${oceanGLSL()}
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vec2 slope;
  float h = oceanH(w.xz, uTime, slope);
  w.y += h;
  vWorld = w.xyz;
  vNormal = normalize(vec3(-slope.x, 1.0, -slope.y));
  vCrest = h / ${glf(OCEAN_MAX_HEIGHT)};
  gl_Position = projectionMatrix * viewMatrix * w;
}`

const OCEAN_FRAG = `
uniform vec3 uDeep;
uniform vec3 uSky;
uniform vec3 uCrest;
uniform vec3 uGlint;
uniform float uPulse;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vCrest;
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(cameraPosition - vWorld);
  float fres = pow(1.0 - max(dot(n, v), 0.0), 4.0);
  vec3 col = mix(uDeep, uSky, clamp(fres * 0.95, 0.0, 1.0));
  vec3 l = normalize(vec3(0.0, 0.22, -1.0));
  vec3 hv = normalize(l + v);
  float spec = pow(max(dot(n, hv), 0.0), 220.0) * (1.6 + uPulse * 1.4);
  col += uGlint * spec;
  col += uCrest * smoothstep(0.35, 0.95, vCrest) * 0.3;
  float d = length(cameraPosition - vWorld);
  col = mix(col, uSky, smoothstep(20.0, 120.0, d));
  gl_FragColor = vec4(col, 1.0);
}`

const SKY_FRAG = `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uSun;
uniform float uPulse;
uniform float uAspect;
varying vec2 vUv;
void main() {
  float h = vUv.y;
  vec3 col = mix(uHorizon, uTop, smoothstep(0.38, 0.95, h));
  vec2 c = vUv - vec2(0.5, 0.4);
  c.x *= uAspect;
  float r = length(c);
  col += uSun * (smoothstep(0.035, 0.03, r) * 0.9 + exp(-r * 14.0) * (0.3 + uPulse * 0.2) + exp(-abs(c.y) * 60.0) * exp(-abs(c.x) * 1.5) * 0.12);
  gl_FragColor = vec4(col, 1.0);
}`

const CAUSTIC_FRAG = `
uniform float uTime;
uniform float uPulse;
uniform float uScale;
uniform vec3 uBase;
uniform vec3 uLight;
uniform vec3 uFog;
varying vec2 vUv;
varying vec3 vWorld;
${CAUSTIC_GLSL}
void main() {
  float c = yuraCaustic(vWorld.xz * uScale + vWorld.y * uScale * 0.6, uTime);
  vec3 col = uBase + uLight * c * (0.9 + uPulse * 0.6);
  float d = length(cameraPosition - vWorld);
  col = mix(col, uFog, smoothstep(14.0, 70.0, d));
  gl_FragColor = vec4(col, 1.0);
}`

/** Additive light shaft / aurora ray: soft edges, fading along its length, breathing. */
const SHAFT_FRAG = `
uniform float uTime;
uniform float uPulse;
uniform float uPhase;
uniform float uGain;
uniform vec3 uLight;
varying vec2 vUv;
void main() {
  float edge = 1.0 - abs(vUv.x * 2.0 - 1.0);
  edge *= edge;
  float along = pow(vUv.y, 1.6);
  float breathe = 0.55 + 0.45 * sin(uTime * 0.7 + uPhase * 6.2831853);
  float a = edge * along * breathe * uGain * (1.0 + uPulse * 0.5);
  gl_FragColor = vec4(uLight * a, a);
}`

const AURORA_VERT = `
uniform float uTime;
uniform float uPhase;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec3 p = position;
  p.z += sin(p.x * 0.09 + uTime * 0.25 + uPhase * 6.28) * 4.0 + sin(p.x * 0.23 - uTime * 0.4) * 1.4;
  p.x += sin(p.y * 0.2 + uTime * 0.3) * 0.8;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`

const AURORA_FRAG = `
uniform float uTime;
uniform float uPulse;
uniform float uPhase;
uniform vec3 uA;
uniform vec3 uB;
varying vec2 vUv;
void main() {
  float foot = smoothstep(0.0, 0.12, vUv.y) * pow(1.0 - vUv.y, 1.3);
  float rays = 0.55 + 0.45 * sin(vUv.x * 90.0 + sin(vUv.x * 11.0 + uTime * 0.6 + uPhase * 9.0) * 5.0);
  float band = 0.6 + 0.4 * sin(vUv.x * 7.0 - uTime * 0.25 + uPhase * 4.0);
  vec3 col = mix(uA, uB, clamp(vUv.y * 1.3 + 0.25 * sin(vUv.x * 5.0 + uTime * 0.2), 0.0, 1.0));
  float a = foot * rays * band * (1.1 + uPulse * 0.4);
  gl_FragColor = vec4(col * a, a);
}`

const BUBBLE_VERT = `
uniform float uTime;
uniform float uPx;
uniform float uMaxPoint;
attribute vec4 aBubble;
void main() {
  float rise = position.y + uTime * aBubble.y;
  vec3 p = vec3(position.x + sin(uTime * 1.7 + aBubble.z * 6.28) * 0.25,
                ${glf(BUBBLE_FLOOR)} + mod(rise, ${glf(BUBBLE_SPAN)}),
                position.z);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = clamp(aBubble.x * uPx / max(0.1, -mv.z), 1.0, uMaxPoint);
  gl_Position = projectionMatrix * mv;
}`

const BUBBLE_FRAG = `
uniform vec3 uLight;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = length(c);
  if (r > 1.0) discard;
  float rim = smoothstep(0.62, 0.95, r) * (1.0 - smoothstep(0.95, 1.0, r));
  float spot = smoothstep(0.35, 0.0, length(c - vec2(-0.35, -0.35)));
  float a = rim * 0.8 + spot * 0.9;
  gl_FragColor = vec4(uLight * a, a);
}`

/** Sky backdrop size behind the sea (world units). */
const SKY_W = 420
const SKY_H = 160

/** Point-size ceiling used when the GL context cannot be asked. */
const FALLBACK_MAX_POINT = 64
/** Projected bubble size gain (pixels per world unit at distance 1, before pixel ratio). */
const BUBBLE_PX = 900

// ------------------------------------------------------------------ build

/** What a light world needs from {@link createStageWorld}. */
export interface LightWorldContext {
  THREE: ThreeNamespace
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scene: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  renderer: any
  seed: number
  keep<D extends { dispose(): void }>(d: D): D
  /** Registers an sRGB colour sink for a scheme role. */
  tint(role: 'bg' | 'fg' | 'sub' | 'accent' | 'accent2' | 'dim', sink: { color: { set(v: string): void } }): void
  updaters: ((f: WorldFrame) => void)[]
  /** Hide the shared dust / echo (the `void` world wants pure black). */
  hideShared(): void
  /** Canvas factory for generated textures. */
  makeCanvas(): HTMLCanvasElement
}

/** Names of the worlds this module builds. */
export const LIGHT_WORLDS = ['ocean', 'caustics', 'aurora', 'rays', 'void'] as const
export type LightWorldName = (typeof LIGHT_WORLDS)[number]

/** Max point size the context allows (runtime query, safe fallback). */
function maxPointSize(renderer: { getContext?: () => WebGLRenderingContext }): number {
  try {
    const gl = renderer.getContext?.()
    const range = gl?.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array | number[] | undefined
    const max = range ? Number(range[1]) : NaN
    return Number.isFinite(max) && max >= 1 ? max : FALLBACK_MAX_POINT
  } catch {
    return FALLBACK_MAX_POINT
  }
}

/** Builds one of the light / water worlds into the context's scene. */
export function buildLightWorld(name: LightWorldName, c: LightWorldContext): void {
  const { THREE, scene, keep, tint, updaters, seed } = c
  // A uniform that takes scheme hex strings (sRGB, no colour management).
  const colour = (role: Parameters<LightWorldContext['tint']>[0]): { value: { set(x: number, y: number, z: number): unknown } } => {
    const u = { value: new THREE.Vector3(0, 0, 0) }
    tint(role, { color: { set: (v: string) => u.value.set(...hexToRgb(v)) } })
    return u
  }
  const time = { value: 0 }
  const pulse = { value: 0 }
  updaters.push((f) => {
    time.value = f.t
    pulse.value = f.pulse
  })
  const shader = (o: Record<string, unknown>) => keep(new THREE.ShaderMaterial(o))
  const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }

  switch (name) {
    case 'ocean': {
      const sky = new THREE.Mesh(
        keep(new THREE.PlaneGeometry(SKY_W, SKY_H)),
        shader({ uniforms: { uTop: colour('bg'), uHorizon: colour('dim'), uSun: colour('accent2'), uPulse: pulse, uAspect: { value: SKY_W / SKY_H } }, vertexShader: WORLD_VERT, fragmentShader: SKY_FRAG, depthWrite: false }),
      )
      sky.position.set(0, 18, -150)
      scene.add(sky)
      const geo = keep(new THREE.PlaneGeometry(320, 220, 220, 160))
      geo.rotateX(-Math.PI / 2)
      const sea = new THREE.Mesh(
        geo,
        shader({ uniforms: { uTime: time, uPulse: pulse, uDeep: colour('bg'), uSky: colour('dim'), uCrest: colour('sub'), uGlint: colour('accent2') }, vertexShader: OCEAN_VERT, fragmentShader: OCEAN_FRAG }),
      )
      sea.position.set(0, -4.5, -90)
      scene.add(sea)
      break
    }
    case 'caustics': {
      const uniforms = (scale: number) => ({ uTime: time, uPulse: pulse, uScale: { value: scale }, uBase: colour('bg'), uLight: colour('accent'), uFog: colour('bg') })
      const floor = new THREE.Mesh(keep(new THREE.PlaneGeometry(200, 200)), shader({ uniforms: uniforms(0.35), vertexShader: WORLD_VERT, fragmentShader: CAUSTIC_FRAG }))
      floor.rotation.x = -Math.PI / 2
      floor.position.set(0, -7, -40)
      scene.add(floor)
      const wall = new THREE.Mesh(keep(new THREE.PlaneGeometry(200, 60)), shader({ uniforms: uniforms(0.22), vertexShader: WORLD_VERT, fragmentShader: CAUSTIC_FRAG }))
      wall.position.set(0, 18, -60)
      scene.add(wall)
      addShafts(c, colour('accent2'), time, pulse, 0.18, additive, 22)
      // Bubbles: positions and per-bubble (size, speed, phase) live in attributes; the vertex shader rises them.
      const bubbles = bubbleLayout(seed)
      const pos = new Float32Array(bubbles.length * 3)
      const attr = new Float32Array(bubbles.length * 4)
      bubbles.forEach((b, i) => {
        pos.set([b.x, b.y, b.z], i * 3)
        attr.set([b.sx, b.spin, b.r, 0], i * 4)
      })
      const bgeo = keep(new THREE.BufferGeometry())
      bgeo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      bgeo.setAttribute('aBubble', new THREE.BufferAttribute(attr, 4))
      const px = { value: BUBBLE_PX }
      const bmat = shader({ uniforms: { uTime: time, uPx: px, uMaxPoint: { value: maxPointSize(c.renderer) }, uLight: colour('fg') }, vertexShader: BUBBLE_VERT, fragmentShader: BUBBLE_FRAG, ...additive })
      const points = new THREE.Points(bgeo, bmat)
      points.frustumCulled = false // the shader moves every point; the CPU bounds never know where
      scene.add(points)
      updaters.push(() => {
        const pr = typeof c.renderer.getPixelRatio === 'function' ? c.renderer.getPixelRatio() : 1
        px.value = BUBBLE_PX * pr
      })
      break
    }
    case 'aurora': {
      curtainLayout(seed).forEach((p, i) => {
        const geo = keep(new THREE.PlaneGeometry(p.sx, p.sy, 160, 1))
        const mat = shader({
          uniforms: { uTime: time, uPulse: pulse, uPhase: { value: p.r }, uA: colour(i % 2 ? 'accent2' : 'accent'), uB: colour(i % 2 ? 'accent' : 'accent2') },
          vertexShader: AURORA_VERT,
          fragmentShader: AURORA_FRAG,
          ...additive,
        })
        const m = new THREE.Mesh(geo, mat)
        m.position.set(p.x, p.y, p.z)
        m.rotation.x = -0.18
        m.rotation.y = (p.r - 0.5) * 0.5
        scene.add(m)
      })
      break
    }
    case 'rays': {
      // A glowing source above and behind the words, and shafts fanning down from it.
      const glowTex = radialTexture(c)
      if (glowTex) {
        const srcMat = keep(new THREE.SpriteMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }))
        tint('accent2', srcMat)
        const src = new THREE.Sprite(srcMat)
        src.position.set(0, 20, -44)
        src.scale.set(34, 34, 1)
        scene.add(src)
        updaters.push((f) => src.scale.setScalar(34 * (1 + f.pulse * 0.08)))
      }
      addShafts(c, colour('accent'), time, pulse, 0.4, additive, 20)
      break
    }
    case 'void':
      c.hideShared()
      break
  }
}

/** Fans light shafts down from above (shared by `caustics` and `rays`). */
function addShafts(
  c: LightWorldContext,
  light: { value: unknown },
  time: { value: number },
  pulse: { value: number },
  gain: number,
  additive: Record<string, unknown>,
  top: number,
): void {
  const { THREE, scene, keep } = c
  const plans = shaftLayout(c.seed)
  const meshes = plans.map((p) => {
    const geo = keep(new THREE.PlaneGeometry(1, 1))
    geo.translate(0, -0.5, 0) // pivot at the top, so a rotation fans the shaft from its source
    const mat = keep(new THREE.ShaderMaterial({ uniforms: { uTime: time, uPulse: pulse, uPhase: { value: p.r }, uGain: { value: gain }, uLight: light }, vertexShader: WORLD_VERT, fragmentShader: SHAFT_FRAG, ...additive }))
    const m = new THREE.Mesh(geo, mat)
    m.position.set(p.x * 0.3, top, p.z)
    m.scale.set(p.sx, p.sy, 1)
    m.rotation.z = p.spin
    scene.add(m)
    return { m, p }
  })
  c.updaters.push((f) => {
    for (const { m, p } of meshes) m.rotation.z = p.spin + Math.sin(f.t * 0.12 + p.r * 6.28) * 0.04
  })
}

/** A soft white radial glow drawn once into a canvas texture (null without a 2D context). */
function radialTexture(c: LightWorldContext): unknown {
  const canvas = c.makeCanvas()
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | null
  if (!ctx) return null
  canvas.width = canvas.height = 256
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.18, 'rgba(255,255,255,0.55)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 256, 256)
  return c.keep(new c.THREE.CanvasTexture(canvas))
}
