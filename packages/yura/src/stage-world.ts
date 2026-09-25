import { hash01 } from './motions'
import { segmentGraphemes } from './shapes'
import type { StageScheme, WorldName, StageFonts } from './stage-themes'
import type { CameraPose } from './stage-motion'

/**
 * The Three.js world behind a {@link lyricStage}: a lit 3D space the camera
 * moves through, recoloured by every scheme swap, pulsing on the beat — and
 * the lyrics themselves living in it (a huge dim echo of the current line in
 * depth, and in the `cosmos` world every glyph of the song as a star).
 *
 * Like the rest of Yura's Three support this module NEVER imports 'three':
 * the caller passes their own `THREE` namespace, so the library adds no
 * dependency and works with whatever version the page already ships. The
 * placement of every object is a pure seeded function (exported, tested);
 * only {@link createStageWorld} touches THREE.
 */

/** A THREE namespace (`import * as THREE from 'three'`), duck-typed. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ThreeNamespace = Record<string, any>

// ------------------------------------------------------------------ pure layouts

/** One placed object: position, per-axis scale, spin, and a 0..1 random. */
export interface Placement {
  x: number
  y: number
  z: number
  sx: number
  sy: number
  sz: number
  spin: number
  r: number
}

const rnd = (seed: number, i: number, salt: number): number => hash01(seed, i, salt)
const between = (a: number, b: number, u: number): number => a + (b - a) * u

/** Keeps a point out of the reading area around the lyric plane (|x| < clear near z≈0). */
function clearCentre(x: number, z: number, clear: number): number {
  if (z > -8 && Math.abs(x) < clear) return x < 0 ? x - clear : x + clear
  return x
}

/** Monoliths: tall slabs on both sides of the stage, receding into depth. (Pure.) */
export function monolithLayout(seed: number, count = 28): Placement[] {
  return Array.from({ length: count }, (_, i) => {
    const side = i % 2 === 0 ? -1 : 1
    const z = between(-46, -2, rnd(seed, i, 1))
    // Deeper slabs sit further out, so perspective never pulls them in behind the words.
    const x = side * (between(8, 20, rnd(seed, i, 2)) + Math.max(0, -z) * 0.28)
    const h = between(5, 20, rnd(seed, i, 3))
    return { x, y: h / 2 - 5, z, sx: between(0.6, 1.8, rnd(seed, i, 4)), sy: h, sz: between(0.6, 1.8, rnd(seed, i, 5)), spin: between(-0.4, 0.4, rnd(seed, i, 6)), r: rnd(seed, i, 7) }
  })
}

/** Shards: small polyhedra in a thick shell around the stage, clear of the text. (Pure.) */
export function shardLayout(seed: number, count = 64): Placement[] {
  return Array.from({ length: count }, (_, i) => {
    const a = rnd(seed, i, 11) * Math.PI * 2
    const r = between(8, 30, rnd(seed, i, 12))
    const z = between(-40, 4, rnd(seed, i, 13))
    const s = between(0.3, 1.6, rnd(seed, i, 14))
    return { x: clearCentre(Math.cos(a) * r, z, 9), y: Math.sin(a) * r * 0.6, z, sx: s, sy: s, sz: s, spin: between(-1, 1, rnd(seed, i, 15)), r: rnd(seed, i, 16) }
  })
}

/** Dust: a deep box of points (flat xyz array). (Pure.) */
export function dustLayout(seed: number, count = 700, spread = 60): Float32Array {
  const out = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    out[i * 3] = (rnd(seed, i, 21) - 0.5) * spread
    out[i * 3 + 1] = (rnd(seed, i, 22) - 0.5) * spread * 0.6
    out[i * 3 + 2] = between(-spread, spread * 0.2, rnd(seed, i, 23))
  }
  return out
}

/** Petals: falling flakes with their own drift phase and fall speed. (Pure.) */
export function petalLayout(seed: number, count = 420): Placement[] {
  return Array.from({ length: count }, (_, i) => ({
    x: (rnd(seed, i, 31) - 0.5) * 50,
    y: (rnd(seed, i, 32) - 0.5) * 30,
    z: between(-30, 6, rnd(seed, i, 33)),
    sx: between(0.18, 0.36, rnd(seed, i, 34)),
    sy: between(0.12, 0.24, rnd(seed, i, 35)),
    sz: 1,
    spin: between(0.4, 1.6, rnd(seed, i, 36)),
    r: rnd(seed, i, 37),
  }))
}

/** Petal fall height span (world units) before a flake wraps back to the top. */
export const PETAL_SPAN = 30
/** Petal position at time t: falls, sways, tumbles; wraps vertically. (Pure.) */
export function petalAt(p: Placement, t: number): { x: number; y: number; z: number; rx: number; ry: number; rz: number } {
  const fall = t * (0.8 + p.spin * 0.6)
  const y = ((((p.y + PETAL_SPAN / 2 - fall) % PETAL_SPAN) + PETAL_SPAN) % PETAL_SPAN) - PETAL_SPAN / 2
  return {
    x: p.x + Math.sin(t * 0.6 * p.spin + p.r * 6.28) * 1.4,
    y,
    z: p.z,
    rx: t * p.spin * 1.3 + p.r * 6,
    ry: t * p.spin * 0.9,
    rz: p.r * 3,
  }
}

/** Glyph stars for the cosmos world: every grapheme of the song, placed in deep space. (Pure.) */
export function glyphStarLayout(lines: readonly string[], seed: number, cap = 360): { char: string; line: number; p: Placement }[] {
  const out: { char: string; line: number; p: Placement }[] = []
  lines.forEach((text, line) => {
    for (const char of segmentGraphemes(text.replace(/\s/g, ''))) {
      if (out.length >= cap) return
      const i = out.length
      const z = between(-44, -6, rnd(seed, i, 41))
      const s = between(0.6, 2.2, rnd(seed, i, 42))
      out.push({
        char,
        line,
        p: { x: clearCentre((rnd(seed, i, 43) - 0.5) * 56, z, 6), y: (rnd(seed, i, 44) - 0.5) * 30, z, sx: s, sy: s, sz: s, spin: between(-0.3, 0.3, rnd(seed, i, 45)), r: rnd(seed, i, 46) },
      })
    }
  })
  return out
}

/** Tunnel ring spacing and count (world units). */
export const TUNNEL_SPACING = 3.2
export const TUNNEL_RINGS = 36
/** z of tunnel ring i after the tunnel has advanced `travel` units (wraps behind the camera). (Pure.) */
export function tunnelRingZ(i: number, travel: number): number {
  const len = TUNNEL_SPACING * TUNNEL_RINGS
  const z = -i * TUNNEL_SPACING + (Number.isFinite(travel) ? travel : 0)
  // Keep every ring in [-len + 14, 14): rings that pass the camera re-enter far away.
  return ((((z - 14) % len) - len) % len) + 14
}

// ------------------------------------------------------------------ world recipes (docs)

export const stageWorlds = {
  monolith: { ja: 'モノリス', desc: '黒い石柱が左右に林立し、奥へと続く。縁だけがアクセント色に光り、拍で明滅する。静かで重い空間。' },
  tunnel: { ja: 'トンネル', desc: '光る輪が連なるトンネルを、奥へ奥へと進み続ける。輪は拍で膨らみ、疾走感と没入感を生む。' },
  grid: { ja: 'グリッド', desc: '地平線まで続くネオンの床の格子が流れ、遠くに縞の入った太陽が沈む。レトロフューチャーの疾走。' },
  shards: { ja: '結晶', desc: '尖った多面体の破片が、画面の周りを回転しながら漂う。鋭く、冷たく、壊れやすい。' },
  orbit: { ja: '軌道', desc: '傾いた何重もの輪が、それぞれの速さで回り続ける。中心の網目の球と、周回する光の粒。' },
  petals: { ja: '花びら', desc: '無数の花びらが、揺れ、回りながら舞い落ち続ける。はかなく、やさしい。' },
  cosmos: { ja: '文字の宇宙', desc: '歌詞のすべての文字が星のように奥行きの中に散らばり、今歌われている行の文字だけが明るく灯る。' },
} satisfies Record<WorldName, { ja: string; desc: string }>

// ------------------------------------------------------------------ THREE glue

/** Per-frame input to a world. */
export interface WorldFrame {
  /** Timeline seconds. */
  t: number
  /** Seconds since the last frame (clamped by the caller). */
  dt: number
  /** 0..1 beat envelope. */
  pulse: number
  camera: CameraPose
}

/** A live world: drive it every frame, recolour it per cut, dispose it on stop. */
export interface StageWorld {
  readonly canvas: HTMLCanvasElement
  setScheme(s: StageScheme): void
  /** Tell the world which line is being sung (echo text, lit glyph stars). */
  setLine(index: number, text: string): void
  resize(width: number, height: number, pixelRatio: number): void
  frame(f: WorldFrame): void
  dispose(): void
}

export interface WorldOptions {
  name: WorldName
  seed: number
  lines: readonly string[]
  fonts: StageFonts
  /** Canvas factory for text textures (defaults to document.createElement('canvas')). */
  createCanvas?: () => HTMLCanvasElement
}

/** Resolution of the lyric echo texture (texels on the long side). */
const ECHO_TEXTURE = 2048
/** Resolution of one glyph-star texture. */
const GLYPH_TEXTURE = 128
/** Distance of the lyric echo plane behind the text. */
const ECHO_Z = -16
const ECHO_OPACITY = 0.07
/** Depth of the orbit rings: far enough back that no ring slices across the words. */
const ORBIT_Z = -18

type Role = 'bg' | 'fg' | 'sub' | 'accent' | 'accent2' | 'dim'

/**
 * Builds a world with the caller's THREE namespace, rendering into `canvas`.
 * Throws if WebGL is unavailable — {@link lyricStage} catches that and falls
 * back to a CSS backdrop.
 */
export function createStageWorld(THREE: ThreeNamespace, canvas: HTMLCanvasElement, opts: WorldOptions): StageWorld {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' })
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 200)
  scene.fog = new THREE.Fog(0x000000, 18, 70)
  const makeCanvas = opts.createCanvas ?? (() => document.createElement('canvas'))
  const seed = opts.seed

  // Materials by colour role — a scheme swap is one loop over this table.
  const roles: Record<Role, { color: { set(v: string): void } }[]> = { bg: [], fg: [], sub: [], accent: [], accent2: [], dim: [] }
  const tint = <M extends { color: { set(v: string): void } }>(role: Role, m: M): M => {
    roles[role].push(m)
    return m
  }
  const disposables: { dispose(): void }[] = []
  const keep = <D extends { dispose(): void }>(d: D): D => {
    disposables.push(d)
    return d
  }

  // Lights: a soft fill plus a key and an accent-coloured rim.
  // Fill and key stay white (a dark text colour must not darken the world); the rim follows the accent.
  scene.add(new THREE.AmbientLight(0xffffff, 0.9))
  const key = new THREE.DirectionalLight(0xffffff, 1.6)
  key.position.set(6, 10, 8)
  scene.add(key)
  const rim = tint('accent', new THREE.PointLight(0xffffff, 60, 80, 1.6))
  rim.position.set(-10, 4, -12)
  scene.add(rim)

  // Dust — depth cue shared by every world.
  const dustGeo = keep(new THREE.BufferGeometry())
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustLayout(seed), 3))
  const dustMat = keep(tint('sub', new THREE.PointsMaterial({ size: 0.07, sizeAttenuation: true, transparent: true, opacity: 0.7, depthWrite: false })))
  const dust = new THREE.Points(dustGeo, dustMat)
  scene.add(dust)

  // Lyric echo: the current line, huge and dim, deep behind the real text.
  const echoCanvas = makeCanvas()
  echoCanvas.width = ECHO_TEXTURE
  echoCanvas.height = ECHO_TEXTURE / 4
  const echoTex = keep(new THREE.CanvasTexture(echoCanvas))
  if (THREE.SRGBColorSpace) echoTex.colorSpace = THREE.SRGBColorSpace
  const echoMat = keep(tint('fg', new THREE.MeshBasicMaterial({ map: echoTex, transparent: true, opacity: ECHO_OPACITY, depthWrite: false })))
  const echoGeo = keep(new THREE.PlaneGeometry(64, 16))
  const echo = new THREE.Mesh(echoGeo, echoMat)
  echo.position.set(0, 0, ECHO_Z)
  scene.add(echo)
  const fontFamily = opts.fonts.lyric === 'serif' ? opts.fonts.serif : opts.fonts.display
  const drawEcho = (text: string): void => {
    const ctx = echoCanvas.getContext('2d') as CanvasRenderingContext2D | null
    if (!ctx) return
    const w = echoCanvas.width
    const h = echoCanvas.height
    ctx.clearRect(0, 0, w, h)
    const flat = text.replace(/\n/g, ' ')
    const n = Math.max(1, segmentGraphemes(flat).length)
    ctx.font = `${opts.fonts.weight} ${Math.min(h * 0.8, (w * 0.95) / n)}px ${fontFamily}`
    ctx.fillStyle = '#ffffff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(flat, w / 2, h / 2)
    echoTex.needsUpdate = true
  }

  // ---------------------------------------------------------------- world body
  const updaters: ((f: WorldFrame) => void)[] = []
  let lineIndex = -1

  switch (opts.name) {
    case 'monolith': {
      const box = keep(new THREE.BoxGeometry(1, 1, 1))
      const edges = keep(new THREE.EdgesGeometry(box))
      const solid = keep(tint('dim', new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.35 })))
      const edgeMat = keep(tint('accent', new THREE.LineBasicMaterial({ transparent: true, opacity: 0.7 })))
      const group = new THREE.Group()
      for (const p of monolithLayout(seed)) {
        const m = new THREE.Mesh(box, solid)
        m.position.set(p.x, p.y, p.z)
        m.scale.set(p.sx, p.sy, p.sz)
        m.rotation.y = p.spin
        const e = new THREE.LineSegments(edges, edgeMat)
        m.add(e)
        group.add(m)
      }
      scene.add(group)
      updaters.push((f) => {
        group.rotation.y = Math.sin(f.t * 0.05) * 0.08
        edgeMat.opacity = 0.35 + f.pulse * 0.55
      })
      break
    }
    case 'tunnel': {
      const rings: { position: { z: number }; scale: { setScalar(v: number): void } }[] = []
      const circle = keep(new THREE.TorusGeometry(7, 0.05, 6, 96))
      const square = keep(new THREE.TorusGeometry(7.5, 0.05, 6, 4))
      const matA = keep(tint('accent', new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9 })))
      const matB = keep(tint('accent2', new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.6 })))
      for (let i = 0; i < TUNNEL_RINGS; i++) {
        const sq = hash01(seed, i, 51) < 0.35
        const ring = new THREE.Mesh(sq ? square : circle, i % 3 === 0 ? matA : matB)
        if (sq) ring.rotation.z = Math.PI / 4
        ring.position.z = tunnelRingZ(i, 0)
        scene.add(ring)
        rings.push(ring)
      }
      let travel = 0
      updaters.push((f) => {
        travel += f.dt * 7
        rings.forEach((r, i) => {
          r.position.z = tunnelRingZ(i, travel)
          r.scale.setScalar(1 + f.pulse * 0.08 * (i % 2 ? 1 : -0.5))
        })
      })
      break
    }
    case 'grid': {
      const SIZE = 160
      const STEP = 4
      const pts: number[] = []
      for (let x = -SIZE / 2; x <= SIZE / 2; x += STEP) pts.push(x, 0, -SIZE, x, 0, 12)
      for (let z = -SIZE; z <= 12; z += STEP) pts.push(-SIZE / 2, 0, z, SIZE / 2, 0, z)
      const gridGeo = keep(new THREE.BufferGeometry())
      gridGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3))
      const gridMat = keep(tint('accent', new THREE.LineBasicMaterial({ transparent: true, opacity: 0.8 })))
      const floor = new THREE.LineSegments(gridGeo, gridMat)
      floor.position.y = -4.5
      scene.add(floor)
      // Striped sun drawn once into a texture; its tint follows the scheme.
      const sunCanvas = makeCanvas()
      sunCanvas.width = 512
      sunCanvas.height = 512
      const sctx = sunCanvas.getContext('2d') as CanvasRenderingContext2D | null
      if (sctx) {
        sctx.fillStyle = '#ffffff'
        sctx.beginPath()
        sctx.arc(256, 256, 250, 0, Math.PI * 2)
        sctx.fill()
        sctx.globalCompositeOperation = 'destination-out'
        for (let k = 0; k < 9; k++) sctx.fillRect(0, 290 + k * 26, 512, 4 + k * 2.2)
      }
      const sunTex = keep(new THREE.CanvasTexture(sunCanvas))
      const sunMat = keep(tint('accent2', new THREE.MeshBasicMaterial({ map: sunTex, transparent: true, fog: false, depthWrite: false })))
      const sunGeo = keep(new THREE.PlaneGeometry(40, 40))
      const sun = new THREE.Mesh(sunGeo, sunMat)
      sun.position.set(0, 22, -110) // above the text band, so the words never sit on it
      scene.add(sun)
      updaters.push((f) => {
        floor.position.z = (f.t * 9) % STEP
        gridMat.opacity = 0.5 + f.pulse * 0.45
      })
      break
    }
    case 'shards': {
      const geos = [keep(new THREE.IcosahedronGeometry(1, 0)), keep(new THREE.OctahedronGeometry(1, 0)), keep(new THREE.TetrahedronGeometry(1, 0))]
      const wire = keep(tint('accent', new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.8 })))
      const flat = keep(tint('fg', new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.3, metalness: 0.6 })))
      const alt = keep(tint('accent2', new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.4, metalness: 0.3 })))
      const meshes: { m: { rotation: { x: number; y: number } }; p: Placement }[] = []
      shardLayout(seed).forEach((p, i) => {
        const m = new THREE.Mesh(geos[i % 3], p.r < 0.4 ? wire : p.r < 0.8 ? flat : alt)
        m.position.set(p.x, p.y, p.z)
        m.scale.set(p.sx, p.sy, p.sz)
        scene.add(m)
        meshes.push({ m, p })
      })
      updaters.push((f) => {
        for (const { m, p } of meshes) {
          m.rotation.x = f.t * p.spin * 0.6 + p.r * 6
          m.rotation.y = f.t * p.spin * 0.4
        }
        wire.opacity = 0.45 + f.pulse * 0.5
      })
      break
    }
    case 'orbit': {
      const rings: { rotation: { x: number; y: number; z: number }; scale: { setScalar(v: number): void } }[] = []
      const matA = keep(tint('accent', new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85 })))
      const matB = keep(tint('sub', new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5 })))
      for (let i = 0; i < 6; i++) {
        const g = keep(new THREE.TorusGeometry(9 + i * 3, 0.035 + (i % 2) * 0.03, 6, 160))
        const ring = new THREE.Mesh(g, i % 2 ? matB : matA)
        ring.position.z = ORBIT_Z
        ring.rotation.x = Math.PI / 2 + (hash01(seed, i, 61) - 0.5) * 1.2
        ring.rotation.y = (hash01(seed, i, 62) - 0.5) * 1.2
        scene.add(ring)
        rings.push(ring)
      }
      const coreGeo = keep(new THREE.IcosahedronGeometry(4, 2))
      const coreMat = keep(tint('accent2', new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.35 })))
      const core = new THREE.Mesh(coreGeo, coreMat)
      core.position.z = ORBIT_Z
      scene.add(core)
      updaters.push((f) => {
        rings.forEach((r, i) => {
          r.rotation.z = f.t * (0.08 + i * 0.03) * (i % 2 ? -1 : 1)
          r.scale.setScalar(1 + f.pulse * 0.04)
        })
        core.rotation.y = f.t * 0.12
        core.rotation.x = f.t * 0.05
      })
      break
    }
    case 'petals': {
      const layout = petalLayout(seed)
      const geo = keep(new THREE.CircleGeometry(1, 10))
      const mat = keep(tint('accent', new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, opacity: 0.85 })))
      const inst = new THREE.InstancedMesh(geo, mat, layout.length)
      const dummy = new THREE.Object3D()
      scene.add(inst)
      updaters.push((f) => {
        layout.forEach((p, i) => {
          const s = petalAt(p, f.t)
          dummy.position.set(s.x, s.y, s.z)
          dummy.rotation.set(s.rx, s.ry, s.rz)
          dummy.scale.set(p.sx, p.sy, 1)
          dummy.updateMatrix()
          inst.setMatrixAt(i, dummy.matrix)
        })
        inst.instanceMatrix.needsUpdate = true
      })
      break
    }
    case 'cosmos': {
      const stars = glyphStarLayout(opts.lines, seed)
      const cache = new Map<string, unknown>()
      const glyphTex = (ch: string): unknown => {
        const hit = cache.get(ch)
        if (hit) return hit
        const c = makeCanvas()
        c.width = GLYPH_TEXTURE
        c.height = GLYPH_TEXTURE
        const ctx = c.getContext('2d') as CanvasRenderingContext2D | null
        if (ctx) {
          ctx.font = `${opts.fonts.weight} ${GLYPH_TEXTURE * 0.78}px ${fontFamily}`
          ctx.fillStyle = '#ffffff'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(ch, GLYPH_TEXTURE / 2, GLYPH_TEXTURE / 2)
        }
        const tex = keep(new THREE.CanvasTexture(c))
        cache.set(ch, tex)
        return tex
      }
      const sprites = stars.map(({ char, line, p }) => {
        const mat = keep(new THREE.SpriteMaterial({ map: glyphTex(char), transparent: true, opacity: 0.45, depthWrite: false }))
        const sp = new THREE.Sprite(mat)
        sp.position.set(p.x, p.y, p.z)
        sp.scale.set(p.sx, p.sy, 1)
        scene.add(sp)
        return { sp, mat, line, p }
      })
      updaters.push((f) => {
        for (const s of sprites) {
          const lit = s.line === lineIndex
          s.mat.opacity += ((lit ? 1 : 0.35) - s.mat.opacity) * Math.min(1, f.dt * 4)
          const k = (lit ? 1.6 : 1) * (1 + (lit ? f.pulse * 0.2 : 0))
          s.sp.scale.set(s.p.sx * k, s.p.sy * k, 1)
          s.sp.position.y = s.p.y + Math.sin(f.t * 0.3 + s.p.r * 6) * 0.4
        }
      })
      // Lit stars take the accent colour; the others stay in the sub tone.
      const litColour = { set: (v: string) => sprites.forEach((s) => s.line === lineIndex && s.mat.color.set(v)) }
      const dimColour = { set: (v: string) => sprites.forEach((s) => s.line !== lineIndex && s.mat.color.set(v)) }
      roles.accent.push({ color: litColour })
      roles.sub.push({ color: dimColour })
      break
    }
  }

  let scheme: StageScheme | null = null
  const applyScheme = (s: StageScheme): void => {
    scheme = s
    renderer.setClearColor(s.bg, 1)
    scene.fog.color.set(s.bg)
    for (const role of Object.keys(roles) as Role[]) for (const m of roles[role]) m.color.set(s[role])
  }

  return {
    canvas,
    setScheme: applyScheme,
    setLine(index, text) {
      if (index === lineIndex) return
      lineIndex = index
      drawEcho(text)
      if (scheme) applyScheme(scheme) // re-tint lit glyph stars for the new line
    },
    resize(width, height, pixelRatio) {
      if (!(width > 0 && height > 0)) return
      renderer.setPixelRatio(pixelRatio)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    },
    frame(f) {
      for (const u of updaters) u(f)
      dust.rotation.y = f.t * 0.01
      echo.position.x = -f.camera.x * 0.15
      echo.rotation.y = Math.sin(f.t * 0.1) * 0.05
      camera.position.set(f.camera.x, f.camera.y, f.camera.z)
      camera.up.set(Math.sin(f.camera.roll), Math.cos(f.camera.roll), 0)
      camera.lookAt(f.camera.tx, f.camera.ty, f.camera.tz)
      if (camera.fov !== f.camera.fov) {
        camera.fov = f.camera.fov
        camera.updateProjectionMatrix()
      }
      renderer.render(scene, camera)
    },
    dispose() {
      for (const d of disposables) d.dispose()
      renderer.dispose()
    },
  }
}
