import { hash01 } from './motions'
import type { CameraName, TransitionName } from './stage-themes'

/**
 * Pure motion math for {@link lyricStage}: 3D camera moves, cut transitions,
 * and screen effects (shake, flash, grain). Everything here is a function of
 * time and a seed — no DOM, no WebGL — so a frame is reproducible and every
 * curve is testable. Camera distances are in world units of the stage's
 * Three.js scene (the lyric plane sits at the origin); screen effects are in
 * em or % of the stage, never pixels.
 */

const TAU = Math.PI * 2
const clamp01 = (v: number): number => (Number.isNaN(v) ? 0 : Math.min(1, Math.max(0, v)))
const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
const outExpo = (t: number): number => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t))
const frac = (v: number): number => v - Math.floor(v)
const fin = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback)

/** Seconds per beat from a tempo, with a safe default for nonsense input. */
export const DEFAULT_STAGE_BPM = 120
export function beatSeconds(bpm: number | undefined): number {
  const b = bpm !== undefined && Number.isFinite(bpm) && bpm > 0 ? bpm : DEFAULT_STAGE_BPM
  return 60 / b
}

/** 0..1 position inside the current beat (0 = on the beat). */
export function beatPhase(t: number, bpm?: number): number {
  return Number.isFinite(t) ? frac(t / beatSeconds(bpm)) : 0
}

/** Beat pulse envelope: 1 on the beat, decaying fast. */
export function beatPulse(t: number, bpm?: number, sharpness = 6): number {
  return Math.exp(-beatPhase(t, bpm) * sharpness)
}

// ------------------------------------------------------------------ camera

/** Where the camera is and what it looks at, in world units / radians / degrees. */
export interface CameraPose {
  x: number
  y: number
  z: number
  tx: number
  ty: number
  tz: number
  /** Roll around the view axis, radians. */
  roll: number
  /** Vertical field of view, degrees. */
  fov: number
}

/** Resting camera distance from the lyric plane. */
export const CAMERA_DISTANCE = 12
/** Resting vertical field of view. */
export const CAMERA_FOV = 50
/** How far the accent "crash zoom" narrows the lens at the start of a line. */
const CRASH_ZOOM_FOV = 16
const CRASH_ZOOM_DECAY = 5

interface CameraRecipe {
  ja: string
  desc: string
  /** u = 0..1 through the line, t = seconds into it, beat = 0..1 phase, s = ±1 seeded side. */
  pose(u: number, t: number, beat: number, s: number, seed: number): Partial<CameraPose>
}

/** Smooth pseudo-noise from a few seeded sines (hand-held drift). */
function wobble(t: number, seed: number, salt: number): number {
  let v = 0
  for (let k = 1; k <= 3; k++) v += Math.sin(t * (0.9 * k + hash01(seed, k, salt) * 0.8) + hash01(seed, k, salt + 7) * TAU) / k
  return v / 1.83
}

const D = CAMERA_DISTANCE

export const cameraMoves = {
  'dolly-in': {
    ja: 'ドリーイン',
    desc: '行の頭から終わりまで、カメラがまっすぐ文字へ寄っていく。言葉に引き込まれる集中。',
    pose: (u) => ({ z: D * (1.3 - 0.4 * easeInOut(u)) }),
  },
  'pull-back': {
    ja: '引き',
    desc: '寄りから始めて、ゆっくり後ろへ下がる。言葉の周りの世界が見えてくる余韻。',
    pose: (u) => ({ z: D * (0.8 + 0.45 * easeInOut(u)) }),
  },
  orbit: {
    ja: '周回',
    desc: '文字を中心に、カメラが弧を描いて回り込む。立体の空間に言葉が浮かんでいると分かる。',
    pose: (u, _t, _b, s) => {
      const a = (u - 0.5) * 0.9 * s
      return { x: Math.sin(a) * D, z: Math.cos(a) * D }
    },
  },
  crane: {
    ja: 'クレーン',
    desc: '低い位置から上へ持ち上がり、見下ろす角度に変わる。場面が大きく開ける。',
    pose: (u) => ({ y: -4 + 8 * easeInOut(u), z: D * 1.05 }),
  },
  truck: {
    ja: '横移動',
    desc: '文字と平行に横へ滑る。奥の世界だけが視差で流れ、奥行きが際立つ。',
    pose: (u, _t, _b, s) => ({ x: s * (-4 + 8 * easeInOut(u)), tx: s * (-1 + 2 * easeInOut(u)) }),
  },
  dutch: {
    ja: 'ダッチアングル',
    desc: '画面が斜めに傾いていく。不安や高揚、日常が崩れる瞬間に。',
    pose: (u, _t, _b, s) => ({ roll: s * 0.2 * easeInOut(u), z: D * (1.1 - 0.15 * u) }),
  },
  handheld: {
    ja: '手持ち',
    desc: '人が構えたカメラのように細かく揺れ続ける。生々しさ、ライブ感。',
    pose: (_u, t, _b, _s, seed) => ({ x: wobble(t * 2.2, seed, 11) * 0.35, y: wobble(t * 2.6, seed, 23) * 0.25, roll: wobble(t * 1.7, seed, 37) * 0.025 }),
  },
  whip: {
    ja: 'ホイップパン',
    desc: '横から勢いよく振り込んで、ぴたりと止まる。切り替えに速度を与える。',
    pose: (u, _t, _b, s) => {
      const k = 1 - outExpo(clamp01(u * 4))
      return { x: s * 9 * k, tx: s * 3 * k, roll: -s * 0.12 * k }
    },
  },
  spiral: {
    ja: '渦ズーム',
    desc: '回りながら寄っていく。吸い込まれるような陶酔感。',
    pose: (u, _t, _b, s) => {
      const a = u * Math.PI * 0.7 * s
      const r = D * (1.25 - 0.4 * easeInOut(u))
      return { x: Math.sin(a) * r * 0.35, z: Math.cos(a * 0.3) * r, roll: a * 0.25 }
    },
  },
  float: {
    ja: '浮遊',
    desc: 'ほとんど動かず、水に浮かぶようにゆったり漂う。言葉を静かに読ませる。',
    pose: (_u, t, _b, _s, seed) => ({ x: Math.sin(t * 0.35 + seed) * 0.8, y: Math.sin(t * 0.27 + seed * 2) * 0.5, roll: Math.sin(t * 0.2) * 0.02 }),
  },
  'beat-zoom': {
    ja: '拍でズーム',
    desc: '拍ごとにレンズがぐっと寄って戻る。画面そのものがリズムを刻む。',
    pose: (_u, _t, beat) => ({ fov: CAMERA_FOV - 7 * Math.exp(-beat * 6) }),
  },
  underwater: {
    ja: '水中漂流',
    desc: '水の中を漂うように、ゆっくり大きく揺られ続ける。上下左右の揺れに、わずかな傾きが混ざる。',
    pose: (_u, t, _b, _s, seed) => ({ x: wobble(t * 0.45, seed, 41) * 1.1, y: wobble(t * 0.38, seed, 53) * 0.7, roll: wobble(t * 0.3, seed, 67) * 0.06, z: D * 1.05 }),
  },
  'surface-break': {
    ja: '水面突破',
    desc: '水面の下から持ち上がり、水面を割って文字の高さに出る。視界が開ける解放感。',
    pose: (u) => {
      const k = easeInOut(u)
      return { y: -5 * (1 - k), ty: -1.5 * (1 - k), roll: Math.sin(u * TAU) * 0.02 * (1 - k) }
    },
  },
  ascend: {
    ja: '光へ昇る',
    desc: 'カメラが上昇しながら視線を上へ向け、頭上の光を仰ぎ見る。祈り、救い、希望。',
    pose: (u) => {
      const k = easeInOut(u)
      return { y: 4.5 * k, ty: 3.5 * k, z: D * (1.1 - 0.1 * k) }
    },
  },
  tide: {
    ja: '潮',
    desc: '潮の満ち引きのように、左右へゆったり大きく揺れる。波間で見る景色。',
    pose: (_u, t, _b, s) => ({ x: s * Math.sin(t * 0.4) * 2.4, y: Math.sin(t * 0.31) * 0.6, roll: s * Math.sin(t * 0.4 + 0.6) * 0.03 }),
  },
  vertigo: {
    ja: 'めまい',
    desc: 'ドリーズーム。文字の大きさは変わらないまま、背景の奥行きだけがぐにゃりと伸び縮みする。動揺、覚醒、世界が変わる瞬間。',
    pose: (u) => {
      const z = D * (0.65 + 0.9 * easeInOut(u))
      // Keep the lyric plane's framing: tan(fov/2) · z stays what it is at rest.
      const fov = (2 * Math.atan((Math.tan(((CAMERA_FOV / 2) * Math.PI) / 180) * D) / z) * 180) / Math.PI
      return { z, fov }
    },
  },
} satisfies Record<CameraName, CameraRecipe>

/**
 * Camera pose for a move at `u` (0..1 through the line) and `t` seconds in.
 * Accent lines add a crash zoom that narrows the lens and decays. Reduced
 * motion freezes every move to the resting frame. (Pure.)
 */
export function cameraAt(
  move: CameraName,
  u: number,
  t: number,
  opts: { beat?: number; seed?: number; accent?: boolean; reducedMotion?: boolean } = {},
): CameraPose {
  const pose: CameraPose = { x: 0, y: 0, z: D, tx: 0, ty: 0, tz: 0, roll: 0, fov: CAMERA_FOV }
  if (opts.reducedMotion) return pose
  const seed = fin(opts.seed ?? 0)
  const s = hash01(seed, 0, 91) < 0.5 ? -1 : 1
  const recipe = (cameraMoves as Record<string, CameraRecipe>)[move] ?? cameraMoves.float
  const p = recipe.pose(clamp01(u), fin(t), clamp01(fin(opts.beat ?? 0)), s, seed)
  for (const k of Object.keys(p) as (keyof CameraPose)[]) pose[k] = fin(p[k] as number, pose[k])
  if (opts.accent) pose.fov -= CRASH_ZOOM_FOV * Math.exp(-Math.max(0, fin(t)) * CRASH_ZOOM_DECAY)
  return pose
}

// ------------------------------------------------------------------ transitions (つなぎ)

/**
 * One frame of a cut transition, as styles for a single full-stage overlay.
 * `background` may reference the stage's CSS colour variables.
 */
export interface TransitionFrame {
  opacity: number
  background: string
  clipPath: string
  transform: string
}

interface TransitionRecipe {
  ja: string
  desc: string
  /** p: 0..1 across the cut; 0.5 = the moment of the cut (fully covered). */
  frame(p: number, s: number): Partial<TransitionFrame>
}

/** Peak opacity for white flashes — kept under full white for comfort. */
export const FLASH_MAX = 0.85
const ACCENT = 'var(--yura-accent)'
const ACCENT2 = 'var(--yura-accent2)'
/** Vertices along the crest of a flood transition's wave. */
const WAVE_POINTS = 12
/** Columns of drips in a drip transition. */
const DRIP_COLUMNS = 14
/** Degrees per spoke of a godray transition (a spoke at full width covers it). */
const GODRAY_SPOKE = 12
/** Coverage 0 → 1 → 0 across the cut. */
const cover = (p: number): number => (p < 0.5 ? p * 2 : (1 - p) * 2)
const pct = (v: number): string => `${Math.round(v * 1000) / 10}%`

export const stageTransitions = {
  cut: {
    ja: 'カット',
    desc: 'つなぎを入れず、次の配色と行へそのまま切り替える。最も速い。',
    frame: () => ({ opacity: 0 }),
  },
  flash: {
    ja: 'フラッシュ',
    desc: '一瞬、画面が白く飛んで次の場面になる。サビ頭や決めの行に。',
    frame: (p) => ({ background: 'var(--yura-flash, #ffffff)', opacity: FLASH_MAX * cover(p) ** 1.5 }),
  },
  black: {
    ja: '黒コマ',
    desc: '一瞬の暗転を挟む。呼吸を置き、次の行を際立たせる。',
    frame: (p) => ({ background: '#000000', opacity: clamp01(cover(p) * 1.6) }),
  },
  wipe: {
    ja: 'ワイプ',
    desc: 'アクセント色の面が横切って、通り過ぎた後ろに次の場面が現れる。',
    frame: (p, s) => {
      const from = s > 0 ? 'left' : 'right'
      const a = p < 0.5 ? 1 - p * 2 : 0
      const b = p < 0.5 ? 0 : p * 2 - 1
      return { background: ACCENT, opacity: 1, clipPath: from === 'left' ? `inset(0 ${pct(a)} 0 ${pct(b)})` : `inset(0 ${pct(b)} 0 ${pct(a)})` }
    },
  },
  slash: {
    ja: '斜め帯',
    desc: '斜めに傾いた色の帯が画面を一閃する。スピードと鋭さ。',
    frame: (p) => {
      const x = -60 + p * 220 // band centre in %, sweeps well past both edges
      const w = 55
      return { background: ACCENT, opacity: 1, clipPath: `polygon(${x - w}% 0, ${x + w * 0.4}% 0, ${x}% 100%, ${x - w * 1.4}% 100%)` }
    },
  },
  iris: {
    ja: 'アイリス',
    desc: '画面の中心から円が広がって覆い、また縮んで次の場面を開く。',
    frame: (p) => ({ background: ACCENT, opacity: 1, clipPath: `circle(${pct(cover(p) * 0.75)} at 50% 50%)` }),
  },
  blinds: {
    ja: 'ブラインド',
    desc: '細い縦の帯が一斉に太って閉じ、また細くなって開く。',
    frame: (p) => {
      const f = cover(p) * 10
      return { background: `repeating-linear-gradient(90deg, ${ACCENT} 0 ${f}%, transparent ${f}% 10%)`, opacity: 1 }
    },
  },
  shutter: {
    ja: 'シャッター',
    desc: '上下から幕が閉じて、開くと次の場面。映画的な区切り。',
    frame: (p) => {
      const h = cover(p) * 50
      return {
        background: ACCENT,
        opacity: 1,
        clipPath: `polygon(0 0, 100% 0, 100% ${h}%, 0 ${h}%, 0 ${100 - h}%, 100% ${100 - h}%, 100% 100%, 0 100%)`,
      }
    },
  },
  push: {
    ja: 'プッシュ',
    desc: '色の面が横から押し込んできて、そのまま反対側へ抜けていく。',
    frame: (p, s) => ({ background: ACCENT, opacity: 1, transform: `translateX(${Math.round((1 - p * 2) * 1000) / 10 * s}%)` }),
  },
  ripple: {
    ja: '波紋',
    desc: '画面の中心から、アクセント色の波紋の輪が広がって覆い、また引いて次の場面を見せる。',
    frame: (p) => ({
      background: `repeating-radial-gradient(circle at 50% 50%, ${ACCENT} 0 2.4%, ${ACCENT2} 2.4% 4.8%)`,
      opacity: 1,
      clipPath: `circle(${pct(cover(p) * 0.75)} at 50% 50%)`,
    }),
  },
  flood: {
    ja: '満ちる水',
    desc: '下から波打つ水面がせり上がって画面を満たし、引いていくと次の場面が現れる。',
    frame: (p) => {
      const h = cover(p) * 112 // overshoot so the wave crests clear the top edge when full
      const pts: string[] = []
      for (let k = 0; k <= WAVE_POINTS; k++) {
        const x = (k / WAVE_POINTS) * 100
        const y = 100 - h + Math.sin(k * 1.3 + p * 14) * 3
        pts.push(`${pct(x / 100)} ${pct(Math.max(0, Math.min(100, y)) / 100)}`)
      }
      return { background: `linear-gradient(to top, ${ACCENT}, ${ACCENT2})`, opacity: 1, clipPath: `polygon(${pts.join(', ')}, 100% 100%, 0% 100%)` }
    },
  },
  'light-leak': {
    ja: '光漏れ',
    desc: 'フィルムに光が漏れたように、暖かい光のにじみが画面を横切る。フィルム映像のような余韻。',
    frame: (p) => ({
      background: `radial-gradient(ellipse 70% 90% at ${pct(0.1 + p * 0.8)} 35%, ${ACCENT2} 0%, ${ACCENT} 38%, transparent 72%)`,
      opacity: FLASH_MAX * cover(p) ** 1.2,
    }),
  },
  bloom: {
    ja: '白く滲む',
    desc: '画面の中心から白い光がにじみ広がり、すべてを包んでから引いていく。',
    frame: (p) => {
      const c = cover(p)
      return { background: `radial-gradient(circle at 50% 50%, var(--yura-flash, #ffffff) 0%, var(--yura-flash, #ffffff) ${pct(c * 0.55)}, transparent ${pct(0.05 + c)})`, opacity: FLASH_MAX * c }
    },
  },
  drip: {
    ja: '垂れ幕',
    desc: '上から色が垂れ落ちて、しずくの筋が画面を覆う。塗料や雨だれのような有機的なつなぎ。',
    frame: (p) => {
      const c = cover(p)
      const pts = ['0% 0%', '100% 0%']
      for (let k = DRIP_COLUMNS; k >= 0; k--) {
        const long = 0.5 + 0.5 * Math.sin(k * 12.9898 + 4.1414)
        pts.push(`${pct(k / DRIP_COLUMNS)} ${pct(Math.min(1, c * (1.05 + long * 0.45)))}`)
      }
      return { background: ACCENT, opacity: 1, clipPath: `polygon(${pts.join(', ')})` }
    },
  },
  rain: {
    ja: '雨幕',
    desc: '斜めに降る雨の筋が一気に強まって画面を覆い、やむと次の場面になる。',
    frame: (p) => {
      const c = cover(p)
      return {
        background: `repeating-linear-gradient(100deg, ${ACCENT} 0 ${pct(0.004 + c * 0.03)}, transparent ${pct(0.004 + c * 0.03)} 3.4%)`,
        opacity: clamp01(c * 1.4),
        transform: `translateY(${Math.round((p * 2 - 1) * 200) / 10}%) scale(1.5)`,
      }
    },
  },
  prism: {
    ja: '分光',
    desc: '虹色に分かれた光の帯が斜めに画面を横切る。プリズムを通したような色彩のつなぎ。',
    frame: (p) => ({
      background: 'linear-gradient(100deg, transparent 20%, #ff3b3b 30%, #ffb13b 37%, #fff23b 44%, #3bff7c 51%, #3be8ff 58%, #5b6bff 65%, #c43bff 72%, transparent 82%)',
      opacity: clamp01(cover(p) * 2.2),
      transform: `translateX(${Math.round((p * 2 - 1) * 900) / 10}%) scaleX(2)`,
    }),
  },
  godray: {
    ja: '光芒',
    desc: '画面の上から放射状の光の筋が広がって画面を満たし、また細くなって消える。',
    frame: (p) => {
      const w = cover(p) * GODRAY_SPOKE
      return {
        background: `repeating-conic-gradient(from ${Math.round(p * 300) / 10}deg at 50% -12%, ${ACCENT2} 0deg ${Math.round(w * 100) / 100}deg, transparent ${Math.round(w * 100) / 100}deg ${GODRAY_SPOKE}deg)`,
        opacity: 1,
      }
    },
  },
} satisfies Record<TransitionName, TransitionRecipe>

/** Seconds a cut transition spans (centred on the line boundary). */
export const TRANSITION_SECONDS = 0.5

/** Full overlay frame for a transition at p (0..1); off-range p yields an invisible frame. (Pure.) */
export function transitionAt(name: TransitionName, p: number, seed = 0): TransitionFrame {
  const out: TransitionFrame = { opacity: 0, background: 'transparent', clipPath: 'none', transform: 'none' }
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return out
  const recipe = (stageTransitions as Record<string, TransitionRecipe>)[name] ?? stageTransitions.cut
  const s = hash01(fin(seed), 1, 93) < 0.5 ? -1 : 1
  const f = recipe.frame(p, s)
  return {
    opacity: clamp01(fin(f.opacity ?? 0)),
    background: f.background ?? out.background,
    clipPath: f.clipPath ?? out.clipPath,
    transform: f.transform ?? out.transform,
  }
}

// ------------------------------------------------------------------ screen fx

/** Peak stage shake on accent lines, in em of the stage base size. */
const SHAKE_EM = 0.6
const SHAKE_DECAY = 7
const SHAKE_HZ = 30

/** Decaying screen shake `t` seconds after an accent hit. (Pure.) */
export function shakeAt(t: number, seed = 0): { x: number; y: number; rotate: number } {
  if (!Number.isFinite(t) || t < 0) return { x: 0, y: 0, rotate: 0 }
  const amp = SHAKE_EM * Math.exp(-t * SHAKE_DECAY)
  if (amp < 1e-3) return { x: 0, y: 0, rotate: 0 }
  const k = Math.floor(t * SHAKE_HZ)
  return {
    x: (hash01(fin(seed), k, 71) - 0.5) * 2 * amp,
    y: (hash01(fin(seed), k, 72) - 0.5) * 2 * amp,
    rotate: (hash01(fin(seed), k, 73) - 0.5) * amp * 2,
  }
}

/** White flash on an accent hit, decaying from FLASH_MAX. (Pure.) */
export function accentFlash(t: number): number {
  if (!Number.isFinite(t) || t < 0) return 0
  return FLASH_MAX * 0.7 * Math.exp(-t * 9)
}

/** Grain re-rolls this many times a second (film-like, not per display frame). */
const GRAIN_FPS = 24

/** Background offset (%) for the grain tile — jumps each grain frame so the noise lives. (Pure.) */
export function grainOffset(t: number): [number, number] {
  const k = Math.floor(fin(t) * GRAIN_FPS)
  return [Math.round(hash01(k, 1, 61) * 100), Math.round(hash01(k, 2, 62) * 100)]
}
