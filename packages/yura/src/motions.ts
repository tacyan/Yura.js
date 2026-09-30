import { sweepProgress } from './app'
import {
  hash01,
  clamp01,
  outCubic,
  outQuart,
  outExpo,
  inCubic,
  inQuad,
  outBack,
  outElastic,
  outBounce,
  TAU,
  frac,
  signedHash,
} from './motion-kit'
import { LIGHT_ENTER, LIGHT_HOLD, LIGHT_EXIT } from './motions-light'
import { WATER_ENTER, WATER_HOLD, WATER_EXIT } from './motions-water'
import { KINETIC_ENTER, KINETIC_HOLD, KINETIC_EXIT, KINETIC_LAYOUT } from './motions-kinetic'
import { COMPOSE_LAYOUT } from './motions-layouts'
import { HORROR_ENTER, HORROR_HOLD, HORROR_EXIT, TYPE_ENTER, TYPE_HOLD, TYPE_EXIT } from './motions-type'
import type { TreatmentName } from './treatments'

/**
 * The web-typography motion vocabulary behind {@link kineticLyrics}: the
 * text effects a hand-built landing page reaches for (mask reveals, split-
 * letter staggers, blur focus pulls, scramble decoders, neon flicker…),
 * each one named, described in words, and expressed as a pure function of
 * progress. Particles are one way to say a lyric; these are the DOM/CSS ways.
 *
 * Four families, one per phase of a line's life:
 *   - enter  (登場) — how a line arrives.        pose(p) with p 0 → 1 = arrived
 *   - hold   (保持) — how it lives while sung.   pose(t) with t = seconds held
 *   - exit   (退場) — how it leaves.             pose(p) with p 0 → 1 = gone
 *   - layout (配置) — where and how it sits on screen.
 *
 * Every magnitude is in em (or % of the glyph's own box), so a recipe reads
 * the same at any font size, resolution or device — nothing is in pixels.
 * Randomness is a seeded integer hash (never Math.random): the same seed
 * always yields the same frame, which is what makes a lyric video exportable.
 */

// ------------------------------------------------------------------ pose

/** Where one glyph is at one instant. Offsets compose additively, scales multiplicatively. */
export interface GlyphPose {
  /** Offset in em. */
  x: number
  y: number
  /** Offset in % of the glyph's own box (mask reveals use this). */
  tx: number
  ty: number
  /** Uniform scale, and per-axis scales on top of it. */
  scale: number
  sx: number
  sy: number
  /** Degrees: in-plane rotation, 3D flips around X / Y, horizontal skew. */
  rotate: number
  rx: number
  ry: number
  skew: number
  /** 0..1. */
  opacity: number
  /** Gaussian blur radius in em. */
  blur: number
  /** Glow radius in em (a text-shadow in the glyph's own color). */
  glow: number
  /** Chromatic split offset in em (two tinted ghosts either side). */
  split: number
  /** Clip insets in % of the glyph box: top, right, bottom, left. */
  clip: [number, number, number, number]
  /** Brightness multiplier (1 = as is; >1 blooms toward white — light effects). */
  bright: number
  /** Hue rotation in degrees (prism / aurora colour play). */
  hue: number
  /** Outline width in em (0 = none): line-drawn letters. */
  stroke: number
  /** Fill opacity 0..1 (1 = solid, 0 = hollow outline). */
  fill: number
  /** Temporary replacement character (scramble / decode effects). */
  char?: string
}

/** A fresh at-rest pose: no offset, full scale, fully visible, unclipped. */
export function identityPose(): GlyphPose {
  return {
    x: 0,
    y: 0,
    tx: 0,
    ty: 0,
    scale: 1,
    sx: 1,
    sy: 1,
    rotate: 0,
    rx: 0,
    ry: 0,
    skew: 0,
    opacity: 1,
    blur: 0,
    glow: 0,
    split: 0,
    clip: [0, 0, 0, 0],
    bright: 1,
    hue: 0,
    stroke: 0,
    fill: 1,
  }
}

/**
 * Layers a partial pose onto a base (in place, returns base): offsets and
 * angles add, scales and opacity multiply, clips keep the tighter inset, and
 * a replacement character from the layer wins. Brightness multiplies and hue adds. (Pure w.r.t. `layer`.)
 */
export function composePose(base: GlyphPose, layer: Partial<GlyphPose>): GlyphPose {
  if (layer.x !== undefined) base.x += layer.x
  if (layer.y !== undefined) base.y += layer.y
  if (layer.tx !== undefined) base.tx += layer.tx
  if (layer.ty !== undefined) base.ty += layer.ty
  if (layer.scale !== undefined) base.scale *= layer.scale
  if (layer.sx !== undefined) base.sx *= layer.sx
  if (layer.sy !== undefined) base.sy *= layer.sy
  if (layer.rotate !== undefined) base.rotate += layer.rotate
  if (layer.rx !== undefined) base.rx += layer.rx
  if (layer.ry !== undefined) base.ry += layer.ry
  if (layer.skew !== undefined) base.skew += layer.skew
  if (layer.opacity !== undefined) base.opacity *= layer.opacity
  if (layer.blur !== undefined) base.blur += layer.blur
  if (layer.glow !== undefined) base.glow += layer.glow
  if (layer.split !== undefined) base.split += layer.split
  if (layer.clip) {
    for (let k = 0; k < 4; k++) base.clip[k] = Math.max(base.clip[k], layer.clip[k])
  }
  if (layer.bright !== undefined) base.bright *= layer.bright
  if (layer.hue !== undefined) base.hue += layer.hue
  if (layer.stroke !== undefined) base.stroke += layer.stroke
  if (layer.fill !== undefined) base.fill *= layer.fill
  if (layer.char !== undefined) base.char = layer.char
  return base
}

// ------------------------------------------------------------------ glyph context

/** Which glyph moves first when a phase staggers across a line. */
export type GlyphOrder = 'ltr' | 'rtl' | 'center' | 'edges' | 'random' | 'all'

/** What a recipe knows about the glyph it is posing. */
export interface MotionGlyph {
  /** Index in reading order, and glyph count of the whole line. */
  i: number
  n: number
  /** The line's seed — per-line randomness stays stable frame to frame. */
  seed: number
  /** The glyph itself (a grapheme: emoji and combining marks stay whole). */
  char: string
  /** 0..1 position of this glyph in the recipe's order (0 = moves first). */
  rank: number
}

export { hash01 }

/** 0..1 rank of glyph `i` of `n` under an order (0 = first to move). (Pure.) */
export function glyphRank(order: GlyphOrder, i: number, n: number, seed = 0): number {
  if (n <= 1) return 0
  const l = i / (n - 1)
  switch (order) {
    case 'rtl':
      return 1 - l
    case 'center':
      return Math.abs(l * 2 - 1)
    case 'edges':
      return 1 - Math.abs(l * 2 - 1)
    case 'random':
      return hash01(seed, i, SALT_ORDER)
    case 'all':
      return 0
    default:
      return l
  }
}

/**
 * A glyph's own 0..1 progress inside a staggered phase: the line-level
 * progress `p` swept across glyph ranks with `stagger` spread — the same
 * sweep math the particle morph uses, so both typographies stagger alike.
 */
export function glyphProgress(p: number, rank: number, stagger: number): number {
  // A finished phase finishes every glyph: (1 + s) - 1·s can round to 0.9999999999999999,
  // which would leave the last glyph a hair short of rest.
  if (p >= 1) return 1
  if (p <= 0) return 0
  return sweepProgress(p, rank, stagger)
}

// ------------------------------------------------------------------ easing

// Hash salts: distinct streams per purpose so effects never correlate.
const SALT_ORDER = 1
const SALT_ANGLE = 2
const SALT_DIST = 3
const SALT_SPIN = 4
const SALT_CHAR = 5
const SALT_FLICKER = 6
const SALT_JITTER_X = 7
const SALT_JITTER_Y = 8
const SALT_GLITCH = 9

// ------------------------------------------------------------------ magnitudes (em / deg / %)

/** Short travel for soft arrivals (fade-up / fade-down). */
const SOFT_TRAVEL_EM = 0.6
/** Travel for slides — about a glyph and a half. */
const SLIDE_TRAVEL_EM = 1.6
/** Full mask travel: the glyph hides entirely inside its own box. */
const MASK_TRAVEL_PCT = 105
/** Peak blur for focus pulls. */
const FOCUS_BLUR_EM = 0.35
/** Starting scale for oversized zoom arrivals. */
const ZOOM_FROM_SCALE = 3
/** Drop height for bounce landings. */
const DROP_HEIGHT_EM = 2.2
/** Scatter radius for arrive-from-everywhere effects. */
const SCATTER_RADIUS_EM = 4
/** Per-glyph spacing gain for tracking (letter-spacing) effects. */
const TRACKING_GAIN_EM = 0.9
/** Glyphs cycled through by decode / scramble effects. */
export const SCRAMBLE_GLYPHS = '#%&*+=<>/\\|?!01アイウエオカキクケコサシスセソ'
const SCRAMBLE_POOL: readonly string[] = Array.from(SCRAMBLE_GLYPHS)
/** How many distinct scramble characters a glyph shows over one phase. */
const SCRAMBLE_STEPS = 14
/** Glitch: horizontal jitter and chromatic split peaks. */
const GLITCH_JITTER_EM = 0.5
const GLITCH_SPLIT_EM = 0.12
/** Neon: glow radius when lit. */
const NEON_GLOW_EM = 0.35

const isBlank = (c: string): boolean => c.trim() === ''

/** Picks a scramble glyph for a moment of the phase; blanks stay blank. */
function scrambleChar(g: MotionGlyph, step: number): string {
  if (isBlank(g.char)) return g.char
  const k = Math.floor(hash01(g.seed, g.i * 131 + step, SALT_CHAR) * SCRAMBLE_POOL.length)
  return SCRAMBLE_POOL[k]
}

/** Offset of glyph i from the line's middle, in glyph slots (tracking effects). */
const fromMiddle = (g: MotionGlyph): number => g.i - (g.n - 1) / 2

// ------------------------------------------------------------------ recipe types

interface Described {
  /** Japanese display name. */
  ja: string
  /** What the viewer sees — the effect put into words. */
  desc: string
}

/** An entrance or exit: a staggered pose over 0..1 progress. */
export interface TransitionRecipe extends Described {
  /** Which glyph moves first. Default 'ltr'. */
  order?: GlyphOrder
  /** 0..1 share of the phase spent staggering across glyphs. Default 0.5. */
  stagger?: number
  /** CSS transform-origin for the glyph (flips and hinges). */
  origin?: string
  /**
   * The glyph's pose at its own progress `p` (0..1, already staggered).
   * Enter: p = 1 must be at rest. Exit: p = 0 must be at rest.
   */
  pose(p: number, g: MotionGlyph): Partial<GlyphPose>
}

/** A hold: a looping pose over seconds since the line arrived. */
export interface HoldRecipe extends Described {
  origin?: string
  /** `t` = seconds since the line started; `beat` = seconds per beat. */
  pose(t: number, g: MotionGlyph, beat: number): Partial<GlyphPose>
}

/** Where a line sits: container CSS plus an optional per-glyph base offset. */
export interface LayoutRecipe extends Described {
  /** CSS properties for the line box (camelCase keys, string values). */
  box: Readonly<Record<string, string>>
  /** Multiplier on the run's base font size. Default 1. */
  fontScale?: number
  /** Static per-glyph offset in em (staircases, scatter), optionally turned and scaled (rings, spirals). */
  offset?(g: MotionGlyph): { x: number; y: number; rotate?: number; scale?: number }
  /** Style for the text block itself (a capsule, a card, a sign board…). */
  block?: Readonly<Record<string, string>>
  /** Decoration markup placed inside the text block (tails, perforations, rods, icons). */
  deco?: string
}

// ------------------------------------------------------------------ enter (登場)

const ENTER = {
  cut: {
    ja: 'カット',
    desc: '前触れなく一瞬で現れる。編集点そのものを見せる、いちばん強い登場。',
    order: 'all',
    stagger: 0,
    pose: (p) => ({ opacity: p > 0 ? 1 : 0 }),
  },
  fade: {
    ja: 'フェード',
    desc: '一文字ずつ静かに不透明になる。説明を足さない、いちばん素直な出方。',
    stagger: 0.6,
    pose: (p) => ({ opacity: outCubic(p) }),
  },
  'fade-up': {
    ja: 'ふわっと浮上',
    desc: '少し下から浮かびながら現れる。LPのファーストビューで定番の、軽くて品のある登場。',
    stagger: 0.55,
    pose: (p) => ({ y: (1 - outCubic(p)) * SOFT_TRAVEL_EM, opacity: outCubic(p) }),
  },
  'fade-down': {
    ja: 'ふわっと降下',
    desc: '少し上から降りてくる。見出しの上に置いたキャッチコピーに向く。',
    stagger: 0.55,
    pose: (p) => ({ y: -(1 - outCubic(p)) * SOFT_TRAVEL_EM, opacity: outCubic(p) }),
  },
  'slide-left': {
    ja: '左からスライド',
    desc: '左から滑り込んで止まる。読む方向と同じ流れで、視線を自然に運ぶ。',
    stagger: 0.4,
    pose: (p) => ({ x: -(1 - outExpo(p)) * SLIDE_TRAVEL_EM, opacity: clamp01(p * 3) }),
  },
  'slide-right': {
    ja: '右からスライド',
    desc: '右から逆行して入る。流れに逆らう分、ひっかかりが生まれる。',
    order: 'rtl',
    stagger: 0.4,
    pose: (p) => ({ x: (1 - outExpo(p)) * SLIDE_TRAVEL_EM, opacity: clamp01(p * 3) }),
  },
  rise: {
    ja: 'せり上がり',
    desc: '見えない枠の下から文字がせり上がる。マスクで切るので輪郭が鋭く、コーポレートサイトの見出しで最も多い手法。',
    stagger: 0.45,
    pose: (p) => {
      const ty = (1 - outQuart(p)) * MASK_TRAVEL_PCT
      return { ty, clip: [0, 0, ty, 0] }
    },
  },
  drop: {
    ja: '降りてくるマスク',
    desc: '枠の上から文字が降りてきて収まる。せり上がりの逆で、落ち着いた印象。',
    stagger: 0.45,
    pose: (p) => {
      const ty = (1 - outQuart(p)) * MASK_TRAVEL_PCT
      return { ty: -ty, clip: [ty, 0, 0, 0] }
    },
  },
  wipe: {
    ja: 'ワイプ',
    desc: '左から塗られるように姿を現す。ペンでなぞるような、線的な登場。',
    stagger: 0.7,
    pose: (p) => ({ clip: [0, (1 - outCubic(p)) * 100, 0, 0] }),
  },
  'wipe-down': {
    ja: '上からワイプ',
    desc: '上から下へ幕が下りるように見えてくる。縦書きとの相性がよい。',
    stagger: 0.6,
    pose: (p) => ({ clip: [0, 0, (1 - outCubic(p)) * 100, 0] }),
  },
  shutter: {
    ja: 'シャッター',
    desc: '文字の中央から上下に開いて現れる。カメラのシャッターのような機械的な切れ味。',
    stagger: 0.35,
    pose: (p) => {
      const c = (1 - outCubic(p)) * 50
      return { clip: [c, 0, c, 0] }
    },
  },
  'center-open': {
    ja: '観音開き',
    desc: '文字の中心から左右に開く。行の中央から順に開くので、扉が開いていくように見える。',
    order: 'center',
    stagger: 0.5,
    pose: (p) => {
      const c = (1 - outCubic(p)) * 50
      return { clip: [0, c, 0, c] }
    },
  },
  'blur-in': {
    ja: 'ぼかしから焦点',
    desc: 'ピントの外れた状態からじわりと焦点が合う。余韻のある歌い出しに。',
    stagger: 0.5,
    pose: (p) => ({ blur: (1 - outCubic(p)) * FOCUS_BLUR_EM, opacity: outCubic(p), scale: 1 + (1 - outCubic(p)) * 0.15 }),
  },
  'zoom-in': {
    ja: '巨大から等倍',
    desc: '画面を覆うほど大きな文字が縮んで定位置に収まる。サビ頭などの決め所向き。',
    order: 'all',
    stagger: 0,
    pose: (p) => ({ scale: 1 + (1 - outExpo(p)) * (ZOOM_FROM_SCALE - 1), opacity: clamp01(p * 2.5) }),
  },
  grow: {
    ja: '点から膨らむ',
    desc: '点のような大きさから膨らんで現れる。かわいらしく、軽い。',
    order: 'center',
    stagger: 0.5,
    pose: (p) => ({ scale: outCubic(p), opacity: clamp01(p * 4) }),
  },
  pop: {
    ja: 'ポップ',
    desc: '一瞬行き過ぎてから戻る弾む登場。ポップで明るいフレーズに。',
    stagger: 0.6,
    pose: (p) => ({ scale: Math.max(0, outBack(p)), opacity: clamp01(p * 4) }),
  },
  bounce: {
    ja: 'バウンド着地',
    desc: '上から落ちて床で何度か跳ねて止まる。重さと楽しさが同時に出る。',
    stagger: 0.55,
    pose: (p) => ({ y: -(1 - outBounce(p)) * DROP_HEIGHT_EM, opacity: clamp01(p * 5) }),
  },
  elastic: {
    ja: 'ゴム伸び',
    desc: '縦に伸びたり縮んだりしながら落ち着く。ゴムのような弾性で遊ぶ。',
    stagger: 0.5,
    origin: '50% 100%',
    pose: (p) => ({ sy: Math.max(0, outElastic(p)), sx: 1 + (1 - outElastic(p)) * 0.3, opacity: clamp01(p * 5) }),
  },
  'flip-x': {
    ja: '起き上がり',
    desc: '奥に倒れていた文字が縦回転で起き上がる。立体的で、札をめくるような手触り。',
    stagger: 0.55,
    origin: '50% 100%',
    pose: (p) => ({ rx: (1 - outBack(p)) * 90, opacity: clamp01(p * 3) }),
  },
  'flip-y': {
    ja: '横回転',
    desc: '文字がくるりと横に回って正面を向く。カードを裏返すような登場。',
    stagger: 0.55,
    pose: (p) => ({ ry: (1 - outCubic(p)) * -90, opacity: clamp01(p * 3) }),
  },
  domino: {
    ja: 'ドミノ',
    desc: '左端から順に、倒れていた文字が蝶番で立ち上がっていく。連鎖が見える。',
    stagger: 0.75,
    origin: '0% 100%',
    pose: (p) => ({ rotate: (1 - outBack(p)) * -90, opacity: clamp01(p * 4) }),
  },
  'rotate-in': {
    ja: '回転しながら',
    desc: '小さく回りながら大きくなって定位置へ。軽快でリズミカル。',
    stagger: 0.5,
    pose: (p) => ({ rotate: (1 - outCubic(p)) * -180, scale: outBack(p), opacity: clamp01(p * 3) }),
  },
  'skew-in': {
    ja: 'スキュー',
    desc: '斜めに歪んだまま滑り込み、止まる瞬間にまっすぐになる。スピード感が出る。',
    stagger: 0.35,
    pose: (p) => ({ x: -(1 - outExpo(p)) * SLIDE_TRAVEL_EM, skew: (1 - outCubic(p)) * -35, opacity: clamp01(p * 3) }),
  },
  'tracking-in': {
    ja: '字間収束',
    desc: '大きく開いた字間がぎゅっと詰まって一語になる。ブランドサイトのロゴ出しでよく見る。',
    order: 'all',
    stagger: 0,
    pose: (p, g) => ({
      x: fromMiddle(g) * (1 - outExpo(p)) * TRACKING_GAIN_EM,
      blur: (1 - outCubic(p)) * FOCUS_BLUR_EM * 0.5,
      opacity: outCubic(p),
    }),
  },
  typewriter: {
    ja: 'タイプライター',
    desc: '左から一文字ずつ打たれていく。中間の状態がなく、パッと置かれる。',
    stagger: 1,
    pose: (p) => ({ opacity: p >= 0.5 ? 1 : 0 }),
  },
  scramble: {
    ja: '解読',
    desc: '記号がめまぐるしく入れ替わったあと、正しい文字に確定する。暗号を解くようなデジタル感。',
    stagger: 0.7,
    pose: (p, g) =>
      p >= 1 ? {} : { char: scrambleChar(g, Math.floor(p * SCRAMBLE_STEPS)), opacity: p > 0 ? 1 : 0 },
  },
  'glitch-in': {
    ja: 'グリッチ出現',
    desc: '左右にぶれ、色がずれ、ちらつきながら実体化する。電波の乱れのような登場。',
    order: 'random',
    stagger: 0.5,
    pose: (p, g) => {
      if (p <= 0) return { opacity: 0 }
      if (p >= 1) return {}
      const k = 1 - p
      const step = Math.floor(p * 10)
      return {
        x: signedHash(g.seed, g.i * 17 + step, SALT_GLITCH) * GLITCH_JITTER_EM * k,
        split: GLITCH_SPLIT_EM * k,
        opacity: hash01(g.seed, g.i * 17 + step, SALT_FLICKER) < 0.25 + p * 0.75 ? 1 : 0,
      }
    },
  },
  neon: {
    ja: 'ネオン点灯',
    desc: '接触の悪いネオン管のように何度か瞬き、光のにじみが落ち着いて点灯する。夜の街の空気。',
    order: 'random',
    stagger: 0.4,
    pose: (p, g) => {
      if (p <= 0) return { opacity: 0 }
      if (p >= 1) return {}
      // The tube settles: glow fades out as the flicker resolves, so the hold
      // phase takes over without a pop.
      const lit = hash01(g.seed, g.i * 29 + Math.floor(p * 12), SALT_FLICKER) < p
      return { opacity: lit ? 1 : 0.12, glow: lit ? NEON_GLOW_EM * (1 - p) : 0 }
    },
  },
  stamp: {
    ja: 'スタンプ',
    desc: '大きな文字が勢いよく押し付けられ、わずかに傾いて止まる。判子を押したような強調。',
    order: 'all',
    stagger: 0,
    pose: (p, g) => ({
      scale: 1 + (1 - outQuart(p)) * 1.4,
      rotate: (1 - outQuart(p)) * signedHash(g.seed, 0, SALT_SPIN) * 30,
      opacity: clamp01(p * 6),
    }),
  },
  'wave-in': {
    ja: '波立ち',
    desc: '文字が波の山を越えるように順に持ち上がって着地する。やわらかい連なり。',
    stagger: 0.7,
    pose: (p) => ({ y: -Math.sin(p * Math.PI) * 0.5, opacity: clamp01(p * 2.5) }),
  },
  spiral: {
    ja: '螺旋集合',
    desc: '渦を巻く軌道から一文字ずつ吸い寄せられて並ぶ。幻想的で広がりがある。',
    stagger: 0.6,
    pose: (p, g) => {
      const k = 1 - outCubic(p)
      const a = hash01(g.seed, g.i, SALT_ANGLE) * TAU + k * Math.PI * 2
      const r = k * SCATTER_RADIUS_EM * 0.6
      return { x: Math.cos(a) * r, y: Math.sin(a) * r, rotate: k * 180, opacity: clamp01(p * 2) }
    },
  },
  gather: {
    ja: '四方から集結',
    desc: '画面の四方に散っていた文字が一斉に集まってくる。散り散りのものがまとまる瞬間。',
    order: 'random',
    stagger: 0.4,
    pose: (p, g) => {
      const k = 1 - outExpo(p)
      const a = hash01(g.seed, g.i, SALT_ANGLE) * TAU
      const r = (0.5 + hash01(g.seed, g.i, SALT_DIST) * 0.5) * SCATTER_RADIUS_EM * k
      return { x: Math.cos(a) * r, y: Math.sin(a) * r, rotate: signedHash(g.seed, g.i, SALT_SPIN) * 240 * k, opacity: clamp01(p * 3) }
    },
  },
  'random-fade': {
    ja: 'ランダム点灯',
    desc: '順番を持たずにばらばらに灯っていく。星が出るような、静かなきらめき。',
    order: 'random',
    stagger: 0.8,
    pose: (p) => ({ opacity: outCubic(p) }),
  },
} satisfies Record<string, TransitionRecipe>

// ------------------------------------------------------------------ hold (保持)

/** Seconds per cycle for the slow ambient holds. */
const FLOAT_PERIOD = 3.2
const BREATHE_PERIOD = 4
const WAVE_PERIOD = 1.6
const SWAY_PERIOD = 2.8
const SHIMMER_PERIOD = 2.2
/** Hz at which jitter / flicker / glitch re-roll. */
const JITTER_HZ = 18
const FLICKER_HZ = 10
const GLITCH_HZ = 8

const HOLD = {
  still: {
    ja: '静止',
    desc: '何もしない。動かないことで言葉そのものを読ませる。',
    pose: () => ({}),
  },
  float: {
    ja: 'ふわふわ',
    desc: '一文字ずつ少しずれた周期で上下に漂う。水に浮かぶような穏やかさ。',
    pose: (t, g) => ({ y: Math.sin((t / FLOAT_PERIOD) * TAU + g.i * 0.55) * 0.06 }),
  },
  breathe: {
    ja: '呼吸',
    desc: '行全体がゆっくり膨らんでは戻る。生きている気配だけを足す。',
    pose: (t) => ({ scale: 1 + Math.sin((t / BREATHE_PERIOD) * TAU) * 0.025 }),
  },
  wave: {
    ja: 'ウェーブ',
    desc: '文字の並びを波が端から端へ通り抜け続ける。歌のうねりを目で見せる。',
    pose: (t, g) => ({ y: Math.sin((t / WAVE_PERIOD) * TAU - g.i * 0.6) * 0.1 }),
  },
  sway: {
    ja: 'ゆらぎ',
    desc: '一文字ずつがわずかに左右へ首を振る。風に揺れる草のような柔らかさ。',
    origin: '50% 100%',
    pose: (t, g) => ({ rotate: Math.sin((t / SWAY_PERIOD) * TAU + g.i * 0.8) * 4 }),
  },
  jitter: {
    ja: 'ジッター',
    desc: '細かく小刻みに震え続ける。緊張や不安、手持ちカメラのような落ち着かなさ。',
    pose: (t, g) => {
      const s = Math.floor(t * JITTER_HZ)
      return { x: signedHash(g.seed, g.i * 97 + s, SALT_JITTER_X) * 0.05, y: signedHash(g.seed, g.i * 97 + s, SALT_JITTER_Y) * 0.05 }
    },
  },
  flicker: {
    ja: 'ちらつき',
    desc: 'ときどき一文字だけ暗くなる。切れかけの照明のような不穏さ。',
    pose: (t, g) => ({ opacity: hash01(g.seed, g.i * 53 + Math.floor(t * FLICKER_HZ), SALT_FLICKER) < 0.07 ? 0.3 : 1 }),
  },
  pulse: {
    ja: '鼓動',
    desc: '拍ごとにドンと膨らんで素早く戻る。曲のテンポに合わせて脈を打つ。',
    pose: (t, _g, beat) => ({ scale: 1 + Math.exp(-frac(t / beat) * 6) * 0.07 }),
  },
  hop: {
    ja: '拍で跳ねる',
    desc: '拍ごとに一文字おきで交互に小さく跳ねる。リズムを刻む手拍子のような動き。',
    pose: (t, g, beat) => ({ y: -Math.exp(-frac(t / beat + (g.i % 2) * 0.5) * 5) * 0.14 }),
  },
  shimmer: {
    ja: 'きらめき',
    desc: '光の帯が文字の上を左から右へ繰り返し通り過ぎる。高級感のある光沢。',
    pose: (t, g) => ({ glow: Math.max(0, 1 - Math.abs(frac(t / SHIMMER_PERIOD) * 1.4 - 0.2 - g.rank) * 6) * 0.3 }),
  },
  glitch: {
    ja: '時々ずれる',
    desc: '普段は静かだが、ときおり一瞬だけ横にずれて色が割れる。デジタルなノイズ感。',
    pose: (t, g) => {
      const s = Math.floor(t * GLITCH_HZ)
      if (hash01(g.seed, s, SALT_GLITCH) > 0.12) return {}
      return { x: signedHash(g.seed, s * 7 + (g.i >> 1), SALT_JITTER_X) * 0.25, split: GLITCH_SPLIT_EM }
    },
  },
  'push-in': {
    ja: 'じわ寄り',
    desc: '行全体がゆっくりと大きくなり続ける。カメラがじわじわ寄っていくような集中。',
    pose: (t) => ({ scale: 1 + (1 - Math.exp(-t / 4)) * 0.08 }),
  },
} satisfies Record<string, HoldRecipe>

// ------------------------------------------------------------------ exit (退場)

/** Builds an exit that plays an entrance backwards (same shape, reversed time and order). */
function reversed(enter: TransitionRecipe, words: Described, order?: GlyphOrder): TransitionRecipe {
  return { ...words, order: order ?? enter.order, stagger: enter.stagger, origin: enter.origin, pose: (p, g) => enter.pose(1 - p, g) }
}

const EXIT = {
  cut: {
    ja: 'カット',
    desc: '一瞬で消える。次の行へ間を空けずに切り替える。',
    order: 'all',
    stagger: 0,
    pose: (p) => ({ opacity: p >= 1 ? 0 : 1 }),
  },
  fade: reversed(ENTER.fade, { ja: 'フェード', desc: '静かに透明になって消える。余韻を残す基本の退場。' }),
  'fade-up': {
    ja: '上へ抜ける',
    desc: '少し浮き上がりながら消えていく。前向きな余韻。',
    stagger: 0.5,
    pose: (p) => ({ y: -inCubic(p) * SOFT_TRAVEL_EM, opacity: 1 - inQuad(p) }),
  },
  sink: {
    ja: '沈む',
    desc: '見えない枠の下へ沈み込んで消える。せり上がりと対になる、切れ味のある退場。',
    stagger: 0.45,
    pose: (p) => {
      const ty = inCubic(p) * MASK_TRAVEL_PCT
      return { ty, clip: [0, 0, ty, 0] }
    },
  },
  'rise-out': {
    ja: '上へ吸い込まれる',
    desc: '枠の上へ抜けて消える。次の行が下から来るときに流れがつながる。',
    stagger: 0.45,
    pose: (p) => {
      const ty = inCubic(p) * MASK_TRAVEL_PCT
      return { ty: -ty, clip: [ty, 0, 0, 0] }
    },
  },
  'wipe-out': {
    ja: 'ワイプ退場',
    desc: '左から順に拭き取られるように消える。',
    stagger: 0.7,
    pose: (p) => ({ clip: [0, 0, 0, inCubic(p) * 100] }),
  },
  shutter: reversed(ENTER.shutter, { ja: 'シャッター', desc: '上下から閉じて消える。場面転換をはっきり告げる。' }),
  'blur-out': {
    ja: 'ぼけて消える',
    desc: 'ピントが外れていきながら薄れる。記憶が遠のくような退場。',
    stagger: 0.5,
    pose: (p) => ({ blur: inCubic(p) * FOCUS_BLUR_EM, opacity: 1 - inQuad(p), scale: 1 + inCubic(p) * 0.1 }),
  },
  'zoom-through': {
    ja: '手前へ抜ける',
    desc: '文字が一気に大きくなって画面の手前へ突き抜ける。次の場面へ飛び込む勢い。',
    order: 'all',
    stagger: 0,
    pose: (p) => ({ scale: 1 + inCubic(p) * (ZOOM_FROM_SCALE - 1), opacity: 1 - inQuad(p) }),
  },
  shrink: {
    ja: '奥へ遠ざかる',
    desc: '点になるまで小さくなって消える。遠ざかっていく寂しさ。',
    order: 'edges',
    stagger: 0.5,
    pose: (p) => ({ scale: 1 - inCubic(p), opacity: 1 - inQuad(p) }),
  },
  'pop-out': reversed(ENTER.pop, { ja: 'ポップ退場', desc: '一度ふくらんでから弾けるように縮んで消える。' }),
  fall: {
    ja: '重力落下',
    desc: '支えを失った文字が回りながら順に落ちていく。崩れ落ちる脱力感。',
    order: 'random',
    stagger: 0.6,
    pose: (p, g) => ({ y: inQuad(p) * DROP_HEIGHT_EM * 2, rotate: signedHash(g.seed, g.i, SALT_SPIN) * 90 * p, opacity: 1 - inCubic(p) }),
  },
  scatter: {
    ja: '飛散',
    desc: '文字が四方八方へ弾け飛ぶ。感情の爆発や、サビ前の区切りに。',
    order: 'all',
    stagger: 0,
    pose: (p, g) => {
      const a = hash01(g.seed, g.i, SALT_ANGLE) * TAU
      const r = (0.5 + hash01(g.seed, g.i, SALT_DIST)) * SCATTER_RADIUS_EM * outCubic(p)
      return { x: Math.cos(a) * r, y: Math.sin(a) * r, rotate: signedHash(g.seed, g.i, SALT_SPIN) * 360 * p, opacity: 1 - inQuad(p) }
    },
  },
  dissolve: {
    ja: 'ほろほろ',
    desc: '順不同に一文字ずつ、少し沈みながら崩れて消える。こぼれ落ちるような儚さ。',
    order: 'random',
    stagger: 0.75,
    pose: (p) => ({ y: inQuad(p) * 0.3, opacity: 1 - outCubic(p), blur: p * 0.08 }),
  },
  evaporate: {
    ja: '霧散',
    desc: 'ぼけながら上へ立ち昇って消える。湯気や煙のように溶けていく。',
    order: 'random',
    stagger: 0.6,
    pose: (p, g) => ({ y: -outCubic(p) * 0.9, x: signedHash(g.seed, g.i, SALT_DIST) * 0.4 * p, blur: p * FOCUS_BLUR_EM, opacity: 1 - p }),
  },
  backspace: {
    ja: 'バックスペース',
    desc: '行末から一文字ずつ消されていく。書き直し、言い直しの気配。',
    order: 'rtl',
    stagger: 1,
    pose: (p) => ({ opacity: p >= 0.5 ? 0 : 1 }),
  },
  'scramble-out': {
    ja: '記号化',
    desc: '文字が意味を失って記号に崩れ、そのまま消える。解読の逆再生。',
    order: 'random',
    stagger: 0.6,
    pose: (p, g) => (p <= 0 ? {} : { char: scrambleChar(g, Math.floor(p * SCRAMBLE_STEPS)), opacity: p >= 1 ? 0 : 1 }),
  },
  'glitch-out': reversed(ENTER['glitch-in'], { ja: 'グリッチ退場', desc: 'ぶれと色ずれが強まり、ちらついて途切れる。' }),
  'spin-out': {
    ja: '回って消える',
    desc: 'くるくる回りながら小さくなって消える。軽やかな退場。',
    stagger: 0.5,
    pose: (p) => ({ rotate: inCubic(p) * 270, scale: 1 - inCubic(p), opacity: 1 - inQuad(p) }),
  },
  'fall-back': {
    ja: 'パタン倒れ',
    desc: '文字が奥へパタンと倒れて見えなくなる。札をめくるような区切り。',
    stagger: 0.55,
    origin: '50% 100%',
    pose: (p) => ({ rx: inCubic(p) * 90, opacity: 1 - inCubic(p) }),
  },
  'tracking-out': {
    ja: '字間が開く',
    desc: '字間がじわじわ広がりながら薄れていく。言葉がほどけていくような余韻。',
    order: 'all',
    stagger: 0,
    pose: (p, g) => ({ x: fromMiddle(g) * outCubic(p) * TRACKING_GAIN_EM * 0.6, opacity: 1 - p, blur: p * FOCUS_BLUR_EM * 0.4 }),
  },
  squash: {
    ja: '潰れる',
    desc: '上から押し潰されたように縦に縮んで消える。コミカルで重い。',
    origin: '50% 100%',
    stagger: 0.4,
    pose: (p) => ({ sy: 1 - inCubic(p), sx: 1 + inCubic(p) * 0.4 }),
  },
} satisfies Record<string, TransitionRecipe>

// ------------------------------------------------------------------ layout (配置)

const LAYOUT = {
  center: {
    ja: '中央',
    desc: '画面の真ん中に一行を置く。いちばん強く、いちばん読みやすい。',
    box: { justifyContent: 'center', alignItems: 'center', textAlign: 'center' },
  },
  lower: {
    ja: '下部テロップ',
    desc: '画面の下寄りに小さめに置く。映像を主役にして歌詞は添える、字幕型の配置。',
    box: { justifyContent: 'center', alignItems: 'flex-end', textAlign: 'center', paddingBottom: '9%' },
    fontScale: 0.55,
  },
  left: {
    ja: '左寄せ',
    desc: '左の余白に揃えて置く。雑誌の見出しのような、編集された印象。',
    box: { justifyContent: 'flex-start', alignItems: 'center', textAlign: 'left', paddingLeft: '8%' },
  },
  right: {
    ja: '右寄せ',
    desc: '右側に寄せて置く。左に余白を残し、視線を画面全体へ泳がせる。',
    box: { justifyContent: 'flex-end', alignItems: 'center', textAlign: 'right', paddingRight: '8%' },
  },
  vertical: {
    ja: '縦書き',
    desc: '縦に組む。和の情緒、手紙や詩のような語りかけに。',
    box: { justifyContent: 'center', alignItems: 'center', writingMode: 'vertical-rl', textAlign: 'start' },
  },
  diagonal: {
    ja: '斜め組',
    desc: '行全体をわずかに傾けて置く。勢いと不安定さが同時に出る。',
    box: { justifyContent: 'center', alignItems: 'center', textAlign: 'center', transform: 'rotate(-8deg)' },
  },
  stair: {
    ja: '階段',
    desc: '一文字ごとに少しずつ下がっていく。言葉が段を降りていくようなリズム。',
    box: { justifyContent: 'center', alignItems: 'center', textAlign: 'center' },
    offset: (g) => ({ x: 0, y: fromMiddle(g) * 0.16 }),
  },
  giant: {
    ja: '見切れ大文字',
    desc: '画面からはみ出すほど大きく組む。全部は読ませず、形として迫らせる。',
    box: { justifyContent: 'center', alignItems: 'center', textAlign: 'center', letterSpacing: '-0.04em', whiteSpace: 'nowrap' },
    fontScale: 2.6,
  },
  scatter: {
    ja: '散らし組',
    desc: '文字が少しずつ上下左右にずれて置かれる。手書きの貼り紙のような揺らぎ。',
    box: { justifyContent: 'center', alignItems: 'center', textAlign: 'center' },
    offset: (g) => ({ x: signedHash(g.seed, g.i, SALT_JITTER_X) * 0.3, y: signedHash(g.seed, g.i, SALT_JITTER_Y) * 0.7 }),
  },
} satisfies Record<string, LayoutRecipe>

// ------------------------------------------------------------------ registries

// The core vocabulary above, then the packs: 光 light, 水 water, キネティック kinetic.
const ENTER_ALL = { ...ENTER, ...LIGHT_ENTER, ...WATER_ENTER, ...KINETIC_ENTER, ...HORROR_ENTER, ...TYPE_ENTER }
const HOLD_ALL = { ...HOLD, ...LIGHT_HOLD, ...WATER_HOLD, ...KINETIC_HOLD, ...HORROR_HOLD, ...TYPE_HOLD }
const EXIT_ALL = { ...EXIT, ...LIGHT_EXIT, ...WATER_EXIT, ...KINETIC_EXIT, ...HORROR_EXIT, ...TYPE_EXIT }
const LAYOUT_ALL = { ...LAYOUT, ...KINETIC_LAYOUT, ...COMPOSE_LAYOUT }

export type EnterName = keyof typeof ENTER_ALL
export type HoldName = keyof typeof HOLD_ALL
export type ExitName = keyof typeof EXIT_ALL
export type LayoutName = keyof typeof LAYOUT_ALL

/** The whole vocabulary, by phase. Read-only by convention. */
export const motions: {
  readonly enter: Readonly<Record<EnterName, TransitionRecipe>>
  readonly hold: Readonly<Record<HoldName, HoldRecipe>>
  readonly exit: Readonly<Record<ExitName, TransitionRecipe>>
  readonly layout: Readonly<Record<LayoutName, LayoutRecipe>>
} = { enter: ENTER_ALL, hold: HOLD_ALL, exit: EXIT_ALL, layout: LAYOUT_ALL }

/** A phase of the vocabulary. */
export type MotionPhase = keyof typeof motions

/** One catalog row: a recipe put into words. */
export interface MotionEntry {
  phase: MotionPhase
  name: string
  ja: string
  desc: string
}

/** Every recipe in the vocabulary as a flat, documented list (for pickers and docs). */
export function kineticCatalog(): MotionEntry[] {
  const out: MotionEntry[] = []
  for (const phase of Object.keys(motions) as MotionPhase[]) {
    for (const [name, r] of Object.entries(motions[phase] as Record<string, Described>)) {
      out.push({ phase, name, ja: r.ja, desc: r.desc })
    }
  }
  return out
}

// ------------------------------------------------------------------ moods (雰囲気)

/** A mood: which recipes a planner draws from for each phase. */
export interface KineticMood extends Described {
  enter: readonly EnterName[]
  hold: readonly HoldName[]
  exit: readonly ExitName[]
  layout: readonly LayoutName[]
  /** Text treatments lines of this mood draw from (none when omitted). */
  treat?: readonly TreatmentName[]
}

/**
 * Curated palettes of motion — the "tone" of a lyric video put into words.
 * A planner draws each line's enter / hold / exit / layout from one mood.
 */
export const kineticMoods = {
  calm: {
    ja: 'しっとり',
    desc: '焦点が合い、浮かび、ほどけて消える。バラードや語りの行に。',
    enter: ['fade-up', 'blur-in', 'rise', 'random-fade', 'tracking-in'],
    hold: ['float', 'breathe', 'still'],
    exit: ['fade-up', 'blur-out', 'dissolve', 'evaporate'],
    layout: ['center', 'vertical', 'lower'],
  },
  pop: {
    ja: 'ポップ',
    desc: '弾み、跳ね、押し付ける。明るいアップテンポの曲に。',
    enter: ['pop', 'bounce', 'stamp', 'elastic', 'grow', 'rotate-in'],
    hold: ['hop', 'pulse', 'sway'],
    exit: ['pop-out', 'fall', 'scatter', 'squash', 'spin-out'],
    layout: ['center', 'stair', 'scatter', 'diagonal'],
  },
  glitch: {
    ja: 'グリッチ',
    desc: 'ぶれ、割れ、化ける。エレクトロやロックの鋭い行に。',
    enter: ['glitch-in', 'scramble', 'neon', 'typewriter', 'cut'],
    hold: ['glitch', 'jitter', 'flicker'],
    exit: ['glitch-out', 'scramble-out', 'cut', 'backspace'],
    layout: ['center', 'giant', 'diagonal', 'left'],
  },
  graphic: {
    ja: 'グラフィック',
    desc: 'マスクで切り、枠で見せる。コーポレートサイトのような端正さ。',
    enter: ['rise', 'drop', 'wipe', 'shutter', 'center-open', 'skew-in', 'slide-left'],
    hold: ['still', 'push-in', 'shimmer'],
    exit: ['sink', 'rise-out', 'wipe-out', 'shutter', 'shrink'],
    layout: ['left', 'right', 'giant', 'center'],
  },
  editorial: {
    ja: 'エディトリアル',
    desc: '打ち、組み、消す。雑誌や文芸のような静かな知性。',
    enter: ['typewriter', 'fade', 'tracking-in', 'wipe', 'rise'],
    hold: ['still', 'breathe'],
    exit: ['backspace', 'fade', 'tracking-out', 'blur-out'],
    layout: ['left', 'lower', 'vertical', 'center'],
  },
  emotional: {
    ja: 'エモーショナル',
    desc: '渦を巻き、揺れ、立ち昇る。感情が溢れる行に。',
    enter: ['blur-in', 'spiral', 'wave-in', 'tracking-in', 'gather'],
    hold: ['wave', 'float', 'shimmer', 'sway'],
    exit: ['evaporate', 'dissolve', 'tracking-out', 'zoom-through'],
    layout: ['center', 'vertical', 'scatter'],
  },
  luminous: {
    ja: '光',
    desc: '灯り、あふれ、まぶしく溶ける。光そのものを主役にする行に。',
    enter: ['flare-in', 'light-sweep', 'ignite', 'halo-in', 'bloom-in', 'constellation', 'spark-in', 'godray-in', 'sunrise'],
    hold: ['glow-breathe', 'sparkle', 'lighthouse', 'radiance', 'twinkle', 'flare'],
    exit: ['flare-out', 'white-out', 'supernova', 'twinkle-out', 'ember', 'godray-out', 'eclipse'],
    layout: ['center', 'giant', 'spread', 'vertical', 'arc'],
  },
  aqua: {
    ja: '水',
    desc: '浮かび、揺らぎ、滴り、流れ去る。水辺や雨、涙の歌に。',
    enter: ['ripple-in', 'surface', 'droplet', 'splash', 'liquid', 'bubble-up', 'refract', 'tide-in', 'rain-in', 'upwell', 'pour'],
    hold: ['ripple', 'underwater', 'buoy', 'caustic', 'current', 'drip', 'refraction', 'glint'],
    exit: ['melt', 'sink-deep', 'splash-out', 'mist', 'ripple-out', 'drain', 'wash-away', 'drip-out', 'dissolve-water', 'surface-out'],
    layout: ['center', 'wave-row', 'bowl', 'lower', 'vertical'],
  },
  spectrum: {
    ja: '分光',
    desc: '色が分かれ、巡り、また一つに戻る。虹やプリズムのようにカラフルな行に。',
    enter: ['prism-in', 'aurora-in', 'photon', 'laser-scan', 'lens-focus', 'frost-in'],
    hold: ['prism', 'rainbow', 'aurora', 'caustic'],
    exit: ['prism-out', 'light-speed', 'photon-out', 'dissolve-water'],
    layout: ['wave-row', 'arc', 'center', 'spread'],
  },
  kinetic: {
    ja: 'キネティック',
    desc: '叩きつけ、振り抜き、弾き飛ばす。モーショングラフィックスの重さと勢い。',
    enter: ['slam', 'whip-in', 'flip-3d', 'roll-in', 'zipper', 'split-in', 'magnet', 'solari', 'thud', 'stretch-in', 'bounce-in'],
    hold: ['bob', 'stretch', 'kick', 'quake', 'ticktock', 'spring'],
    exit: ['slam-out', 'whip-out', 'split-out', 'shatter', 'stretch-out', 'roll-out', 'drop-out', 'jump-out'],
    layout: ['headline', 'zigzag', 'condensed', 'giant', 'ascend'],
  },
  cinematic: {
    ja: 'シネマ',
    desc: '絞りが開き、焦点が合い、光に溶ける。映画のタイトルバックのような品格。',
    enter: ['iris-in', 'depth-in', 'flare-in', 'blur-in', 'tracking-in', 'light-sweep', 'lens-focus'],
    hold: ['push-in', 'breathe', 'lighthouse', 'glide'],
    exit: ['depth-out', 'white-out', 'iris-out', 'blur-out', 'tracking-out', 'fade-to-dark'],
    layout: ['lower', 'center', 'spread', 'floor', 'corner'],
  },
  dream: {
    ja: '夢幻',
    desc: '泡や星や蛍のように、漂い、瞬き、ほどけていく。夢の中の歌に。',
    enter: ['bubble-up', 'aurora-in', 'constellation', 'firefly', 'mirage', 'condense'],
    hold: ['underwater', 'aurora', 'twinkle', 'levitate', 'buoy'],
    exit: ['bubble-out', 'twinkle-out', 'mist', 'evaporate', 'ember'],
    layout: ['arc', 'wave-row', 'vertical', 'center', 'bowl'],
  },
  eerie: {
    ja: '不穏',
    desc: '明かりが揺れ、文字が震え、闇へ沈む。ホラーや緊張感のある行に。',
    enter: ['ignite', 'condense', 'typewriter', 'glitch-in', 'ink-bloom', 'strobe-in'],
    hold: ['candle', 'flicker', 'tremble', 'drip', 'neon-hum'],
    exit: ['fade-to-dark', 'melt', 'sink-deep', 'burn-out', 'drip-out'],
    layout: ['scatter', 'vertical-right', 'corner', 'tilt-right', 'diagonal'],
  },
  mapping: {
    ja: '投影',
    desc: 'プロジェクションマッピング向け。黒を「光のない面」として使い、光量と輪郭のはっきりした動きで建物や壁に強く映る。',
    enter: ['flashbulb', 'light-sweep', 'beam-in', 'slam', 'laser-scan', 'iris-in', 'godray-in', 'constellation'],
    hold: ['halo', 'strobe', 'glow-breathe', 'lighthouse', 'radiance', 'still'],
    exit: ['white-out', 'beam-out', 'eclipse', 'slam-out', 'godray-out', 'implode'],
    layout: ['giant', 'center', 'split', 'headline', 'wall', 'floor'],
  },
  horror: {
    ja: 'ホラー',
    desc: '瞬きの間に近づき、一字だけ残り、闇に呑まれる。怖さを間と光でつくる行に。',
    enter: ['blink-creep', 'jump-scare', 'uneasy', 'v-hold', 'mirror-snap', 'manifest', 'claw-reveal'],
    hold: ['twitch', 'stare', 'lag-one', 'dying-light', 'flicker'],
    exit: ['pulled-down', 'look-back', 'turn-away', 'shiver', 'swallow', 'flicker-die', 'bleed'],
    layout: ['scatter', 'vertical-right', 'corner', 'tilt-right', 'center'],
    treat: ['eroded', 'ink-bleed', 'redact', 'double-exposure', 'none'],
  },
  wa: {
    ja: '和風',
    desc: '墨が滲み、ルビが降り、縦に組まれる。明朝と余白で見せる日本語の行に。',
    enter: ['ink-bloom', 'rise', 'wipe-down', 'fade-up', 'ruby-drop', 'stroke-draw', 'upwell'],
    hold: ['float', 'breathe', 'still', 'glint'],
    exit: ['blur-out', 'evaporate', 'fade', 'under-sink', 'mist'],
    layout: ['vertical', 'vertical-right', 'vertical-left', 'spread', 'center'],
    treat: ['emphasis-dots', 'brackets', 'none', 'gold', 'head-rules'],
  },
  ballad: {
    ja: 'バラード',
    desc: '焦点が合い、ゆっくり呼吸し、光に溶ける。聴かせるための静かな行に。',
    enter: ['blur-in', 'fade-up', 'bloom-in', 'manifest', 'halo-in', 'sunrise'],
    hold: ['breathe', 'float', 'glow-breathe', 'twinkle'],
    exit: ['evaporate', 'blur-out', 'twinkle-out', 'fade', 'mist'],
    layout: ['center', 'lower', 'spread', 'vertical'],
    treat: ['soft-shadow', 'none', 'glow', 'fade'],
  },
  lyricpv: {
    ja: '文字PV',
    desc: '一字ずつ拡大し、叩きつけ、線で消し、改行で送る。文字だけで一本の映像にする行に。',
    enter: ['key-first', 'zoom-one', 'line-wipe', 'slam', 'stamp', 'typewriter', 'tracking-in', 'split-in', 'outline-fill'],
    hold: ['key-pulse', 'track-step', 'pulse', 'read-cursor', 'outline-blink'],
    exit: ['strike-out', 'line-feed', 'to-index', 'cut', 'backspace', 'slam-out', 'to-dot'],
    layout: ['headline', 'giant', 'zigzag', 'condensed', 'center', 'upper'],
    treat: ['outline', 'hard-shadow', 'marker', 'band', 'head-big', 'none', 'spot-char', 'misregister'],
  },
  typo: {
    ja: '文字組',
    desc: '括弧が開き、ルビが降り、升目に収まる。組版そのものを動きにする行に。',
    enter: ['bracket-open', 'ruby-drop', 'retype', 'dot-grow', 'under-lift', 'stroke-draw', 'key-first'],
    hold: ['read-cursor', 'key-pulse', 'track-step', 'still'],
    exit: ['bracket-close', 'to-dot', 'to-index', 'under-sink', 'fold-vert', 'strike-out', 'unstroke'],
    layout: ['left', 'spread', 'headline', 'vertical', 'center'],
    treat: ['head-rules', 'emphasis-dots', 'underline', 'hollow-key', 'genkou', 'wide-tracking', 'none'],
  },
  chaos: {
    ja: '全部入り',
    desc: '辞典のすべての動き・配置・文字処理から毎行を選ぶ。何が来るか分からない、実験と発見の行に。',
    enter: Object.keys(ENTER_ALL) as EnterName[],
    hold: Object.keys(HOLD_ALL) as HoldName[],
    exit: Object.keys(EXIT_ALL) as ExitName[],
    layout: Object.keys(LAYOUT_ALL) as LayoutName[],
    treat: ['none', 'outline', 'extrude', 'long-shadow', 'marker', 'glow', 'neon', 'halftone', 'chrome', 'glitch-split', 'sticker', 'ransom', 'keycap', 'rainbow', 'stencil', 'shine'],
  },
} satisfies Record<string, KineticMood>

export type KineticMoodName = keyof typeof kineticMoods

/** Entrances reserved for accent lines (サビ頭・決め台詞): the loud ones. */
export const ACCENT_ENTERS: readonly EnterName[] = ['stamp', 'zoom-in', 'glitch-in']
/** Hold used on accent lines — a beat-locked pulse. */
export const ACCENT_HOLD: HoldName = 'pulse'
