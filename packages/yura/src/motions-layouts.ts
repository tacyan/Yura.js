import type { LayoutRecipe, MotionGlyph } from './motions'
import { hash01, fromMiddle, sideOf, TAU } from './motion-kit'

/**
 * 組み — composition layouts: where a line sits and what it sits *on*. Rings
 * and spirals of letters, corner-to-corner splits, big-and-small mixes, and
 * objects the words are printed on — a speech bubble, a chat message, a
 * search box, a ticket, a station name board, a noren curtain, a tanzaku
 * slip, a hanging scroll, a paper lantern, a warning label, a price tag, a
 * sticky note, a polaroid, a postcard, a vinyl label, an ema plaque…
 *
 * Objects are drawn with CSS on the line's text block plus a little
 * decoration markup (tails, rods, perforations, icons); colours follow the
 * stage / film palette through CSS variables. Every size is em, so a layout
 * holds together at any font size.
 */

const CENTER = { justifyContent: 'center', alignItems: 'center', textAlign: 'center' } as const
const A = 'var(--yura-accent, #ff3355)'
const FG = 'var(--yura-fg, currentColor)'
const BGV = 'var(--yura-bg, #111111)'
const PAPER = '#fbf8f1'
const INKC = '#141414'
const abs = (css: string): string => `<div style="position:absolute;${css}"></div>`

/** Where glyph i would sit on a circle of `n` glyphs, relative to its place in the line (em). */
function onCircle(g: MotionGlyph, radius: number, start = -Math.PI / 2, sweep = TAU): { x: number; y: number; rotate: number } {
  const a = start + (g.n <= 1 ? 0 : (g.i / (sweep >= TAU ? g.n : g.n - 1)) * sweep)
  const natural = fromMiddle(g) * 1.02
  return { x: Math.cos(a) * radius - natural, y: Math.sin(a) * radius, rotate: ((a + Math.PI / 2) * 180) / Math.PI }
}
/** Ring radius (em): room for every glyph around the circumference, never tighter than a small dial. */
const ringRadius = (n: number): number => Math.max(1.9, (n * 1.25) / TAU)

export const COMPOSE_LAYOUT = {
  ring: {
    ja: '円環',
    desc: '文字が円を描いて一周に並ぶ。回り続ける時間、巡る季節、終わらない歌。',
    box: CENTER,
    fontScale: 0.8,
    offset: (g) => onCircle(g, ringRadius(g.n)),
  },
  'arc-top': {
    ja: '虹の弧',
    desc: '文字が上に膨らむ半円に沿って並ぶ。虹、看板のアーチ、祝福。',
    box: CENTER,
    offset: (g) => {
      const c = onCircle(g, Math.max(2, g.n * 0.42), Math.PI * 1.15, Math.PI * 0.7)
      return { ...c, y: c.y + Math.max(2, g.n * 0.42) * 0.8 }
    },
  },
  spiral: {
    ja: '螺旋',
    desc: '文字が渦巻きの線に沿って内側へ巻き込まれていく。めまい、夢、深みへ。',
    box: CENTER,
    fontScale: 0.75,
    offset: (g) => {
      // An Archimedean spiral: each glyph one glyph-width further along the curve.
      const a = 0.9 + g.i * 0.75
      const r = 0.9 + a * 0.42
      return { x: Math.cos(a) * r - fromMiddle(g) * 1.02, y: Math.sin(a) * r, rotate: (a * 180) / Math.PI + 90, scale: 0.75 + (g.i / Math.max(1, g.n)) * 0.45 }
    },
  },
  corners: {
    ja: '対角配置',
    desc: '行の前半を左上へ、後半を右下へ振り分ける。問いと答え、呼びかけと応え。',
    box: CENTER,
    offset: (g) => ({ x: sideOf(g) * 1.6, y: sideOf(g) * 1.3 }),
  },
  mixed: {
    ja: '大小ミックス',
    desc: '大きな字と小さな字が混ざって組まれる。手作りのポスター、声の強弱。',
    box: CENTER,
    offset: (g) => ({ x: 0, y: 0, scale: hash01(g.seed, g.i, 801) < 0.35 ? 1.55 : 0.8 }),
  },
  cascade: {
    ja: '段落ち',
    desc: '一文字ずつ右下へずれ落ちていく、滝のような組み。',
    box: CENTER,
    offset: (g) => ({ x: fromMiddle(g) * 0.1, y: fromMiddle(g) * 0.35 }),
  },
  sideways: {
    ja: '縦倒し',
    desc: '行を九十度倒して、画面の端に縦に沿わせる。背表紙や帯のような脇役の置き方。',
    box: { justifyContent: 'flex-start', alignItems: 'center', paddingLeft: '6%' },
    block: { transform: 'rotate(-90deg)', transformOrigin: '50% 50%' },
  },
  band: {
    ja: '斜め帯',
    desc: '画面を斜めに横切る色の帯の上に文字を置く。スポーツ中継やセールの告知。',
    box: { ...CENTER, background: `linear-gradient(-8deg, transparent 38%, ${A} 38% 62%, transparent 62%)` },
    block: { transform: 'rotate(-8deg)', color: BGV },
  },
  'circle-window': {
    ja: '円窓',
    desc: '丸い窓の中に文字を収める。和室の丸窓、覗き穴、ひとつの視点。',
    box: CENTER,
    block: { width: '5.2em', height: '5.2em', borderRadius: '50%', border: `0.08em solid ${FG}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', overflow: 'hidden', padding: '0.4em' },
    fontScale: 0.7,
  },
  pill: {
    ja: 'カプセル',
    desc: '丸い両端の色つきカプセルに文字を収める。ボタン、タグ、アプリの UI。',
    box: CENTER,
    block: { background: A, color: BGV, borderRadius: '99em', padding: '0.2em 0.9em' },
    fontScale: 0.75,
  },
  'subtitle-bar': {
    ja: '字幕帯',
    desc: '画面の下に半透明の黒い帯を敷き、その上に字幕のように置く。',
    box: { justifyContent: 'center', alignItems: 'flex-end', textAlign: 'center', paddingBottom: '7%' },
    block: { background: 'rgba(0,0,0,0.62)', color: '#ffffff', padding: '0.18em 0.8em', borderRadius: '0.12em' },
    fontScale: 0.5,
  },
  'frame-box': {
    ja: '額縁',
    desc: '二重線の額縁に言葉を収める。賞状、展示、特別なひとこと。',
    box: CENTER,
    block: { border: `0.2em double ${FG}`, padding: '0.45em 0.9em' },
    fontScale: 0.8,
  },
  bubble: {
    ja: '吹き出し',
    desc: '角の丸い吹き出しの中に言葉を置く。漫画の台詞、心の声。',
    box: CENTER,
    block: { background: '#ffffff', color: INKC, borderRadius: '0.8em', padding: '0.35em 0.8em', boxShadow: '0 0.15em 0.4em rgba(0,0,0,0.25)' },
    deco: abs(`left:18%;bottom:-0.35em;width:0.7em;height:0.7em;background:#ffffff;transform:rotate(45deg);box-shadow:0.12em 0.12em 0.2em rgba(0,0,0,0.12)`),
    fontScale: 0.7,
  },
  chat: {
    ja: 'チャット',
    desc: 'メッセージアプリの吹き出しとして、左の丸いアイコンの横に届く。',
    box: { justifyContent: 'flex-start', alignItems: 'center', paddingLeft: '14%' },
    block: { background: '#ffffff', color: INKC, borderRadius: '0.9em 0.9em 0.9em 0.2em', padding: '0.3em 0.75em', textAlign: 'left' },
    deco: abs(`left:-1.6em;bottom:0;width:1.2em;height:1.2em;border-radius:50%;background:${A}`),
    fontScale: 0.55,
  },
  notification: {
    ja: '通知',
    desc: 'スマートフォンの通知カードとして画面の上に現れる。アプリのアイコンと「今」の表示つき。',
    box: { justifyContent: 'center', alignItems: 'flex-start', paddingTop: '6%' },
    block: { background: 'rgba(245,245,247,0.94)', color: INKC, borderRadius: '0.6em', padding: '1.1em 0.9em 0.45em 2.2em', textAlign: 'left', boxShadow: '0 0.3em 0.9em rgba(0,0,0,0.3)', minWidth: '8em' },
    deco: abs(`left:0.6em;top:0.5em;width:1.1em;height:1.1em;border-radius:0.28em;background:${A}`) + `<div style="position:absolute;left:2.2em;top:0.35em;font-size:0.4em;opacity:0.55;letter-spacing:0.05em">MESSAGE</div><div style="position:absolute;right:0.8em;top:0.35em;font-size:0.4em;opacity:0.55">now</div>`,
    fontScale: 0.5,
  },
  'search-bar': {
    ja: '検索窓',
    desc: '検索窓に言葉が打ち込まれているように置く。調べる、探す、誰かの疑問。',
    box: CENTER,
    block: { background: '#ffffff', color: INKC, borderRadius: '99em', padding: '0.28em 1em 0.28em 1.9em', boxShadow: '0 0.1em 0.5em rgba(0,0,0,0.25)', minWidth: '9em', textAlign: 'left' },
    deco: `<svg viewBox="0 0 24 24" style="position:absolute;left:0.6em;top:50%;width:0.8em;height:0.8em;margin-top:-0.4em"><circle cx="10" cy="10" r="6.5" fill="none" stroke="#666" stroke-width="2.4"/><path d="M15 15l6 6" stroke="#666" stroke-width="2.4" stroke-linecap="round"/></svg>`,
    fontScale: 0.55,
  },
  ticket: {
    ja: 'チケット',
    desc: '切り取り線の入ったチケットに刷られた文字。ライブ、旅、特別な一日への入場券。',
    box: CENTER,
    block: { background: A, color: BGV, padding: '0.35em 1.6em 0.35em 0.9em', WebkitMaskImage: 'radial-gradient(circle at 0 50%, transparent 0.35em, #000 0.37em), radial-gradient(circle at 100% 50%, transparent 0.35em, #000 0.37em)', WebkitMaskComposite: 'source-in', maskComposite: 'intersect', maskImage: 'radial-gradient(circle at 0 50%, transparent 0.35em, #000 0.37em), radial-gradient(circle at 100% 50%, transparent 0.35em, #000 0.37em)' },
    deco: abs('right:1em;top:12%;bottom:12%;border-left:0.05em dashed currentColor;opacity:0.7'),
    fontScale: 0.7,
  },
  'station-sign': {
    ja: '駅名標',
    desc: '駅のホームの駅名標のように、色の帯と矢印を添えて置く。旅、別れ、次の駅。',
    box: CENTER,
    block: { background: '#ffffff', color: INKC, padding: '0.35em 1.4em 0.55em', borderTop: `0.28em solid ${A}`, minWidth: '8em' },
    deco: `<div style="position:absolute;left:0;right:0;bottom:0.18em;height:0.1em;background:${A}"></div><div style="position:absolute;left:0.3em;bottom:0.32em;font-size:0.35em;color:#555">◀</div><div style="position:absolute;right:0.3em;bottom:0.32em;font-size:0.35em;color:#555">▶</div>`,
    fontScale: 0.75,
  },
  noren: {
    ja: '暖簾',
    desc: '店先の暖簾のように、切れ目の入った藍染めの布に白く染め抜く。和の店、始まりの挨拶。',
    box: { justifyContent: 'center', alignItems: 'flex-start', paddingTop: '4%' },
    block: { background: '#1f3a6b', color: PAPER, padding: '0.6em 0.6em 1.4em', writingMode: 'vertical-rl', WebkitMaskImage: 'linear-gradient(90deg, #000 32%, transparent 32% 34%, #000 34% 66%, transparent 66% 68%, #000 68%)', maskImage: 'linear-gradient(90deg, #000 32%, transparent 32% 34%, #000 34% 66%, transparent 66% 68%, #000 68%)', minWidth: '4.5em', textAlign: 'center' },
    deco: abs('left:-0.3em;right:-0.3em;top:-0.25em;height:0.25em;background:#6b4a2b;border-radius:0.1em'),
    fontScale: 0.8,
  },
  tanzaku: {
    ja: '短冊',
    desc: '七夕の短冊のような細長い色紙に、縦に願いを書く。',
    box: CENTER,
    block: { background: 'linear-gradient(180deg, #ffd6e7, #ffb3cf)', color: INKC, writingMode: 'vertical-rl', padding: '1.1em 0.35em 0.8em', boxShadow: '0 0.1em 0.3em rgba(0,0,0,0.25)' },
    deco: abs('left:50%;top:0.3em;width:0.22em;height:0.22em;margin-left:-0.11em;border-radius:50%;background:rgba(0,0,0,0.35)') + abs('left:50%;top:-1.2em;height:1.4em;border-left:0.04em solid #c9a24a'),
    fontScale: 0.65,
  },
  omikuji: {
    ja: 'おみくじ',
    desc: '神社のおみくじの紙のように、朱の枠と見出しを付けて縦に刷る。運勢、占い、祈り。',
    box: CENTER,
    block: { background: PAPER, color: INKC, writingMode: 'vertical-rl', border: '0.06em solid #c8102e', outline: '0.03em solid #c8102e', outlineOffset: '-0.18em', padding: '1.4em 0.5em 0.6em' },
    deco: `<div style="position:absolute;top:0.2em;left:0;right:0;text-align:center;font-size:0.4em;color:#c8102e;letter-spacing:0.2em;writing-mode:horizontal-tb">大吉</div>`,
    fontScale: 0.6,
  },
  kakejiku: {
    ja: '掛け軸',
    desc: '床の間の掛け軸のように、上下に軸のついた縦長の紙に書く。格式、禅、静けさ。',
    box: CENTER,
    block: { background: '#f3ead6', color: INKC, writingMode: 'vertical-rl', padding: '1.2em 0.7em', borderLeft: '0.35em solid #7a5b3a', borderRight: '0.35em solid #7a5b3a' },
    deco: abs('left:-0.6em;right:-0.6em;top:-0.3em;height:0.3em;background:#2b2118;border-radius:0.15em') + abs('left:-0.6em;right:-0.6em;bottom:-0.3em;height:0.3em;background:#2b2118;border-radius:0.15em'),
    fontScale: 0.65,
  },
  lantern: {
    ja: '提灯',
    desc: '赤い提灯に縦に文字を入れる。祭り、夜店、あたたかな灯り。',
    box: CENTER,
    block: { background: 'radial-gradient(ellipse at 50% 45%, #ff6b4a, #c8102e 70%, #7a0a1c)', color: '#fff3d6', writingMode: 'vertical-rl', padding: '1em 1.1em', borderRadius: '45% / 50%', boxShadow: '0 0 1.2em rgba(255,110,60,0.55)', backgroundImage: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.12) 0 0.05em, transparent 0.05em 0.5em), radial-gradient(ellipse at 50% 45%, #ff6b4a, #c8102e 70%, #7a0a1c)' },
    deco: abs('left:25%;right:25%;top:-0.25em;height:0.25em;background:#1b1b1b') + abs('left:25%;right:25%;bottom:-0.25em;height:0.25em;background:#1b1b1b'),
    fontScale: 0.6,
  },
  'warning-label': {
    ja: '警告ラベル',
    desc: '黄色と黒の警告ラベルに言葉を刷る。危険、注意、立入禁止。',
    box: CENTER,
    block: { background: '#ffd400', color: INKC, border: `0.08em solid ${INKC}`, padding: '0.55em 0.9em' },
    deco: abs(`left:0;right:0;top:0;height:0.3em;background:repeating-linear-gradient(-45deg, ${INKC} 0 0.25em, #ffd400 0.25em 0.5em)`) + abs(`left:0;right:0;bottom:0;height:0.3em;background:repeating-linear-gradient(-45deg, ${INKC} 0 0.25em, #ffd400 0.25em 0.5em)`),
    fontScale: 0.7,
  },
  'price-tag': {
    ja: '値札',
    desc: '紐のついた値札に言葉を書く。売り出し、価値、ちょっとした皮肉。',
    box: CENTER,
    block: { background: PAPER, color: INKC, padding: '0.3em 0.8em 0.3em 1.3em', clipPath: 'polygon(0.6em 0, 100% 0, 100% 100%, 0.6em 100%, 0 50%)', transform: 'rotate(-6deg)' },
    deco: abs('left:0.45em;top:50%;width:0.22em;height:0.22em;margin-top:-0.11em;border-radius:50%;background:rgba(0,0,0,0.45)'),
    fontScale: 0.7,
  },
  'name-tag': {
    ja: '名札',
    desc: '「HELLO my name is」の名札に書き込むように置く。自己紹介、出会い、ユーモア。',
    box: CENTER,
    block: { background: '#ffffff', color: INKC, padding: '1.1em 0.9em 0.35em', borderRadius: '0.3em', boxShadow: '0 0.1em 0.4em rgba(0,0,0,0.3)', minWidth: '6em' },
    deco: `<div style="position:absolute;left:0;right:0;top:0;height:0.95em;background:#d7263d;border-radius:0.3em 0.3em 0 0;color:#fff;font-size:0.36em;line-height:2.6em;letter-spacing:0.1em;font-family:system-ui,sans-serif;font-weight:800">HELLO my name is</div>`,
    fontScale: 0.65,
  },
  'sticky-note': {
    ja: '付箋',
    desc: '少し傾いた黄色い付箋に、手書きのメモのように置く。',
    box: CENTER,
    block: { background: '#fff17a', color: INKC, padding: '0.7em 0.8em', transform: 'rotate(-4deg)', boxShadow: '0 0.25em 0.4em rgba(0,0,0,0.25)', minWidth: '4.5em', minHeight: '3em', display: 'flex', flexDirection: 'column', justifyContent: 'center' },
    fontScale: 0.6,
  },
  polaroid: {
    ja: 'ポラロイド',
    desc: '下の余白が広いインスタント写真の枠の、余白に書き込むように置く。思い出、記録。',
    box: CENTER,
    block: { background: '#ffffff', color: INKC, padding: '3.2em 0.45em 0.25em', boxShadow: '0 0.2em 0.6em rgba(0,0,0,0.35)', transform: 'rotate(3deg)', minWidth: '5em' },
    deco: abs(`left:0.45em;right:0.45em;top:0.45em;height:2.6em;background:linear-gradient(135deg, ${A}, #2a2a40)`),
    fontScale: 0.55,
  },
  postcard: {
    ja: 'はがき',
    desc: '切手と宛名の罫線のあるはがきに書く。遠くの誰かへの便り。',
    box: CENTER,
    block: { background: PAPER, color: INKC, padding: '1.4em 2.2em 0.5em 0.6em', minWidth: '8em', textAlign: 'left', backgroundImage: 'repeating-linear-gradient(180deg, transparent 0 1.2em, rgba(200,16,46,0.35) 1.2em 1.24em)' },
    deco: abs('right:0.35em;top:0.3em;width:1.1em;height:1.3em;border:0.05em dashed #c8102e') + abs('left:0.4em;top:0.3em;width:2.4em;height:0.35em;background:repeating-linear-gradient(90deg, rgba(200,16,46,0.6) 0 0.3em, transparent 0.3em 0.4em)'),
    fontScale: 0.55,
  },
  letter: {
    ja: '便箋',
    desc: '罫線の入った便箋に綴る。手紙、告白、ていねいな気持ち。',
    box: CENTER,
    block: { background: PAPER, color: INKC, padding: '0.5em 0.9em', backgroundImage: 'repeating-linear-gradient(180deg, transparent 0 1.2em, rgba(80,120,200,0.35) 1.2em 1.25em)', lineHeight: '1.25', boxShadow: '0 0.1em 0.4em rgba(0,0,0,0.2)', minWidth: '8em' },
    fontScale: 0.6,
  },
  calendar: {
    ja: 'カレンダー',
    desc: '日めくりカレンダーの一枚として置く。記念日、約束の日、時間の経過。',
    box: CENTER,
    block: { background: '#ffffff', color: INKC, padding: '1.3em 0.9em 0.5em', borderRadius: '0.25em', boxShadow: '0 0.2em 0.5em rgba(0,0,0,0.3)', minWidth: '5em' },
    deco: abs('left:0;right:0;top:0;height:0.8em;background:#d7263d;border-radius:0.25em 0.25em 0 0') + abs('left:28%;top:-0.2em;width:0.14em;height:0.5em;background:#555;border-radius:0.1em') + abs('right:28%;top:-0.2em;width:0.14em;height:0.5em;background:#555;border-radius:0.1em'),
    fontScale: 0.7,
  },
  clapper: {
    ja: 'カチンコ',
    desc: '撮影のカチンコの板に書き込む。本番、シーンの始まり、映画の舞台裏。',
    box: CENTER,
    block: { background: '#1b1b1b', color: '#ffffff', padding: '1.1em 0.9em 0.4em', minWidth: '7em', textAlign: 'left' },
    deco: abs('left:0;right:0;top:0;height:0.6em;background:repeating-linear-gradient(-60deg, #ffffff 0 0.4em, #1b1b1b 0.4em 0.8em)'),
    fontScale: 0.6,
  },
  billboard: {
    ja: '看板',
    desc: '二本の支柱に立つ看板に大きく書く。道端の広告、宣言、街の声。',
    box: CENTER,
    block: { background: PAPER, color: INKC, padding: '0.4em 0.9em', border: `0.12em solid ${INKC}` },
    deco: abs(`left:20%;bottom:-1.6em;width:0.2em;height:1.5em;background:${INKC}`) + abs(`right:20%;bottom:-1.6em;width:0.2em;height:1.5em;background:${INKC}`),
    fontScale: 0.8,
  },
  ema: {
    ja: '絵馬',
    desc: '五角形の木の絵馬に願いを書く。祈願、合格、恋愛成就。',
    box: CENTER,
    block: { background: 'linear-gradient(180deg, #e2c08d, #c89d5e)', color: '#3a2412', padding: '1.2em 1em 0.5em', clipPath: 'polygon(50% 0, 100% 28%, 100% 100%, 0 100%, 0 28%)', minWidth: '5em' },
    deco: abs('left:50%;top:0.55em;width:0.22em;height:0.22em;margin-left:-0.11em;border-radius:50%;background:#3a2412'),
    fontScale: 0.65,
  },
  vinyl: {
    ja: 'レコード',
    desc: 'レコード盤の中央ラベルに曲名のように刷る。音楽、ヴィンテージ、DJ。',
    box: CENTER,
    block: { width: '8em', height: '8em', borderRadius: '50%', background: `radial-gradient(circle, ${A} 0 32%, #111 33% 34%, #1c1c1c 35% 100%)`, backgroundImage: `radial-gradient(circle, #000 0 3%, ${A} 3.5% 32%, #111 33%), repeating-radial-gradient(circle, #1a1a1a 0 0.06em, #262626 0.06em 0.12em)`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ffffff', flexDirection: 'column' },
    fontScale: 0.5,
  },
  'book-spine': {
    ja: '背表紙',
    desc: '本の背表紙のように、細長い帯に縦に題を刷る。本棚、物語、記録。',
    box: CENTER,
    block: { background: '#23395b', color: '#f1e3c2', writingMode: 'vertical-rl', padding: '1.2em 0.35em', borderTop: '0.15em solid #c9a24a', borderBottom: '0.15em solid #c9a24a' },
    fontScale: 0.6,
  },
  newspaper: {
    ja: '新聞',
    desc: '新聞の一面の見出しのように、罫線と号外の印を添えて太く組む。事件、速報、時代。',
    box: CENTER,
    block: { background: '#f1ece2', color: INKC, padding: '0.9em 0.8em 0.4em', borderTop: `0.12em double ${INKC}`, fontFamily: "'Hiragino Mincho ProN', 'Noto Serif JP', serif", fontWeight: '900' },
    deco: `<div style="position:absolute;left:0.6em;top:0.15em;font-size:0.36em;letter-spacing:0.25em;font-weight:900">号外 EXTRA</div>`,
    fontScale: 0.85,
  },
  magazine: {
    ja: '見開き',
    desc: '雑誌の見開きのように、中央の綴じ目を挟んで左右に言葉を分ける。',
    box: { ...CENTER, background: 'linear-gradient(90deg, transparent calc(50% - 0.02em), rgba(128,128,128,0.5) calc(50% - 0.02em) calc(50% + 0.02em), transparent calc(50% + 0.02em))' },
    offset: (g) => ({ x: sideOf(g) * 1.1, y: 0 }),
  },
  poster: {
    ja: 'ポスター',
    desc: '太い枠と小さな添え書きのある、映画や展覧会のポスターのように組む。',
    box: CENTER,
    block: { border: `0.1em solid ${FG}`, padding: '1em 0.8em 1.2em' },
    deco: `<div style="position:absolute;left:0.5em;right:0.5em;top:0.25em;display:flex;justify-content:space-between;font-size:0.3em;letter-spacing:0.2em"><span>NO.01</span><span>2026</span></div><div style="position:absolute;left:0.5em;right:0.5em;bottom:0.3em;font-size:0.3em;letter-spacing:0.3em;text-align:center">NOW SHOWING</div>`,
    fontScale: 0.9,
  },
  'swiss-grid': {
    ja: 'スイスグリッド',
    desc: '細い格子線の上に、左上揃えで端正に組む。国際様式のグラフィックデザイン。',
    box: { justifyContent: 'flex-start', alignItems: 'flex-start', textAlign: 'left', padding: '10% 0 0 10%', backgroundImage: 'linear-gradient(90deg, rgba(128,128,128,0.25) 1px, transparent 1px), linear-gradient(rgba(128,128,128,0.25) 1px, transparent 1px)', backgroundSize: '12.5% 25%' },
    fontScale: 1.1,
  },
  contents: {
    ja: '目次',
    desc: '本の目次の一行のように、点線のリーダーとページ番号を添えて置く。',
    box: CENTER,
    block: { paddingRight: '3.4em', minWidth: '10em', textAlign: 'left' },
    deco: `<div style="position:absolute;right:1.1em;left:auto;width:2em;bottom:0.25em;border-bottom:0.06em dotted currentColor"></div><div style="position:absolute;right:0;bottom:0;font-size:0.6em;font-family:ui-monospace,monospace">p.12</div>`,
    fontScale: 0.7,
  },
  dictionary: {
    ja: '辞書',
    desc: '辞書の見出し語のように、読みと品詞を小さく添えて置く。言葉の定義、言葉遊び。',
    box: { justifyContent: 'flex-start', alignItems: 'center', paddingLeft: '10%' },
    block: { paddingBottom: '0.8em', borderBottom: `0.04em solid ${FG}` },
    deco: `<div style="position:absolute;left:0;bottom:0.1em;font-size:0.3em;letter-spacing:0.1em;opacity:0.7">【名】 ことば ‥ 心に浮かんだものを表す音や文字</div>`,
  },
  'route-map': {
    ja: '路線図',
    desc: '言葉の下に路線の線と駅の丸を描く。旅程、人生の駅、つながり。',
    box: CENTER,
    block: { paddingBottom: '0.8em' },
    deco: abs(`left:-0.3em;right:-0.3em;bottom:0.25em;height:0.14em;background:${A};border-radius:1em`) + [0, 33, 66, 100].map((x) => abs(`left:calc(${x}% - 0.18em);bottom:0.14em;width:0.36em;height:0.36em;border-radius:50%;background:#fff;border:0.08em solid ${A};box-sizing:border-box`)).join(''),
  },
  'hanko': {
    ja: '落款',
    desc: '朱の四角い判子のように、小さく縦に押す。署名、印、和の締め。',
    box: { justifyContent: 'flex-end', alignItems: 'flex-end', padding: '0 9% 9% 0' },
    block: { border: '0.12em solid #c8102e', color: '#c8102e', writingMode: 'vertical-rl', padding: '0.25em', transform: 'rotate(-4deg)', fontWeight: '900' },
    fontScale: 0.45,
  },
  shoji: {
    ja: '障子',
    desc: '障子の桟の格子越しに言葉が透けて見える。和室、影、ひそやかな気配。',
    box: { ...CENTER, backgroundColor: '#f4efe2', backgroundImage: 'linear-gradient(90deg, #8a6a45 0.08em, transparent 0.08em), linear-gradient(#8a6a45 0.08em, transparent 0.08em)', backgroundSize: '3em 2.2em', color: '#2b2118' },
  },
} satisfies Record<string, LayoutRecipe>
