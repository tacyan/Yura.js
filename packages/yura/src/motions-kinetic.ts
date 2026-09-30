import type { HoldRecipe, LayoutRecipe, MotionGlyph, TransitionRecipe } from './motions'
import {
  hash01,
  clamp01,
  signedHash,
  frac,
  bump,
  smooth,
  ring,
  TAU,
  outCubic,
  outQuart,
  outExpo,
  outBack,
  outBounce,
  inCubic,
  inQuad,
  inExpo,
  inBack,
  fromMiddle,
  sideOf,
  poolChar,
  reversed,
} from './motion-kit'

/**
 * キネティック — the kinetic-typography pack: the weight, momentum and
 * mechanics of motion-graphics type. Slams that squash on impact, whips
 * with motion blur, hinges, split-flap boards, zippers, magnets, pixel
 * decoders — plus layouts that set a line on an arc, a wave, a floor in
 * perspective or split around a free centre (for projecting onto an
 * object that must stay unlit).
 */

const SALT_ANGLE = 301
const SALT_DIST = 302
const SALT_SPIN = 303
const SALT_CHAR = 304
const SALT_QUAKE = 305
const SALT_JITTER = 306

/** Characters a split-flap (solari) board rolls through before it lands. */
const SOLARI_POOL: readonly string[] = Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
/** Block shades a pixel decoder steps through, densest last. */
const PIXEL_POOL: readonly string[] = ['░', '▒', '▓', '█']
/** Flaps a split-flap board turns per glyph over one phase. */
const SOLARI_FLAPS = 8
/** Travel for whips and magnets, em. */
const WHIP_EM = 4
/** Scale a slam starts from. */
const SLAM_FROM = 4
/** Radius for shattered fragments, em. */
const SHATTER_EM = 3.5

const angleOf = (g: MotionGlyph): number => hash01(g.seed, g.i, SALT_ANGLE) * TAU

// ------------------------------------------------------------------ enter

export const KINETIC_ENTER = {
  slam: {
    ja: '叩きつけ',
    desc: '巨大な文字が画面に叩きつけられ、衝撃でぐしゃっと潰れてから戻る。最強の決め。',
    order: 'all',
    stagger: 0,
    origin: '50% 100%',
    pose: (p) => {
      if (p < 0.45) {
        const q = p / 0.45
        return { scale: SLAM_FROM - (SLAM_FROM - 1) * inQuad(q), opacity: clamp01(q * 8), blur: (1 - q) * 0.15 }
      }
      const w = ring((p - 0.45) / 0.55, 1.5, 3)
      return { sy: 1 - w * 0.35, sx: 1 + w * 0.25 }
    },
  },
  'whip-in': {
    ja: 'ホイップ',
    desc: '残像を引きながら横から鋭く振り込まれ、ぴたりと止まる。',
    stagger: 0.3,
    pose: (p) => {
      const k = 1 - outExpo(p)
      return { x: -k * WHIP_EM, skew: -(1 - outCubic(p)) * 25, blur: k * 0.15, opacity: clamp01(p * 4) }
    },
  },
  unfold: {
    ja: '展開',
    desc: '上辺を軸に、手前に折られていた文字がぱたんと開く。ポップアップ絵本のような登場。',
    stagger: 0.5,
    origin: '50% 0%',
    pose: (p) => ({ rx: -(1 - outBack(p)) * 90, opacity: clamp01(p * 3) }),
  },
  'swing-in': {
    ja: '振り子',
    desc: '上から吊られた看板のように、大きく揺れながら振れ幅を小さくして止まる。',
    stagger: 0.5,
    origin: '50% 0%',
    pose: (p) => ({ rotate: 70 * Math.cos(p * 3 * Math.PI) * (1 - p) ** 2, opacity: clamp01(p * 4) }),
  },
  cascade: {
    ja: '滝落ち',
    desc: '順不同に上から降り注ぎ、滝の水が溜まるように行が埋まる。',
    order: 'random',
    stagger: 0.7,
    pose: (p) => {
      const k = 1 - outCubic(p)
      return { y: -k * 4, sy: 1 + k * 0.5, blur: k * 0.1, opacity: clamp01(p * 3) }
    },
  },
  'jump-in': {
    ja: '跳び込み',
    desc: '左下から放物線を描いて跳び込み、くるりと回って着地する。',
    stagger: 0.6,
    pose: (p) => ({ x: -(1 - p) * 1.5, y: -bump(p) * 1.2 + (1 - p) * 0.8, rotate: -(1 - outCubic(p)) * 90, opacity: clamp01(p * 4) }),
  },
  'depth-in': {
    ja: '奥から',
    desc: 'はるか奥の小さな点から、ぼけを抜けて手前の定位置まで飛んでくる。',
    stagger: 0.4,
    pose: (p) => {
      const k = 1 - outExpo(p)
      return { scale: 1 - 0.9 * k, blur: k * 0.3, opacity: clamp01(p * 2) }
    },
  },
  'flip-3d': {
    ja: '裏返し',
    desc: '裏を向いていた札が、立体的に半回転して表を見せる。',
    stagger: 0.5,
    pose: (p) => ({ ry: (1 - outBack(p)) * 180, opacity: clamp01((p - 0.2) * 5) }),
  },
  'roll-in': {
    ja: '転がり',
    desc: 'タイヤのように一回転しながら左から転がってきて止まる。',
    stagger: 0.5,
    pose: (p) => {
      const k = 1 - outCubic(p)
      return { x: -k * 3, rotate: -k * 360, opacity: clamp01(p * 3) }
    },
  },
  'shatter-in': {
    ja: '破片集合',
    desc: 'ばらばらに回転していた破片が一斉に集まり、一枚の文字に組み上がる。',
    order: 'random',
    stagger: 0.4,
    pose: (p, g) => {
      const k = 1 - outQuart(p)
      const a = angleOf(g)
      const r = (0.5 + hash01(g.seed, g.i, SALT_DIST)) * SHATTER_EM * k
      return { x: Math.cos(a) * r, y: Math.sin(a) * r, rotate: signedHash(g.seed, g.i, SALT_SPIN) * 540 * k, rx: k * 60, blur: k * 0.1, opacity: clamp01(p * 3) }
    },
  },
  'iris-in': {
    ja: '絞り開き',
    desc: 'カメラの絞りが開くように、四方から枠が開いて文字が見えてくる。',
    stagger: 0.4,
    pose: (p) => {
      const c = (1 - outCubic(p)) * 50
      return { clip: [c, c, c, c] }
    },
  },
  solari: {
    ja: 'パタパタ',
    desc: '駅の発車標のように、札が何度もめくれて文字が切り替わり、最後に正しい文字で止まる。',
    stagger: 0.6,
    origin: '50% 50%',
    pose: (p, g) => {
      if (p <= 0) return { opacity: 0 }
      if (p >= 1) return {}
      const step = Math.floor(p * SOLARI_FLAPS)
      return { char: poolChar(SOLARI_POOL, g, step, SALT_CHAR), rx: -frac(p * SOLARI_FLAPS) * 70 }
    },
  },
  'stretch-in': {
    ja: '伸縮',
    desc: '横に引き伸ばされた薄い文字が、ぎゅっと縮んで本来の形に戻る。',
    stagger: 0.35,
    pose: (p) => {
      const k = 1 - outExpo(p)
      return { sx: 1 + k * 3, sy: 1 - k * 0.7, opacity: clamp01(p * 3) }
    },
  },
  'vortex-in': {
    ja: '渦巻き',
    desc: '大きな渦の外側から回り込みながら中心へ吸い寄せられ、文字になる。',
    stagger: 0.5,
    pose: (p, g) => {
      const k = 1 - outCubic(p)
      const a = angleOf(g) + k * TAU * 1.5
      return { x: Math.cos(a) * k * 2.5, y: Math.sin(a) * k * 2.5, rotate: k * 720, scale: outCubic(p) }
    },
  },
  rubber: {
    ja: 'ゴムの引き',
    desc: '左から引っ張られたゴムのように飛んできて、行き過ぎて伸び縮みしてから止まる。',
    stagger: 0.4,
    origin: '0% 50%',
    pose: (p) => ({ x: -(1 - outExpo(p)) * 1.2, sx: 1 + ring(p, 1.5, 2) * 0.6, opacity: clamp01(p * 5) }),
  },
  'heartbeat-in': {
    ja: '鼓動出現',
    desc: 'ドクン、ドクンと二度脈打つように膨らんで現れる。心の動きを見せる登場。',
    order: 'all',
    stagger: 0,
    pose: (p) => ({ scale: 1 + ring(p, 2, 2) * 0.3, opacity: clamp01(p * 6) }),
  },
  origami: {
    ja: '折り紙',
    desc: '斜めに折りたたまれていた紙が開くように、二つの軸で回転して正面を向く。',
    stagger: 0.5,
    pose: (p) => {
      const k = 1 - outCubic(p)
      return { rx: k * 90, ry: -k * 60, opacity: clamp01(p * 2.5) }
    },
  },
  zipper: {
    ja: 'ジッパー',
    desc: '一文字おきに上と下から交互に閉じていく。ファスナーを閉めるような噛み合わせ。',
    stagger: 0.6,
    pose: (p, g) => ({ y: (g.i % 2 ? 1 : -1) * (1 - outExpo(p)) * 1.5, opacity: clamp01(p * 3) }),
  },
  'split-in': {
    ja: '左右から',
    desc: '行の左半分は左から、右半分は右から寄ってきて、中央で一つになる。',
    order: 'edges',
    stagger: 0.4,
    pose: (p, g) => ({ x: sideOf(g) * (1 - outExpo(p)) * 3, opacity: clamp01(p * 3) }),
  },
  thud: {
    ja: 'ドスン',
    desc: '重い文字が真上から重力のままに落ちてきて、床でわずかに潰れる。',
    stagger: 0.5,
    origin: '50% 100%',
    pose: (p) => {
      if (p < 0.7) {
        const q = p / 0.7
        return { y: -3 * (1 - q * q), opacity: clamp01(q * 4) }
      }
      const w = ring((p - 0.7) / 0.3, 1, 3)
      return { sy: 1 - w * 0.25, sx: 1 + w * 0.15 }
    },
  },
  'blinds-in': {
    ja: 'ブラインド',
    desc: '一文字おきに上から・下から幕が開いて現れる。交互に開くリズムが気持ちいい。',
    stagger: 0.5,
    pose: (p, g) => {
      const c = (1 - outCubic(p)) * 100
      return { clip: g.i % 2 ? [0, 0, c, 0] : [c, 0, 0, 0] }
    },
  },
  pixel: {
    ja: 'ドット化',
    desc: '粗いブロックの濃淡が詰まっていき、最後に本来の文字に確定する。ゲーム画面のようなデジタル感。',
    order: 'random',
    stagger: 0.6,
    pose: (p, g) => {
      if (p <= 0) return { opacity: 0 }
      if (p >= 1) return {}
      return { char: g.char.trim() === '' ? g.char : PIXEL_POOL[Math.min(PIXEL_POOL.length - 1, Math.floor(p * PIXEL_POOL.length))] }
    },
  },
  magnet: {
    ja: '磁力',
    desc: '右の遠くから磁石に引かれるように飛んできて、少し行き過ぎてから吸い付く。',
    stagger: 0.4,
    pose: (p) => ({ x: (1 - outBack(p)) * WHIP_EM, opacity: clamp01(p * 3) }),
  },
  'bounce-in': {
    ja: '床で弾む',
    desc: '一文字ずつ高く跳ね上がってから落ち、何度か弾んで止まる。子どもが跳ねるような楽しさ。',
    order: 'random',
    stagger: 0.6,
    pose: (p) => ({ y: -(1 - outBounce(p)) * 1.6, sy: 1 + (1 - p) * 0.15, opacity: clamp01(p * 5) }),
  },
} satisfies Record<string, TransitionRecipe>

// ------------------------------------------------------------------ hold

export const KINETIC_HOLD = {
  swing: {
    ja: '振り子',
    desc: '上から吊られたように、一文字ずつが小さく左右に揺れ続ける。',
    origin: '50% 0%',
    pose: (t, g) => ({ rotate: Math.sin(t * 2 + g.i * 0.3) * 6 }),
  },
  bob: {
    ja: '上下',
    desc: '二拍でひと往復、行全体がゆったり上下にリズムを取る。',
    pose: (t, _g, beat) => ({ y: Math.sin((t / (beat * 2)) * TAU) * 0.06 }),
  },
  tilt: {
    ja: '傾き',
    desc: '行全体がゆっくり右へ左へ傾く。揺れる船の上のような浮遊感。',
    pose: (t) => ({ rotate: Math.sin(t * 0.5) * 3 }),
  },
  orbit: {
    ja: '公転',
    desc: '一文字ずつが自分の位置のまわりを小さな円を描いて回る。',
    pose: (t, g) => ({ x: Math.cos(t * 2 + g.i) * 0.05, y: Math.sin(t * 2 + g.i) * 0.05 }),
  },
  stretch: {
    ja: '拍で伸縮',
    desc: '拍の頭で縦にびよんと伸び、すぐ戻る。アニメーションの弾性表現。',
    origin: '50% 100%',
    pose: (t, _g, beat) => {
      const e = Math.exp(-frac(t / beat) * 6)
      return { sy: 1 + e * 0.15, sx: 1 - e * 0.08 }
    },
  },
  quake: {
    ja: '地響き',
    desc: '拍ごとに地面が揺れたように、行全体がドンとぶれて収まる。',
    pose: (t, g, beat) => {
      const k = Math.floor(t / beat)
      const e = Math.exp(-frac(t / beat) * 8)
      return { x: signedHash(g.seed, k, SALT_QUAKE) * 0.24 * e, y: signedHash(g.seed, k, SALT_QUAKE + 1) * 0.16 * e }
    },
  },
  wobble: {
    ja: 'ぐらぐら',
    desc: '一文字ずつが落ち着きなくぐらぐら揺れる。酔い、戸惑い、ふざけた気分。',
    pose: (t, g) => ({ rotate: Math.sin(t * 5 + g.i * 1.1) * 3, skew: Math.sin(t * 4 + g.i) * 2 }),
  },
  heartbeat: {
    ja: '心拍',
    desc: '二拍ごとに「ドクン、ドクン」と二度脈打つ。緊張や恋の鼓動。',
    pose: (t, _g, beat) => {
      const v = frac(t / (beat * 2))
      const s = Math.exp(-v * 14) + (v > 0.18 ? Math.exp(-(v - 0.18) * 14) * 0.7 : 0)
      return { scale: 1 + s * 0.06 }
    },
  },
  rainbow: {
    ja: '虹色',
    desc: '文字ごとに色がずれながら、虹色がぐるぐる巡り続ける。',
    pose: (t, g) => ({ hue: ((t * 90 + g.i * 30) % 360) - 180 }),
  },
  levitate: {
    ja: '浮揚',
    desc: '行全体が少し持ち上がった位置で、重さを失ったようにふわりと浮かぶ。',
    pose: (t) => ({ y: -0.05 - Math.sin(t * 1.2) * 0.04, scale: 1.01 }),
  },
  vibrate: {
    ja: '振動',
    desc: '携帯の着信のように、細かく速く横に震え続ける。',
    pose: (t) => ({ x: Math.sin(t * 60) * 0.015 }),
  },
  tremble: {
    ja: '震え',
    desc: '一文字ずつがおびえるように小刻みに傾く。寒さや恐れ、張り詰めた声。',
    pose: (t, g) => ({ rotate: signedHash(g.seed, g.i * 89 + Math.floor(t * 12), SALT_JITTER) * 3 }),
  },
  spin: {
    ja: '順に回る',
    desc: '四拍ごとに一文字ずつ順番に、くるりと一回転する。',
    pose: (t, g, beat) => {
      const cycle = t / (beat * 4)
      if (Math.floor(cycle) % Math.max(1, g.n) !== g.i) return {}
      return { ry: outCubic(clamp01(frac(cycle) * 3)) * 360 }
    },
  },
  spring: {
    ja: '弾み',
    desc: '拍に合わせて一文字ずつ少しずれて、ぽんぽんと弾み続ける。',
    pose: (t, g, beat) => ({ y: -Math.abs(Math.sin(((t / beat) + g.rank * 0.5) * Math.PI)) * 0.1 }),
  },
  glide: {
    ja: '横流れ',
    desc: '行全体がゆっくり左右に流れる。視線を横へ誘う、映像的なドリフト。',
    pose: (t) => ({ x: Math.sin(t * 0.25) * 0.3 }),
  },
  kick: {
    ja: 'キック',
    desc: '一拍おきのキックに合わせて、行全体が強く押し出される。',
    pose: (t, _g, beat) => {
      const k = Math.floor(t / beat)
      if (k % 2) return {}
      const e = Math.exp(-frac(t / beat) * 10)
      return { scale: 1 + e * 0.12, y: e * 0.03 }
    },
  },
  'sway-3d': {
    ja: '立体の揺れ',
    desc: '一文字ずつが縦軸のまわりで、立体的にゆっくり首を振る。',
    pose: (t, g) => ({ ry: Math.sin(t * 1.2 + g.i * 0.4) * 20 }),
  },
  ticktock: {
    ja: '時計',
    desc: '拍ごとにカチッ、カチッと左右へ交互に傾く。時を刻む秒針のような律動。',
    pose: (t, _g, beat) => ({ rotate: (Math.floor(t / beat) % 2 ? 1 : -1) * 4 * (1 - Math.exp(-frac(t / beat) * 20)) }),
  },
} satisfies Record<string, HoldRecipe>

// ------------------------------------------------------------------ exit

export const KINETIC_EXIT = {
  'slam-out': {
    ja: '叩き落とし',
    desc: '上から叩かれたように一気に下へ落ち、画面の外へ消える。',
    order: 'all',
    stagger: 0,
    origin: '50% 100%',
    pose: (p) => ({ y: inExpo(p) * 5, sy: 1 + p * 0.5, opacity: 1 - smooth(0.7, 1, p) }),
  },
  'whip-out': {
    ja: 'ホイップ退場',
    desc: '残像を引きながら右へ鋭く振り抜けて消える。',
    stagger: 0.3,
    pose: (p) => ({ x: inExpo(p) * 5, skew: p * 25, blur: p * 0.2, opacity: 1 - inQuad(p) }),
  },
  'roll-out': {
    ja: '転がり退場',
    desc: '一回転しながら右へ転がっていって消える。',
    stagger: 0.5,
    pose: (p) => ({ x: inCubic(p) * 3, rotate: inCubic(p) * 360, opacity: 1 - inCubic(p) }),
  },
  hinge: {
    ja: '蝶番外れ',
    desc: '片方の留め具が外れたようにぶら下がり、やがて落ちていく。',
    order: 'random',
    stagger: 0.5,
    origin: '0% 0%',
    pose: (p) => ({ rotate: 80 * outBack(Math.min(1, p * 2)), y: inQuad(Math.max(0, p * 2 - 1)) * 4, opacity: 1 - smooth(0.6, 1, p) }),
  },
  fold: {
    ja: '折りたたみ',
    desc: '上辺を軸に、文字が手前へぱたんと折りたたまれて見えなくなる。',
    stagger: 0.5,
    origin: '50% 0%',
    pose: (p) => ({ rx: -inCubic(p) * 90, opacity: 1 - inCubic(p) }),
  },
  shatter: {
    ja: '粉砕',
    desc: 'ガラスが割れるように、回転する破片になって四方へ砕け散る。',
    order: 'all',
    stagger: 0,
    pose: (p, g) => {
      const a = angleOf(g)
      const r = (0.5 + hash01(g.seed, g.i, SALT_DIST)) * SHATTER_EM * outCubic(p)
      return { x: Math.cos(a) * r, y: Math.sin(a) * r + inQuad(p) * 2, rotate: signedHash(g.seed, g.i, SALT_SPIN) * 540 * p, rx: p * 80, scale: 1 - p * 0.5, opacity: 1 - inQuad(p) }
    },
  },
  'blow-away': {
    ja: '風に飛ばされる',
    desc: '左から吹いた風に、文字が順にさらわれて回りながら飛んでいく。',
    stagger: 0.7,
    pose: (p, g) => ({ x: outCubic(p) * 4 + Math.sin(p * TAU) * 0.2, y: -p * 1.5 * hash01(g.seed, g.i, SALT_DIST), rotate: p * signedHash(g.seed, g.i, SALT_SPIN) * 400, opacity: 1 - p }),
  },
  'vortex-out': {
    ja: '渦に消える',
    desc: '回転しながら小さくなって、渦の中心へ吸い込まれる。',
    stagger: 0.4,
    pose: (p) => ({ rotate: p * 720, scale: 1 - inCubic(p), opacity: 1 - inQuad(p) }),
  },
  'stretch-out': {
    ja: '伸びて消える',
    desc: '横に一気に引き伸ばされ、紙のように薄くなって消える。',
    stagger: 0.35,
    pose: (p) => ({ sx: 1 + inExpo(p) * 4, sy: 1 - inCubic(p) }),
  },
  'solari-out': reversed(KINETIC_ENTER.solari, { ja: 'パタパタ消去', desc: '札がめくれ続けて意味のない記号になり、最後に消える。' }),
  implode: {
    ja: '収縮',
    desc: '文字が行の中心へ一気に吸い寄せられ、光る一点になって消える。',
    order: 'all',
    stagger: 0,
    pose: (p, g) => ({ x: -fromMiddle(g) * inCubic(p), scale: 1 - inCubic(p), bright: 1 + p * 2 }),
  },
  'depth-out': {
    ja: '奥へ飛ぶ',
    desc: 'ぼけながら奥へ一直線に飛び去り、遠くの点になって消える。',
    stagger: 0.4,
    pose: (p) => ({ scale: 1 - 0.9 * inExpo(p), blur: p * 0.3, opacity: 1 - p }),
  },
  'pixel-out': reversed(KINETIC_ENTER.pixel, { ja: 'ドット崩し', desc: '文字が粗いブロックにほどけ、薄くなって消える。' }),
  'iris-out': reversed(KINETIC_ENTER['iris-in'], { ja: '絞り閉じ', desc: 'カメラの絞りが閉じるように、四方から枠が迫って消える。' }),
  'zipper-out': reversed(KINETIC_ENTER.zipper, { ja: 'ジッパー開き', desc: '一文字おきに上と下へ交互に開いて抜けていく。' }),
  'split-out': {
    ja: '左右へ割れる',
    desc: '行が中央から裂けて、左右へ離れていき消える。',
    order: 'center',
    stagger: 0.4,
    pose: (p, g) => ({ x: sideOf(g) * inCubic(p) * 3, opacity: 1 - inQuad(p) }),
  },
  'drop-out': {
    ja: '床抜け',
    desc: '床が抜けたように、順不同にすとんと下へ落ちて消える。',
    order: 'random',
    stagger: 0.6,
    pose: (p) => ({ y: inQuad(p) * 4, opacity: 1 - smooth(0.5, 1, p) }),
  },
  'flip-out': {
    ja: '裏返って消える',
    desc: '札を裏返すように横に半回転し、裏になった瞬間に消える。',
    stagger: 0.5,
    pose: (p) => ({ ry: inCubic(p) * 180, opacity: 1 - clamp01((p - 0.4) * 2.5) }),
  },
  'magnet-out': {
    ja: '引き寄せられる',
    desc: '一瞬ためてから、左の遠くへ磁石に引かれるように吸い取られる。',
    stagger: 0.4,
    pose: (p) => ({ x: -Math.max(0, inBack(p)) * WHIP_EM + Math.min(0, inBack(p)) * -0.5, opacity: 1 - inQuad(p) }),
  },
  'jump-out': {
    ja: '跳び去る',
    desc: '放物線を描いて右上へ跳んでいき、回りながら消える。',
    stagger: 0.5,
    pose: (p) => ({ x: p * 1.5, y: -bump(p) * 1.2 + p * 0.6, rotate: inCubic(p) * 120, opacity: 1 - smooth(0.6, 1, p) }),
  },
} satisfies Record<string, TransitionRecipe>

// ------------------------------------------------------------------ layout

const CENTER_BOX = { justifyContent: 'center', alignItems: 'center', textAlign: 'center' } as const
/** Gap (em each side) a split layout leaves around the centre of the frame. */
const SPLIT_GAP_EM = 1.4

export const KINETIC_LAYOUT = {
  upper: {
    ja: '上部',
    desc: '画面の上寄りに置く。下半分を映像や被写体に明け渡す配置。',
    box: { justifyContent: 'center', alignItems: 'flex-start', textAlign: 'center', paddingTop: '9%' },
    fontScale: 0.7,
  },
  corner: {
    ja: '左下隅',
    desc: '左下の隅に小さく置く。映画のクレジットのような控えめさ。',
    box: { justifyContent: 'flex-start', alignItems: 'flex-end', textAlign: 'left', padding: '0 0 7% 7%' },
    fontScale: 0.6,
  },
  'corner-right': {
    ja: '右上隅',
    desc: '右上の隅に置く。ミュージックビデオの曲名表示のような位置取り。',
    box: { justifyContent: 'flex-end', alignItems: 'flex-start', textAlign: 'right', padding: '7% 7% 0 0' },
    fontScale: 0.6,
  },
  arc: {
    ja: '弧',
    desc: '行の両端が下がる、ゆるやかな弧に並べる。空や虹を見上げるような形。',
    box: CENTER_BOX,
    offset: (g) => {
      const l = g.n <= 1 ? 0 : (g.i / (g.n - 1)) * 2 - 1
      return { x: 0, y: l * l * 0.5 - 0.25 }
    },
  },
  bowl: {
    ja: '器',
    desc: '行の中央が沈む、お椀の形に並べる。水をすくうようなやわらかい形。',
    box: CENTER_BOX,
    offset: (g) => {
      const l = g.n <= 1 ? 0 : (g.i / (g.n - 1)) * 2 - 1
      return { x: 0, y: 0.25 - l * l * 0.5 }
    },
  },
  'wave-row': {
    ja: '波組',
    desc: '文字が波の形に上下して並ぶ。水辺や音の揺れを組み方そのものに込める。',
    box: CENTER_BOX,
    offset: (g) => ({ x: 0, y: Math.sin(g.i * 0.9) * 0.25 }),
  },
  ascend: {
    ja: '右上がり',
    desc: '文字が一つずつ右上へ上がっていく。前向きで、上昇していく気分。',
    box: CENTER_BOX,
    offset: (g) => ({ x: 0, y: -fromMiddle(g) * 0.14 }),
  },
  zigzag: {
    ja: 'ジグザグ',
    desc: '一文字おきに上下へずらして置く。ポップで跳ねるような落ち着かなさ。',
    box: CENTER_BOX,
    offset: (g) => ({ x: 0, y: g.i % 2 ? 0.18 : -0.18 }),
  },
  spread: {
    ja: '字間ゆったり',
    desc: '字間を大きく開けて組む。静かで上品、呼吸の長い言葉に。',
    box: { ...CENTER_BOX, letterSpacing: '0.35em' },
    fontScale: 0.85,
  },
  condensed: {
    ja: '長体',
    desc: '文字を縦長に詰めて大きく組む。ポスターの見出しのような緊張感。',
    box: { ...CENTER_BOX, transform: 'scaleX(0.72)', letterSpacing: '-0.02em' },
    fontScale: 1.35,
  },
  split: {
    ja: '中央を空ける',
    desc: '行を左右に分けて、画面の中央を空けておく。人物や投影対象の上に文字を重ねたくないときに。',
    box: CENTER_BOX,
    offset: (g) => ({ x: sideOf(g) * SPLIT_GAP_EM, y: 0 }),
  },
  'vertical-left': {
    ja: '縦書き左寄せ',
    desc: '縦に組んで左側に置く。右に余白を残す、手紙の追伸のような配置。',
    box: { justifyContent: 'flex-start', alignItems: 'center', writingMode: 'vertical-rl', textAlign: 'start', paddingLeft: '10%' },
  },
  'vertical-right': {
    ja: '縦書き右寄せ',
    desc: '縦に組んで右側に置く。縦書きの読み始めの位置で、和書の一ページ目のよう。',
    box: { justifyContent: 'flex-end', alignItems: 'center', writingMode: 'vertical-rl', textAlign: 'start', paddingRight: '10%' },
  },
  headline: {
    ja: '大見出し',
    desc: '左に寄せて大きく、行間を詰めて組む。雑誌の表紙や広告のコピーのような強さ。',
    box: { justifyContent: 'flex-start', alignItems: 'center', textAlign: 'left', paddingLeft: '6%', lineHeight: '0.95' },
    fontScale: 1.6,
  },
  'tilt-right': {
    ja: '逆斜め',
    desc: '行全体を右上がりにわずかに傾ける。勢いを前に向ける斜め組。',
    box: { ...CENTER_BOX, transform: 'rotate(6deg)' },
  },
  floor: {
    ja: '床置き',
    desc: '奥へ倒した床の上に文字を置く。遠くへ流れていく映画のオープニングのような奥行き。',
    box: { ...CENTER_BOX, transform: 'perspective(40em) rotateX(32deg)' },
    fontScale: 1.2,
  },
  wall: {
    ja: '壁面',
    desc: '斜めに向いた壁に文字を貼る。建物の側面に投影したような立体感。',
    box: { ...CENTER_BOX, transform: 'perspective(40em) rotateY(-26deg)' },
    fontScale: 1.1,
  },
} satisfies Record<string, LayoutRecipe>
