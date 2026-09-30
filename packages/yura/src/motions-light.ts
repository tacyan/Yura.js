import type { HoldRecipe, TransitionRecipe } from './motions'
import {
  hash01,
  clamp01,
  signedHash,
  frac,
  bump,
  smooth,
  drift,
  TAU,
  outCubic,
  outQuart,
  outExpo,
  outBack,
  inCubic,
  inQuad,
  inExpo,
  reversed,
} from './motion-kit'

/**
 * 光 — the light pack of the lyric-motion vocabulary: letters that ignite,
 * bloom, flare, scan in on a laser line, burn out into embers or dissolve
 * into white. Built on the pose's light fields (`bright`, `glow`, `hue`),
 * so every recipe is still a pure function of progress and seed, and reads
 * the same at any size.
 *
 * Light that clips to white is also what a projector does best: on a
 * projection surface black is "no light", so these recipes carry most of
 * their energy in brightness rather than in movement — see the `mapping`
 * mood, which leans on them.
 */

// Hash salts for this pack (distinct from the core vocabulary's 1..9).
const SALT_FLICK = 101
const SALT_ANGLE = 102
const SALT_SPARK = 103
const SALT_PHASE = 104
const SALT_DRIFT = 105

/** Peak brightness multipliers: a soft bloom, a hard flare, a blown-out flash. */
const BLOOM_BRIGHT = 1.6
const FLARE_BRIGHT = 3
const FLASH_BRIGHT = 8
/** Glow radii in em. */
const SOFT_GLOW_EM = 0.3
const HALO_GLOW_EM = 1.1
/** How far a streak of light travels, in em. */
const STREAK_EM = 3
/** Hue swing for prism effects, degrees. */
const PRISM_HUE = 160
/** Thickness a glyph keeps while it is still a beam of light (share of its height). */
const BEAM_THICKNESS = 0.04

// ------------------------------------------------------------------ enter

export const LIGHT_ENTER = {
  'flare-in': {
    ja: '閃光結像',
    desc: 'まぶしい閃光の中から、にじんだ光が文字の形に結ばれていく。サビ頭や決め所の登場に。',
    stagger: 0.4,
    pose: (p) => {
      const k = 1 - outCubic(p)
      return { bright: 1 + k * FLARE_BRIGHT, glow: k * 0.6, blur: k * 0.2, scale: 1 + k * 0.2, opacity: clamp01(p * 2.5) }
    },
  },
  'light-sweep': {
    ja: '光の走査',
    desc: '光の筋が左から走り、通り過ぎたところに文字が焼き付く。スキャナーのような精密さ。',
    stagger: 0.8,
    pose: (p) => ({ clip: [0, (1 - outCubic(p)) * 100, 0, 0], glow: bump(p) * 0.35, bright: 1 + bump(p) * 1.2 }),
  },
  ignite: {
    ja: '灯火',
    desc: '一文字ずつ、火が移るように揺らぎながら灯っていく。ろうそくや提灯のあたたかさ。',
    order: 'random',
    stagger: 0.6,
    pose: (p, g) => {
      if (p <= 0) return { opacity: 0 }
      if (p >= 1) return {}
      const flick = hash01(g.seed, g.i * 31 + Math.floor(p * 16), SALT_FLICK)
      return { opacity: clamp01(p * 1.5) * (0.55 + 0.45 * flick), glow: (1 - p) * 0.4 * flick, bright: 1 + (1 - p) * 0.8 * flick, hue: -(1 - p) * 20 }
    },
  },
  sunrise: {
    ja: '夜明け',
    desc: '暗い色から暖かい光へ移りながら、ゆっくり昇ってくる。一日の始まり、希望の歌い出しに。',
    stagger: 0.5,
    pose: (p) => {
      const k = 1 - outCubic(p)
      return { y: k * 0.8, hue: -k * 40, bright: 1 - k * 0.7, glow: bump(p) * 0.25, opacity: clamp01(p * 2) }
    },
  },
  'prism-in': {
    ja: '分光',
    desc: '虹色に分かれた光が重なり合い、一つの白い文字に揃う。プリズムを逆にたどるような登場。',
    stagger: 0.5,
    pose: (p) => {
      const k = 1 - outCubic(p)
      return { split: k * 0.25, hue: k * PRISM_HUE, blur: k * 0.1, opacity: clamp01(p * 2) }
    },
  },
  'beam-in': {
    ja: '光線展開',
    desc: '細い光の線が横に走り、それが縦に開いて文字になる。レーザー彫刻やSFの転送装置のよう。',
    stagger: 0.4,
    pose: (p) => {
      if (p < 0.5) {
        const q = p * 2
        return { sx: outCubic(q), sy: BEAM_THICKNESS, bright: FLARE_BRIGHT, glow: 0.4 }
      }
      const k = 1 - outCubic((p - 0.5) * 2)
      return { sy: 1 - (1 - BEAM_THICKNESS) * k, bright: 1 + k * (FLARE_BRIGHT - 1), glow: k * 0.4 }
    },
  },
  'spark-in': {
    ja: '火花',
    desc: '文字がぱちっと火花のように弾けて現れる。順不同に散る光が、祭りや花火の高揚をつくる。',
    order: 'random',
    stagger: 0.7,
    pose: (p) => ({ scale: Math.max(0, outBack(p)), glow: bump(p) * 0.5, bright: 1 + bump(p) * 2 }),
  },
  'halo-in': {
    ja: '後光',
    desc: '大きな光の輪をまとって現れ、光が引くと文字だけが残る。神々しく、祈るような登場。',
    order: 'center',
    stagger: 0.5,
    pose: (p) => {
      const k = 1 - outCubic(p)
      return { glow: k * HALO_GLOW_EM, bright: 1 + k * BLOOM_BRIGHT, opacity: outCubic(p) }
    },
  },
  'strobe-in': {
    ja: 'ストロボ',
    desc: '激しく点滅しながら、だんだん点いている時間が長くなって定着する。クラブやライブの照明。',
    order: 'all',
    stagger: 0,
    pose: (p) => {
      if (p <= 0) return { opacity: 0 }
      if (p >= 1) return {}
      const lit = p > 0.8 || Math.floor(p * p * 22) % 2 === 1
      return { opacity: lit ? 1 : 0, bright: lit ? 1 + (1 - p) * 1.5 : 1 }
    },
  },
  'laser-scan': {
    ja: 'レーザー走査',
    desc: '上から下へ走査線が降り、色ずれを伴って文字が描き出される。計器やホログラムのような精密さ。',
    stagger: 0.55,
    pose: (p) => {
      const k = 1 - outCubic(p)
      return { clip: [0, 0, k * 100, 0], split: k * 0.08, glow: bump(p) * 0.3, bright: 1 + bump(p) }
    },
  },
  'bloom-in': {
    ja: 'ブルーム',
    desc: '白くあふれる光のにじみが収まって、くっきりとした文字になる。夢から醒めるような焦点。',
    stagger: 0.45,
    pose: (p) => {
      const k = 1 - outCubic(p)
      return { blur: k * 0.5, bright: 1 + k * 2.5, scale: 1 + k * 0.35, opacity: clamp01(p * 1.8) }
    },
  },
  constellation: {
    ja: '星座',
    desc: '夜空に星が一つずつ灯り、その点が膨らんで文字になる。点と点がつながって意味になる瞬間。',
    order: 'random',
    stagger: 0.85,
    pose: (p) => {
      if (p < 0.5) return { scale: 0.12, glow: 0.5, bright: FLARE_BRIGHT, opacity: clamp01(p * 6) }
      const k = 1 - outBack((p - 0.5) * 2)
      return { scale: 1 - 0.88 * k, glow: 0.5 * k, bright: 1 + (FLARE_BRIGHT - 1) * Math.max(0, k) }
    },
  },
  firefly: {
    ja: '蛍',
    desc: '明滅する小さな光が、ふらふらと漂いながら文字の位置に落ち着く。夏の夜の水辺のような静けさ。',
    order: 'random',
    stagger: 0.8,
    pose: (p, g) => {
      if (p >= 1) return {}
      const k = 1 - outCubic(p)
      const a = hash01(g.seed, g.i, SALT_ANGLE) * TAU
      const blink = 0.6 + 0.4 * Math.sin(p * 40 + g.i * 1.7)
      return {
        x: Math.cos(a) * k * 1.2 + Math.sin(p * TAU * 2 + g.i) * 0.15 * k,
        y: Math.sin(a) * k * 0.9,
        glow: k * 0.5 * blink,
        bright: 1 + k * 1.5 * blink,
        opacity: clamp01(p * 3) * (1 - k * (1 - blink)),
      }
    },
  },
  photon: {
    ja: '光子',
    desc: '左から光の尾を引いて飛び込み、止まった瞬間に尾が消える。光速で届く言葉。',
    stagger: 0.5,
    pose: (p) => {
      const k = 1 - outExpo(p)
      return { x: -k * STREAK_EM, sx: 1 + k * 2.5, blur: k * 0.15, bright: 1 + k * 2, glow: k * 0.3, opacity: clamp01(p * 3) }
    },
  },
  'aurora-in': {
    ja: 'オーロラ',
    desc: '色を変えながら波打つ光のカーテンが、ゆっくり文字の形に落ち着く。北の夜空の幻想。',
    stagger: 0.8,
    pose: (p, g) => {
      const k = 1 - outCubic(p)
      return { y: Math.sin(g.rank * TAU + p * TAU) * 0.3 * k, hue: k * 120, blur: k * 0.25, glow: k * 0.3, opacity: outCubic(p) }
    },
  },
  flashbulb: {
    ja: 'フラッシュバルブ',
    desc: 'カメラのストロボを焚いたように真っ白に光って現れ、光が引いて色が戻る。報道写真の一瞬。',
    order: 'all',
    stagger: 0,
    pose: (p) => (p <= 0 ? { opacity: 0 } : { bright: 1 + (1 - outExpo(p)) * FLASH_BRIGHT, glow: (1 - outExpo(p)) * 0.5 }),
  },
  'lens-focus': {
    ja: '色収差ピント',
    desc: 'レンズの縁のように色がにじんでぼけた像が、ピントとともに一つに重なる。映画的な焦点送り。',
    stagger: 0.35,
    pose: (p) => {
      const k = 1 - outQuart(p)
      return { split: k * 0.18, blur: k * 0.3, scale: 1 + k * 0.25, opacity: clamp01(p * 2) }
    },
  },
  'godray-in': {
    ja: '光芒',
    desc: '雲間から差す光の筋のように縦に長く伸びた光が、縮んで文字になる。天から降りてくる言葉。',
    stagger: 0.5,
    origin: '50% 100%',
    pose: (p) => {
      const k = 1 - outCubic(p)
      return { sy: 1 + k * 2.5, sx: 1 - k * 0.5, glow: k * 0.6, bright: 1 + k * 2, opacity: outCubic(p) }
    },
  },
} satisfies Record<string, TransitionRecipe>

// ------------------------------------------------------------------ hold

/** Seconds per cycle of the slow light holds. */
const GLOW_PERIOD = 3.4
const BEAM_PERIOD = 3.2
const RADIATE_PERIOD = 2.2
const FLARE_PERIOD = 4.5

export const LIGHT_HOLD = {
  'glow-breathe': {
    ja: '光の呼吸',
    desc: '文字の光がゆっくり強まっては弱まる。発光する看板や、呼吸する生きものの気配。',
    pose: (t) => {
      const s = 0.5 + 0.5 * Math.sin((t / GLOW_PERIOD) * TAU)
      return { glow: 0.08 + s * 0.18, bright: 1 + s * 0.18 }
    },
  },
  candle: {
    ja: 'ろうそく',
    desc: '一文字ずつが炎のように不規則に明るさを揺らす。暗い部屋でともる、あたたかな不安定さ。',
    pose: (t, g) => {
      const f = drift(t * 3.1 + g.i * 1.3, g.seed + g.i, SALT_DRIFT)
      return { bright: 1 + f * 0.14, glow: 0.14 + f * 0.08, y: f * -0.012 }
    },
  },
  sparkle: {
    ja: 'きらめき散る',
    desc: 'ときどき一文字がきらっと光る。宝石や水面の反射のような、控えめな華やかさ。',
    pose: (t, g) => {
      const rate = 0.9 + hash01(g.seed, g.i, SALT_PHASE) * 0.8
      const cycle = t * rate + hash01(g.seed, g.i, SALT_SPARK)
      if (hash01(g.seed, g.i * 71 + Math.floor(cycle), SALT_SPARK) > 0.35) return {}
      const peak = Math.exp(-frac(cycle) * 10)
      return { bright: 1 + peak * 1.6, glow: peak * 0.35, scale: 1 + peak * 0.06 }
    },
  },
  prism: {
    ja: 'プリズム',
    desc: '文字ごとに色相がずれ、虹色の帯が行の上をゆっくり流れ続ける。玩具のような多幸感。',
    pose: (t, g) => ({ hue: ((t * 60 + g.rank * 150) % 360) - 180, split: 0.025 }),
  },
  lighthouse: {
    ja: '灯台',
    desc: '一定の間隔で光の帯が端から端へ文字を照らしていく。遠くから届く、確かな合図。',
    pose: (t, g) => {
      const d = Math.abs(frac(t / BEAM_PERIOD) * 1.6 - 0.3 - g.rank)
      const beam = Math.max(0, 1 - d * 5)
      return { bright: 1 + beam * 1.5, glow: beam * 0.45 }
    },
  },
  halo: {
    ja: '後光の鼓動',
    desc: '拍に合わせて文字の周りの光がふくらむ。静止したまま、光だけでリズムを刻む。',
    pose: (t, _g, beat) => {
      const e = Math.exp(-frac(t / beat) * 5)
      return { glow: 0.08 + e * 0.4, bright: 1 + e * 0.45 }
    },
  },
  strobe: {
    ja: '拍のストロボ',
    desc: '拍の頭で一瞬だけ強く光る。照明が音に合わせて焚かれるライブ会場の感覚。',
    pose: (t, _g, beat) => (frac(t / beat) < 0.08 ? { bright: 2.2, glow: 0.25 } : {}),
  },
  radiance: {
    ja: '放射',
    desc: '行の中心から外側へ、光の波が繰り返し広がっていく。言葉からエネルギーがあふれ出す。',
    pose: (t, g) => {
      const d = Math.abs(Math.abs(g.rank * 2 - 1) - frac(t / RADIATE_PERIOD))
      const w = Math.max(0, 1 - d * 4)
      return { bright: 1 + w * 1.2, glow: w * 0.3 }
    },
  },
  aurora: {
    ja: 'オーロラ',
    desc: '色がゆっくり移ろい、文字の並びが光のカーテンのように波打つ。',
    pose: (t, g) => ({ hue: Math.sin(t * 0.4 + g.rank * 2) * 40, y: Math.sin(t * 0.8 + g.i * 0.5) * 0.05, glow: 0.15 }),
  },
  'neon-hum': {
    ja: 'ネオンの唸り',
    desc: '光がかすかに唸るように震え、ごくたまに一瞬暗くなる。古いネオン管の生々しさ。',
    pose: (t, g) => {
      const hum = 0.5 + 0.5 * Math.sin(t * 50 + g.i)
      const drop = hash01(g.seed, g.i * 37 + Math.floor(t * 9), SALT_FLICK) < 0.03
      return { glow: 0.22 + hum * 0.05, opacity: drop ? 0.55 : 1 }
    },
  },
  flare: {
    ja: 'フレア',
    desc: '数秒おきに、光が行の上を強く横切ってまぶしく反射する。カメラに太陽が入ったような一瞬。',
    pose: (t, g) => {
      const v = frac(t / FLARE_PERIOD)
      const d = Math.abs(v * 3 - 1 - g.rank)
      const w = v < 0.66 ? Math.max(0, 1 - d * 3) : 0
      return { bright: 1 + w * 2.2, glow: w * 0.5 }
    },
  },
  twinkle: {
    ja: '瞬き',
    desc: '一文字ずつが別々の周期でかすかに明滅する。星空を見上げたときの静かなまたたき。',
    pose: (t, g) => {
      const rate = 0.6 + hash01(g.seed, g.i, SALT_PHASE) * 1.1
      const s = 0.5 + 0.5 * Math.sin(t * rate * TAU + hash01(g.seed, g.i, SALT_SPARK) * TAU)
      return { opacity: 0.72 + s * 0.28, glow: s * 0.15 }
    },
  },
} satisfies Record<string, HoldRecipe>

// ------------------------------------------------------------------ exit

export const LIGHT_EXIT = {
  'burn-out': {
    ja: '燃え尽き',
    desc: '一度強く燃え上がり、赤く冷えながら暗くなって消える。燃えるような想いの終わり。',
    order: 'random',
    stagger: 0.5,
    pose: (p) => {
      const up = bump(Math.min(1, p * 2.5))
      return { bright: 1 + up * 1.4 - smooth(0.4, 1, p) * 0.8, glow: up * 0.4, hue: -smooth(0.3, 1, p) * 35, y: -inQuad(p) * 0.4, opacity: 1 - smooth(0.45, 1, p) }
    },
  },
  'flare-out': {
    ja: '閃光に溶ける',
    desc: '光が強まり、にじんで膨らみながら白い光の中に溶けて消える。',
    stagger: 0.4,
    pose: (p) => ({ bright: 1 + inCubic(p) * 5, blur: p * 0.3, scale: 1 + p * 0.3, glow: p * 0.8, opacity: 1 - inQuad(p) }),
  },
  'white-out': {
    ja: '白飛び',
    desc: '行全体が露出オーバーのように真っ白に飛んで消える。場面転換を強く告げる。',
    order: 'all',
    stagger: 0,
    pose: (p) => ({ bright: 1 + p * FLASH_BRIGHT, glow: p * 0.6, opacity: 1 - inExpo(p) }),
  },
  eclipse: {
    ja: '日食',
    desc: '左右から影が閉じていき、最後に光の縁だけが残って消える。',
    order: 'center',
    stagger: 0.5,
    pose: (p) => {
      const c = inCubic(p) * 50
      return { clip: [0, c, 0, c], glow: p * 0.5, bright: 1 + p * 0.8 }
    },
  },
  supernova: {
    ja: '超新星',
    desc: '一文字ずつが光を放って膨張し、はじけて消える。最後の輝きのような退場。',
    order: 'random',
    stagger: 0.6,
    pose: (p) => ({ scale: 1 + outExpo(p) * 2.5, glow: p, bright: 1 + p * 4, opacity: 1 - p }),
  },
  ember: {
    ja: '残り火',
    desc: '文字が火の粉のように赤く小さくなりながら、ゆらゆら舞い上がって消える。',
    order: 'random',
    stagger: 0.7,
    pose: (p, g) => ({
      y: -inQuad(p) * 1.2,
      x: signedHash(g.seed, g.i, SALT_ANGLE) * 0.6 * p + Math.sin(p * TAU * 1.5 + g.i) * 0.08 * p,
      hue: -p * 35,
      bright: 1 - p * 0.3,
      scale: 1 - p * 0.5,
      glow: bump(p) * 0.3,
      opacity: 1 - p,
    }),
  },
  'light-speed': {
    ja: '光速',
    desc: '文字が光の尾を引いて右へ一瞬で飛び去る。ワープのような加速。',
    stagger: 0.4,
    pose: (p) => ({ x: inExpo(p) * 6, sx: 1 + inCubic(p) * 4, blur: p * 0.2, bright: 1 + p * 2, opacity: 1 - inQuad(p) }),
  },
  'beam-out': reversed(LIGHT_ENTER['beam-in'], { ja: '光線収束', desc: '文字が縦につぶれて一本の光の線になり、その線も縮んで消える。' }),
  'prism-out': reversed(LIGHT_ENTER['prism-in'], { ja: '分光して消える', desc: '白い文字が虹色に分かれ、ばらばらの光になって消えていく。' }),
  'photon-out': reversed(LIGHT_ENTER.photon, { ja: '光子化', desc: '文字が光の尾を伸ばしながら、来た方向へ光の速さで戻っていく。' }, 'rtl'),
  'twinkle-out': {
    ja: '星に還る',
    desc: '一文字ずつ小さな光の点に縮み、瞬いて消える。言葉が夜空に還っていく。',
    order: 'random',
    stagger: 0.85,
    pose: (p) => ({ scale: 1 - p * 0.88, glow: bump(p) * 0.5, bright: 1 + p * 2, opacity: 1 - smooth(0.6, 1, p) }),
  },
  'fade-to-dark': {
    ja: '消灯',
    desc: '照明が落ちるように暗くなり、最後に一度だけちらついて消える。夜が来る、部屋を出る。',
    order: 'random',
    stagger: 0.5,
    pose: (p, g) => {
      const blink = p > 0.6 && p < 0.85 && hash01(g.seed, g.i * 13 + Math.floor(p * 20), SALT_FLICK) < 0.4
      return { bright: 1 - p * 0.8, opacity: (blink ? 0.25 : 1) * (1 - smooth(0.7, 1, p)) }
    },
  },
  'godray-out': reversed(LIGHT_ENTER['godray-in'], { ja: '昇天', desc: '文字が縦に長い光の筋へ引き伸ばされ、天へ吸い上げられるように消える。' }),
} satisfies Record<string, TransitionRecipe>
