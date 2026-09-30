import { hash01, clamp01, outCubic, outExpo, inCubic } from './motion-kit'

/**
 * 画面効果 — screen effects over a whole frame: glitches (slices, blocks, RGB
 * split, VHS roll, tracking noise), camera-ish hits (zoom punch, shake,
 * whip blur, stutter, squash), light (flash, bloom, anamorphic streak, light
 * sweep, film burn, god rays), print and screen looks (halftone, duotone,
 * posterize, 1-bit dither, interlace, mosaic, edge detect), manga marks
 * (focus lines, speed lines, sparkle), and endings (CRT switch-off, shutter).
 *
 * An effect is a pure function of its own progress `p` (0..1 over its
 * duration): it returns a style for the picture itself (`root`: filter /
 * transform) and for one full-frame overlay (`overlay`). Overlays that must
 * change the picture beneath them use `backdrop-filter`; pixel-level looks use
 * the SVG filters in {@link FX_SVG_DEFS} (include that markup once). Nothing
 * here touches the DOM, so every frame of an effect is reproducible.
 */

export type Css = Record<string, string>

export interface FxFrame {
  root: Css
  overlay: Css
}

export interface FxRecipe {
  ja: string
  desc: string
  /** Default seconds the effect lasts. */
  dur: number
  frame(p: number, seed: number): Partial<FxFrame>
}

const r3 = (v: number): string => String(Math.round((Number.isFinite(v) ? v : 0) * 1000) / 1000)
const A = 'var(--yura-treat-a, var(--yura-accent, var(--f-accent, #ff3355)))'
const B = 'var(--yura-treat-b, var(--yura-accent2, var(--f-sub, #2de2e6)))'
/** 1 → 0 decay over the effect. */
const decay = (p: number, k = 4): number => Math.exp(-clamp01(p) * k)
/** 0 → 1 → 0 over the effect. */
const bell = (p: number): number => Math.sin(clamp01(p) * Math.PI)
/** A step index that re-rolls `hz` times over the effect (glitches). */
const step = (p: number, hz: number): number => Math.floor(clamp01(p) * hz)
const jitter = (seed: number, k: number, salt: number): number => hash01(seed, k, salt) * 2 - 1

const NOISE = `url("data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>",
)}")`

/** Horizontal bands for slice / tracking glitches, as a clip or gradient. */
function bands(seed: number, k: number, n: number): string {
  const stops: string[] = []
  for (let i = 0; i < n; i++) {
    const y = hash01(seed, k * 31 + i, 501) * 100
    const h = 0.6 + hash01(seed, k * 31 + i, 502) * 5
    stops.push(`transparent ${r3(y)}%, #000 ${r3(y)}%, #000 ${r3(y + h)}%, transparent ${r3(y + h)}%`)
  }
  return stops.map((s) => `linear-gradient(180deg, ${s})`).join(',')
}

export const screenFx = {
  flash: {
    ja: 'フラッシュ',
    desc: '画面が一瞬白く飛ぶ。決めの行、カットの頭、写真を撮った瞬間。',
    dur: 0.35,
    frame: (p) => ({ overlay: { background: 'var(--yura-flash, #ffffff)', opacity: r3(0.85 * decay(p, 5)) } }),
  },
  strobe: {
    ja: 'ストロボ',
    desc: '白い閃光が短い間隔で何度も明滅する。クラブの照明、高揚、混乱。',
    dur: 0.8,
    frame: (p) => ({ overlay: { background: '#ffffff', opacity: step(p, 10) % 2 ? '0.75' : '0' } }),
  },
  invert: {
    ja: '反転',
    desc: '一瞬だけ色が反転する。衝撃、ネガ、世界がひっくり返る。',
    dur: 0.25,
    frame: (p) => ({ root: p < 0.7 ? { filter: 'invert(1)' } : ({} as Css) }),
  },
  shake: {
    ja: '揺れ',
    desc: '画面全体が激しく揺れて収まる。衝撃、地響き、叫び。',
    dur: 0.6,
    frame: (p, s) => {
      const k = step(p, 30)
      const a = 0.8 * decay(p, 4)
      return { root: { transform: `translate(${r3(jitter(s, k, 511) * a)}em, ${r3(jitter(s, k, 512) * a)}em) rotate(${r3(jitter(s, k, 513) * a * 2)}deg)` } }
    },
  },
  'zoom-punch': {
    ja: 'ズームパンチ',
    desc: '画面がぐっと寄って、すぐ戻る。拍の頭、強調、キック。',
    dur: 0.4,
    frame: (p) => ({ root: { transform: `scale(${r3(1 + 0.14 * decay(p, 6))})` } }),
  },
  'zoom-blur': {
    ja: 'ズームブラー',
    desc: '手前へ吸い込まれるようにぼけながら拡大する。切り替え、突入、スピード。',
    dur: 0.45,
    frame: (p) => ({ root: { transform: `scale(${r3(1 + 0.3 * bell(p))})`, filter: `blur(${r3(0.25 * bell(p))}em)` } }),
  },
  'zoom-stutter': {
    ja: 'ズーム連打',
    desc: 'カクカクと段階的に三度寄る。漫画的な強調、ツッコミ、驚き。',
    dur: 0.6,
    frame: (p) => ({ root: { transform: `scale(${r3(1 + Math.min(3, step(p, 4)) * 0.08)})` } }),
  },
  'whip-blur': {
    ja: 'ホイップブラー',
    desc: '横に鋭く振られてぶれ、ぴたりと止まる。場面を勢いよく送る。',
    dur: 0.4,
    frame: (p) => ({ root: { transform: `translateX(${r3((1 - outExpo(p)) * 25)}%)`, filter: `url(#yura-fx-smear-${Math.min(3, Math.floor((1 - p) * 4))})` } }),
  },
  squash: {
    ja: '伸縮',
    desc: '画面がぐにゃっと潰れて伸び、弾んで戻る。コミカルな衝撃。',
    dur: 0.5,
    frame: (p) => {
      const w = Math.sin(p * Math.PI * 3) * decay(p, 3)
      return { root: { transform: `scale(${r3(1 + w * 0.08)}, ${r3(1 - w * 0.08)})` } }
    },
  },
  'rotate-snap': {
    ja: '傾きスナップ',
    desc: '画面が拍に合わせてカクッと傾いて戻る。ノリ、ダンス、キレ。',
    dur: 0.5,
    frame: (p, s) => ({ root: { transform: `rotate(${r3((hash01(s, 0, 521) < 0.5 ? -1 : 1) * 4 * decay(p, 5))}deg)` } }),
  },
  heartbeat: {
    ja: '鼓動',
    desc: '画面全体がドクン、ドクンと二度脈打つ。緊張、恋、命。',
    dur: 0.8,
    frame: (p) => {
      const a = Math.exp(-p * 14) + (p > 0.25 ? Math.exp(-(p - 0.25) * 14) * 0.7 : 0)
      return { root: { transform: `scale(${r3(1 + a * 0.05)})` }, overlay: { background: 'radial-gradient(circle, transparent 45%, rgba(160,0,20,0.45))', opacity: r3(a) } }
    },
  },
  'film-advance': {
    ja: 'フィルム送り',
    desc: 'コマがずれるように画面が縦に跳んで戻る。映写機、古い映画。',
    dur: 0.3,
    frame: (p) => ({ root: { transform: `translateY(${r3(p < 0.5 ? -8 * (1 - p * 2) : 0)}%)` } }),
  },
  'perspective-tilt': {
    ja: 'パース揺れ',
    desc: '画面が板のように奥へ傾いて揺り戻す。立体的な揺らぎ。',
    dur: 0.8,
    frame: (p) => ({ root: { transform: `perspective(60em) rotateX(${r3(Math.sin(p * Math.PI * 2) * 12 * decay(p, 2))}deg) rotateY(${r3(Math.sin(p * Math.PI * 3) * 8 * decay(p, 2))}deg)` } }),
  },
  defocus: {
    ja: 'ピンぼけ',
    desc: 'ピントが外れてぼやけ、また合う。回想、めまい、夢。',
    dur: 0.8,
    frame: (p) => ({ root: { filter: `blur(${r3(bell(p) * 0.4)}em)` } }),
  },
  chroma: {
    ja: '色ズレ',
    desc: '赤と青の版が左右にずれて跳ね、戻る。デジタルの乱れ、衝撃。',
    dur: 0.4,
    frame: (p) => {
      const d = r3(0.12 * decay(p, 5))
      return { root: { filter: `drop-shadow(${d}em 0 0 rgba(255,0,60,0.85)) drop-shadow(-${d}em 0 0 rgba(0,220,255,0.85))` } }
    },
  },
  'rgb-split': {
    ja: 'RGB分離',
    desc: '三原色が大きくずれて震え続ける。強いグリッチ、壊れた映像。',
    dur: 0.8,
    frame: (p, s) => {
      const k = step(p, 16)
      const d = 0.08 + 0.12 * hash01(s, k, 531)
      return { root: { filter: `drop-shadow(${r3(d)}em 0 0 rgba(255,0,0,0.8)) drop-shadow(${r3(-d)}em ${r3(d * 0.4)}em 0 rgba(0,255,120,0.6)) drop-shadow(0 ${r3(-d * 0.5)}em 0 rgba(0,80,255,0.8))` } }
    },
  },
  'radial-chroma': {
    ja: '放射色収差',
    desc: '画面の縁ほど色がにじんで外へ広がる。レンズの歪み、酩酊。',
    dur: 0.6,
    frame: (p) => ({ root: { transform: `scale(${r3(1 + 0.03 * bell(p))})`, filter: `drop-shadow(0 0 ${r3(0.15 * bell(p))}em ${B}) saturate(${r3(1 + bell(p))})` } }),
  },
  slice: {
    ja: 'スライスグリッチ',
    desc: '画面が横の帯に裂け、帯ごとに色が反転してずれる。データの破損。',
    dur: 0.5,
    frame: (p, s) => {
      const k = step(p, 12)
      return {
        root: { transform: `translateX(${r3(jitter(s, k, 541) * 3)}%) skewX(${r3(jitter(s, k, 542) * 6)}deg)` },
        overlay: { backdropFilter: 'invert(1) hue-rotate(90deg)', WebkitBackdropFilter: 'invert(1) hue-rotate(90deg)', WebkitMaskImage: bands(s, k, 4), maskImage: bands(s, k, 4), opacity: p < 0.9 ? '1' : '0' },
      }
    },
  },
  block: {
    ja: 'ブロックグリッチ',
    desc: '四角いブロックがあちこちで色化けする。圧縮ノイズ、通信の乱れ。',
    dur: 0.5,
    frame: (p, s) => {
      const k = step(p, 10)
      const rects = Array.from({ length: 6 }, (_, i) => {
        const x = hash01(s, k * 13 + i, 551) * 90
        const y = hash01(s, k * 13 + i, 552) * 90
        const w = 4 + hash01(s, k * 13 + i, 553) * 18
        const h = 2 + hash01(s, k * 13 + i, 554) * 10
        return `linear-gradient(#000, #000) ${r3(x)}% ${r3(y)}% / ${r3(w)}% ${r3(h)}% no-repeat`
      }).join(',')
      return { overlay: { backdropFilter: 'invert(1) saturate(3) hue-rotate(160deg)', WebkitBackdropFilter: 'invert(1) saturate(3) hue-rotate(160deg)', WebkitMask: rects, mask: rects, opacity: p < 0.95 ? '1' : '0' } }
    },
  },
  'band-invert': {
    ja: '帯反転',
    desc: '反転した太い帯が画面を上から下へ通り過ぎる。スキャン、切り替え。',
    dur: 0.6,
    frame: (p) => {
      const y = -20 + p * 140
      const m = `linear-gradient(180deg, transparent ${r3(y)}%, #000 ${r3(y)}%, #000 ${r3(y + 18)}%, transparent ${r3(y + 18)}%)`
      return { overlay: { backdropFilter: 'invert(1)', WebkitBackdropFilter: 'invert(1)', WebkitMaskImage: m, maskImage: m } }
    },
  },
  'negative-ring': {
    ja: '反転リング',
    desc: '中心から反転色の輪が広がって抜けていく。衝撃波、覚醒。',
    dur: 0.6,
    frame: (p) => {
      const r = outCubic(p) * 80
      const m = `radial-gradient(circle at 50% 50%, transparent ${r3(r - 8)}%, #000 ${r3(r - 8)}%, #000 ${r3(r)}%, transparent ${r3(r)}%)`
      return { overlay: { backdropFilter: 'invert(1)', WebkitBackdropFilter: 'invert(1)', WebkitMaskImage: m, maskImage: m } }
    },
  },
  'vhs-roll': {
    ja: 'VHSロール',
    desc: '画面が縦にずるっと流れ、ノイズの帯が走る。古いビデオの同期ずれ。',
    dur: 0.7,
    frame: (p) => ({ root: { transform: `translateY(${r3(Math.sin(p * Math.PI) * -12)}%)`, filter: 'saturate(1.4) contrast(1.1)' }, overlay: { backgroundImage: `linear-gradient(180deg, transparent ${r3(p * 100)}%, rgba(255,255,255,0.4) ${r3(p * 100 + 3)}%, transparent ${r3(p * 100 + 8)}%), ${NOISE}`, opacity: '0.6', mixBlendMode: 'screen' } }),
  },
  'tracking-noise': {
    ja: 'トラッキングノイズ',
    desc: 'ビデオのトラッキングがずれたように、白いノイズの線と横ずれが走る。',
    dur: 0.6,
    frame: (p, s) => {
      const k = step(p, 14)
      return { root: { transform: `skewX(${r3(jitter(s, k, 561) * 3)}deg)` }, overlay: { backgroundImage: bands(s, k, 3).replace(/#000/g, 'rgba(255,255,255,0.55)'), mixBlendMode: 'screen' } }
    },
  },
  'tv-static': {
    ja: '砂嵐',
    desc: '画面が一瞬テレビの砂嵐に覆われる。放送の途切れ、ホラー、切り替え。',
    dur: 0.4,
    frame: (p, s) => ({ overlay: { backgroundImage: NOISE, backgroundSize: '12em', backgroundPosition: `${step(p, 24) * 37 % 100}% ${hash01(s, step(p, 24), 571) * 100}%`, opacity: r3(0.9 * bell(p) + 0.1), backgroundColor: '#777', mixBlendMode: 'normal' } }),
  },
  interlace: {
    ja: 'インターレース',
    desc: '一行おきに走査線が走り、わずかに横にずれる。古いモニターやカメラの映像。',
    dur: 0.8,
    frame: (p) => ({ overlay: { background: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.35) 0 0.05em, transparent 0.05em 0.1em)', opacity: r3(bell(p)) }, root: { transform: `translateX(${r3(Math.sin(p * 60) * 0.3)}%)` } }),
  },
  mosaic: {
    ja: 'モザイク',
    desc: '画面が粗いピクセルのモザイクになって戻る。規制、デジタル、正体を隠す。',
    dur: 0.5,
    frame: (p) => ({ root: { filter: bell(p) > 0.15 ? `url(#yura-fx-mosaic-${Math.min(3, Math.floor(bell(p) * 4))})` : 'none' } }),
  },
  posterize: {
    ja: 'ポスタリゼ',
    desc: '色の階調が減って、版画のような平たい色面になる。ポップアート、レトロ印刷。',
    dur: 0.8,
    frame: () => ({ root: { filter: 'url(#yura-fx-posterize)' } }),
  },
  dither: {
    ja: '1bitディザ',
    desc: '白と黒の二値だけで描かれた画面になる。古いゲーム機やレシートの印刷。',
    dur: 0.8,
    frame: () => ({ root: { filter: 'url(#yura-fx-dither)' } }),
  },
  'edge-detect': {
    ja: '輪郭抽出',
    desc: '形の輪郭線だけが浮かび上がる。解析、スキャン、骨組み。',
    dur: 0.6,
    frame: () => ({ root: { filter: 'url(#yura-fx-edge)' } }),
  },
  ripple: {
    ja: '波ゆがみ',
    desc: '水面に映ったように画面全体がゆらゆら歪む。回想、酔い、水中。',
    dur: 1,
    frame: (p) => ({ root: { filter: `url(#yura-fx-ripple-${Math.min(3, Math.floor(bell(p) * 4))})` } }),
  },
  halftone: {
    ja: '網点',
    desc: '画面全体に網点のスクリーンがかかる。印刷物、コミック、紙の質感。',
    dur: 0.8,
    frame: (p) => ({ overlay: { background: 'radial-gradient(rgba(0,0,0,0.55) 28%, transparent 32%)', backgroundSize: '0.22em 0.22em', mixBlendMode: 'multiply', opacity: r3(bell(p)) } }),
  },
  duotone: {
    ja: 'ダブルトーン',
    desc: '画面が二色だけの印刷物のような色調になる。グラフィックで大胆な印象。',
    dur: 0.8,
    frame: () => ({ root: { filter: 'grayscale(1) contrast(1.2)' }, overlay: { background: `linear-gradient(135deg, ${A}, ${B})`, mixBlendMode: 'color' } }),
  },
  'hue-shift': {
    ja: '色相シフト',
    desc: '画面全体の色がぐるりと一周して戻る。幻覚、トリップ、七色。',
    dur: 1,
    frame: (p) => ({ root: { filter: `hue-rotate(${r3(p * 360)}deg) saturate(1.3)` } }),
  },
  bloom: {
    ja: 'ブルーム',
    desc: '明るいところから光があふれてにじみ、画面が輝く。感動、天国、夢。',
    dur: 0.7,
    frame: (p) => ({ root: { filter: `brightness(${r3(1 + 0.6 * bell(p))}) saturate(${r3(1 + 0.4 * bell(p))})` }, overlay: { background: 'radial-gradient(circle, rgba(255,255,255,0.55), transparent 65%)', opacity: r3(bell(p)), mixBlendMode: 'screen' } }),
  },
  anamorphic: {
    ja: 'アナモフレア',
    desc: '画面を横一文字に青い光の筋が貫く。映画のレンズフレア、SF。',
    dur: 0.8,
    frame: (p) => ({ overlay: { background: `radial-gradient(ellipse 60% 1.2% at 50% 48%, #ffffff, ${B} 30%, transparent 70%)`, opacity: r3(bell(p)), mixBlendMode: 'screen', filter: 'blur(0.05em)' } }),
  },
  'light-sweep': {
    ja: '光の筋',
    desc: '斜めの光の帯が画面を一度横切る。新しさ、光沢、ひらめき。',
    dur: 0.6,
    frame: (p) => ({ overlay: { background: `linear-gradient(110deg, transparent ${r3(p * 140 - 30)}%, rgba(255,255,255,0.55) ${r3(p * 140 - 20)}%, transparent ${r3(p * 140 - 10)}%)`, mixBlendMode: 'screen' } }),
  },
  'light-rays': {
    ja: '光芒',
    desc: '画面の上から光の筋が差し込み、ゆっくり消える。救い、朝、祝福。',
    dur: 1.2,
    frame: (p) => ({ overlay: { background: 'repeating-conic-gradient(from 160deg at 50% -10%, rgba(255,255,240,0.35) 0 2deg, transparent 2deg 8deg)', opacity: r3(bell(p)), mixBlendMode: 'screen' } }),
  },
  'film-burn': {
    ja: 'フィルム焼け',
    desc: 'フィルムが焼けるように、橙と白の光のしみが画面の端から広がる。',
    dur: 0.9,
    frame: (p, s) => ({ overlay: { background: `radial-gradient(circle at ${r3(hash01(s, 0, 581) < 0.5 ? 10 : 90)}% ${r3(20 + hash01(s, 0, 582) * 60)}%, #fff8e0 0%, #ff9a2e ${r3(10 + outCubic(p) * 30)}%, rgba(255,60,0,0.4) ${r3(20 + outCubic(p) * 50)}%, transparent ${r3(35 + outCubic(p) * 60)}%)`, opacity: r3(bell(p)), mixBlendMode: 'screen' } }),
  },
  'dust-scratches': {
    ja: 'フィルム傷',
    desc: '古いフィルムのような縦の傷と埃がちらつく。ノスタルジー、記録映像。',
    dur: 1,
    frame: (p, s) => {
      const k = step(p, 12)
      const x1 = hash01(s, k, 591) * 100
      const x2 = hash01(s, k, 592) * 100
      return { overlay: { background: `linear-gradient(90deg, transparent ${r3(x1)}%, rgba(255,255,255,0.5) ${r3(x1)}%, rgba(255,255,255,0.5) ${r3(x1 + 0.15)}%, transparent ${r3(x1 + 0.15)}%), linear-gradient(90deg, transparent ${r3(x2)}%, rgba(0,0,0,0.5) ${r3(x2)}%, rgba(0,0,0,0.5) ${r3(x2 + 0.1)}%, transparent ${r3(x2 + 0.1)}%), ${NOISE}`, opacity: '0.5', mixBlendMode: 'overlay' } }
    },
  },
  'focus-lines': {
    ja: '集中線',
    desc: '画面の外から中心へ向かう線が一瞬走る。漫画の決めコマ、驚き、強調。',
    dur: 0.5,
    frame: (p, s) => ({ overlay: { background: `repeating-conic-gradient(from ${r3(step(p, 10) * 7 + hash01(s, 0, 601) * 10)}deg at 50% 50%, rgba(0,0,0,0.75) 0 0.7deg, transparent 0.7deg 5deg)`, WebkitMaskImage: 'radial-gradient(circle, transparent 22%, #000 45%)', maskImage: 'radial-gradient(circle, transparent 22%, #000 45%)', opacity: r3(bell(p)) } }),
  },
  'speed-lines': {
    ja: '流線',
    desc: '横に流れる細い線が画面を走り抜ける。スピード、移動、疾走。',
    dur: 0.6,
    frame: (p, s) => ({ overlay: { background: Array.from({ length: 10 }, (_, i) => { const y = hash01(s, i, 611) * 100; return `linear-gradient(90deg, transparent, rgba(255,255,255,0.7), transparent) ${r3(((p * 300 + hash01(s, i, 612) * 100) % 300) - 100)}% ${r3(y)}% / 40% 0.12em no-repeat` }).join(','), mixBlendMode: 'screen' } }),
  },
  sparkle: {
    ja: 'キラッ',
    desc: '画面のあちこちに十字の光がきらっと瞬く。宝石、アイドル、特別な瞬間。',
    dur: 0.7,
    frame: (p, s) => {
      const star = (i: number): string => {
        const x = 10 + hash01(s, i, 621) * 80
        const y = 10 + hash01(s, i, 622) * 80
        const k = bell(clamp01(p * 1.6 - i * 0.15)) * (1.5 + hash01(s, i, 623) * 2)
        return `linear-gradient(90deg, transparent, #fff, transparent) ${r3(x)}% ${r3(y)}% / ${r3(k * 3)}em 0.08em no-repeat, linear-gradient(0deg, transparent, #fff, transparent) ${r3(x)}% ${r3(y)}% / 0.08em ${r3(k * 3)}em no-repeat`
      }
      return { overlay: { background: [0, 1, 2, 3].map(star).join(','), mixBlendMode: 'screen', filter: 'drop-shadow(0 0 0.2em #fff)' } }
    },
  },
  'color-bars': {
    ja: 'カラーバー',
    desc: '一瞬、テレビの試験用のカラーバーが差し込まれる。放送事故、メタ演出。',
    dur: 0.3,
    frame: () => ({ overlay: { background: 'linear-gradient(90deg, #c0c0c0 0 14.28%, #c0c000 0 28.57%, #00c0c0 0 42.85%, #00c000 0 57.14%, #c000c0 0 71.42%, #c00000 0 85.71%, #0000c0 0)' } }),
  },
  'scan-bar': {
    ja: 'スキャン',
    desc: '明るい一本の線が画面を上から下へ走査する。読み取り、解析、コピー機。',
    dur: 0.7,
    frame: (p) => ({ overlay: { background: `linear-gradient(180deg, transparent ${r3(p * 110 - 6)}%, ${A} ${r3(p * 110 - 1)}%, #ffffff ${r3(p * 110)}%, transparent ${r3(p * 110 + 1)}%)`, mixBlendMode: 'screen', filter: 'drop-shadow(0 0 0.3em #fff)' } }),
  },
  letterbox: {
    ja: 'シネスコ帯',
    desc: '上下から黒い帯が入って映画の画面になる。本気の場面、回想。',
    dur: 1.2,
    frame: (p) => {
      const h = outCubic(clamp01(p * 3)) * 12
      return { overlay: { background: `linear-gradient(180deg, #000 ${r3(h)}%, transparent ${r3(h)}% ${r3(100 - h)}%, #000 ${r3(100 - h)}%)` } }
    },
  },
  snapshot: {
    ja: 'シャッター',
    desc: 'カシャッと白く光り、上下から黒い幕が閉じて開く。写真、記録、記憶に残す瞬間。',
    dur: 0.45,
    frame: (p) => {
      const c = bell(p) * 50
      return { overlay: { background: `linear-gradient(180deg, #000 ${r3(c)}%, rgba(255,255,255,${r3(0.8 * decay(p, 6))}) ${r3(c)}% ${r3(100 - c)}%, #000 ${r3(100 - c)}%)` } }
    },
  },
  'mirror-flash': {
    ja: 'ミラー',
    desc: '一瞬だけ画面が左右反転する。違和感、鏡の世界、裏返し。',
    dur: 0.25,
    frame: (p) => ({ root: p < 0.6 ? { transform: 'scaleX(-1)' } : ({} as Css) }),
  },
  'crt-off': {
    ja: 'ブラウン管オフ',
    desc: '古いテレビの電源を切ったように、画面が横線に潰れ、光る点になって消える。終わり、暗転。',
    dur: 0.6,
    frame: (p) => {
      const sy = p < 0.5 ? 1 - inCubic(p * 2) * 0.995 : 0.005
      const sx = p < 0.5 ? 1 : 1 - inCubic((p - 0.5) * 2)
      return { root: { transform: `scale(${r3(sx)}, ${r3(sy)})`, filter: `brightness(${r3(1 + p * 4)})` }, overlay: { background: '#000', opacity: p >= 1 ? '1' : '0' } }
    },
  },
} satisfies Record<string, FxRecipe>

export type FxName = keyof typeof screenFx

/** An effect's styles at progress `p`; outside 0..1 (or unknown names) it is invisible. (Pure.) */
export function fxFrame(name: string, p: number, seed = 1): FxFrame {
  const r = (screenFx as Record<string, FxRecipe>)[name]
  if (!r || !Number.isFinite(p) || p < 0 || p > 1) return { root: {}, overlay: { opacity: '0' } }
  const f = r.frame(p, seed)
  return { root: f.root ?? {}, overlay: f.overlay ? { opacity: '1', ...f.overlay } : { opacity: '0' } }
}

/**
 * Combines several active effects: filters and transforms chain in order,
 * the last overlay wins (later effects draw on top). (Pure.)
 */
export function combineFx(frames: readonly FxFrame[]): FxFrame {
  const filters: string[] = []
  const transforms: string[] = []
  let overlay: Css = { opacity: '0' }
  for (const f of frames) {
    if (f.root.filter && f.root.filter !== 'none') filters.push(f.root.filter)
    if (f.root.transform && f.root.transform !== 'none') transforms.push(f.root.transform)
    if (f.overlay.opacity !== '0') overlay = f.overlay
  }
  return { root: { filter: filters.join(' ') || 'none', transform: transforms.join(' ') || 'none' }, overlay }
}

/** Mosaic block size (px of the logical frame) for each strength step. */
const MOSAIC_SIZES = [6, 12, 20, 32]
/** Displacement scale for each ripple strength step. */
const RIPPLE_SCALES = [6, 14, 24, 36]
/** Horizontal blur for each smear step (whip blur). */
const SMEAR_BLURS = [4, 10, 20, 36]

/** SVG filters used by the pixel-level effects. Put this markup in the page once (it takes no space). (Pure.) */
export const FX_SVG_DEFS =
  `<svg aria-hidden="true" width="0" height="0" style="position:absolute;width:0;height:0"><defs>` +
  MOSAIC_SIZES.map(
    (s, i) =>
      `<filter id="yura-fx-mosaic-${i}" x="0" y="0" width="100%" height="100%"><feFlood x="${s / 2}" y="${s / 2}" width="1" height="1"/><feComposite width="${s}" height="${s}"/><feTile result="a"/><feComposite in="SourceGraphic" in2="a" operator="in"/><feMorphology operator="dilate" radius="${s / 2}"/></filter>`,
  ).join('') +
  RIPPLE_SCALES.map((s, i) => `<filter id="yura-fx-ripple-${i}"><feTurbulence type="fractalNoise" baseFrequency="0.006 0.02" numOctaves="2" seed="${i + 3}" result="t"/><feDisplacementMap in="SourceGraphic" in2="t" scale="${s}" xChannelSelector="R" yChannelSelector="G"/></filter>`).join('') +
  SMEAR_BLURS.map((s, i) => `<filter id="yura-fx-smear-${i}" x="-20%" width="140%"><feGaussianBlur stdDeviation="${s} 0"/></filter>`).join('') +
  `<filter id="yura-fx-posterize"><feComponentTransfer><feFuncR type="discrete" tableValues="0 0.33 0.66 1"/><feFuncG type="discrete" tableValues="0 0.33 0.66 1"/><feFuncB type="discrete" tableValues="0 0.33 0.66 1"/></feComponentTransfer></filter>` +
  `<filter id="yura-fx-dither"><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncR type="discrete" tableValues="0 1"/><feFuncG type="discrete" tableValues="0 1"/><feFuncB type="discrete" tableValues="0 1"/></feComponentTransfer></filter>` +
  `<filter id="yura-fx-edge"><feColorMatrix type="saturate" values="0"/><feConvolveMatrix order="3" kernelMatrix="-1 -1 -1 -1 8 -1 -1 -1 -1" preserveAlpha="true"/><feComponentTransfer><feFuncR type="linear" slope="3"/><feFuncG type="linear" slope="3"/><feFuncB type="linear" slope="3"/></feComponentTransfer></filter>` +
  `</defs></svg>`
