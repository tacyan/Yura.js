import type { HoldRecipe, MotionGlyph, TransitionRecipe } from './motions'
import {
  hash01,
  clamp01,
  signedHash,
  frac,
  smooth,
  drift,
  outCubic,
  outQuart,
  outExpo,
  outBack,
  inCubic,
  inQuad,
  inExpo,
  fromMiddle,
  poolChar,
  reversed,
} from './motion-kit'

/**
 * Two packs of the lyric-motion vocabulary:
 *
 *   不穏 (horror) — letters that appear between blinks, jump at you, hang one
 *   beat too long, turn their back, get dragged down into the dark. No gore:
 *   the unease is in timing and light.
 *
 *   文字組 (typographic) — motion that comes from typesetting itself: the key
 *   glyph arriving first, a line drawn and then filled, ruby dropping into
 *   place, brackets opening, retyping a wrong character, a strike-through
 *   that takes the word away, letters returning to a dot or to their index.
 *
 * Built on the pose's outline channels (`stroke`, `fill`) as well as the
 * usual ones, and held to the same contracts as the rest of the vocabulary.
 */

const SALT_KEY = 701
const SALT_BLINK = 702
const SALT_TWITCH = 703
const SALT_WRONG = 704

/** The line's key glyph: a seeded choice among its glyphs (stable per line). */
const keyIndex = (g: MotionGlyph): number => Math.floor(hash01(g.seed, 0, SALT_KEY) * g.n)
const isKey = (g: MotionGlyph): boolean => g.i === keyIndex(g)
/** Outline width for line-drawn letters, em. */
const LINE_EM = 0.03
/** Characters a mistyped glyph shows before it is corrected. */
const WRONG_POOL: readonly string[] = Array.from('あいうえおかきくけこアイウエオxyzqk')
const DIGITS: readonly string[] = Array.from('0123456789')

// ------------------------------------------------------------------ horror: enter

export const HORROR_ENTER = {
  'blink-creep': {
    ja: '瞬きの間に',
    desc: '画面が瞬くたびに、文字が少しずつ近づいている。まばたきした隙に距離を詰めてくる恐怖。',
    order: 'all',
    stagger: 0,
    pose: (p) => {
      if (p >= 1) return {}
      const k = Math.floor(p * 5)
      const dark = frac(p * 5) < 0.28
      return { opacity: dark || p <= 0 ? 0 : 1, scale: 0.35 + (k / 5) * 0.65 }
    },
  },
  'jump-scare': {
    ja: '飛び出し',
    desc: '長い無音のあと、突然巨大な文字が飛び出して震える。お化け屋敷の驚かし。',
    order: 'all',
    stagger: 0,
    pose: (p, g) => {
      if (p < 0.72) return { opacity: 0 }
      const q = (p - 0.72) / 0.28
      const k = 1 - outExpo(q)
      return { scale: 1 + k * 1.6, x: signedHash(g.seed, Math.floor(q * 20), SALT_TWITCH) * 0.2 * k, bright: 1 + k * 1.5 }
    },
  },
  uneasy: {
    ja: '間の悪い出現',
    desc: '順番もばらばらに、一度しゃっくりするように消えかけてから文字が灯る。落ち着かない出方。',
    order: 'random',
    stagger: 0.9,
    pose: (p, g) => {
      if (p >= 1) return {}
      const hiccup = p > 0.45 && p < 0.6 && hash01(g.seed, g.i, SALT_BLINK) < 0.7
      return { opacity: hiccup ? 0.15 : clamp01(p * 1.6) }
    },
  },
  'v-hold': {
    ja: '垂直同期',
    desc: '古いテレビの同期が外れたように、文字が縦に流れて何度か回り、止まる。',
    order: 'all',
    stagger: 0,
    pose: (p) => {
      if (p <= 0) return { opacity: 0 }
      // The glyph rolls through its own box a few times, slowing to a stop.
      const roll = (1 - outCubic(p)) * 3.4
      return { ty: -frac(roll) * 100 }
    },
  },
  'mirror-snap': {
    ja: '鏡文字',
    desc: '左右が反転した鏡文字で現れ、ある瞬間にぱちんと正しい向きに戻る。何かがおかしい。',
    stagger: 0.4,
    pose: (p) => ({ sx: p < 0.7 ? -1 : 1, opacity: clamp01(p * 4) }),
  },
  manifest: {
    ja: '浮かび上がる',
    desc: '暗がりの中から、ぼんやりとした輪郭がゆっくり形を結ぶ。そこに最初からいたかのように。',
    order: 'random',
    stagger: 0.5,
    pose: (p) => ({ opacity: p * p, blur: (1 - p) * 0.3, bright: 0.4 + 0.6 * p, y: (1 - outCubic(p)) * 0.1 }),
  },
  'claw-reveal': {
    ja: '爪痕から',
    desc: '引っ掻いたような鋭い裂け目から文字が現れる。暴力的な気配の、切り裂く登場。',
    stagger: 0.3,
    pose: (p, g) => {
      const k = 1 - outExpo(p)
      return { clip: [0, k * 100, 0, 0], skew: k * -20, split: k * 0.08, x: signedHash(g.seed, g.i, SALT_TWITCH) * k * 0.2 }
    },
  },
} satisfies Record<string, TransitionRecipe>

// ------------------------------------------------------------------ horror: hold

export const HORROR_HOLD = {
  twitch: {
    ja: '痙攣',
    desc: 'ふだんは静かだが、ときおり一文字がびくっと引きつる。生きているような不気味さ。',
    pose: (t, g) => {
      const k = Math.floor(t * 7)
      if (hash01(g.seed, g.i * 53 + k, SALT_TWITCH) > 0.035) return {}
      return { rotate: signedHash(g.seed, g.i + k, SALT_TWITCH) * 18, x: signedHash(g.seed, g.i + k, SALT_KEY) * 0.12 }
    },
  },
  stare: {
    ja: '見つめる字',
    desc: '一文字だけがじわじわ大きく、明るくなっていく。こちらを見ているかのように。',
    pose: (t, g) => (isKey(g) ? { scale: 1 + (1 - Math.exp(-t / 4)) * 0.25, bright: 1 + (1 - Math.exp(-t / 4)) * 0.4 } : { bright: 1 - (1 - Math.exp(-t / 4)) * 0.25 }),
  },
  'lag-one': {
    ja: '遅れる一字',
    desc: '行全体が揺れる中で、一文字だけが一拍遅れてついてくる。仲間はずれの違和感。',
    pose: (t, g) => {
      const lag = isKey(g) ? 0.6 : 0
      return { y: Math.sin((t - lag) * 1.6) * 0.06, rotate: isKey(g) ? Math.sin((t - lag) * 1.6) * 4 : 0 }
    },
  },
  'dying-light': {
    ja: '切れかけの灯',
    desc: '切れかけた蛍光灯のように、行全体が不規則に暗くなり、ふっと消えかける。',
    pose: (t, g) => {
      const k = Math.floor(t * 12)
      const off = hash01(g.seed, k, SALT_BLINK) < 0.08
      return { opacity: off ? 0.1 : 1, bright: 0.85 + 0.15 * drift(t * 4, g.seed, SALT_BLINK) }
    },
  },
} satisfies Record<string, HoldRecipe>

// ------------------------------------------------------------------ horror: exit

export const HORROR_EXIT = {
  'pulled-down': {
    ja: '引きずり込み',
    desc: '一文字ずつ、下から何かに掴まれたように一気に引きずり込まれて消える。',
    order: 'random',
    stagger: 0.7,
    origin: '50% 0%',
    pose: (p) => ({ y: inExpo(p) * 4, sy: 1 + inCubic(p) * 1.2, opacity: 1 - smooth(0.6, 1, p) }),
  },
  'look-back': {
    ja: '一字残る',
    desc: '他の文字が消えたあとも、一文字だけがしばらく残ってから消える。まだ、そこにいる。',
    order: 'all',
    stagger: 0,
    pose: (p, g) => ({ opacity: isKey(g) ? 1 - smooth(0.8, 1, p) : 1 - smooth(0, 0.35, p) }),
  },
  'turn-away': {
    ja: '背を向ける',
    desc: '文字がゆっくり横に回って背を向け、そのまま見えなくなる。拒絶、別れ。',
    stagger: 0.5,
    pose: (p) => ({ ry: inCubic(p) * 180, opacity: 1 - smooth(0.4, 0.55, p) }),
  },
  shiver: {
    ja: '震えて消える',
    desc: '文字が細かく震え、その震えが強くなりながら薄れて消える。',
    order: 'random',
    stagger: 0.5,
    pose: (p, g) => {
      const k = Math.floor(p * 40)
      return { x: signedHash(g.seed, g.i * 41 + k, SALT_TWITCH) * 0.12 * p, y: signedHash(g.seed, g.i * 43 + k, SALT_KEY) * 0.08 * p, opacity: 1 - inQuad(p) }
    },
  },
  swallow: {
    ja: '闇に呑まれる',
    desc: '文字が暗く沈み、ぼやけ、小さくなって闇に呑み込まれる。',
    order: 'edges',
    stagger: 0.5,
    pose: (p) => ({ bright: 1 - p * 0.9, blur: p * 0.25, scale: 1 - p * 0.3, opacity: 1 - inCubic(p) }),
  },
  'flicker-die': {
    ja: '明滅して消える',
    desc: '接触の悪い電球のように明滅を繰り返し、点いている時間が短くなって消える。',
    order: 'random',
    stagger: 0.4,
    pose: (p, g) => {
      if (p >= 1) return { opacity: 0 }
      if (p <= 0) return {}
      const on = hash01(g.seed, g.i * 67 + Math.floor(p * 18), SALT_BLINK) > p
      return { opacity: on ? 1 : 0 }
    },
  },
  bleed: {
    ja: '滴り落ちる',
    desc: '文字が赤く染まりながら下へ伸び、滴り落ちるように消える。',
    order: 'random',
    stagger: 0.6,
    origin: '50% 0%',
    pose: (p) => ({ sy: 1 + inCubic(p) * 2, y: inQuad(p) * 0.6, hue: -p * 40, bright: 1 - p * 0.3, opacity: 1 - inCubic(p) }),
  },
} satisfies Record<string, TransitionRecipe>

// ------------------------------------------------------------------ typographic: enter

export const TYPE_ENTER = {
  'stroke-draw': {
    ja: '線画から塗り',
    desc: '最初は細い輪郭線だけが描かれ、そのあと中が塗られて文字が完成する。',
    stagger: 0.6,
    pose: (p) => ({ opacity: clamp01(p * 5), stroke: (1 - smooth(0.6, 1, p)) * LINE_EM, fill: smooth(0.45, 1, p), clip: [0, (1 - smooth(0, 0.5, p)) * 100, 0, 0] }),
  },
  'outline-fill': {
    ja: '輪郭→塗り',
    desc: '白抜きの輪郭で現れ、ある瞬間にぱっと塗りつぶされる。ポスターのような切り替え。',
    stagger: 0.4,
    pose: (p) => ({ opacity: clamp01(p * 4), stroke: p < 0.65 ? LINE_EM : 0, fill: p < 0.65 ? 0 : 1, scale: p < 0.65 ? 1 : 1 + (1 - outBack((p - 0.65) / 0.35)) * 0.1 }),
  },
  'key-first': {
    ja: 'キー字先行',
    desc: '行の中の一文字だけが先に大きく現れ、あとから残りの文字が揃う。言葉の核を先に見せる。',
    order: 'all',
    stagger: 0,
    pose: (p, g) => {
      const q = isKey(g) ? clamp01(p * 2.5) : clamp01((p - 0.45) / 0.55)
      const k = 1 - outCubic(q)
      return { opacity: outCubic(q), y: k * 0.5, scale: isKey(g) ? 1 + k * 0.6 : 1 }
    },
  },
  'line-wipe': {
    ja: '行送りワイプ',
    desc: '一文字ずつ、左から右へ塗られるように現れていく。読む速さで文字が生まれる。',
    stagger: 0.95,
    pose: (p) => ({ clip: [0, (1 - p) * 100, 0, 0] }),
  },
  'zoom-one': {
    ja: '一字ずつ拡大',
    desc: '一文字ずつが大きく現れては所定の大きさに収まり、次の文字へ移る。',
    stagger: 0.85,
    pose: (p) => ({ scale: 1 + (1 - outQuart(p)) * 1.4, opacity: clamp01(p * 3) }),
  },
  'under-lift': {
    ja: '下線から立つ',
    desc: '文字が下の線から背を伸ばすように立ち上がる。地面から芽が出るような登場。',
    stagger: 0.5,
    origin: '50% 100%',
    pose: (p) => ({ sy: Math.max(0, outBack(p)), opacity: clamp01(p * 6) }),
  },
  'dot-grow': {
    ja: '点から字',
    desc: 'まず小さな点が打たれ、それがふくらんで文字になる。句読点から言葉が生まれる。',
    order: 'random',
    stagger: 0.6,
    pose: (p) => (p < 0.4 ? { scale: 0.1, opacity: clamp01(p * 6) } : { scale: 1 - 0.9 * (1 - outBack((p - 0.4) / 0.6)) }),
  },
  'bracket-open': {
    ja: '括弧が開く',
    desc: '行の中央に畳まれていた文字が、括弧が開くように左右へ広がって並ぶ。',
    order: 'all',
    stagger: 0,
    pose: (p, g) => ({ x: -fromMiddle(g) * (1 - outExpo(p)), opacity: clamp01(p * 3) }),
  },
  retype: {
    ja: '打ち直し',
    desc: '一文字ずつ打たれるが、ところどころ打ち間違えては消し、正しい字に打ち直す。',
    stagger: 0.9,
    pose: (p, g) => {
      if (p <= 0) return { opacity: 0 }
      if (p >= 1) return {}
      const wrong = hash01(g.seed, g.i, SALT_WRONG) < 0.35
      if (!wrong) return { opacity: p > 0.2 ? 1 : 0 }
      if (p < 0.45) return { char: poolChar(WRONG_POOL, g, 0, SALT_WRONG), opacity: p > 0.15 ? 1 : 0 }
      if (p < 0.65) return { opacity: 0 }
      return {}
    },
  },
  'ruby-drop': {
    ja: 'ルビから',
    desc: 'ルビのように小さく上に置かれた文字が、本文の位置へ降りてきて大きくなる。',
    stagger: 0.55,
    pose: (p) => {
      const k = 1 - outCubic(p)
      return { scale: 1 - k * 0.65, y: -k * 1.1, opacity: clamp01(p * 3) }
    },
  },
} satisfies Record<string, TransitionRecipe>

// ------------------------------------------------------------------ typographic: hold

export const TYPE_HOLD = {
  'key-pulse': {
    ja: '一字の鼓動',
    desc: '行の中の一文字だけが、拍に合わせて脈を打つ。言葉の心臓。',
    pose: (t, g, beat) => (isKey(g) ? { scale: 1 + Math.exp(-frac(t / beat) * 6) * 0.14 } : {}),
  },
  'read-cursor': {
    ja: '読み送り',
    desc: '読む速さで、光る印が一文字ずつ行の上を進んでいく。朗読、字幕、カラオケの手前。',
    pose: (t, g) => {
      const at = Math.floor(t * 4) % Math.max(1, g.n + 3)
      return at === g.i ? { bright: 1.5, glow: 0.2, y: -0.04 } : {}
    },
  },
  'outline-blink': {
    ja: '白抜き明滅',
    desc: '拍ごとに、文字が塗りと白抜きを交互に行き来する。看板の点滅のようなリズム。',
    pose: (t, _g, beat) => (Math.floor(t / beat) % 2 ? { stroke: LINE_EM, fill: 0 } : {}),
  },
  'track-step': {
    ja: '字間ステップ',
    desc: '拍ごとに字間がカクッと開いて閉じる。文字が呼吸するような、機械的なリズム。',
    pose: (t, g, beat) => ({ x: fromMiddle(g) * (Math.floor(t / beat) % 2 ? 0.08 : 0) }),
  },
} satisfies Record<string, HoldRecipe>

// ------------------------------------------------------------------ typographic: exit

export const TYPE_EXIT = {
  'strike-out': {
    ja: '線で消す',
    desc: '文字が一本の線に潰れ、その線が右から縮んで消える。書いた言葉を線で消すように。',
    stagger: 0.3,
    pose: (p) => {
      const squash = smooth(0, 0.45, p) * 46
      const cut = smooth(0.45, 1, p) * 100
      return { clip: [squash, 0, squash, cut] }
    },
  },
  'to-dot': {
    ja: '点に戻る',
    desc: '文字が小さな点に縮み、その点も消える。言葉が句読点に還っていく。',
    order: 'random',
    stagger: 0.6,
    pose: (p) => ({ scale: 1 - smooth(0, 0.6, p) * 0.9, opacity: 1 - smooth(0.7, 1, p) }),
  },
  'line-feed': {
    ja: '改行送り',
    desc: '行全体が一行分、上へ送られて消える。次の行のために紙を送るように。',
    order: 'all',
    stagger: 0,
    pose: (p) => ({ y: -outCubic(p) * 1.25, opacity: 1 - smooth(0.2, 0.8, p) }),
  },
  'bracket-close': reversed(TYPE_ENTER['bracket-open'], { ja: '括弧閉じ', desc: '文字が行の中央へ畳まれるように集まり、閉じた括弧の中に消える。' }),
  'to-index': {
    ja: '番号に変わる',
    desc: '文字が自分の順番の数字に変わり、その数字も消える。言葉が記号に還元される。',
    order: 'ltr',
    stagger: 0.5,
    pose: (p, g) => (p <= 0 ? {} : { char: g.char.trim() === '' ? g.char : DIGITS[(g.i + 1) % 10], opacity: 1 - smooth(0.5, 1, p), scale: 1 - p * 0.3 }),
  },
  'under-sink': {
    ja: '下線へ沈む',
    desc: '文字が背を縮めて、下の線に吸い込まれるように消える。',
    stagger: 0.5,
    origin: '50% 100%',
    pose: (p) => ({ sy: 1 - inCubic(p) }),
  },
  'fold-vert': {
    ja: '縦組に折れる',
    desc: '文字が一つずつ九十度倒れて縦に折りたたまれ、消える。横組みから縦組みへ。',
    stagger: 0.6,
    origin: '0% 100%',
    pose: (p) => ({ rotate: outCubic(p) * 90, opacity: 1 - smooth(0.5, 1, p) }),
  },
  unstroke: reversed(
    {
      ja: '',
      desc: '',
      stagger: 0.6,
      pose: (p) => ({ opacity: clamp01(p * 5), stroke: (1 - smooth(0.6, 1, p)) * LINE_EM, fill: smooth(0.45, 1, p), clip: [0, (1 - smooth(0, 0.5, p)) * 100, 0, 0] }),
    },
    { ja: '塗りから線画', desc: '塗りが抜けて輪郭線だけになり、その線も消えていく。完成した文字を解体する。' },
  ),
} satisfies Record<string, TransitionRecipe>
