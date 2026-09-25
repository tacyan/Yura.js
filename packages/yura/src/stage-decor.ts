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
