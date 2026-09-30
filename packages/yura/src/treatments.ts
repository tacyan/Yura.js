import { hash01, clamp01 } from './motion-kit'

/**
 * 文字処理 — text treatments: how the letters themselves are drawn, as a
 * layer independent of how they move. An outline, a 3D extrusion, a marker
 * swipe, a halftone fill, chrome, 傍点, a stencil cut, a ransom-note collage,
 * keycaps, 原稿用紙 cells… any treatment combines with any motion, layout,
 * theme or film look.
 *
 * A glyph's `transform`, `opacity`, `filter`, `clip-path` and `text-shadow`
 * belong to the motion writer, frame by frame. Treatments therefore speak
 * through the other channels — inherited `text-shadow` and text stroke on the
 * line block, `background-clip: text` fills, masks, borders, and the
 * individual `translate` / `rotate` / `scale` properties, which compose with
 * `transform` instead of replacing it. So a treatment never fights a motion.
 *
 * Colours come from CSS variables with sensible fallbacks, so the same
 * treatment follows a stage theme, a film look or a page's own palette:
 *   --yura-treat-a      accent      (falls back to --yura-accent, then #ff3355)
 *   --yura-treat-b      second      (falls back to --yura-accent2, then #2de2e6)
 *   --yura-treat-ink    shadow ink  (defaults to near-black)
 *   --yura-treat-paper  paper       (falls back to --yura-bg, then #ffffff)
 * Sizes are em of the glyph, so every treatment scales with the text. (Pure.)
 */

export type Css = Record<string, string>

/** What a treatment knows about one glyph. */
export interface TreatGlyph {
  i: number
  n: number
  char: string
  seed: number
}

export interface TreatmentRecipe {
  ja: string
  desc: string
  /** Style for the line block that holds the glyphs (inherited text-shadow, stroke, spacing…). */
  block?: Css
  /** Static style for one glyph (fills, borders, cells, individual transforms). */
  glyph?(g: TreatGlyph): Css
  /** Text placed before and after the line (brackets). */
  wrap?: [string, string]
  /** Style that changes with time: `t` seconds since the line arrived. */
  live?(t: number, g: TreatGlyph): Css
}

export const A = 'var(--yura-treat-a, var(--yura-accent, #ff3355))'
export const B = 'var(--yura-treat-b, var(--yura-accent2, #2de2e6))'
const INK = 'var(--yura-treat-ink, rgba(8,8,12,0.9))'
const PAPER = 'var(--yura-treat-paper, var(--yura-bg, #ffffff))'
const blank = (g: TreatGlyph): boolean => g.char.trim() === ''

/** text-shadow ring: the same shadow in 16 directions at radius r (a solid outer border). */
function ringShadow(r: number, color: string): string {
  const out: string[] = []
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2
    out.push(`${(Math.cos(a) * r).toFixed(3)}em ${(Math.sin(a) * r).toFixed(3)}em 0 ${color}`)
  }
  return out.join(', ')
}
/** Stacked shadows along a direction: extrusions and long shadows. */
function stackShadow(steps: number, dx: number, dy: number, color: (k: number) => string): string {
  return Array.from({ length: steps }, (_, k) => `${((k + 1) * dx).toFixed(3)}em ${((k + 1) * dy).toFixed(3)}em 0 ${color(k)}`).join(', ')
}
/** A fill painted inside the letters only. */
const clipFill = (image: string, extra: Css = {}): Css => ({
  backgroundImage: image,
  WebkitBackgroundClip: 'text',
  backgroundClip: 'text',
  WebkitTextFillColor: 'transparent',
  ...extra,
})
/** One gradient spread across the whole line (each glyph shows its slice). */
const lineSlice = (g: TreatGlyph): Css => ({
  backgroundSize: `${Math.max(1, g.n) * 100}% 100%`,
  backgroundPosition: `${g.n <= 1 ? 0 : (g.i / (g.n - 1)) * 100}% 0`,
})
const mix = (color: string, pct: number): string => `color-mix(in srgb, ${color} ${pct}%, transparent)`

/** Grain for eroded letters (percent-encoded so it can sit inside an inline style). */
const EROSION = `url("data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'><filter id='e'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/><feComponentTransfer><feFuncA type='discrete' tableValues='1 1 1 0 1 1 0 1'/></feComponentTransfer></filter><rect width='100%' height='100%' filter='url(#e)'/></svg>",
)}")`

export const treatments = {
  none: { ja: 'なし', desc: '文字に何もしない。動きと配置だけで見せる、いちばん素直な状態。' },
  outline: {
    ja: '袋文字',
    desc: '中を抜いて輪郭線だけで描く。重い見出しを軽く見せ、背景を透かす。',
    block: { WebkitTextStroke: '0.035em currentColor', WebkitTextFillColor: 'transparent' },
  },
  border: {
    ja: '縁取り',
    desc: '文字の外側に太い縁を回す。どんな背景の上でも読める、テロップの基本。',
    block: { textShadow: ringShadow(0.07, INK) },
  },
  'double-border': {
    ja: '二重縁',
    desc: '紙色とアクセント色の二重の縁。バラエティ番組や看板のような賑やかさ。',
    block: { textShadow: `${ringShadow(0.05, PAPER)}, ${ringShadow(0.11, A)}` },
  },
  extrude: {
    ja: '立体',
    desc: '文字が奥へ押し出されたように厚みを持つ。レトロなロゴやゲームのタイトルに。',
    block: { textShadow: stackShadow(10, 0.012, 0.012, (k) => (k < 9 ? mix(A, 100 - k * 5) : INK)) },
  },
  'long-shadow': {
    ja: '長い影',
    desc: '斜め下へ長く伸びる影。フラットデザインの定番で、平面に奥行きを足す。',
    block: { textShadow: stackShadow(28, 0.018, 0.018, (k) => mix(INK, 55 - k * 1.8)) },
  },
  'hard-shadow': {
    ja: 'ずらし影',
    desc: 'ぼかさない影を少しずらして置く。版画やポスターのような、平たく強い立体感。',
    block: { textShadow: `0.07em 0.07em 0 ${A}` },
  },
  'soft-shadow': {
    ja: 'ぼかし影',
    desc: '柔らかく落ちる影で文字を背景から浮かせる。写真や映像の上に置く見出しに。',
    block: { textShadow: '0 0.08em 0.3em rgba(0,0,0,0.45)' },
  },
  glow: {
    ja: '発光',
    desc: '文字の周りにアクセント色の光がにじむ。夜景や暗い背景で映える。',
    block: { textShadow: `0 0 0.12em ${A}, 0 0 0.4em ${A}` },
  },
  neon: {
    ja: 'ネオン管',
    desc: '細い管の輪郭が光る。中は暗く、縁だけが発光するネオンサイン。',
    block: { WebkitTextStroke: `0.03em ${A}`, WebkitTextFillColor: 'transparent', textShadow: `0 0 0.1em ${A}, 0 0 0.35em ${A}` },
  },
  marker: {
    ja: 'マーカー',
    desc: '文字の下半分に蛍光ペンを引いたような帯。強調したい一行に。',
    glyph: (): Css => ({ backgroundImage: `linear-gradient(transparent 58%, ${mix(A, 70)} 58%, ${mix(A, 70)} 92%, transparent 92%)` }),
  },
  underline: {
    ja: '下線',
    desc: '行の下に太い線を引く。編集的で、言葉を指し示す。',
    glyph: (g): Css => (blank(g) ? {} : { boxShadow: `inset 0 -0.07em 0 ${A}` }),
  },
  strike: {
    ja: '取り消し線',
    desc: '文字の中央に線を通す。否定、言い直し、皮肉。',
    glyph: (): Css => ({ backgroundImage: 'linear-gradient(transparent 50%, currentColor 50%, currentColor 57%, transparent 57%)' }),
  },
  boxed: {
    ja: '箱組',
    desc: '行全体を線の箱で囲む。ラベルや看板のように、言葉を一つの物にする。',
    block: { border: '0.06em solid currentColor', padding: '0.12em 0.45em' },
  },
  'band': {
    ja: '帯敷き',
    desc: '行の背後に色の帯を敷き、文字を反転色で置く。テロップや見出しの帯。',
    block: { background: A, color: PAPER, padding: '0.08em 0.4em' },
  },
  'gradient-v': {
    ja: '縦グラデ',
    desc: '文字の上から下へ二色が移ろう。夕焼けや金属のような表情。',
    glyph: (): Css => clipFill(`linear-gradient(180deg, ${A}, ${B})`),
  },
  'split-color': {
    ja: '上下二色',
    desc: '文字の上半分と下半分で色を分ける。水面に映ったような、切り替えの強さ。',
    glyph: (): Css => clipFill(`linear-gradient(180deg, currentColor 52%, ${A} 52%)`),
  },
  rainbow: {
    ja: '虹色',
    desc: '行全体に虹色のグラデーションを通す。祝祭、ポップ、子ども向け。',
    glyph: (g): Css => clipFill('linear-gradient(90deg, #ff4d4d, #ffb84d, #f8ff4d, #4dff88, #4dd2ff, #7a4dff, #ff4dd8)', lineSlice(g)),
  },
  chrome: {
    ja: 'クローム',
    desc: '鏡のように光る金属の文字。80年代のロゴやアクション映画のタイトル。',
    glyph: (): Css => clipFill('linear-gradient(180deg, #ffffff 0%, #dfe6ee 42%, #5b6470 50%, #c9d3dc 58%, #8f99a3 100%)'),
    block: { filter: 'drop-shadow(0 0.03em 0 rgba(0,0,0,0.6))' },
  },
  gold: {
    ja: '金文字',
    desc: '金箔のような光沢のある文字。授賞式、和の祝い、高級感。',
    glyph: (): Css => clipFill('linear-gradient(180deg, #fff6c8 0%, #f2c14e 40%, #9a6b12 52%, #f5d77a 64%, #b8871b 100%)'),
  },
  halftone: {
    ja: '網点',
    desc: '文字を細かな点の集まりで塗る。印刷物やアメコミのような質感。',
    glyph: (): Css => clipFill('radial-gradient(currentColor 42%, transparent 46%)', { backgroundSize: '0.11em 0.11em', WebkitTextFillColor: 'transparent', color: 'inherit' }),
  },
  stripes: {
    ja: 'ストライプ',
    desc: '文字の中に横縞を走らせる。スピード感とレトロな電子音の気配。',
    glyph: (): Css => clipFill('repeating-linear-gradient(0deg, currentColor 0 0.055em, transparent 0.055em 0.11em)'),
  },
  hatch: {
    ja: '斜線',
    desc: '文字を斜めの細い線で塗る。版画や設計図のハッチングのような手触り。',
    glyph: (): Css => clipFill('repeating-linear-gradient(45deg, currentColor 0 0.04em, transparent 0.04em 0.1em)'),
  },
  'glitch-split': {
    ja: '色版ズレ',
    desc: '文字の左右に色の違う版がずれて重なる。印刷ミスやデジタルノイズの表情。',
    block: { textShadow: `-0.04em 0 ${A}, 0.04em 0 ${B}` },
  },
  'shadow-stack': {
    ja: '多重影',
    desc: '色の違う影を何枚も重ねて段々に落とす。ポップで賑やかな立体感。',
    block: { textShadow: `0.05em 0.05em 0 ${A}, 0.1em 0.1em 0 ${B}, 0.15em 0.15em 0 ${INK}` },
  },
  echo: {
    ja: '輪郭の残響',
    desc: '文字の後ろに薄い影が何重にも尾を引く。動いた後の残像、記憶の反響。',
    block: { textShadow: `0.07em 0.05em 0 ${mix(A, 55)}, 0.14em 0.1em 0 ${mix(A, 32)}, 0.21em 0.15em 0 ${mix(A, 16)}` },
  },
  'misregister': {
    ja: '版ズレ袋文字',
    desc: '輪郭線と塗りが少しずれて刷られたように見える。リソグラフ印刷の味わい。',
    block: { WebkitTextStroke: '0.03em currentColor', WebkitTextFillColor: 'transparent', textShadow: `0.06em 0.05em 0 ${mix(A, 85)}` },
  },
  'double-exposure': {
    ja: '二重露光',
    desc: '少しずれた半透明の分身が重なる。夢、回想、ぶれた記憶。',
    block: { textShadow: `0.1em -0.05em 0 ${mix('currentColor', 35)}, -0.06em 0.04em 0 ${mix(A, 30)}` },
  },
  'emphasis-dots': {
    ja: '傍点',
    desc: '一文字ずつに小さな点を打つ。日本語の強調の作法で、縦書きにも横書きにも。',
    block: { textEmphasisStyle: 'filled dot', textEmphasisColor: A, textEmphasisPosition: 'over right' },
  },
  italic: {
    ja: '斜体',
    desc: '行全体を斜めに傾ける。スピード、勢い、話し言葉の軽さ。',
    block: { transform: 'skewX(-12deg)' },
  },
  wide: {
    ja: '平体',
    desc: '文字を横に広げ、背を低くする。安定感と迫力、看板の文字。',
    block: { scale: '1.3 0.86' },
  },
  tall: {
    ja: '長体',
    desc: '文字を縦に細長くする。緊張感と品、ファッション誌の見出し。',
    block: { scale: '0.76 1.16' },
  },
  'faux-bold': {
    ja: '極太',
    desc: '輪郭に同じ色の線を重ねて、書体の限界より太くする。叫ぶような強さ。',
    block: { WebkitTextStroke: '0.045em currentColor' },
  },
  'wide-tracking': {
    ja: '字間広め',
    desc: '文字と文字の間を大きく空ける。静けさ、余白、上品な間。',
    block: { letterSpacing: '0.32em' },
  },
  inline: {
    ja: 'インライン',
    desc: '文字の縁の内側に細い線が走る。クラシックな看板や賞状の書体のよう。',
    block: { WebkitTextStroke: `0.02em ${PAPER}`, textShadow: `0.05em 0.05em 0 ${A}` },
  },
  sticker: {
    ja: 'シール縁',
    desc: '文字の外に厚い白い縁を回し、シールのように浮かせる。SNS映え、ポップ。',
    block: { textShadow: `${ringShadow(0.1, PAPER)}, 0 0.16em 0.22em rgba(0,0,0,0.3)` },
  },
  reflection: {
    ja: '映り込み',
    desc: '文字の下に、薄れていく鏡像が映る。床や水面に置いたような広がり。',
    block: { WebkitBoxReflect: 'below 0.02em linear-gradient(transparent 40%, rgba(0,0,0,0.35))' },
  },
  stencil: {
    ja: 'ステンシル字',
    desc: '文字の横に切れ目が入る。吹き付け塗装、軍用、工業的な表示。',
    glyph: (): Css => ({ WebkitMaskImage: 'linear-gradient(180deg, #000 45%, transparent 45%, transparent 53%, #000 53%)', maskImage: 'linear-gradient(180deg, #000 45%, transparent 45%, transparent 53%, #000 53%)' }),
  },
  eroded: {
    ja: '風化',
    desc: '文字が細かく欠け、擦り切れている。古い看板、廃墟、時間の経過。',
    glyph: (): Css => ({ WebkitMaskImage: EROSION, maskImage: EROSION, WebkitMaskSize: '0.9em', maskSize: '0.9em' }),
  },
  'ink-bleed': {
    ja: '滲み垂れ',
    desc: '文字の墨が下へ滲んで垂れていく。不穏、ホラー、雨に濡れた貼り紙。',
    block: { textShadow: `0 0.04em 0.05em currentColor, 0 0.14em 0.1em ${mix('currentColor', 55)}, 0 0.3em 0.14em ${mix('currentColor', 25)}` },
  },
  redact: {
    ja: '黒塗り',
    desc: 'ところどころの文字が黒い帯で塗りつぶされる。機密文書、隠された言葉。',
    glyph: (g): Css => (!blank(g) && hash01(g.seed, g.i, 401) < 0.3 ? { background: INK, color: 'transparent', WebkitTextFillColor: 'transparent', padding: '0 0.04em' } : {}),
  },
  alternate: {
    ja: '交互色',
    desc: '一文字ごとに色を入れ替える。リズムが目に見える、弾むような配色。',
    glyph: (g): Css => (g.i % 2 ? { color: A } : {}),
  },
  'size-wave': {
    ja: '大小リズム',
    desc: '文字の大きさが波のように大小に揺れて並ぶ。手作りのポスター、遊び心。',
    glyph: (g): Css => ({ scale: (1 + Math.sin(g.i * 1.3) * 0.28).toFixed(3), display: 'inline-block' }),
  },
  'rotate-alt': {
    ja: '揺れ字',
    desc: '一文字おきに左右へ傾けて並べる。手書きの寄せ書きのような不揃いのかわいさ。',
    glyph: (g): Css => ({ rotate: `${g.i % 2 ? 7 : -6}deg` }),
  },
  'baseline-shift': {
    ja: '段違い',
    desc: '文字を交互に上下へずらして置く。弾む会話、ポップなリズム。',
    glyph: (g): Css => ({ translate: `0 ${g.i % 2 ? 0.12 : -0.1}em` }),
  },
  'head-big': {
    ja: '頭字強調',
    desc: '最初の一文字だけを大きく、色を変えて置く。雑誌の書き出しや名前の頭文字。',
    glyph: (g): Css => (g.i === 0 ? { scale: '1.55', color: A, transformOrigin: '50% 90%', margin: '0 0.18em 0 0.1em' } : {}),
  },
  'spot-char': {
    ja: '一字マーク',
    desc: '行の中の一文字だけを色の丸で囲む。そこだけに目が行く、指差しの強調。',
    glyph: (g): Css => (g.i === Math.floor(hash01(g.seed, 0, 403) * g.n) && !blank(g) ? { background: A, color: PAPER, borderRadius: '50%', padding: '0 0.08em' } : {}),
  },
  'hollow-key': {
    ja: '一字抜き',
    desc: '行の中の一文字だけを輪郭線にする。欠けたもの、足りないもの、問いかけ。',
    glyph: (g): Css => (g.i === Math.floor(hash01(g.seed, 0, 404) * g.n) && !blank(g) ? { WebkitTextStroke: '0.035em currentColor', WebkitTextFillColor: 'transparent' } : {}),
  },
  fade: {
    ja: '余韻',
    desc: '行の終わりへ向かって文字が少しずつ薄れていく。言い切らない、消えゆく言葉。',
    glyph: (g): Css => ({ color: mix('currentColor', Math.round(100 - (g.n <= 1 ? 0 : g.i / (g.n - 1)) * 70)) }),
  },
  circled: {
    ja: '丸囲み',
    desc: '一文字ずつを円で囲む。丸数字や記号のような、整然としたかわいさ。',
    glyph: (g): Css => (blank(g) ? {} : { border: '0.06em solid currentColor', borderRadius: '50%', padding: '0.06em', margin: '0 0.03em', lineHeight: '1' }),
  },
  keycap: {
    ja: 'キーキャップ',
    desc: '一文字ずつがキーボードのキーになる。デジタル、ゲーム、ショートカットの表示。',
    glyph: (g): Css => (blank(g) ? {} : { background: 'linear-gradient(180deg, #fafafa, #d9d9de)', color: '#1a1a1f', WebkitTextFillColor: '#1a1a1f', borderRadius: '0.16em', padding: '0.08em 0.14em', margin: '0 0.05em', boxShadow: '0 0.08em 0 #9a9aa3, 0 0.12em 0.2em rgba(0,0,0,0.35)', lineHeight: '1.05' }),
  },
  tile: {
    ja: '文字タイル',
    desc: '一文字ずつが色違いの四角いタイルに乗る。ボードゲームやパズルのよう。',
    glyph: (g): Css => (blank(g) ? {} : { background: [A, B, INK][g.i % 3], color: PAPER, WebkitTextFillColor: '#ffffff', padding: '0.06em 0.12em', margin: '0 0.04em', borderRadius: '0.08em' }),
  },
  magnet: {
    ja: 'マグネット',
    desc: '色とりどりの磁石の文字が、少し傾いて冷蔵庫に貼られている。子ども部屋の遊び心。',
    glyph: (g): Css => (blank(g) ? {} : { color: ['#e8412c', '#2c7be8', '#f2b705', '#2caa55', '#9b3fd6'][Math.floor(hash01(g.seed, g.i, 405) * 5)], rotate: `${((hash01(g.seed, g.i, 406) - 0.5) * 16).toFixed(1)}deg`, WebkitTextStroke: '0.02em rgba(0,0,0,0.25)' }),
  },
  ransom: {
    ja: '切り貼り文字',
    desc: '雑誌から切り抜いたような、色も形もばらばらの文字を貼り合わせる。脅迫状、パンク、コラージュ。',
    glyph: (g): Css => {
      if (blank(g)) return {}
      const k = Math.floor(hash01(g.seed, g.i, 407) * 4)
      const bg = [A, INK, PAPER, B][k]
      const fg = k === 2 ? INK : PAPER
      return { background: bg, color: fg, WebkitTextFillColor: k === 2 ? '#111111' : '#ffffff', padding: '0.02em 0.1em', margin: '0 0.03em', rotate: `${((hash01(g.seed, g.i, 408) - 0.5) * 12).toFixed(1)}deg`, fontFamily: k % 2 ? 'serif' : 'inherit' }
    },
  },
  genkou: {
    ja: '原稿用紙',
    desc: '一文字ずつが升目に収まる。作文、手紙、日本語の手書きの原稿。',
    glyph: (g): Css => ({ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '1.15em', height: '1.15em', outline: `0.03em solid ${mix(A, 70)}`, margin: '0 0.02em 0.1em' }),
  },
  bubble: {
    ja: '泡文字',
    desc: '一文字ずつが丸い泡の中に浮かぶ。水、炭酸、ふわっとした軽さ。',
    glyph: (g): Css => (blank(g) ? {} : { background: `radial-gradient(circle at 32% 30%, rgba(255,255,255,0.85), ${mix(B, 40)} 45%, ${mix(B, 15)} 70%)`, borderRadius: '50%', padding: '0.14em', margin: '0 0.02em', boxShadow: `inset 0 0 0 0.03em ${mix(B, 60)}` }),
  },
  bulb: {
    ja: '電球サイン',
    desc: '文字の輪郭に電球が並んで光るような看板。劇場、遊園地、ショーの始まり。',
    block: { WebkitTextStroke: `0.05em ${A}`, WebkitTextFillColor: 'transparent', textShadow: `0 0 0.2em ${A}` },
    glyph: (): Css => ({ WebkitMaskImage: 'radial-gradient(circle, #000 55%, transparent 60%)', maskImage: 'radial-gradient(circle, #000 55%, transparent 60%)', WebkitMaskSize: '0.12em 0.12em', maskSize: '0.12em 0.12em' }),
  },
  led: {
    ja: 'ドット表示',
    desc: '文字が光る点の集まりで表示される。電光掲示板、駅の案内、デジタル時計。',
    glyph: (): Css => ({ ...clipFill(`radial-gradient(${A} 45%, transparent 50%)`, { backgroundSize: '0.09em 0.09em' }) }),
    block: { textShadow: `0 0 0.15em ${mix(A, 60)}`, fontWeight: '900' },
  },
  brackets: {
    ja: 'かぎ括弧',
    desc: '行を「」で挟む。台詞、引用、心の声。',
    wrap: ['「', '」'],
  },
  'head-rules': {
    ja: '天地罫',
    desc: '行の上下に細い罫線を引く。雑誌の見出しや本の扉のような端正な枠。',
    block: { borderTop: '0.04em solid currentColor', borderBottom: '0.04em solid currentColor', padding: '0.18em 0.1em' },
  },
  karaoke: {
    ja: 'カラオケ',
    desc: '歌われる速さで、文字が左から順に色で満たされていく。歌詞の定番。',
    glyph: (): Css => clipFill(`linear-gradient(90deg, ${A} 50%, currentColor 50%)`, { backgroundSize: '200% 100%', backgroundPosition: '100% 0' }),
    live: (t, g) => ({ backgroundPosition: `${((1 - clamp01(t * KARAOKE_RATE - g.i)) * 100).toFixed(2)}% 0` }),
  },
  waterline: {
    ja: '水位',
    desc: '文字の下半分が水に沈んだように色が変わり、水面がゆっくり上下する。',
    glyph: (): Css => clipFill(`linear-gradient(180deg, currentColor 55%, ${A} 55%)`, { backgroundSize: '100% 200%' }),
    live: (t, g) => ({ backgroundPosition: `0 ${(50 + Math.sin(t * 1.6 + g.i * 0.45) * 12).toFixed(2)}%` }),
  },
  shine: {
    ja: '光沢スイープ',
    desc: '文字の上を斜めの光が繰り返し走る。高級感、新しさ、商品の輝き。',
    glyph: (g): Css => clipFill('linear-gradient(110deg, currentColor 40%, #ffffff 50%, currentColor 60%)', { backgroundColor: 'currentColor', backgroundSize: `${Math.max(1, g.n) * 300}% 100%` }),
    live: (t, g) => ({ backgroundPosition: `${(((t / SHINE_PERIOD) % 1) * -200 + 150 + (g.n <= 1 ? 0 : (g.i / (g.n - 1)) * 33)).toFixed(2)}% 0` }),
  },
} satisfies Record<string, TreatmentRecipe>

/** Glyphs filled per second by `karaoke`. */
const KARAOKE_RATE = 5.5
/** Seconds between two passes of `shine`. */
const SHINE_PERIOD = 2.6

export type TreatmentName = keyof typeof treatments

/** Static styles of a treatment for a line of `n` glyphs. Unknown names give no style. (Pure.) */
export function treatmentStyles(name: string | undefined, glyphs: readonly string[], seed = 1): { block: Css; glyphs: Css[]; wrap: [string, string] | null } {
  const r = name ? ((treatments as Record<string, TreatmentRecipe>)[name] ?? null) : null
  if (!r) return { block: {}, glyphs: glyphs.map(() => ({})), wrap: null }
  const n = glyphs.length
  return {
    block: { ...(r.block ?? {}) },
    glyphs: glyphs.map((char, i) => ({ ...(r.glyph ? r.glyph({ i, n, char, seed }) : {}) })),
    wrap: r.wrap ?? null,
  }
}

/** Time-varying styles of a treatment (empty for static ones). (Pure.) */
export function treatmentLive(name: string | undefined, t: number, glyphs: readonly string[], seed = 1): Css[] | null {
  const r = name ? ((treatments as Record<string, TreatmentRecipe>)[name] ?? null) : null
  if (!r?.live) return null
  const tt = Number.isFinite(t) ? Math.max(0, t) : 0
  return glyphs.map((char, i) => r.live!(tt, { i, n: glyphs.length, char, seed }))
}

/** CSS property name for a camelCase key (Webkit prefixes included). */
export function cssProp(key: string): string {
  // WebkitTextStroke → -webkit-text-stroke (the capital W becomes the leading dash).
  const k = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
  return k.startsWith('webkit-') ? `-${k}` : k
}

/** Serialises a style object for an inline `style` attribute (quotes made attribute-safe). (Pure.) */
export function cssText(style: Css): string {
  return Object.entries(style)
    .map(([k, v]) => `${cssProp(k)}:${String(v).replace(/"/g, '&quot;')}`)
    .join(';')
}
