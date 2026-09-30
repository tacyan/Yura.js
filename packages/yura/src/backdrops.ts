import { hash01 } from './motion-kit'

/**
 * 背景 — full-frame backdrops drawn in CSS and inline SVG: Japanese patterns
 * (青海波, 麻の葉, 市松, 千鳥格子, 矢絣), graphic patterns (sunburst, concentric
 * rings, chevrons, isometric cubes, halftone fades, moiré), scenery (skyline,
 * sunset, mountains, ocean, rain on a window, snow, clouds, a night with a
 * moon), and screen textures (VHS band, film strip, speed lines, colour bars).
 *
 * A backdrop is static markup plus an optional pure `frame(t)` that moves
 * keyed layers (drift, rotation, falling rain). Colours are CSS variables, so
 * one backdrop follows any theme, film look or page palette:
 *   --bd-bg  ground   (falls back to --yura-bg / --f-bg)
 *   --bd-a   figure   (falls back to --yura-accent / --f-accent)
 *   --bd-b   second   (falls back to --yura-accent2 / --f-sub)
 *   --bd-ink dim ink  (falls back to --yura-dim / --f-dark)
 * Nothing is fetched and nothing is in pixels of a particular screen: sizes
 * are em (of the host's font size) or %, so it tiles the same at any
 * resolution. (Pure.)
 */

export type Css = Record<string, string>

export interface BackdropRecipe {
  ja: string
  desc: string
  /** Layer markup; animated layers carry `data-bd="k"` keys. */
  layers(seed: number): string
  /** Styles per `data-bd` key at `t` seconds (optional). */
  frame?(t: number, seed: number): Record<string, Css>
}

const BG = 'var(--bd-bg, var(--yura-bg, var(--f-bg, #0d0d12)))'
const FA = 'var(--bd-a, var(--yura-accent, var(--f-accent, #ff4d6d)))'
const FB = 'var(--bd-b, var(--yura-accent2, var(--f-sub, #4dd6ff)))'
const INK = 'var(--bd-ink, var(--yura-dim, var(--f-dark, #1d1d26)))'
const mix = (c: string, pct: number): string => `color-mix(in srgb, ${c} ${pct}%, transparent)`
const r3 = (v: number): string => String(Math.round((Number.isFinite(v) ? v : 0) * 1000) / 1000)

/** One absolutely positioned full-frame layer. */
const layer = (style: string, key?: string, inner = ''): string =>
  `<div${key ? ` data-bd="${key}"` : ''} style="position:absolute;inset:0;${style}">${inner}</div>`
/** An oversized layer (room to drift or rotate without showing edges). */
const big = (style: string, key?: string, inner = ''): string =>
  `<div${key ? ` data-bd="${key}"` : ''} style="position:absolute;inset:-50%;${style}">${inner}</div>`
/** A repeating inline-SVG tile as a CSS background (percent-encoded, attribute-safe). */
const svgTile = (svg: string): string => `url(&quot;data:image/svg+xml,${encodeURIComponent(svg)}&quot;)`
/** SVG colours cannot read CSS variables inside a data URL: the tile is a mask, painted with a variable colour. */
const masked = (svg: string, size: string, color: string, key?: string, extra = ''): string =>
  layer(`background:${color};-webkit-mask-image:${svgTile(svg)};mask-image:${svgTile(svg)};-webkit-mask-size:${size};mask-size:${size};${extra}`, key)
const ground = layer(`background:${BG}`)
const drift = (t: number, speed: number, size = 100): string => `${r3((t * speed) % size)}em ${r3((t * speed * 0.6) % size)}em`

// ------------------------------------------------------------------ SVG tiles (drawn here, not traced)

/** Overlapping semicircular waves (青海波). */
const SEIGAIHA = (() => {
  const rings = (cx: number, cy: number): string =>
    [40, 31, 22, 13].map((r) => `<circle cx='${cx}' cy='${cy}' r='${r}' fill='none' stroke='black' stroke-width='3.2'/>`).join('')
  return `<svg xmlns='http://www.w3.org/2000/svg' width='80' height='40'><g>${rings(0, 40)}${rings(80, 40)}${rings(40, 20)}${rings(0, 0)}${rings(80, 0)}</g></svg>`
})()

/** Hemp-leaf star lattice (麻の葉): six spokes and the kite lines between them. */
const ASANOHA = (() => {
  const w = 60
  const h = 104
  const cx = w / 2
  const cy = h / 2
  const hex = [0, 1, 2, 3, 4, 5].map((k) => [cx + 30 * Math.cos((Math.PI / 3) * k + Math.PI / 6), cy + 30 * Math.sin((Math.PI / 3) * k + Math.PI / 6)])
  let d = ''
  for (const [x, y] of hex) d += `M${cx} ${cy}L${r3(x)} ${r3(y)}`
  for (let k = 0; k < 6; k++) {
    const [x1, y1] = hex[k]
    const [x2, y2] = hex[(k + 1) % 6]
    const mx = (x1 + x2) / 2
    const my = (y1 + y2) / 2
    const kx = cx + (mx - cx) * 0.66
    const ky = cy + (my - cy) * 0.66
    d += `M${r3(x1)} ${r3(y1)}L${r3(kx)} ${r3(ky)}L${r3(x2)} ${r3(y2)}M${cx} ${cy}L${r3(kx)} ${r3(ky)}`
  }
  return `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'><path d='${d}' stroke='black' stroke-width='1.6' fill='none'/><path d='M0 0L${w} 0M0 ${h}L${w} ${h}' stroke='black' stroke-width='1.6'/></svg>`
})()

/** Houndstooth (千鳥格子): the four-pointed check drawn on a 4×4 grid. */
const HOUNDSTOOTH = `<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 4 4'><path d='M0 0h2v2H0zM2 2h1l1-1v2l-1 1H2zM0 2l2 2H0zM2 0h1L2 1z' fill='black'/></svg>`

/** Arrow-feather stripes (矢絣). */
const YAGASURI = `<svg xmlns='http://www.w3.org/2000/svg' width='40' height='80'><path d='M0 0L20 20L20 60L0 40zM20 20L40 0L40 40L20 60z' fill='black' fill-opacity='0.9'/><path d='M0 40L20 60L20 80L0 60zM20 60L40 40L40 60L20 80z' fill='black' fill-opacity='0.35'/></svg>`

/** Isometric cubes: three shaded faces per hexagon. */
const CUBES = `<svg xmlns='http://www.w3.org/2000/svg' width='52' height='90' viewBox='0 0 52 90'><path d='M26 0L52 15L26 30L0 15z' fill='black' fill-opacity='0.95'/><path d='M0 15L26 30L26 60L0 45z' fill='black' fill-opacity='0.55'/><path d='M52 15L26 30L26 60L52 45z' fill='black' fill-opacity='0.25'/><path d='M26 60L52 75L26 90L0 75z' fill='black' fill-opacity='0.95'/><path d='M0 45L0 75L26 60zM52 45L52 75L26 60z' fill='black' fill-opacity='0.4'/></svg>`

/** Hexagonal grid outline. */
const HEXGRID = `<svg xmlns='http://www.w3.org/2000/svg' width='56' height='98' viewBox='0 0 56 98'><path d='M28 66L0 50L0 16L28 0L56 16L56 50L28 66L28 98M0 82L0 98M56 82L56 98' fill='none' stroke='black' stroke-width='1.5'/></svg>`

/** Triangle tessellation. */
const TRIANGLES = `<svg xmlns='http://www.w3.org/2000/svg' width='60' height='52'><path d='M0 52L30 0L60 52z' fill='black' fill-opacity='0.8'/><path d='M30 0L60 52L60 0z' fill='black' fill-opacity='0.3'/><path d='M0 0L30 0L0 52z' fill='black' fill-opacity='0.5'/></svg>`

/** Herringbone. */
const HERRINGBONE = `<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40'><path d='M0 10L10 0H20L0 20zM20 40L40 20V30L30 40zM20 0H30L40 10V20zM0 30V40H10L0 30z' fill='black' fill-opacity='0.85'/><path d='M0 20L20 0H30L0 30zM10 40L40 10V20L20 40z' fill='black' fill-opacity='0.35'/></svg>`

const NOISE = `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1.4 -0.3'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>`

/** Seeded scatter of small elements (stars, bokeh, particles, snow). */
function dots(seed: number, n: number, salt: number, style: (i: number, u: number, v: number, s: number) => string, key?: string): string {
  let out = ''
  for (let i = 0; i < n; i++) {
    const u = hash01(seed, i, salt)
    const v = hash01(seed, i, salt + 1)
    const s = hash01(seed, i, salt + 2)
    out += `<i${key ? ` data-bd="${key}${i}"` : ''} style="position:absolute;left:${r3(u * 100)}%;top:${r3(v * 100)}%;${style(i, u, v, s)}"></i>`
  }
  return out
}

/** Terrain / skyline / wave silhouettes as polygon paths across the frame (0..100 × 0..100). */
function ridge(seed: number, salt: number, base: number, amp: number, n: number, jag = 0): string {
  let d = `M0 100L0 ${r3(base)}`
  for (let k = 0; k <= n; k++) {
    const x = (k / n) * 100
    const y = base - amp * (0.5 + 0.5 * Math.sin(k * 0.9 + hash01(seed, k, salt) * 3)) - (jag ? hash01(seed, k, salt + 1) * jag : 0)
    d += `L${r3(x)} ${r3(y)}`
  }
  return `${d}L100 100Z`
}
function skylinePath(seed: number, base: number): string {
  let d = `M0 100L0 ${base}`
  let x = 0
  let k = 0
  while (x < 100) {
    const w = 3 + hash01(seed, k, 71) * 6
    const h = 8 + hash01(seed, k, 72) * 26
    d += `L${r3(x)} ${r3(base - h)}L${r3(x + w)} ${r3(base - h)}`
    x += w
    k++
  }
  return `${d}L100 ${base}L100 100Z`
}
const svgLayer = (inner: string, key?: string, extra = ''): string =>
  `<svg${key ? ` data-bd="${key}"` : ''} viewBox="0 0 100 100" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;${extra}">${inner}</svg>`

// ------------------------------------------------------------------ recipes

export const backdrops = {
  seigaiha: {
    ja: '青海波',
    desc: '重なり合う半円の波が一面に続く。穏やかな海と、途切れない幸せを願う和の文様。',
    layers: () => ground + masked(SEIGAIHA, '4em 2em', mix(FA, 55), '0'),
    frame: (t) => ({ '0': { WebkitMaskPosition: `${r3(t * 0.4)}em 0`, maskPosition: `${r3(t * 0.4)}em 0` } }),
  },
  asanoha: {
    ja: '麻の葉',
    desc: '六方へ伸びる線が星のような葉を編む。まっすぐ育つ麻にあやかる、きりっとした和の文様。',
    layers: () => ground + masked(ASANOHA, '3em 5.2em', mix(FA, 50)),
  },
  ichimatsu: {
    ja: '市松',
    desc: '二色の正方形が交互に並ぶ市松模様。粋で、途切れず広がる繁栄の柄。',
    layers: () => layer(`background:conic-gradient(${FA} 25%, ${BG} 0 50%, ${FA} 0 75%, ${BG} 0);background-size:3em 3em`, '0'),
    frame: (t) => ({ '0': { backgroundPosition: `${r3(t * 0.3)}em ${r3(t * 0.3)}em` } }),
  },
  houndstooth: {
    ja: '千鳥格子',
    desc: '鳥が連なって飛ぶような格子柄。英国の生地のような品と、クラシックな緊張感。',
    layers: () => ground + masked(HOUNDSTOOTH, '2.4em 2.4em', mix(FA, 80)),
  },
  yagasuri: {
    ja: '矢絣',
    desc: '矢羽根の形が縦に連なる柄。袴や着物の、凛とした前向きさ。',
    layers: () => ground + masked(YAGASURI, '2em 4em', mix(FA, 75)),
  },
  herringbone: {
    ja: 'ヘリンボーン',
    desc: '魚の骨のように互い違いに並ぶ斜めの矩形。ツイードや床の寄木のような落ち着き。',
    layers: () => ground + masked(HERRINGBONE, '2em 2em', mix(FA, 45)),
  },
  argyle: {
    ja: 'アーガイル',
    desc: '菱形の格子と細い斜線が重なる。セーターや靴下のような、あたたかい学生らしさ。',
    layers: () =>
      layer(
        `background:repeating-linear-gradient(45deg, transparent 0 2.08em, ${mix(FB, 60)} 2.08em 2.16em),repeating-linear-gradient(-45deg, transparent 0 2.08em, ${mix(FB, 60)} 2.08em 2.16em),linear-gradient(45deg, ${FA} 25%, transparent 25% 75%, ${FA} 75%),linear-gradient(-45deg, ${FA} 25%, ${BG} 25% 75%, ${FA} 75%);background-size:auto,auto,3em 5em,3em 5em`,
      ),
  },
  tartan: {
    ja: 'タータン',
    desc: '太さの違う縞が縦横に重なるチェック。スコットランドの布のような温かみ。',
    layers: () =>
      layer(
        `background:${BG};background-image:repeating-linear-gradient(90deg, ${mix(FA, 45)} 0 1.4em, transparent 1.4em 2em, ${mix(FB, 35)} 2em 2.3em, transparent 2.3em 4.2em),repeating-linear-gradient(0deg, ${mix(FA, 45)} 0 1.4em, transparent 1.4em 2em, ${mix(FB, 35)} 2em 2.3em, transparent 2.3em 4.2em)`,
      ),
  },
  chevron: {
    ja: '山形',
    desc: 'ジグザグの山形が帯になって流れる。勢いと方向、ポップな賑やかさ。',
    layers: () => layer(`background:linear-gradient(135deg, ${FA} 25%, transparent 25%) -1.5em 0,linear-gradient(225deg, ${FA} 25%, transparent 25%) -1.5em 0,linear-gradient(315deg, ${FA} 25%, transparent 25%),linear-gradient(45deg, ${FA} 25%, transparent 25%);background-size:3em 3em;background-color:${BG}`, '0'),
    frame: (t) => ({ '0': { backgroundPosition: `-1.5em ${r3(t * 1.2)}em, -1.5em ${r3(t * 1.2)}em, 0 ${r3(t * 1.2)}em, 0 ${r3(t * 1.2)}em` } }),
  },
  cubes: {
    ja: '立方体',
    desc: '三つの面で陰影をつけた立方体が敷き詰められる。錯視のような奥行き。',
    layers: () => ground + masked(CUBES, '2.6em 4.5em', mix(FA, 85)),
  },
  hexgrid: {
    ja: '六角格子',
    desc: '蜂の巣のような六角形の網目。テクノロジー、構造、つながり。',
    layers: () => ground + masked(HEXGRID, '2.8em 4.9em', mix(FA, 45), '0'),
    frame: (t) => ({ '0': { opacity: r3(0.6 + 0.4 * Math.sin(t * 1.2)) } }),
  },
  triangles: {
    ja: '三角モザイク',
    desc: '濃淡の違う三角形が敷き詰められる。幾何学的で、硬質なグラフィック。',
    layers: () => ground + masked(TRIANGLES, '3em 2.6em', mix(FA, 70)),
  },
  sunburst: {
    ja: '放射',
    desc: '中心から放射状に色の帯が広がり、ゆっくり回る。祝い、発表、昭和のポスターの高揚。',
    layers: () => big(`background:repeating-conic-gradient(from 0deg at 50% 50%, ${FA} 0 7.5deg, ${BG} 7.5deg 15deg)`, '0'),
    frame: (t) => ({ '0': { transform: `rotate(${r3(t * 6)}deg)` } }),
  },
  concentric: {
    ja: '同心円',
    desc: '中心から同心円が広がり続ける。催眠、音の波、吸い込まれる感覚。',
    layers: () => layer(`background:repeating-radial-gradient(circle at 50% 50%, ${FA} 0 1.2em, ${BG} 1.2em 2.4em)`, '0'),
    frame: (t) => ({ '0': { backgroundSize: `${r3(100 + ((t * 20) % 40))}% ${r3(100 + ((t * 20) % 40))}%`, backgroundPosition: 'center' } }),
  },
  moire: {
    ja: 'モアレ',
    desc: '二つの細かな同心円がずれて重なり、干渉の縞がうねる。目眩のような錯視。',
    layers: () =>
      ground +
      layer(`background:repeating-radial-gradient(circle at 40% 50%, ${mix(FA, 70)} 0 0.14em, transparent 0.14em 0.36em)`) +
      layer(`background:repeating-radial-gradient(circle at 60% 50%, ${mix(FB, 70)} 0 0.14em, transparent 0.14em 0.36em)`, '0'),
    frame: (t) => ({ '0': { transform: `translateX(${r3(Math.sin(t * 0.5) * 6)}%)` } }),
  },
  'halftone-fade': {
    ja: '網点グラデ',
    desc: '網点が画面の端から中央へ向かって小さくなっていく。印刷物やアメコミの陰影。',
    layers: () => ground + layer(`background:radial-gradient(${FA} 30%, transparent 32%);background-size:0.8em 0.8em;-webkit-mask-image:linear-gradient(90deg, #000, transparent 70%);mask-image:linear-gradient(90deg, #000, transparent 70%)`),
  },
  'big-stripes': {
    ja: '大きな斜線',
    desc: '太い斜めの縞が画面を横切って流れ続ける。工事現場、警告、スピード。',
    layers: () => layer(`background:repeating-linear-gradient(-45deg, ${FA} 0 2em, ${BG} 2em 4em)`, '0'),
    frame: (t) => ({ '0': { backgroundPosition: `${r3((t * 3) % 5.657)}em 0` } }),
  },
  'split-v': {
    ja: '左右二色',
    desc: '画面を縦に割って左右で色を変える。対比、対話、二つの視点。',
    layers: () => layer(`background:linear-gradient(90deg, ${BG} 50%, ${FA} 50%)`),
  },
  'split-h': {
    ja: '上下二色',
    desc: '画面を横に割って上下で色を変える。地平線、境界、表と裏。',
    layers: () => layer(`background:linear-gradient(180deg, ${BG} 50%, ${FA} 50%)`),
  },
  'split-diag': {
    ja: '斜め二色',
    desc: '画面を斜めに割って二色に塗り分ける。勢いと切れ味のあるグラフィック。',
    layers: () => layer(`background:linear-gradient(115deg, ${BG} 55%, ${FA} 55%)`),
  },
  spotlight: {
    ja: 'スポットライト',
    desc: '暗い舞台を丸い照明がゆっくり動く。登場、発表、ひとりきりの歌。',
    layers: () => ground + layer(`background:radial-gradient(circle at 50% 50%, ${mix(FA, 55)} 0%, transparent 32%)`, '0'),
    frame: (t) => ({ '0': { transform: `translate(${r3(Math.sin(t * 0.4) * 18)}%, ${r3(Math.cos(t * 0.31) * 10)}%)` } }),
  },
  'color-bars': {
    ja: 'テレビの帯',
    desc: 'テレビの試験放送のような色の帯が並ぶ。放送、昭和、レトロなメディア。',
    layers: () => layer('background:linear-gradient(90deg, #c0c0c0 0 14.28%, #c0c000 0 28.57%, #00c0c0 0 42.85%, #00c000 0 57.14%, #c000c0 0 71.42%, #c00000 0 85.71%, #0000c0 0)'),
  },
  'speed-lines': {
    ja: '集中線',
    desc: '画面の外から中心へ向かう細い線が走る。漫画の決めのコマのような集中と衝撃。',
    layers: () => ground + big(`background:repeating-conic-gradient(from 0deg at 50% 50%, ${mix(FA, 70)} 0 0.6deg, transparent 0.6deg 4deg);-webkit-mask-image:radial-gradient(circle, transparent 18%, #000 40%);mask-image:radial-gradient(circle, transparent 18%, #000 40%)`, '0'),
    frame: (t) => ({ '0': { transform: `rotate(${r3(Math.floor(t * 12) * 1.7)}deg)` } }),
  },
  'scan-bars': {
    ja: '走査線の帯',
    desc: '明るい帯が上から下へ繰り返し画面を走査する。モニター、監視、デジタル。',
    layers: () => ground + layer(`background:repeating-linear-gradient(0deg, ${mix(FA, 12)} 0 0.08em, transparent 0.08em 0.24em)`) + layer(`background:linear-gradient(180deg, transparent, ${mix(FA, 35)} 50%, transparent);height:18%`, '0'),
    frame: (t) => ({ '0': { transform: `translateY(${r3(((t * 30) % 140) * 4 - 100)}%)` } }),
  },
  'dot-grid': {
    ja: 'ドット格子',
    desc: '等間隔の小さな点が画面を埋める。方眼ノートや設計のような整然さ。',
    layers: () => layer(`background:${BG} radial-gradient(${mix(FA, 55)} 12%, transparent 14%);background-size:1.4em 1.4em`, '0'),
    frame: (t) => ({ '0': { backgroundPosition: drift(t, 0.3) } }),
  },
  polka: {
    ja: '水玉',
    desc: '大きめの水玉が互い違いに並ぶ。レトロでかわいい、ポップな地。',
    layers: () => layer(`background-color:${BG};background-image:radial-gradient(${FA} 22%, transparent 23%),radial-gradient(${FA} 22%, transparent 23%);background-size:3em 3em;background-position:0 0, 1.5em 1.5em`),
  },
  grid: {
    ja: '方眼',
    desc: '細い線の方眼がゆっくり流れる。設計図、ノート、整えられた空間。',
    layers: () => layer(`background:${BG};background-image:linear-gradient(${mix(FA, 25)} 1px, transparent 1px),linear-gradient(90deg, ${mix(FA, 25)} 1px, transparent 1px);background-size:2em 2em`, '0'),
    frame: (t) => ({ '0': { backgroundPosition: `0 ${r3((t * 0.6) % 2)}em` } }),
  },
  'retro-grid': {
    ja: 'レトロ格子',
    desc: '地平線へ続くネオンの床の格子が手前へ流れ続ける。80年代の未来像。',
    layers: () =>
      layer(`background:linear-gradient(180deg, ${BG} 0 55%, ${mix(FA, 20)} 55%)`) +
      `<div style="position:absolute;left:-50%;right:-50%;top:55%;bottom:-30%;perspective:12em;overflow:hidden"><div data-bd="0" style="position:absolute;inset:0;transform:rotateX(68deg);transform-origin:50% 0;background-image:linear-gradient(${FA} 0.06em, transparent 0.06em),linear-gradient(90deg, ${FA} 0.06em, transparent 0.06em);background-size:3em 3em"></div></div>` +
      layer(`background:linear-gradient(180deg, transparent 50%, ${FA} 55%, transparent 60%);opacity:0.35`),
    frame: (t) => ({ '0': { backgroundPosition: `0 ${r3((t * 4) % 3)}em` } }),
  },
  mesh: {
    ja: 'メッシュグラデ',
    desc: 'ぼかした色の塊がゆっくり漂って混ざり合う。やわらかく、今っぽいプロダクトの地。',
    layers: (seed) =>
      ground +
      [FA, FB, INK]
        .map((c, i) => `<div data-bd="${i}" style="position:absolute;width:70%;height:80%;left:${r3(hash01(seed, i, 31) * 50 - 10)}%;top:${r3(hash01(seed, i, 32) * 50 - 15)}%;background:radial-gradient(closest-side, ${mix(c, 70)}, transparent);filter:blur(2em)"></div>`)
        .join(''),
    frame: (t) => Object.fromEntries([0, 1, 2].map((i) => [String(i), { transform: `translate(${r3(Math.sin(t * 0.15 + i * 2) * 12)}%, ${r3(Math.cos(t * 0.12 + i) * 10)}%)` }])),
  },
  'duotone-sweep': {
    ja: '二色スイープ',
    desc: '二色のグラデーションの境目が、斜めにゆっくり行き来する。',
    layers: () => big(`background:linear-gradient(120deg, ${BG} 30%, ${FA} 50%, ${FB} 70%)`, '0'),
    frame: (t) => ({ '0': { transform: `translateX(${r3(Math.sin(t * 0.3) * 18)}%)` } }),
  },
  ribbons: {
    ja: 'オーロラの帯',
    desc: 'ぼかした色の帯が斜めに揺らめきながら流れる。オーロラや絹のような光。',
    layers: () =>
      ground +
      [0, 1, 2].map((i) => `<div data-bd="${i}" style="position:absolute;left:-30%;right:-30%;top:${20 + i * 18}%;height:22%;background:linear-gradient(90deg, transparent, ${mix(i % 2 ? FB : FA, 55)}, transparent);filter:blur(1.8em);transform:rotate(-12deg)"></div>`).join(''),
    frame: (t) => Object.fromEntries([0, 1, 2].map((i) => [String(i), { transform: `rotate(${r3(-12 + Math.sin(t * 0.3 + i) * 5)}deg) translateX(${r3(Math.sin(t * 0.2 + i * 1.7) * 10)}%)` }])),
  },
  horizon: {
    ja: '惑星の縁',
    desc: '画面の下に巨大な球体の縁が見え、縁が光る。宇宙、始まり、大きな世界。',
    layers: () => ground + `<div data-bd="0" style="position:absolute;left:-40%;right:-40%;top:62%;height:160%;border-radius:50%;background:${INK};box-shadow:0 -0.3em 2em ${FA}, inset 0 0.25em 0.8em ${mix(FA, 60)}"></div>`,
    frame: (t) => ({ '0': { transform: `translateY(${r3(Math.sin(t * 0.2) * 2)}%)` } }),
  },
  stars: {
    ja: '星空',
    desc: '無数の星がまたたく夜空。静けさ、願い、遠い場所。',
    layers: (seed) => ground + dots(seed, 90, 41, (_i, _u, _v, s) => `width:${s < 0.85 ? 0.08 : 0.14}em;height:${s < 0.85 ? 0.08 : 0.14}em;border-radius:50%;background:#fff`, 's'),
    frame: (t, seed) => Object.fromEntries(Array.from({ length: 90 }, (_, i) => [`s${i}`, { opacity: r3(0.35 + 0.65 * Math.abs(Math.sin(t * (0.6 + hash01(seed, i, 44)) + i))) }])),
  },
  'night-moon': {
    ja: '月夜',
    desc: '星空に大きな月が浮かび、薄い雲がゆっくり流れる。',
    layers: (seed) =>
      ground +
      dots(seed, 50, 46, (_i, _u, _v, s) => `width:${s < 0.8 ? 0.07 : 0.12}em;height:${s < 0.8 ? 0.07 : 0.12}em;border-radius:50%;background:#fff;opacity:${r3(0.4 + s * 0.6)}`) +
      `<div style="position:absolute;right:12%;top:12%;width:18vmin;height:18vmin;border-radius:50%;background:radial-gradient(circle at 40% 38%, #fffbe8, #efe3b8 60%, #d9c98f);box-shadow:0 0 6vmin ${mix('#fff6d0', 50)}"></div>` +
      `<div data-bd="0" style="position:absolute;left:-20%;right:-20%;top:20%;height:12%;background:radial-gradient(ellipse, ${mix('#ffffff', 18)}, transparent 70%);filter:blur(0.8em)"></div>`,
    frame: (t) => ({ '0': { transform: `translateX(${r3(((t * 2) % 60) - 30)}%)` } }),
  },
  skyline: {
    ja: '街並み',
    desc: '高さの違うビルの影が並び、窓の灯りがともる。夜の街、都会の孤独。',
    layers: (seed) =>
      layer(`background:linear-gradient(180deg, ${INK}, ${BG} 70%)`) +
      svgLayer(`<path d='${skylinePath(seed + 1, 82)}' fill='${'#000000'}' fill-opacity='0.35'/>`, undefined, `color:${FB}`) +
      svgLayer(`<path d='${skylinePath(seed, 100)}' fill='black' fill-opacity='0.8'/>`) +
      dots(seed, 60, 51, () => `width:0.18em;height:0.24em;background:${FA};opacity:0.8`, 'w').replace(/top:(\d+(?:\.\d+)?)%/g, (_m, v) => `top:${r3(78 + (Number(v) / 100) * 20)}%`),
    frame: (t, seed) => Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`w${i}`, { opacity: hash01(seed, i + Math.floor(t * 0.5), 52) < 0.7 ? '0.85' : '0.1' }])),
  },
  sunset: {
    ja: '夕日',
    desc: '夕焼けのグラデーションに、横縞の入った太陽が沈んでいく。レトロで切ない。',
    layers: () =>
      layer(`background:linear-gradient(180deg, ${INK} 0%, ${mix(FB, 80)} 45%, ${FA} 75%, ${BG} 76%)`) +
      `<div data-bd="0" style="position:absolute;left:50%;top:40%;width:34vmin;height:34vmin;margin-left:-17vmin;border-radius:50%;background:linear-gradient(180deg, #fff3b0, ${FA});-webkit-mask-image:linear-gradient(180deg, #000 58%, transparent 58% 61%, #000 61% 67%, transparent 67% 71%, #000 71% 77%, transparent 77% 82%, #000 82% 86%, transparent 86%);mask-image:linear-gradient(180deg, #000 58%, transparent 58% 61%, #000 61% 67%, transparent 67% 71%, #000 71% 77%, transparent 77% 82%, #000 82% 86%, transparent 86%)"></div>`,
    frame: (t) => ({ '0': { transform: `translateY(${r3(Math.min(20, t * 0.8))}%)` } }),
  },
  mountains: {
    ja: '山並み',
    desc: '奥へ行くほど霞んでいく山の稜線が幾重にも重なる。旅、雄大さ、日本の風景。',
    layers: (seed) =>
      layer(`background:linear-gradient(180deg, ${BG}, ${mix(FB, 40)})`) +
      [0, 1, 2, 3].map((k) => svgLayer(`<path d='${ridge(seed + k, 61, 58 + k * 10, 16 - k * 2, 14, 3)}' fill='black' fill-opacity='${r3(0.2 + k * 0.2)}'/>`)).join(''),
  },
  ocean: {
    ja: '海の波',
    desc: '重なった波の帯が上下にうねりながら寄せては返す。夏、旅、遠い記憶。',
    layers: (seed) =>
      layer(`background:linear-gradient(180deg, ${BG}, ${mix(FB, 50)})`) +
      [0, 1, 2].map((k) => `<div data-bd="${k}" style="position:absolute;left:-10%;right:-10%;top:${55 + k * 12}%;bottom:-10%;color:${k % 2 ? FA : FB}">${svgLayer(`<path d='${ridge(seed + k, 81, 10, 6, 10)}' fill='currentColor' fill-opacity='${r3(0.45 + k * 0.2)}'/>`)}</div>`).join(''),
    frame: (t) => Object.fromEntries([0, 1, 2].map((k) => [String(k), { transform: `translate(${r3(Math.sin(t * 0.6 + k) * 4)}%, ${r3(Math.sin(t * 0.9 + k * 1.3) * 3)}%)` }])),
  },
  'rain-window': {
    ja: '雨の窓',
    desc: '曇った窓ガラスを雨の筋が次々に流れ落ちる。雨の日の室内、しっとりした別れ。',
    layers: (seed) =>
      layer(`background:linear-gradient(180deg, ${INK}, ${BG});filter:blur(0.02em)`) +
      dots(seed, 40, 91, (_i, _u, _v, s) => `width:0.05em;height:${r3(1 + s * 3)}em;background:linear-gradient(180deg, transparent, ${mix('#ffffff', 45)});border-radius:1em`, 'r'),
    frame: (t, seed) => Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`r${i}`, { transform: `translateY(${r3((((t * (8 + hash01(seed, i, 93) * 10) + hash01(seed, i, 94) * 100) % 140) - 40) * 1)}vh)` }])),
  },
  snow: {
    ja: '雪',
    desc: '大小の雪がゆらゆら揺れながら降り続ける。冬、静けさ、ひとりの夜。',
    layers: (seed) => ground + dots(seed, 70, 101, (_i, _u, _v, s) => `width:${r3(0.08 + s * 0.2)}em;height:${r3(0.08 + s * 0.2)}em;border-radius:50%;background:#fff;opacity:${r3(0.4 + s * 0.6)};filter:blur(${r3(s < 0.3 ? 0.03 : 0)}em)`, 'f'),
    frame: (t, seed) => Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`f${i}`, { transform: `translate(${r3(Math.sin(t * 0.8 + i) * 1.2)}em, ${r3((((t * (3 + hash01(seed, i, 103) * 5) + hash01(seed, i, 104) * 100) % 120) - 20))}vh)` }])),
  },
  clouds: {
    ja: '雲',
    desc: '大きな雲の層がゆっくり横へ流れていく。空、旅立ち、晴れやかな気分。',
    layers: (seed) =>
      layer(`background:linear-gradient(180deg, ${FB}, ${BG})`) +
      [0, 1, 2, 3, 4].map((i) => `<div data-bd="${i}" style="position:absolute;left:${r3(hash01(seed, i, 111) * 100 - 20)}%;top:${r3(10 + hash01(seed, i, 112) * 60)}%;width:${r3(30 + hash01(seed, i, 113) * 30)}%;height:${r3(10 + hash01(seed, i, 114) * 10)}%;border-radius:50%;background:${mix('#ffffff', 75)};filter:blur(0.6em)"></div>`).join(''),
    frame: (t, seed) => Object.fromEntries([0, 1, 2, 3, 4].map((i) => [String(i), { transform: `translateX(${r3(((t * (1 + hash01(seed, i, 115) * 2)) % 160) - 20)}%)` }])),
  },
  bokeh: {
    ja: 'ボケ玉',
    desc: 'ピントの外れた光の玉がゆっくり漂う。夜景、イルミネーション、夢見心地。',
    layers: (seed) => ground + dots(seed, 18, 121, (i, _u, _v, s) => `width:${r3(1 + s * 3)}em;height:${r3(1 + s * 3)}em;border-radius:50%;background:radial-gradient(circle, ${mix(i % 2 ? FA : FB, 55)}, transparent 70%);filter:blur(0.1em)`, 'b'),
    frame: (t) => Object.fromEntries(Array.from({ length: 18 }, (_, i) => [`b${i}`, { transform: `translate(${r3(Math.sin(t * 0.2 + i) * 2)}em, ${r3(Math.cos(t * 0.17 + i * 1.3) * 1.5)}em)` }])),
  },
  particles: {
    ja: '舞い上がる粒',
    desc: '光の粒が下から上へ舞い上がっていく。火の粉、祈り、エネルギー。',
    layers: (seed) => ground + dots(seed, 50, 131, (_i, _u, _v, s) => `width:${r3(0.06 + s * 0.12)}em;height:${r3(0.06 + s * 0.12)}em;border-radius:50%;background:${FA};box-shadow:0 0 0.3em ${FA}`, 'p'),
    frame: (t, seed) => Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`p${i}`, { transform: `translate(${r3(Math.sin(t + i) * 0.8)}em, ${r3(-(((t * (4 + hash01(seed, i, 133) * 6) + hash01(seed, i, 134) * 100) % 120) - 20))}vh)`, opacity: r3(0.3 + 0.7 * Math.abs(Math.sin(t * 2 + i))) }])),
  },
  ripples: {
    ja: '波紋',
    desc: '水面のあちこちに波紋が広がっては消える。雨粒、静かな水、しずかな感情。',
    layers: (seed) => ground + dots(seed, 6, 141, () => `width:0;height:0`, 'q').replace(/<i ([^>]*)><\/i>/g, (_m, a) => `<i ${a}><b style="position:absolute;left:-4em;top:-4em;width:8em;height:8em;border-radius:50%;border:0.08em solid ${FA}"></b></i>`),
    frame: (t, seed) => Object.fromEntries(Array.from({ length: 6 }, (_, i) => { const v = ((t / 3 + hash01(seed, i, 143)) % 1); return [`q${i}`, { transform: `scale(${r3(0.1 + v)})`, opacity: r3(1 - v) }] })),
  },
  equalizer: {
    ja: 'イコライザー',
    desc: '画面の下で音量のバーが音楽に合わせて伸び縮みする。音楽番組、クラブ、ライブ。',
    layers: () =>
      ground +
      `<div style="position:absolute;left:0;right:0;bottom:0;height:45%;display:flex;gap:0.6%;align-items:flex-end;padding:0 3%">${Array.from({ length: 24 }, (_, i) => `<i data-bd="e${i}" style="flex:1;height:100%;background:linear-gradient(0deg, ${FA}, ${FB});transform-origin:50% 100%;opacity:0.55"></i>`).join('')}</div>`,
    frame: (t) => Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`e${i}`, { transform: `scaleY(${r3(0.1 + 0.9 * Math.abs(Math.sin(t * 3.1 + i * 0.7) * Math.sin(t * 1.3 + i * 0.31)))})` }])),
  },
  'film-strip': {
    ja: 'フィルム',
    desc: '上下にフィルムの送り穴が並んで流れる。映画、記録、思い出のひとこま。',
    layers: () =>
      ground +
      [0, 1].map((k) => `<div data-bd="${k}" style="position:absolute;left:0;right:0;${k ? 'bottom' : 'top'}:0;height:9%;background:${INK};background-image:linear-gradient(90deg, transparent 0.5em, ${BG} 0.5em 1.3em, transparent 1.3em);background-size:1.8em 45%;background-repeat:repeat-x;background-position:0 50%"></div>`).join(''),
    frame: (t) => ({ '0': { backgroundPosition: `${r3(-t * 3)}em 50%` }, '1': { backgroundPosition: `${r3(-t * 3)}em 50%` } }),
  },
  vhs: {
    ja: 'VHSノイズ',
    desc: '古いビデオテープのように、ノイズの帯と色ずれの線が画面を流れる。',
    layers: () =>
      ground +
      layer(`background-image:${svgTile(NOISE)};opacity:0.18;mix-blend-mode:screen`, '0') +
      layer(`background:linear-gradient(180deg, transparent, ${mix('#ffffff', 25)} 40%, ${mix(FA, 35)} 50%, transparent);height:10%`, '1') +
      layer(`background:repeating-linear-gradient(0deg, rgba(0,0,0,0.25) 0 0.06em, transparent 0.06em 0.18em)`),
    frame: (t) => ({ '0': { backgroundPosition: `${Math.floor(t * 24) * 37 % 240}px ${Math.floor(t * 24) * 53 % 240}px` }, '1': { transform: `translateY(${r3(((t * 70) % 1100) - 100)}%)` } }),
  },
  'torn-paper': {
    ja: '破れ紙',
    desc: '破り取った紙の縁が画面を斜めに横切る。手作り、コラージュ、ZINE の手触り。',
    layers: (seed) => ground + svgLayer(`<path d='${ridge(seed, 151, 62, 5, 40, 4)}' fill='black' fill-opacity='0.12' transform='translate(0.8 1.2)'/><path d='${ridge(seed, 151, 62, 5, 40, 4)}' fill='white'/>`, undefined, `color:${FA}`),
  },
  'god-rays': {
    ja: '光芒',
    desc: '画面の上から光の筋が扇状に差し込み、ゆっくり揺れる。祈り、救い、朝。',
    layers: () => ground + big(`background:repeating-conic-gradient(from 160deg at 50% 20%, ${mix(FA, 35)} 0 2deg, transparent 2deg 9deg);-webkit-mask-image:linear-gradient(180deg, #000 20%, transparent 80%);mask-image:linear-gradient(180deg, #000 20%, transparent 80%)`, '0'),
    frame: (t) => ({ '0': { transform: `rotate(${r3(Math.sin(t * 0.25) * 4)}deg)` } }),
  },
  topo: {
    ja: '等高線',
    desc: '地図の等高線のような、ゆがんだ同心の線が幾重にも描かれる。地形、探検、分析。',
    layers: (seed) =>
      ground +
      svgLayer(
        Array.from({ length: 12 }, (_, k) => {
          const cx = 30 + hash01(seed, 0, 161) * 40
          const cy = 30 + hash01(seed, 0, 162) * 40
          const r = 6 + k * 7
          let d = ''
          for (let a = 0; a <= 36; a++) {
            const th = (a / 36) * Math.PI * 2
            const rr = r * (1 + 0.18 * Math.sin(th * 3 + k * 0.7 + seed) + 0.08 * Math.sin(th * 5 - k))
            d += `${a ? 'L' : 'M'}${r3(cx + Math.cos(th) * rr)} ${r3(cy + Math.sin(th) * rr * 0.8)}`
          }
          return `<path d='${d}Z' fill='none' stroke='currentColor' stroke-width='0.25' opacity='${r3(0.35 + (k % 4 === 0 ? 0.4 : 0))}' vector-effect='non-scaling-stroke'/>`
        }).join(''),
        undefined,
        `color:${FA}`,
      ),
  },
  letterbox: {
    ja: 'シネスコ帯',
    desc: '画面の上下に黒い帯を置き、映画のワイド画面にする。',
    layers: () => ground + layer('background:linear-gradient(180deg, #000 0 12%, transparent 12% 88%, #000 88%)'),
  },
  frame: {
    ja: '太枠',
    desc: '画面の縁に太い色の枠を回す。ポスターや額装のような、切り取られた一枚。',
    layers: () => ground + layer(`box-shadow:inset 0 0 0 1.2em ${FA}`),
  },
  noise: {
    ja: 'ノイズの揺らぎ',
    desc: '細かな粒子のノイズが画面全体でざわめく。フィルムの粒子、不穏、生々しさ。',
    layers: () => ground + layer(`background-image:${svgTile(NOISE)};opacity:0.35`, '0'),
    frame: (t) => ({ '0': { backgroundPosition: `${(Math.floor(t * 24) * 61) % 240}px ${(Math.floor(t * 24) * 43) % 240}px` } }),
  },
  papercut: {
    ja: '切り絵',
    desc: '影を落とした紙の波が何層にも重なる。手仕事の温かさと奥行き。',
    layers: (seed) =>
      ground +
      [0, 1, 2, 3].map((k) => svgLayer(`<path d='${ridge(seed + k * 7, 171, 45 + k * 13, 9, 8)}' fill='currentColor' fill-opacity='${r3(0.35 + k * 0.18)}'/>`, undefined, `color:${k % 2 ? FA : FB};filter:drop-shadow(0 -0.2em 0.4em rgba(0,0,0,0.35))`)).join(''),
  },
} satisfies Record<string, BackdropRecipe>

export type BackdropName = keyof typeof backdrops

/** Markup for a backdrop; `data-bd` keys are prefixed with `prefix` (so several can share a page). (Pure.) */
export function backdropMarkup(name: string, seed = 1, prefix = 'bd:'): string {
  const r = (backdrops as Record<string, BackdropRecipe>)[name]
  if (!r) return ''
  const html = r.layers(seed).replace(/data-bd="([^"]+)"/g, (_m, k) => `data-bd="${prefix}${k}"`)
  return `<div data-yura-backdrop="${name}" aria-hidden="true" style="position:absolute;inset:0;overflow:hidden;pointer-events:none">${html}</div>`
}

/** Styles of a backdrop's animated layers at `t`, keyed like {@link backdropMarkup}. (Pure.) */
export function backdropFrame(name: string, t: number, seed = 1, prefix = 'bd:'): Record<string, Css> {
  const r = (backdrops as Record<string, BackdropRecipe>)[name]
  if (!r?.frame) return {}
  const out: Record<string, Css> = {}
  for (const [k, v] of Object.entries(r.frame(Number.isFinite(t) ? t : 0, seed))) out[`${prefix}${k}`] = v
  return out
}
