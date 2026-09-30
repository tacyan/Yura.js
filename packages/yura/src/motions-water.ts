import type { HoldRecipe, TransitionRecipe } from './motions'
import {
  hash01,
  clamp01,
  signedHash,
  frac,
  bump,
  smooth,
  drift,
  ring,
  TAU,
  outCubic,
  outQuart,
  outBack,
  inCubic,
  inQuad,
  fromMiddle,
  reversed,
} from './motion-kit'

/**
 * 水 — the water pack of the lyric-motion vocabulary: letters that surface
 * through a rippling skin, fall as droplets and splash, melt and drip, wash
 * away on a current or sink into the deep. Water is motion with memory —
 * every recipe here settles through a damped oscillation ({@link ring})
 * that is exactly zero at rest, so the hand-off to the hold never pops.
 */

const SALT_ANGLE = 201
const SALT_DIST = 202
const SALT_PHASE = 203
const SALT_DROP = 204
const SALT_DRIFT = 205

/** Fall height of a droplet, em. */
const DROP_FALL_EM = 2.5
/** Depth a surfacing line rises from, em. */
const SURFACE_DEPTH_EM = 1.2
/** Distance a current carries a line, em. */
const CURRENT_EM = 3
/** Mask travel (% of the glyph box) for reveals through the water line. */
const WATERLINE_PCT = 105
/** Share of the fall a droplet spends in the air before it lands. */
const DROP_AIR = 0.6

// ------------------------------------------------------------------ enter

export const WATER_ENTER = {
  'ripple-in': {
    ja: '波紋',
    desc: '水面に落ちた一滴から波紋が広がるように、中心の文字から順に揺れて現れる。',
    order: 'center',
    stagger: 0.6,
    pose: (p) => ({ scale: 1 + ring(p, 2.5, 3) * 0.35, blur: (1 - p) * 0.1, opacity: clamp01(p * 3) }),
  },
  surface: {
    ja: '浮上',
    desc: '水の底から、屈折でゆらぎながら浮かび上がって水面で止まる。',
    stagger: 0.5,
    pose: (p) => {
      const k = 1 - outCubic(p)
      return { y: k * SURFACE_DEPTH_EM, blur: k * 0.25, skew: ring(p, 2, 3) * 10, bright: 1 - k * 0.4, opacity: clamp01(p * 2) }
    },
  },
  droplet: {
    ja: '雫',
    desc: '上から落ちてきた雫が着地して、ぷるんと震えて文字になる。',
    order: 'random',
    stagger: 0.6,
    origin: '50% 100%',
    pose: (p) => {
      if (p < DROP_AIR) {
        const q = p / DROP_AIR
        return { y: -DROP_FALL_EM * (1 - inQuad(q)), sy: 1 + 0.5 * (1 - q), sx: 0.7 + 0.3 * q, opacity: clamp01(q * 4) }
      }
      const w = ring((p - DROP_AIR) / (1 - DROP_AIR), 1.5, 3)
      return { sy: 1 + w * 0.35, sx: 1 - w * 0.25 }
    },
  },
  splash: {
    ja: '水しぶき',
    desc: '水面から飛び出したしぶきが弧を描いて落ち、文字の位置に収まる。',
    order: 'random',
    stagger: 0.5,
    pose: (p, g) => {
      const k = 1 - outCubic(p)
      const a = hash01(g.seed, g.i, SALT_ANGLE) * TAU
      return { x: Math.cos(a) * k * 0.9, y: -bump(p) * (0.4 + hash01(g.seed, g.i, SALT_DIST) * 0.6) + k * 0.3, rotate: signedHash(g.seed, g.i, SALT_ANGLE) * 90 * k, scale: Math.max(0, outBack(p)) }
    },
  },
  liquid: {
    ja: '液体',
    desc: 'とろりとした液体のように縦横に伸び縮みしながら形が定まる。',
    stagger: 0.5,
    origin: '50% 100%',
    pose: (p) => {
      const w = ring(p, 2, 3)
      return { sx: 1 + w * 0.5, sy: 1 - w * 0.4, blur: (1 - p) * 0.08, opacity: clamp01(p * 4) }
    },
  },
  'bubble-up': {
    ja: '泡',
    desc: '水底から小さな泡が揺れながら昇ってきて、ふくらんで文字になる。',
    order: 'random',
    stagger: 0.7,
    pose: (p, g) => {
      const k = 1 - outCubic(p)
      return { y: k * 2.2, x: Math.sin(p * TAU * 1.5 + g.i) * 0.2 * k, scale: 1 - 0.7 * (1 - outBack(p)), glow: k * 0.15, opacity: clamp01(p * 2.5) }
    },
  },
  refract: {
    ja: '屈折',
    desc: '水越しに見るように、歪み・ずれ・ぼけが揺り戻しながら正しい形に落ち着く。',
    stagger: 0.4,
    pose: (p) => ({ skew: ring(p, 2, 3) * 25, x: ring(p, 1.5, 3) * 0.3, sx: 1 + ring(p, 1, 2) * 0.15, blur: (1 - p) * 0.12, opacity: outCubic(p) }),
  },
  'tide-in': {
    ja: '潮',
    desc: '左から寄せる波に乗って、上下にうねりながら文字が流れ着く。',
    stagger: 0.6,
    pose: (p) => {
      const k = 1 - outCubic(p)
      return { x: -k * 2, y: Math.sin(p * TAU * 1.5) * 0.3 * k, opacity: clamp01(p * 2) }
    },
  },
  'rain-in': {
    ja: '雨',
    desc: '細長い雨粒が次々に降り注ぎ、地面に着いたところから文字になる。',
    order: 'random',
    stagger: 0.8,
    pose: (p) => {
      const k = 1 - outQuart(p)
      return { y: -k * 3, sy: 1 + k * 1.8, sx: 1 - k * 0.5, blur: k * 0.05, opacity: clamp01(p * 3) }
    },
  },
  condense: {
    ja: '結露',
    desc: '曇ったガラスに水滴が集まるように、ぼんやりとした点がにじんで文字になる。',
    order: 'random',
    stagger: 0.7,
    pose: (p) => {
      const k = 1 - outCubic(p)
      return { blur: k * 0.45, scale: 1 + k * 0.08, bright: 1 + k * 0.4, opacity: outCubic(p) }
    },
  },
  'ink-bloom': {
    ja: '墨流し',
    desc: '水に落とした墨が広がって、ゆっくり形を結ぶ。にじみから始まる和の登場。',
    order: 'center',
    stagger: 0.5,
    pose: (p) => {
      const k = 1 - outQuart(p)
      return { blur: k * 0.6, scale: 1 + k * 0.6, sx: 1 + ring(p, 1, 2) * 0.1, opacity: outQuart(p) }
    },
  },
  'wave-crest': {
    ja: '波頭',
    desc: '波が巻くように、奥に倒れていた文字が持ち上がって手前へ返る。',
    stagger: 0.7,
    origin: '50% 100%',
    pose: (p) => ({ rx: -(1 - outBack(p)) * 80, y: -bump(p) * 0.3, opacity: clamp01(p * 2.5) }),
  },
  mirage: {
    ja: '蜃気楼',
    desc: '熱でゆらぐ空気の向こうに、横に波打つ像が現れて定まる。',
    order: 'all',
    stagger: 0,
    pose: (p) => {
      const k = 1 - outCubic(p)
      return { sx: 1 + Math.sin(p * TAU * 3) * 0.15 * k, skew: Math.sin(p * TAU * 4) * 10 * k, blur: k * 0.2, opacity: outCubic(p) }
    },
  },
  pour: {
    ja: '注ぐ',
    desc: '上から水を注ぐように、文字が上から下へ満たされていく。',
    stagger: 0.6,
    origin: '50% 0%',
    pose: (p) => {
      const k = 1 - outCubic(p)
      return { clip: [0, 0, k * 100, 0], sy: 1 + k * 0.4, bright: 1 + bump(p) * 0.3 }
    },
  },
  upwell: {
    ja: '湧き上がり',
    desc: '水面の線から文字がせり上がり、揺らぎを残しながら姿を現す。泉が湧くような登場。',
    stagger: 0.45,
    pose: (p) => {
      const ty = (1 - outQuart(p)) * WATERLINE_PCT
      return { ty, clip: [0, 0, ty, 0], x: ring(p, 1.5, 3) * 0.08 }
    },
  },
  'frost-in': {
    ja: '霜',
    desc: '冷たく青白い光をまといながら、霜が降りるように文字が浮かぶ。',
    order: 'random',
    stagger: 0.6,
    pose: (p) => {
      const k = 1 - outCubic(p)
      return { bright: 1 + k * 1.8, hue: k * 25, split: k * 0.04, blur: k * 0.1, opacity: clamp01(p * 2) }
    },
  },
} satisfies Record<string, TransitionRecipe>

// ------------------------------------------------------------------ hold

const RIPPLE_PERIOD = 1.8
const TIDE_PERIOD = 6
const DRIP_PERIOD = 3.5
const RAIN_HZ = 4

export const WATER_HOLD = {
  ripple: {
    ja: '波紋',
    desc: '行の中心から外へ、小さな波紋が繰り返し文字を揺らしていく。',
    pose: (t, g) => {
      const w = Math.sin((t / RIPPLE_PERIOD) * TAU - Math.abs(fromMiddle(g)) * 0.9)
      return { scale: 1 + w * 0.03, y: w * -0.02 }
    },
  },
  underwater: {
    ja: '水中',
    desc: '一文字ずつがばらばらにゆらゆら揺れ、水の中から見上げたように歪む。',
    pose: (t, g) => ({
      x: drift(t * 0.9, g.seed + g.i, SALT_DRIFT) * 0.05,
      y: drift(t * 0.8, g.seed + g.i, SALT_DRIFT + 1) * 0.05,
      skew: drift(t * 0.7, g.seed + g.i, SALT_DRIFT + 2) * 3,
    }),
  },
  buoy: {
    ja: '浮き',
    desc: '水に浮かんだ浮きのように、上下に揺れながら少し首をかしげる。',
    origin: '50% 100%',
    pose: (t, g) => ({ y: Math.sin(t * 1.6 + g.i * 0.4) * 0.08, rotate: Math.sin(t * 1.3 + g.i * 0.7) * 4 }),
  },
  caustic: {
    ja: '水面の光',
    desc: 'プールの底に映る光の網のように、明るさが文字の上を不規則に揺らめく。',
    pose: (t, g) => {
      const c = 0.5 + 0.5 * Math.sin(t * 2.1 + g.i * 1.3) * Math.sin(t * 1.7 - g.i * 0.9 + g.seed)
      return { bright: 1 + c * 0.35, glow: c * 0.1 }
    },
  },
  current: {
    ja: '流れ',
    desc: '行の上を流れが通り抜けるように、文字が順に横へなびく。',
    pose: (t, g) => {
      const w = Math.sin(t * 0.9 * TAU * 0.5 - g.rank * 3)
      return { x: w * 0.08, skew: w * 4 }
    },
  },
  drip: {
    ja: '滴る',
    desc: 'ときおり一文字が、雫が垂れるように下へ伸びて戻る。',
    origin: '50% 0%',
    pose: (t, g) => {
      const v = frac(t / DRIP_PERIOD + hash01(g.seed, g.i, SALT_PHASE))
      return v < 0.25 ? { sy: 1 + bump(v * 4) * 0.22 } : {}
    },
  },
  rain: {
    ja: '雨粒',
    desc: '雨粒が当たったように、ばらばらの文字が小さく沈んで戻る。',
    pose: (t, g) => {
      const step = Math.floor(t * RAIN_HZ)
      if (hash01(g.seed, g.i * 59 + step, SALT_DROP) > 0.1) return {}
      const e = Math.exp(-frac(t * RAIN_HZ) * 6)
      return { y: e * 0.06, sy: 1 - e * 0.06 }
    },
  },
  tide: {
    ja: '満ち引き',
    desc: '行全体が潮の満ち引きのように、ゆっくり大きく上下する。',
    pose: (t) => ({ y: Math.sin((t / TIDE_PERIOD) * TAU) * 0.12 }),
  },
  refraction: {
    ja: '揺らぎ',
    desc: '水越しに見る文字のように、形が絶えず斜めにゆがんでは戻る。',
    pose: (t, g) => ({ skew: Math.sin(t * 1.9 + g.i * 0.6) * 5, sx: 1 + Math.sin(t * 2.3 + g.i) * 0.03 }),
  },
  'splash-beat': {
    ja: '拍の水しぶき',
    desc: '拍ごとに、いくつかの文字が水しぶきのように跳ねる。',
    pose: (t, g, beat) => {
      const k = Math.floor(t / beat)
      if (hash01(g.seed, g.i * 43 + k, SALT_DROP) > 0.35) return {}
      const e = Math.exp(-frac(t / beat) * 7)
      return { y: -e * 0.12, scale: 1 + e * 0.05 }
    },
  },
  glint: {
    ja: '水面のきらめき',
    desc: '水面の反射のように、青白い小さな光がときどき文字に宿る。',
    pose: (t, g) => {
      const cycle = t * 1.4 + hash01(g.seed, g.i, SALT_PHASE) * 3
      if (hash01(g.seed, g.i * 67 + Math.floor(cycle), SALT_DROP) > 0.3) return {}
      const e = Math.exp(-frac(cycle) * 9)
      return { bright: 1 + e * 1.1, glow: e * 0.25, hue: e * 12 }
    },
  },
} satisfies Record<string, HoldRecipe>

// ------------------------------------------------------------------ exit

export const WATER_EXIT = {
  melt: {
    ja: '溶ける',
    desc: '文字が下へとろけて伸び、にじみながら流れ落ちて消える。',
    order: 'random',
    stagger: 0.6,
    origin: '50% 0%',
    pose: (p) => ({ sy: 1 + inCubic(p) * 1.6, sx: 1 - p * 0.3, y: inQuad(p) * 0.8, blur: p * 0.15, opacity: 1 - inQuad(p) }),
  },
  'sink-deep': {
    ja: '深く沈む',
    desc: '光の届かない深みへ、暗く、ぼやけながらゆっくり沈んでいく。',
    stagger: 0.5,
    pose: (p) => ({ y: inCubic(p) * 2, blur: p * 0.3, bright: 1 - p * 0.7, hue: p * 20, opacity: 1 - p }),
  },
  'splash-out': {
    ja: '飛沫',
    desc: '水面を叩いたように、文字がしぶきになって弧を描き飛び散る。',
    order: 'all',
    stagger: 0,
    pose: (p, g) => {
      const a = hash01(g.seed, g.i, SALT_ANGLE) * Math.PI
      const r = (0.6 + hash01(g.seed, g.i, SALT_DIST)) * 2.4
      return { x: Math.cos(a) * r * p, y: -Math.sin(a) * r * p + inQuad(p) * 3, scale: 1 - p * 0.6, rotate: signedHash(g.seed, g.i, SALT_ANGLE) * 180 * p, opacity: 1 - inQuad(p) }
    },
  },
  mist: {
    ja: '霧',
    desc: '文字が細かな霧になってふくらみ、白くかすんで消える。',
    order: 'random',
    stagger: 0.6,
    pose: (p) => ({ blur: p * 0.6, scale: 1 + p * 0.4, bright: 1 + p * 0.5, opacity: 1 - p }),
  },
  'ripple-out': {
    ja: '波紋に消える',
    desc: '中心から広がる波紋に揺らされ、ぼけながら水面に溶けていく。',
    order: 'center',
    stagger: 0.5,
    pose: (p) => ({ scale: 1 + Math.sin(p * TAU * 1.5) * 0.2 * p, blur: p * 0.2, opacity: 1 - p }),
  },
  drain: {
    ja: '渦に吸われる',
    desc: '排水口の渦に巻かれるように、回りながら行の中心へ吸い込まれて消える。',
    order: 'all',
    stagger: 0,
    pose: (p, g) => ({ x: -fromMiddle(g) * inCubic(p), rotate: p * 360 * (g.i % 2 ? 1 : -1), scale: 1 - inCubic(p) }),
  },
  'wash-away': {
    ja: '押し流す',
    desc: '横からの波にさらわれ、うねりながら右へ流されて消える。',
    stagger: 0.6,
    pose: (p) => ({ x: inCubic(p) * CURRENT_EM, y: Math.sin(p * TAU) * 0.3, rotate: p * 40, blur: p * 0.1, opacity: 1 - inQuad(p) }),
  },
  'drip-out': {
    ja: '雫落ち',
    desc: '一文字ずつが雫になって、細長く伸びながら落ちていく。',
    order: 'random',
    stagger: 0.7,
    origin: '50% 0%',
    pose: (p) => ({ y: inQuad(p) * DROP_FALL_EM, sy: 1 + p * 0.8, sx: 1 - p * 0.4, opacity: 1 - inCubic(p) }),
  },
  'dissolve-water': {
    ja: '水に溶ける',
    desc: '絵の具が水に溶けるように、色を変えてにじみながら薄れていく。',
    order: 'random',
    stagger: 0.7,
    pose: (p) => ({ blur: p * 0.35, hue: p * 40, y: p * 0.2, sx: 1 + p * 0.2, opacity: 1 - p }),
  },
  'wave-out': {
    ja: '波にさらわれる',
    desc: '大きな波が文字を奥へ巻き込みながら持ち去っていく。',
    stagger: 0.7,
    origin: '50% 100%',
    pose: (p) => ({ y: -bump(p) * 0.6, x: p * 1.5, rx: -p * 70, opacity: 1 - inQuad(p) }),
  },
  freeze: {
    ja: '凍って砕ける',
    desc: '青白く凍りついて止まり、次の瞬間、氷の破片になって砕け散る。',
    order: 'all',
    stagger: 0,
    pose: (p, g) => {
      const ice = smooth(0, 0.35, p)
      const q = Math.max(0, (p - 0.4) / 0.6)
      const a = hash01(g.seed, g.i, SALT_ANGLE) * TAU
      const r = (0.5 + hash01(g.seed, g.i, SALT_DIST)) * 2.2 * outCubic(q)
      return { bright: 1 + ice * 1.2, hue: ice * 30, split: ice * 0.03, x: Math.cos(a) * r, y: Math.sin(a) * r + inQuad(q) * 1.5, rotate: signedHash(g.seed, g.i, SALT_DIST) * 200 * q, opacity: 1 - inQuad(q) }
    },
  },
  'bubble-out': {
    ja: '泡になって昇る',
    desc: '文字が小さな泡になり、揺れながら水面へ昇って消える。',
    order: 'random',
    stagger: 0.7,
    pose: (p, g) => ({ y: -inQuad(p) * 2.5, x: Math.sin(p * TAU * 1.5 + g.i) * 0.2 * p, scale: 1 - p * 0.7, glow: bump(p) * 0.2, opacity: 1 - smooth(0.5, 1, p) }),
  },
  'surface-out': reversed(WATER_ENTER.surface, { ja: '潜る', desc: '水面から、屈折でゆらぎながら水の底へ潜っていく。' }),
} satisfies Record<string, TransitionRecipe>
