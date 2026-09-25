import { motions, glyphRank, glyphProgress, identityPose, composePose, type EnterName, type TransitionRecipe, type GlyphPose } from './motions'
import { poseToStyle, type GlyphStyle } from './kinetic'
import { segmentGraphemes } from './shapes'

/**
 * Pure motion math for {@link yuraSite}: the page-level effects a studio
 * builds by hand for a premium site — split-text reveals, masked image
 * reveals, velocity-reactive marquees, parallax, count-ups, magnetic
 * buttons, a scroll-linked progress, an opening loader. No DOM here: every
 * function maps numbers to numbers (or CSS strings), so each effect is
 * reproducible and tested; site.ts only reads the page and writes styles.
 */

const clamp01 = (v: number): number => (Number.isNaN(v) ? 0 : Math.min(1, Math.max(0, v)))
const fin = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback)
const outExpo = (t: number): number => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t))
const outQuart = (t: number): number => 1 - (1 - t) ** 4
const inOutQuart = (t: number): number => (t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2)
const pct = (v: number): string => `${Math.round(v * 1000) / 10}%`

// ------------------------------------------------------------------ split text

/** A run of text split for per-character animation. Words stay unbroken; spaces stay wrappable. */
export interface SplitToken {
  kind: 'word' | 'space'
  chars: string[]
}

/** Latin-ish words keep together; CJK graphemes may break anywhere, like the browser would. */
const WORD_CHAR = /[\p{L}\p{N}'’\-_.!?,:;]/u
const BREAKS_ANYWHERE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/**
 * Splits text into words and spaces of graphemes. A CJK grapheme is a word
 * of its own (line breaks between them stay legal); Latin letters group into
 * words so a reveal never wraps mid-word. (Pure.)
 */
export function splitText(text: string): SplitToken[] {
  const out: SplitToken[] = []
  let word: string[] = []
  const flush = (): void => {
    if (word.length) out.push({ kind: 'word', chars: word })
    word = []
  }
  for (const g of segmentGraphemes(text)) {
    if (/^\s+$/.test(g)) {
      flush()
      const last = out[out.length - 1]
      if (last && last.kind === 'space') last.chars.push(g)
      else out.push({ kind: 'space', chars: [g] })
    } else if (BREAKS_ANYWHERE.test(g)) {
      flush()
      out.push({ kind: 'word', chars: [g] })
    } else if (WORD_CHAR.test(g)) {
      word.push(g)
    } else {
      // Emoji, symbols: a unit of their own.
      flush()
      out.push({ kind: 'word', chars: [g] })
    }
  }
  flush()
  return out
}

/**
 * Styles for every glyph of a one-shot text reveal at progress `p` (0..1),
 * using an entrance from the kinetic vocabulary — so a page heading and a
 * lyric line speak the same motion language. (Pure.)
 */
export function textRevealStyles(name: EnterName, chars: readonly string[], p: number, seed = 1): (GlyphStyle & { char: string })[] {
  const recipe = (motions.enter[name] ?? motions.enter['fade-up']) as TransitionRecipe
  const n = chars.length
  return chars.map((char, i) => {
    const rank = glyphRank(recipe.order ?? 'ltr', i, n, seed)
    const g = { i, n, seed, char, rank }
    const pose: GlyphPose = composePose(identityPose(), recipe.pose(glyphProgress(clamp01(fin(p)), rank, recipe.stagger ?? 0.5), g))
    return { ...poseToStyle(pose), char: pose.char ?? char }
  })
}

// ------------------------------------------------------------------ block reveals

/** One frame of a block (image / card / section) reveal: the element and its curtain panel. */
export interface BlockFrame {
  opacity: string
  transform: string
  clipPath: string
  /** The accent curtain that sweeps across first ('none' when unused). */
  curtain: { transform: string; opacity: string }
}

interface BlockRecipe {
  ja: string
  desc: string
  frame(p: number): Partial<Omit<BlockFrame, 'curtain'>> & { curtain?: BlockFrame['curtain'] }
}

const NO_CURTAIN = { transform: 'scaleX(0)', opacity: '0' }
/** Rise distance of the fade-up block reveal, in rem (scales with the page's root font size). */
const FADE_TRAVEL_REM = 2.5

export const blockReveals = {
  'fade-up': {
    ja: 'ふわっと浮上',
    desc: '少し下から浮かびながら現れる。どんな要素にも合う、最も汎用的な出方。',
    frame: (p) => {
      const e = outQuart(p)
      return { opacity: String(Math.round(e * 1000) / 1000), transform: `translateY(${Math.round((1 - e) * FADE_TRAVEL_REM * 1000) / 1000}rem)` }
    },
  },
  mask: {
    ja: 'マスク',
    desc: '下から上へ、枠に切り抜かれながら姿を現す。写真やカードに使うと一気に上質になる。',
    frame: (p) => {
      const e = outExpo(p)
      return { clipPath: `inset(${pct(1 - e)} 0 0 0)`, transform: `scale(${Math.round((1.15 - 0.15 * e) * 1000) / 1000})` }
    },
  },
  wipe: {
    ja: 'ワイプ',
    desc: '左から右へ、拭き取られるように現れる。横長の写真や帯に。',
    frame: (p) => ({ clipPath: `inset(0 ${pct(1 - outExpo(p))} 0 0)` }),
  },
  curtain: {
    ja: 'カーテン',
    desc: 'アクセント色の幕が横切り、通り過ぎた跡に要素が現れる。制作会社のサイトでよく見る、最も「作り込んだ」印象の出方。',
    frame: (p) => {
      // First half: the curtain grows from the left. Second half: it leaves to the right, uncovering the element.
      const a = inOutQuart(clamp01(p * 2))
      const b = inOutQuart(clamp01(p * 2 - 1))
      return {
        opacity: p < 0.5 ? '0' : '1',
        curtain: { transform: p < 0.5 ? `scaleX(${Math.round(a * 1000) / 1000})` : `translateX(${pct(b)}) scaleX(${Math.round((1 - b) * 1000) / 1000})`, opacity: p >= 1 ? '0' : '1' },
      }
    },
  },
  zoom: {
    ja: 'ズームアウト',
    desc: '大きく寄った状態から、ゆっくり引いて定位置に収まる。写真に奥行きと重みが出る。',
    frame: (p) => {
      const e = outExpo(p)
      return { opacity: String(Math.round(clamp01(p * 3) * 1000) / 1000), transform: `scale(${Math.round((1.35 - 0.35 * e) * 1000) / 1000})` }
    },
  },
  iris: {
    ja: 'アイリス',
    desc: '中心から円が広がって現れる。丸い写真や、印象的な一枚に。',
    frame: (p) => ({ clipPath: `circle(${pct(outQuart(p) * 0.75)} at 50% 50%)` }),
  },
  blinds: {
    ja: 'ブラインド',
    desc: '上下から開く。シャッターが開くような、機械的で締まった出方。',
    frame: (p) => {
      const c = (1 - outExpo(p)) * 50
      return { clipPath: `inset(${c}% 0 ${c}% 0)` }
    },
  },
} satisfies Record<string, BlockRecipe>

export type BlockRevealName = keyof typeof blockReveals

/** Full frame for a block reveal at `p` (0..1); p ≥ 1 is exactly at rest. (Pure.) */
export function blockRevealAt(name: BlockRevealName, p: number): BlockFrame {
  const q = clamp01(fin(p))
  if (q >= 1) return { opacity: '1', transform: 'none', clipPath: 'none', curtain: NO_CURTAIN }
  const recipe = (blockReveals as Record<string, BlockRecipe>)[name] ?? blockReveals['fade-up']
  const f = recipe.frame(q)
  return { opacity: f.opacity ?? '1', transform: f.transform ?? 'none', clipPath: f.clipPath ?? 'none', curtain: f.curtain ?? NO_CURTAIN }
}

// ------------------------------------------------------------------ scroll

/**
 * 0..1 progress of an element through the viewport: 0 when its top meets the
 * viewport bottom, 1 when its bottom leaves the viewport top. (Pure.)
 */
export function viewProgress(top: number, height: number, viewport: number): number {
  const span = fin(height) + fin(viewport)
  return span > 0 ? clamp01((fin(viewport) - fin(top)) / span) : 0
}

/**
 * 0..1 progress of a tall "scrub" section while it is pinned: 0 when its top
 * reaches the viewport top, 1 when its bottom reaches the viewport bottom. (Pure.)
 */
export function pinProgress(top: number, height: number, viewport: number): number {
  const travel = fin(height) - fin(viewport)
  return travel > 0 ? clamp01(-fin(top) / travel) : clamp01(-fin(top) > 0 ? 1 : 0)
}

/** Parallax shift in px for an element: 0 when centred in the viewport, ±factor·viewport/2 at the edges. (Pure.) */
export function parallaxShift(top: number, height: number, viewport: number, factor: number): number {
  const centre = fin(top) + fin(height) / 2 - fin(viewport) / 2
  return -centre * fin(factor)
}

// ------------------------------------------------------------------ marquee

/** Scroll speed (px/s) at which a marquee reaches its full boost. */
const MARQUEE_VELOCITY_FULL = 2400
/** Max speed multiplier and skew (deg) a fast scroll adds. */
const MARQUEE_BOOST = 4
const MARQUEE_SKEW = 8

/**
 * Advances a marquee: `offset` is the current shift as a fraction (0..1) of
 * one repeat unit, `speed` units/second (negative runs right), `velocity` the
 * page scroll speed in px/s. Scrolling speeds it up (and flips it when
 * scrolling up), like a studio site's ticker. Returns the new offset and a
 * skew for the moment. (Pure.)
 */
export function marqueeStep(offset: number, dt: number, speed: number, velocity: number): { offset: number; skew: number } {
  const v = clamp01(Math.abs(fin(velocity)) / MARQUEE_VELOCITY_FULL)
  const dir = fin(velocity) < 0 ? -1 : 1
  const next = fin(offset) + fin(dt) * fin(speed) * (1 + v * MARQUEE_BOOST) * dir
  return { offset: next - Math.floor(next), skew: -v * MARQUEE_SKEW * dir * Math.sign(fin(speed) || 1) }
}

// ------------------------------------------------------------------ counters

/**
 * The number a count-up shows at progress p, formatted for the page's
 * locale with a fixed number of decimals. (Pure.)
 */
export function countAt(target: number, p: number, decimals = 0, locale?: string): string {
  const d = Math.min(6, Math.max(0, Math.floor(fin(decimals))))
  const v = fin(target) * outExpo(clamp01(fin(p)))
  try {
    return new Intl.NumberFormat(locale, { minimumFractionDigits: d, maximumFractionDigits: d }).format(v)
  } catch {
    return v.toFixed(d)
  }
}

// ------------------------------------------------------------------ magnetic

/**
 * Pull of a magnetic button toward the pointer: `dx, dy` = pointer minus
 * element centre (px), `radius` = where the pull fades to zero, `strength`
 * 0..1 share of the offset followed. (Pure.)
 */
export function magneticOffset(dx: number, dy: number, radius: number, strength = 0.35): { x: number; y: number } {
  const r = fin(radius)
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return { x: 0, y: 0 } // no pointer yet → no pull
  const d = Math.hypot(dx, dy)
  if (!(r > 0) || d >= r) return { x: 0, y: 0 }
  const falloff = 1 - d / r
  const k = clamp01(fin(strength)) * falloff
  return { x: fin(dx) * k, y: fin(dy) * k }
}

/** Frame-rate independent smoothing toward a target (exponential decay, `rate` per second). (Pure.) */
export function follow(current: number, target: number, dt: number, rate: number): number {
  const k = 1 - Math.exp(-Math.max(0, fin(rate)) * Math.max(0, fin(dt)))
  return fin(current) + (fin(target) - fin(current)) * k
}

// ------------------------------------------------------------------ opening

/** Opening loader timeline: counting, then the double curtain lifting. */
export interface LoaderFrame {
  /** 0..100 shown in the counter. */
  count: number
  /** translateY % of the main curtain (0 = covering, -100 = gone). */
  curtain: number
  /** translateY % of the accent curtain that trails it. */
  accent: number
  done: boolean
}

/** Seconds the curtains take to lift once the count completes. */
export const LOADER_LIFT_SECONDS = 1.1

/**
 * Loader frame `t` seconds after start: the counter runs 0→100 over
 * `countSeconds` but never passes 99 until `ready` (the page has loaded);
 * `liftAt` is when it reached 100 (NaN until then). (Pure.)
 */
export function loaderAt(t: number, countSeconds: number, ready: boolean, liftAt = NaN): LoaderFrame {
  const c = Math.max(0.1, fin(countSeconds, 1.6))
  const raw = outQuart(clamp01(fin(t) / c)) * 100
  const count = Math.floor(ready ? raw : Math.min(raw, 99))
  if (!Number.isFinite(liftAt)) return { count, curtain: 0, accent: 0, done: false }
  const u = clamp01((fin(t) - liftAt) / LOADER_LIFT_SECONDS)
  const main = inOutQuart(clamp01(u * 1.25))
  const trail = inOutQuart(clamp01(u * 1.25 - 0.2))
  return { count: 100, curtain: -main * 100, accent: -trail * 100, done: u >= 1 }
}
