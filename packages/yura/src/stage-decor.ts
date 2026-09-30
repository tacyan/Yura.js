import { hash01 } from './motions'
import { segmentGraphemes } from './shapes'
import type { DecorName } from './stage-themes'

/**
 * Decor for {@link lyricStage}: the graphic marks around the words that make
 * a lyric frame read as *designed* — corner brackets, timecode, running line
 * numbers, rulers, barcodes, tickers, a giant watermark glyph. Each recipe
 * returns plain markup (pure, testable); the few that live with the clock
 * mark an element with `data-yura-live` and are updated by {@link decorLive}.
 *
 * Sizes are em of the stage's base size and colours are the stage's CSS
 * variables (`--yura-fg`, `--yura-sub`, `--yura-accent`, `--yura-dim`), so a
 * scheme swap recolours every mark at once without rebuilding anything.
 */

/** What a decor recipe knows about the line it frames. */
export interface DecorContext {
  /** 1-based line number and line count. */
  index: number
  total: number
  text: string
  title: string
  artist: string
  seed: number
}

interface DecorRecipe {
  ja: string
  desc: string
  /** 'back' sits under the lyric text, 'front' over it. */
  layer: 'back' | 'front'
  markup(c: DecorContext): string
}

/** Escapes text for safe interpolation into markup. (Pure.) */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

const pad2 = (n: number): string => String(Math.max(0, Math.floor(n))).padStart(2, '0')
const MONO = 'font-family:var(--yura-mono);letter-spacing:0.08em'
const ABS = 'position:absolute'
/** Inset of edge marks from the stage border. */
const EDGE = '4%'
const HAIR = 'vector-effect="non-scaling-stroke"'

/** Lens-flare ghosts: position along the source→mirror line (0..1), size in em, opacity. */
const FLARE_GHOSTS: readonly [number, number, number][] = [
  [0.35, 1.2, 0.5],
  [0.52, 3.2, 0.25],
  [0.64, 0.7, 0.6],
  [0.8, 5.5, 0.14],
  [1, 2.2, 0.3],
]
/** The spectrum bar stops short of the top-right corner, where coords and running heads sit. */
const SPECTRUM_RIGHT = '26%'
/** Depth the gauge reads on the song's last line, metres. */
const DEPTH_MAX_M = 1200

const corner = (v: 'top' | 'bottom', h: 'left' | 'right'): string =>
  `<div style="${ABS};${v}:${EDGE};${h}:${EDGE};width:2.4em;height:2.4em;border-${v}:0.14em solid var(--yura-accent);border-${h}:0.14em solid var(--yura-accent)"></div>`

export const stageDecor = {
  corners: {
    ja: '枠マーク',
    desc: '画面の四隅にカギ形の印。ファインダー越しに覗いているような、切り取られた画面になる。',
    layer: 'front',
    markup: () => corner('top', 'left') + corner('top', 'right') + corner('bottom', 'left') + corner('bottom', 'right'),
  },
  timecode: {
    ja: 'タイムコード',
    desc: '録画中の赤い点と、時・分・秒・コマが刻々と進む数字。撮影素材のような生々しさ。',
    layer: 'front',
    markup: () =>
      `<div style="${ABS};top:${EDGE};left:calc(${EDGE} + 3.2em);${MONO};font-size:0.8em;color:var(--yura-fg);display:flex;gap:0.8em;align-items:center">` +
      `<span data-yura-live="rec" style="width:0.7em;height:0.7em;border-radius:50%;background:#ff2d2d;display:inline-block"></span>` +
      `<span>REC</span><span data-yura-live="timecode">00:00:00:00</span></div>`,
  },
  index: {
    ja: '通し番号',
    desc: '今の行が何番目かを、隅に巨大な袋文字の数字で置く。曲の中の現在地を示す編集的な印。',
    layer: 'back',
    markup: (c) =>
      `<div style="${ABS};right:${EDGE};bottom:2%;${MONO};line-height:0.8;text-align:right;color:transparent;-webkit-text-stroke:0.035em var(--yura-sub);font-size:9em;font-weight:700;opacity:0.55">${pad2(c.index)}</div>` +
      `<div style="${ABS};right:calc(${EDGE} + 0.2em);bottom:calc(2% + 9.6em);${MONO};font-size:0.75em;color:var(--yura-sub)">/ ${pad2(c.total)}</div>`,
  },
  crosshair: {
    ja: '照準線',
    desc: '画面の中心を通る細い十字線と円。文字が照準の中に捉えられているように見える。',
    layer: 'back',
    markup: () =>
      `<svg style="${ABS};inset:0;width:100%;height:100%;opacity:0.45" viewBox="0 0 100 100" preserveAspectRatio="none" fill="none" stroke="var(--yura-sub)" stroke-width="1">` +
      `<line x1="0" y1="50" x2="38" y2="50" ${HAIR}/><line x1="62" y1="50" x2="100" y2="50" ${HAIR}/>` +
      `<line x1="50" y1="0" x2="50" y2="30" ${HAIR}/><line x1="50" y1="70" x2="50" y2="100" ${HAIR}/></svg>` +
      `<div style="${ABS};left:50%;top:50%;width:26em;height:26em;transform:translate(-50%,-50%);border:0.06em solid var(--yura-sub);border-radius:50%;opacity:0.35"></div>`,
  },
  ruler: {
    ja: '端の定規',
    desc: '画面の左端と下端に目盛りが刻まれる。計測されている、設計されているという印象。',
    layer: 'front',
    markup: () => {
      let left = ''
      let bottom = ''
      for (let i = 0; i <= 50; i++) {
        const long = i % 5 === 0
        left += `<line x1="0" y1="${i * 2}" x2="${long ? 1.6 : 0.8}" y2="${i * 2}" ${HAIR}/>`
        bottom += `<line x1="${i * 2}" y1="100" x2="${i * 2}" y2="${long ? 98.4 : 99.2}" ${HAIR}/>`
      }
      return `<svg style="${ABS};inset:0;width:100%;height:100%;opacity:0.6" viewBox="0 0 100 100" preserveAspectRatio="none" fill="none" stroke="var(--yura-sub)" stroke-width="1">${left}${bottom}</svg>`
    },
  },
  barcode: {
    ja: 'バーコード',
    desc: '隅に小さなバーコードと数字の列。製品ラベルのような、無機質な情報の気配。',
    layer: 'front',
    markup: (c) => {
      let x = 0
      let bars = ''
      for (let i = 0; i < 34; i++) {
        const w = 0.4 + Math.floor(hash01(c.seed, i, 41) * 3) * 0.4
        if (i % 2 === 0) bars += `<rect x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="10"/>`
        x += w
      }
      const digits = Array.from({ length: 12 }, (_, i) => Math.floor(hash01(c.seed, i, 42) * 10)).join('')
      return (
        `<div style="${ABS};left:${EDGE};bottom:${EDGE};color:var(--yura-fg)">` +
        `<svg style="display:block;width:7em;height:2em" viewBox="0 0 ${x.toFixed(2)} 10" preserveAspectRatio="none" fill="currentColor">${bars}</svg>` +
        `<div style="${MONO};font-size:0.6em;margin-top:0.3em">${digits}</div></div>`
      )
    },
  },
  rules: {
    ja: '天地罫',
    desc: '画面の上下に細い罫線を引き、曲名と行番号を小さく添える。雑誌の誌面のような品のある枠組み。',
    layer: 'front',
    markup: (c) => {
      const line = (pos: string) => `<div style="${ABS};left:${EDGE};right:${EDGE};${pos};border-top:0.06em solid var(--yura-sub);opacity:0.7"></div>`
      const label = (pos: string, side: string, text: string) =>
        `<div style="${ABS};${side}:${EDGE};${pos};${MONO};font-size:0.62em;color:var(--yura-sub);text-transform:uppercase">${text}</div>`
      // Labels sit just inside the rules, clear of the corner marks and timecode.
      return (
        line('top:11%') +
        line('bottom:11%') +
        label('top:calc(11% + 0.7em)', 'left', escapeHtml(c.title)) +
        label('top:calc(11% + 0.7em)', 'right', escapeHtml(c.artist)) +
        label('bottom:calc(11% + 0.7em)', 'left', `LYRIC ${pad2(c.index)} — ${pad2(c.total)}`)
      )
    },
  },
  band: {
    ja: '縦書き帯',
    desc: '画面の右端に縦書きの細い帯を立て、曲名と作り手を静かに置く。和の書物の柱のような佇まい。',
    layer: 'front',
    markup: (c) =>
      `<div style="${ABS};top:${EDGE};bottom:${EDGE};right:${EDGE};writing-mode:vertical-rl;font-family:var(--yura-serif);font-size:0.8em;letter-spacing:0.4em;color:var(--yura-sub);border-right:0.08em solid var(--yura-accent);padding-right:0.8em;overflow:hidden;white-space:nowrap">` +
      `${escapeHtml(c.title)}　／　${escapeHtml(c.artist)}　${pad2(c.index)}</div>`,
  },
  progress: {
    ja: '進行バー',
    desc: '画面の下端に、曲の進み具合を示す細い線が伸びていく。',
    layer: 'front',
    markup: () =>
      `<div style="${ABS};left:0;right:0;bottom:0;height:0.22em;background:var(--yura-dim)">` +
      `<div data-yura-live="progress" style="height:100%;background:var(--yura-accent);transform-origin:0 50%;transform:scaleX(0)"></div></div>`,
  },
  grid: {
    ja: '方眼',
    desc: '画面全体にごく薄い方眼を敷く。図面や設計の上に言葉が置かれたような知的な印象。',
    layer: 'back',
    markup: () =>
      `<div style="${ABS};inset:0;opacity:0.35;background-image:linear-gradient(var(--yura-sub) 0.04em, transparent 0.04em),linear-gradient(90deg, var(--yura-sub) 0.04em, transparent 0.04em);background-size:4em 4em;background-position:center"></div>`,
  },
  bigtype: {
    ja: '透かし大文字',
    desc: '行の最初の一文字を、画面からはみ出すほど巨大に、背景に沈めて敷く。読ませず、形で迫る。',
    layer: 'back',
    markup: (c) => {
      const first = segmentGraphemes(c.text.replace(/\s/g, ''))[0] ?? ''
      const side = hash01(c.seed, 0, 43) < 0.5 ? 'left:-4%' : 'right:-4%'
      return `<div style="${ABS};${side};top:50%;transform:translateY(-50%);font-size:34em;line-height:1;font-weight:900;color:var(--yura-dim);white-space:nowrap">${escapeHtml(first)}</div>`
    },
  },
  beat: {
    ja: '拍の輪',
    desc: '隅の輪が拍ごとに膨らんで光る。音が見えるメトロノーム。',
    layer: 'front',
    markup: () =>
      `<div style="${ABS};left:${EDGE};top:50%;width:1.6em;height:1.6em;margin-top:-0.8em;border-radius:50%;border:0.14em solid var(--yura-accent)" data-yura-live="beat"></div>`,
  },
  ticker: {
    ja: 'ティッカー',
    desc: '画面の上端を、歌詞の一節が電光掲示板のように流れ続ける。',
    layer: 'front',
    markup: (c) => {
      const unit = `${escapeHtml(c.text.replace(/\n/g, ' '))}　◆　`
      return (
        `<div style="${ABS};left:0;right:0;top:0;height:1.8em;overflow:hidden;background:var(--yura-accent);color:var(--yura-bg);${MONO};font-size:0.75em;line-height:1.8em;white-space:nowrap">` +
        `<div data-yura-live="ticker" style="display:inline-block">${unit.repeat(12)}</div></div>`
      )
    },
  },
  coords: {
    ja: '座標',
    desc: '隅に座標のような数字を置く。どこかの場所を観測しているような、SF的な気配。',
    layer: 'front',
    markup: (c) => {
      const v = (salt: number) => (hash01(c.seed, c.index, salt) * 180 - 90).toFixed(4)
      return (
        `<div style="${ABS};right:${EDGE};top:${EDGE};${MONO};font-size:0.62em;color:var(--yura-sub);text-align:right;line-height:1.6">` +
        `X ${v(51)}<br>Y ${v(52)}<br>Z ${v(53)}</div>`
      )
    },
  },
  lensflare: {
    ja: 'レンズフレア',
    desc: '左上の強い光源から、画面を斜めに横切って光の輪が連なる。カメラのレンズに光が入ったような眩しさ。',
    layer: 'front',
    markup: (c) => {
      // Ghost discs sit on the line from the source through the centre, as in a real lens.
      const src = { x: 12 + hash01(c.seed, c.index, 61) * 16, y: 10 + hash01(c.seed, c.index, 62) * 12 }
      const discs = FLARE_GHOSTS.map(([t, size, alpha], k) => {
        const x = src.x + (100 - 2 * src.x) * t
        const y = src.y + (100 - 2 * src.y) * t
        const tone = k % 2 ? 'var(--yura-accent)' : 'var(--yura-accent2)'
        return `<div style="${ABS};left:${x.toFixed(2)}%;top:${y.toFixed(2)}%;width:${size}em;height:${size}em;margin:-${size / 2}em 0 0 -${size / 2}em;border-radius:50%;background:radial-gradient(circle, transparent 35%, ${tone} 70%, transparent 72%);opacity:${alpha}"></div>`
      }).join('')
      return (
        `<div style="${ABS};inset:0;mix-blend-mode:screen;pointer-events:none">` +
        `<div style="${ABS};left:${src.x.toFixed(2)}%;top:${src.y.toFixed(2)}%;width:14em;height:14em;margin:-7em 0 0 -7em;border-radius:50%;background:radial-gradient(circle, #ffffff 0%, var(--yura-accent2) 12%, transparent 60%);opacity:0.7"></div>` +
        `<div style="${ABS};left:${src.x.toFixed(2)}%;top:${src.y.toFixed(2)}%;width:60em;height:0.12em;margin:-0.06em 0 0 -30em;background:linear-gradient(90deg, transparent, var(--yura-accent2), transparent);opacity:0.55"></div>` +
        discs +
        `</div>`
      )
    },
  },
  waterline: {
    ja: '水面線',
    desc: '画面の下に、ゆるやかに波打つ細い線を何本か重ねる。水平線や水辺の気配を静かに足す。',
    layer: 'back',
    markup: (c) => {
      const lines = [0, 1, 2]
        .map((k) => {
          const y = 80 + k * 5
          const a = 1.2 + hash01(c.seed, k, 63) * 1.4
          const ph = hash01(c.seed, k, 64) * 6.28
          const pts = Array.from({ length: 41 }, (_, i) => `${(i * 2.5).toFixed(1)},${(y + Math.sin(i * 0.45 + ph) * a).toFixed(2)}`).join(' ')
          return `<polyline points="${pts}" stroke-width="${1 - k * 0.25}" opacity="${0.6 - k * 0.15}" ${HAIR}/>`
        })
        .join('')
      return `<svg style="${ABS};inset:0;width:100%;height:100%" viewBox="0 0 100 100" preserveAspectRatio="none" fill="none" stroke="var(--yura-accent)">${lines}</svg>`
    },
  },
  depth: {
    ja: '水深計',
    desc: '画面の右端に目盛りと水深の数字を置く。行が進むほど深く潜っていく、潜水艇の計器。',
    layer: 'front',
    markup: (c) => {
      const metres = String(Math.round((c.index / Math.max(1, c.total)) * DEPTH_MAX_M)).padStart(4, '0')
      const ticks = Array.from({ length: 11 }, (_, i) => `<div style="${ABS};right:0;top:${i * 10}%;width:${i % 5 === 0 ? 1.2 : 0.6}em;height:0.08em;background:var(--yura-sub)"></div>`).join('')
      const mark = (c.index / Math.max(1, c.total)) * 100
      return (
        `<div style="${ABS};right:${EDGE};top:20%;bottom:20%;width:1.4em">${ticks}` +
        `<div style="${ABS};right:1.5em;top:${mark.toFixed(1)}%;width:0;height:0;border:0.35em solid transparent;border-right-color:var(--yura-accent);transform:translateY(-50%)"></div></div>` +
        `<div style="${ABS};right:${EDGE};bottom:${EDGE};${MONO};font-size:0.7em;color:var(--yura-fg);text-align:right">DEPTH<br><span style="font-size:1.8em;color:var(--yura-accent)">${metres}</span> m</div>`
      )
    },
  },
  spectrum: {
    ja: 'スペクトル',
    desc: '画面の上端に、光の波長を示す虹色の細い帯と目盛りを置く。光の観測装置のような理知的な華やかさ。',
    layer: 'front',
    markup: () =>
      `<div style="${ABS};left:${EDGE};right:${SPECTRUM_RIGHT};top:${EDGE};height:0.28em;background:linear-gradient(90deg, #7a2bff, #2b5bff, #2bd6ff, #2bff7a, #f6ff2b, #ffa12b, #ff2b2b)"></div>` +
      `<div style="${ABS};left:${EDGE};right:${SPECTRUM_RIGHT};top:calc(${EDGE} + 0.6em);display:flex;justify-content:space-between;${MONO};font-size:0.55em;color:var(--yura-sub)">` +
      `<span>380nm</span><span>480</span><span>580</span><span>680</span><span>780nm</span></div>`,
  },
  blobs: {
    ja: 'インクの染み',
    desc: '画面の隅にインクをこぼしたような不定形の染みを置く。手仕事、アート、偶然の美しさ。',
    layer: 'back',
    markup: (c) =>
      [0, 1, 2]
        .map((k) => {
          const x = hash01(c.seed, c.index * 3 + k, 71) < 0.5 ? 4 + hash01(c.seed, k, 72) * 18 : 70 + hash01(c.seed, k, 72) * 18
          const y = 8 + hash01(c.seed, c.index * 3 + k, 73) * 70
          const r = [`${40 + hash01(c.seed, k, 74) * 30}%`, `${35 + hash01(c.seed, k, 75) * 30}%`, `${45 + hash01(c.seed, k, 76) * 25}%`, `${30 + hash01(c.seed, k, 77) * 30}%`].join(' ')
          return `<div style="${ABS};left:${x.toFixed(1)}%;top:${y.toFixed(1)}%;width:${(4 + k * 2).toFixed(1)}em;height:${(3.4 + k * 1.6).toFixed(1)}em;border-radius:${r};background:var(--yura-accent);opacity:${(0.35 - k * 0.08).toFixed(2)}"></div>`
        })
        .join(''),
  },
  bars: {
    ja: '荒い帯',
    desc: '筆で掃いたような荒い色の帯を画面に走らせる。勢い、ストリート、手描きの熱。',
    layer: 'back',
    markup: (c) => `<div style="${ABS};left:-5%;right:-5%;top:${(30 + hash01(c.seed, c.index, 81) * 30).toFixed(1)}%;height:22%;background:var(--yura-accent);opacity:0.28;transform:rotate(${(hash01(c.seed, c.index, 82) * 10 - 5).toFixed(1)}deg);clip-path:polygon(0 12%, 8% 0, 30% 9%, 55% 2%, 78% 10%, 100% 0, 100% 88%, 82% 100%, 60% 90%, 35% 100%, 12% 92%, 0 100%)"></div>`,
  },
  shapes: {
    ja: '図形',
    desc: '丸・三角・四角の単純な図形を画面に散らす。バウハウス、幼さ、遊び心。',
    layer: 'back',
    markup: (c) => {
      const at = (k: number, salt: number) => (hash01(c.seed, c.index * 5 + k, salt) * 80 + 5).toFixed(1)
      return (
        `<div style="${ABS};left:${at(0, 91)}%;top:${at(0, 92)}%;width:2.4em;height:2.4em;border-radius:50%;border:0.14em solid var(--yura-accent);opacity:0.6"></div>` +
        `<div style="${ABS};left:${at(1, 91)}%;top:${at(1, 92)}%;width:0;height:0;border-left:1.2em solid transparent;border-right:1.2em solid transparent;border-bottom:2em solid var(--yura-accent2);opacity:0.55;transform:rotate(${(hash01(c.seed, c.index, 93) * 40).toFixed(0)}deg)"></div>` +
        `<div style="${ABS};left:${at(2, 91)}%;top:${at(2, 92)}%;width:1.8em;height:1.8em;background:var(--yura-sub);opacity:0.35;transform:rotate(${(hash01(c.seed, c.index, 94) * 90).toFixed(0)}deg)"></div>`
      )
    },
  },
  counter: {
    ja: '大きな数字',
    desc: '行番号を画面の奥に巨大な数字として敷く。カウントダウン、章立て、ドキュメンタリー。',
    layer: 'back',
    markup: (c) => `<div style="${ABS};left:${EDGE};bottom:-6%;font-family:var(--yura-mono);font-size:20em;line-height:1;font-weight:800;color:var(--yura-dim);letter-spacing:-0.05em">${pad2(c.index)}</div>`,
  },
  rings: {
    ja: '座標の円',
    desc: '画面の中心に同心円と目盛りを描く。レーダー、計測、狙いを定める。',
    layer: 'back',
    markup: () =>
      `<svg style="${ABS};inset:0;width:100%;height:100%;opacity:0.4" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" fill="none" stroke="var(--yura-sub)">` +
      [12, 24, 36, 48].map((r) => `<circle cx="50" cy="50" r="${r}" stroke-width="1" ${HAIR} stroke-dasharray="${r === 48 ? '1 2' : 'none'}"/>`).join('') +
      Array.from({ length: 36 }, (_, k) => { const a = (k / 36) * Math.PI * 2; return `<line x1="${(50 + Math.cos(a) * 46).toFixed(2)}" y1="${(50 + Math.sin(a) * 46).toFixed(2)}" x2="${(50 + Math.cos(a) * (k % 3 ? 47.5 : 49)).toFixed(2)}" y2="${(50 + Math.sin(a) * (k % 3 ? 47.5 : 49)).toFixed(2)}" stroke-width="1" ${HAIR}/>` }).join('') +
      `</svg>`,
  },
  dots: {
    ja: 'ドットの輪',
    desc: '文字を囲むように小さな点が円を描いて並ぶ。装飾、印、ささやかな華やぎ。',
    layer: 'back',
    markup: () => `<div style="${ABS};left:50%;top:50%;width:14em;height:14em;margin:-7em 0 0 -7em;border-radius:50%;background:repeating-conic-gradient(var(--yura-accent) 0 2deg, transparent 2deg 10deg);-webkit-mask-image:radial-gradient(circle, transparent 66%, #000 67% 69%, transparent 70%);mask-image:radial-gradient(circle, transparent 66%, #000 67% 69%, transparent 70%);opacity:0.8"></div>`,
  },
  arrows: {
    ja: '矢印',
    desc: '画面の端に大きな矢印を置く。方向、前進、次へ。',
    layer: 'front',
    markup: (c) => {
      const left = hash01(c.seed, c.index, 101) < 0.5
      return `<div style="${ABS};${left ? 'left' : 'right'}:${EDGE};bottom:${EDGE};font-size:3em;line-height:1;color:var(--yura-accent);font-weight:900">${left ? '←' : '→'}</div><div style="${ABS};${left ? 'left' : 'right'}:calc(${EDGE} + 0.2em);bottom:calc(${EDGE} + 3.4em);${MONO};font-size:0.6em;color:var(--yura-sub)">NEXT</div>`
    },
  },
  slashes: {
    ja: 'スラッシュ',
    desc: '斜めの太い線を数本、画面に刻む。スピード、切れ味、スポーツの躍動。',
    layer: 'back',
    markup: (c) =>
      [0, 1, 2]
        .map((k) => `<div style="${ABS};left:${(10 + k * 6 + hash01(c.seed, c.index, 111) * 50).toFixed(1)}%;top:-10%;width:${(0.3 + k * 0.25).toFixed(2)}em;height:120%;background:var(--yura-accent);opacity:${(0.5 - k * 0.12).toFixed(2)};transform:rotate(24deg)"></div>`)
        .join(''),
  },
  sparks: {
    ja: 'スパーク',
    desc: '文字の周りに放射状の短い線が弾ける。驚き、ひらめき、漫画の効果線。',
    layer: 'front',
    markup: (c) =>
      `<svg style="${ABS};inset:0;width:100%;height:100%" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" stroke="var(--yura-accent)" stroke-linecap="round">` +
      Array.from({ length: 12 }, (_, k) => { const a = (k / 12) * Math.PI * 2 + hash01(c.seed, c.index, 121); const r0 = 30 + hash01(c.seed, k, 122) * 6; const r1 = r0 + 4 + hash01(c.seed, k, 123) * 5; return `<line x1="${(50 + Math.cos(a) * r0).toFixed(2)}" y1="${(50 + Math.sin(a) * r0 * 0.6).toFixed(2)}" x2="${(50 + Math.cos(a) * r1).toFixed(2)}" y2="${(50 + Math.sin(a) * r1 * 0.6).toFixed(2)}" stroke-width="2.5" ${HAIR}/>` }).join('') +
      `</svg>`,
  },
  leaders: {
    ja: '引き出し線',
    desc: '文字から引き出し線を伸ばして、小さな注釈の数字を添える。図解、解説、ラベル。',
    layer: 'front',
    markup: (c) =>
      `<svg style="${ABS};inset:0;width:100%;height:100%" viewBox="0 0 100 100" preserveAspectRatio="none" fill="none" stroke="var(--yura-sub)"><path d="M58 44 L72 26 L90 26" stroke-width="1" ${HAIR}/><path d="M40 58 L28 74 L10 74" stroke-width="1" ${HAIR}/></svg>` +
      `<div style="${ABS};right:9%;top:21%;${MONO};font-size:0.6em;color:var(--yura-fg)">(${pad2(c.index)}) ${escapeHtml(c.title).slice(0, 18)}</div>` +
      `<div style="${ABS};left:9%;top:75%;${MONO};font-size:0.6em;color:var(--yura-sub)">fig.${c.index}</div>`,
  },
  waveform: {
    ja: '波形',
    desc: '画面の下に、音の波形のような細い縦線の列を置く。声、録音、音楽そのもの。',
    layer: 'back',
    markup: (c) => `<div style="${ABS};left:${EDGE};right:${EDGE};bottom:${EDGE};height:3em;display:flex;align-items:center;gap:0.14em">${Array.from({ length: 72 }, (_, k) => `<i style="flex:1;height:${(10 + Math.abs(Math.sin(k * 0.37 + c.index) * Math.sin(k * 0.11)) * 90 * (0.4 + hash01(c.seed, k, 131) * 0.6)).toFixed(0)}%;background:var(--yura-sub);opacity:0.6;border-radius:1em"></i>`).join('')}</div>`,
  },
  scratches: {
    ja: '引っ掻き傷',
    desc: '画面を何かが引っ掻いたような鋭い傷が数本走る。ホラー、暴力の気配、不穏。',
    layer: 'front',
    markup: (c) =>
      `<svg style="${ABS};inset:0;width:100%;height:100%" viewBox="0 0 100 100" preserveAspectRatio="none" stroke="var(--yura-fg)" fill="none" opacity="0.55">` +
      [0, 1, 2, 3].map((k) => { const x = 60 + hash01(c.seed, c.index, 141) * 25 + k * 2.5; return `<path d="M${x.toFixed(1)} ${(8 + k * 2).toFixed(1)} Q${(x - 6).toFixed(1)} 40 ${(x - 14 + k).toFixed(1)} ${(60 + k * 3).toFixed(1)}" stroke-width="${(2.4 - k * 0.4).toFixed(1)}" stroke-linecap="round" ${HAIR}/>` }).join('') +
      `</svg>`,
  },
  sigil: {
    ja: '魔法陣',
    desc: '文字の背後に、円と星形の図形を重ねた魔法陣のような紋様を描く。儀式、呪い、神秘。',
    layer: 'back',
    markup: () => {
      const star = Array.from({ length: 5 }, (_, k) => { const a = -Math.PI / 2 + (k * 4 * Math.PI) / 5; return `${(50 + Math.cos(a) * 34).toFixed(2)} ${(50 + Math.sin(a) * 34).toFixed(2)}` }).join(' L')
      return `<svg style="${ABS};inset:0;width:100%;height:100%;opacity:0.35" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" fill="none" stroke="var(--yura-accent)"><circle cx="50" cy="50" r="40" stroke-width="1.2" ${HAIR}/><circle cx="50" cy="50" r="36" stroke-width="1" ${HAIR}/><path d="M${star} Z" stroke-width="1.2" ${HAIR}/><circle cx="50" cy="50" r="16" stroke-width="1" stroke-dasharray="1 1.5" ${HAIR}/></svg>`
    },
  },
  eye: {
    ja: '見ている目',
    desc: '画面の隅に、じっとこちらを見ている一つの目を描く。監視、不安、見られている感覚。',
    layer: 'front',
    markup: (c) => {
      const right = hash01(c.seed, c.index, 151) < 0.5
      return `<svg style="${ABS};${right ? 'right' : 'left'}:${EDGE};top:${EDGE};width:4.5em;height:2.4em" viewBox="0 0 90 48"><path d="M3 24 Q45 -8 87 24 Q45 56 3 24 Z" fill="var(--yura-fg)" opacity="0.92"/><circle cx="${right ? 40 : 50}" cy="24" r="12" fill="var(--yura-bg)"/><circle cx="${right ? 40 : 50}" cy="24" r="5" fill="var(--yura-accent)"/></svg>`
    },
  },
  static: {
    ja: '砂嵐の欠片',
    desc: '画面の一部だけにテレビの砂嵐が四角く貼り付く。電波の乱れ、欠けた記録。',
    layer: 'front',
    markup: (c) => `<div style="${ABS};left:${(5 + hash01(c.seed, c.index, 161) * 60).toFixed(1)}%;top:${(5 + hash01(c.seed, c.index, 162) * 70).toFixed(1)}%;width:${(12 + hash01(c.seed, c.index, 163) * 18).toFixed(1)}%;height:${(6 + hash01(c.seed, c.index, 164) * 10).toFixed(1)}%;background-image:url(&quot;data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='s'><feTurbulence type='fractalNoise' baseFrequency='1.2' numOctaves='1'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(#s)'/></svg>")}&quot;);opacity:0.6;mix-blend-mode:screen"></div>`,
  },
  'dust-beam': {
    ja: '光の筋と埃',
    desc: '窓から差し込む斜めの光の筋に、埃の粒が浮かぶ。廃墟、静けさ、時間の止まった部屋。',
    layer: 'back',
    markup: (c) =>
      `<div style="${ABS};left:10%;top:-20%;width:30%;height:140%;background:linear-gradient(90deg, transparent, rgba(255,245,220,0.18), transparent);transform:rotate(-25deg)"></div>` +
      Array.from({ length: 24 }, (_, k) => `<i style="${ABS};left:${(15 + hash01(c.seed, k, 171) * 30).toFixed(1)}%;top:${(hash01(c.seed, k, 172) * 90).toFixed(1)}%;width:0.08em;height:0.08em;border-radius:50%;background:#fff6dc;opacity:${(0.3 + hash01(c.seed, k, 173) * 0.6).toFixed(2)}"></i>`).join(''),
  },
  drips: {
    ja: '垂れる墨',
    desc: '画面の上端から墨や塗料が何本も垂れ落ちている。ホラー、グラフィティ、滲み。',
    layer: 'front',
    markup: (c) =>
      `<div style="${ABS};left:0;right:0;top:0;height:40%;pointer-events:none">` +
      Array.from({ length: 14 }, (_, k) => { const x = (k / 14) * 100 + hash01(c.seed, k, 181) * 5; const h = 10 + hash01(c.seed, k, 182) * 80; return `<i style="${ABS};left:${x.toFixed(1)}%;top:0;width:${(0.3 + hash01(c.seed, k, 183) * 0.5).toFixed(2)}em;height:${h.toFixed(0)}%;background:var(--yura-fg);border-radius:0 0 1em 1em;opacity:0.85"></i>` }).join('') +
      `<i style="${ABS};left:0;right:0;top:0;height:0.6em;background:var(--yura-fg);opacity:0.85"></i></div>`,
  },
  cracks: {
    ja: 'ひび割れ',
    desc: '画面の隅から放射状にひびが走る。衝撃、壊れたガラス、崩壊の予兆。',
    layer: 'front',
    markup: (c) => {
      const ox = hash01(c.seed, c.index, 191) < 0.5 ? 8 : 92
      const oy = hash01(c.seed, c.index, 192) < 0.5 ? 10 : 88
      const paths = Array.from({ length: 7 }, (_, k) => {
        const a = (k / 7) * Math.PI * 2 + hash01(c.seed, k, 193)
        let x = ox
        let y = oy
        let d = `M${x} ${y}`
        for (let j = 0; j < 4; j++) {
          x += Math.cos(a + (hash01(c.seed, k * 7 + j, 194) - 0.5)) * (5 + j * 3)
          y += Math.sin(a + (hash01(c.seed, k * 7 + j, 195) - 0.5)) * (5 + j * 3)
          d += ` L${x.toFixed(1)} ${y.toFixed(1)}`
        }
        return `<path d="${d}" stroke-width="${(1.6 - k * 0.1).toFixed(1)}" ${HAIR}/>`
      }).join('')
      return `<svg style="${ABS};inset:0;width:100%;height:100%" viewBox="0 0 100 100" preserveAspectRatio="none" fill="none" stroke="var(--yura-fg)" opacity="0.6">${paths}</svg>`
    },
  },
  colophon: {
    ja: '奥付',
    desc: '画面の隅に、本の奥付のような小さな発行情報の組版を置く。書籍、編集、記録。',
    layer: 'front',
    markup: (c) =>
      `<div style="${ABS};right:${EDGE};bottom:${EDGE};font-size:0.55em;line-height:1.7;color:var(--yura-sub);text-align:right;border-top:0.08em solid var(--yura-sub);padding-top:0.5em;min-width:12em">` +
      `<div style="font-weight:700;color:var(--yura-fg)">${escapeHtml(c.title || '—')}</div><div>${escapeHtml(c.artist || '')}</div><div style="${MONO}">第${c.index}刷 / 全${c.total}行</div></div>`,
  },
  'glyph-lines': {
    ja: '字割り線',
    desc: '文字の並ぶ帯に、仮想ボディや基準線のような細い補助線を引く。組版の設計図。',
    layer: 'back',
    markup: () =>
      `<svg style="${ABS};inset:0;width:100%;height:100%;opacity:0.45" viewBox="0 0 100 100" preserveAspectRatio="none" stroke="var(--yura-accent)" fill="none">` +
      [38, 42, 58, 62].map((y) => `<line x1="0" y1="${y}" x2="100" y2="${y}" stroke-width="1" ${HAIR} stroke-dasharray="${y === 42 || y === 58 ? 'none' : '2 2'}"/>`).join('') +
      Array.from({ length: 13 }, (_, k) => `<line x1="${(8 + k * 7).toFixed(1)}" y1="38" x2="${(8 + k * 7).toFixed(1)}" y2="62" stroke-width="1" ${HAIR} opacity="0.5"/>`).join('') +
      `</svg>`,
  },
  'type-scale': {
    ja: '級数見本',
    desc: '画面の端に、同じ一字を大きさ違いで並べた級数見本を置く。書体、サイズ、組版の現場。',
    layer: 'back',
    markup: (c) => {
      const ch = escapeHtml(segmentGraphemes(c.text.replace(/\s/g, ''))[0] ?? 'あ')
      return `<div style="${ABS};left:${EDGE};bottom:${EDGE};display:flex;align-items:baseline;gap:0.3em;color:var(--yura-sub);opacity:0.6">${[0.5, 0.8, 1.2, 1.8, 2.7].map((s) => `<span style="font-size:${s}em">${ch}</span>`).join('')}<span style="${MONO};font-size:0.45em;margin-left:0.6em">7Q 12Q 18Q 28Q 42Q</span></div>`
    },
  },
  'big-punct': {
    ja: '大きな約物',
    desc: '「」や！？のような約物を、画面の奥に巨大に敷く。台詞、叫び、問いかけ。',
    layer: 'back',
    markup: (c) => {
      const marks = ['「', '」', '！', '？', '、', '…']
      const m = marks[Math.floor(hash01(c.seed, c.index, 201) * marks.length)]
      return `<div style="${ABS};right:2%;top:50%;transform:translateY(-50%);font-size:26em;line-height:1;color:var(--yura-dim);font-weight:900">${m}</div>`
    },
  },
} satisfies Record<DecorName, DecorRecipe>

/** Markup for a set of decor, split by layer. Unknown names are skipped. (Pure.) */
export function decorMarkup(names: readonly DecorName[], c: DecorContext): { back: string; front: string } {
  let back = ''
  let front = ''
  for (const n of names) {
    const r = (stageDecor as Record<string, DecorRecipe>)[n]
    if (!r) continue
    const html = r.markup(c)
    if (r.layer === 'back') back += html
    else front += html
  }
  return { back, front }
}

/** Frames shown per second in the timecode readout (display convention). */
export const TIMECODE_FPS = 30

/** hh:mm:ss:ff for a timeline second (non-finite and negative read as 0). (Pure.) */
export function formatTimecode(t: number, fps = TIMECODE_FPS): string {
  const safe = Number.isFinite(t) && t > 0 ? t : 0
  const f = Number.isFinite(fps) && fps > 0 ? fps : TIMECODE_FPS
  const total = Math.floor(safe * f)
  const ff = total % f
  const s = Math.floor(total / f)
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}:${pad2(ff)}`
}

/** What one live decor element should show right now. */
export interface DecorLiveFrame {
  text?: string
  transform?: string
  opacity?: string
}

/** Seconds a ticker takes to scroll one repeat unit. */
const TICKER_SECONDS = 9

/**
 * Per-frame state of a live decor element: `t` timeline seconds, `progress`
 * 0..1 through the song, `pulse` 0..1 beat envelope. (Pure.)
 */
export function decorLive(kind: string, t: number, progress: number, pulse: number): DecorLiveFrame {
  const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0
  const b = Number.isFinite(pulse) ? Math.min(1, Math.max(0, pulse)) : 0
  const tt = Number.isFinite(t) ? t : 0
  switch (kind) {
    case 'timecode':
      return { text: formatTimecode(tt) }
    case 'rec':
      return { opacity: Math.floor(tt * 2) % 2 === 0 ? '1' : '0.2' }
    case 'progress':
      return { transform: `scaleX(${Math.round(p * 10000) / 10000})` }
    case 'beat':
      return { transform: `scale(${Math.round((1 + b * 0.45) * 1000) / 1000})`, opacity: String(Math.round((0.35 + b * 0.65) * 1000) / 1000) }
    case 'ticker': {
      // One unit is 1/12 of the strip, so shifting by up to 100/12 % loops seamlessly.
      const off = ((tt / TICKER_SECONDS) % 1) * (100 / 12)
      return { transform: `translateX(-${Math.round(off * 1000) / 1000}%)` }
    }
    default:
      return {}
  }
}
