import { YuraError, CODES } from '@yura/core'
import { motions, composePose, identityPose, glyphRank, glyphProgress, type EnterName, type HoldName, type ExitName } from './motions'
import { hash01, clamp01, TAU, outCubic, outExpo, outBack, inCubic, inOutCubic, frac } from './motion-kit'
import { poseToStyle } from './kinetic'
import { segmentGraphemes } from './shapes'
import { FONT_STACKS } from './stage-themes'
import { escapeHtml } from './stage-decor'
import { treatments, treatmentStyles, treatmentLive, cssText, type TreatmentName } from './treatments'
import { backdrops, backdropMarkup, backdropFrame, type BackdropName } from './backdrops'
import { screenFx, fxFrame, combineFx, FX_SVG_DEFS, type FxName } from './screen-fx'

/**
 * yuraFilm — a promo / explainer / showreel video from a script of scenes.
 *
 * The house style of short product films made in code: a hook, a statement
 * with one accented word, the product, numbered steps over UI cards, big
 * numbers that count up over dot charts, a recap grid and an end card with a
 * call to action — each scene one of the kinds in {@link filmScenes}, in one
 * of the looks in {@link filmLooks}, joined by transitions, framed by corner
 * marks, running heads, a step timeline and captions.
 *
 * Every frame is a pure function of the script and the time: {@link planFilm}
 * lays the timeline out, {@link filmFrame} returns the styles of every element
 * at second `t`. The DOM shell ({@link yuraFilm}) only applies them, so a
 * preview in the browser and a frame-by-frame export are the same pictures.
 * The film is laid out at a fixed logical resolution (1920×1080 for 16:9) and
 * scaled to its box, so it looks identical on every screen and machine.
 */

// ------------------------------------------------------------------ script

/** Output aspect ratios and their logical resolutions. */
export const FILM_ASPECTS = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
} as const
export type FilmAspect = keyof typeof FILM_ASPECTS

/** Brand details used by running heads and the end card. */
export interface FilmBrand {
  name: string
  tagline?: string
  url?: string
  cta?: string
}

/** Fields every scene may carry. */
interface SceneBase {
  /** Seconds on screen (defaults per kind; snapped to whole beats when the film has a bpm). */
  duration?: number
  /** How this scene arrives (defaults to the look's transition). */
  transition?: FilmTransitionName
  /** Subtitle line at the bottom of the frame. */
  caption?: string
  /** Label on the step timeline (defaults to the kind). */
  label?: string
  /** Paint the whole scene in a colour block: the look's accent, dark or light tone. */
  block?: 'accent' | 'dark' | 'light'
  /** A pattern / scenery backdrop behind this scene (青海波, sunburst, skyline…; see backdrops). */
  bg?: BackdropName
  /** How this scene's letters are drawn (outline, extrude, marker, halftone…; see treatments). */
  treat?: TreatmentName
  /** Screen effects on the whole picture, at seconds into the scene (default 0). */
  fx?: FxName | (FxName | { name: FxName; at?: number; dur?: number })[]
  /** 2D camera move over the scene (defaults to the look's). */
  camera?: FilmCameraName
}

/**
 * Emphasis inside any text: `*word*` accent colour, `_word_` serif italic,
 * `~~word~~` struck through, `==word==` highlighter. `\n` breaks a line.
 */
export type FilmText = string

export type FilmScene =
  | (SceneBase & { kind: 'title'; kicker?: FilmText; text: FilmText; sub?: FilmText })
  | (SceneBase & { kind: 'statement'; text: FilmText; sub?: FilmText })
  | (SceneBase & { kind: 'impact'; text: FilmText; side?: FilmText })
  | (SceneBase & { kind: 'stat'; value: number; decimals?: number; prefix?: string; suffix?: string; label?: FilmText; viz?: 'dots' | 'ring' | 'bars' | 'none'; share?: number })
  | (SceneBase & { kind: 'steps'; steps: { title: FilmText; text?: FilmText }[] })
  | (SceneBase & { kind: 'ui'; kicker?: FilmText; text?: FilmText; card: FilmCard })
  | (SceneBase & { kind: 'compare'; before: FilmText; after: FilmText; kicker?: FilmText })
  | (SceneBase & { kind: 'list'; title?: FilmText; items: FilmText[] })
  | (SceneBase & { kind: 'quote'; text: FilmText; author?: string })
  | (SceneBase & { kind: 'countdown'; from?: number; text?: FilmText })
  | (SceneBase & { kind: 'code'; lines: string[]; title?: string })
  | (SceneBase & { kind: 'mosaic'; text?: FilmText })
  | (SceneBase & { kind: 'lyric'; text: FilmText; enter?: EnterName; hold?: HoldName; exit?: ExitName })
  | (SceneBase & { kind: 'end'; text?: FilmText })

/** A mock UI card: any mix of a title, skeleton lines, a chat line, a checklist, a waveform and a button the cursor clicks. */
export interface FilmCard {
  title?: string
  lines?: number
  chat?: string
  checklist?: string[]
  wave?: boolean
  button?: string
  /** Label on the cursor ("You"). Omit the button to skip the cursor. */
  cursor?: string
}

export interface FilmScript {
  title?: string
  aspect?: FilmAspect
  look?: FilmLookName
  /** Tempo of the music bed; scene lengths snap to whole beats. Default 112. */
  bpm?: number
  fps?: number
  brand?: FilmBrand
  /** Number formatting locale for stats (e.g. 'ja-JP', 'pt-BR'). Default 'en-US'. */
  locale?: string
  seed?: number
  scenes: FilmScene[]
}

export type SceneKind = FilmScene['kind']

// ------------------------------------------------------------------ looks

/** A visual system: palette, type, backdrop, frame marks and default motion. */
export interface FilmLook {
  ja: string
  desc: string
  bg: string
  fg: string
  sub: string
  accent: string
  /** Text on the accent colour. */
  onAccent: string
  /** Card / panel surface. */
  surface: string
  /** Dark and light block tones. */
  dark: string
  light: string
  /** CSS font stacks. */
  display: string
  serif: string
  mono: string
  displayWeight: number
  backdrop: 'mesh' | 'grid' | 'paper' | 'solid' | 'spheres' | 'halftone' | 'stars'
  /** Blob / sphere tints for mesh and spheres backdrops. */
  tints: readonly string[]
  corners: boolean
  runningHead: boolean
  timeline: boolean
  transition: FilmTransitionName
  enter: EnterName
  /** Default camera move for scenes. */
  camera: FilmCameraName
  /** Text shadow glow for neon-like looks, em. */
  glow: number
  radius: string
}

// Latin display faces are named first so a page that loads them gets them; the stacks fall back to the OS.
const SANS = `'Inter', 'Helvetica Neue', ${FONT_STACKS.gothic}`
const SERIF = `'Instrument Serif', 'Playfair Display', Georgia, ${FONT_STACKS.mincho}`
const MINCHO = `'Noto Serif JP', ${FONT_STACKS.mincho}`
const CONDENSED = `'Anton', 'Oswald', 'Bebas Neue', Impact, ${FONT_STACKS.gothic}`
const ROUND = `'M PLUS Rounded 1c', 'Nunito', ${FONT_STACKS.round}`
const MONO = `'JetBrains Mono', ${FONT_STACKS.mono}`

export const filmLooks = {
  editorial: {
    ja: '和文エディトリアル',
    desc: '生成りと墨、ひと差しの紅。明朝の縦組みと巨大な一文字。日本の CM やポスターのような間と品格。',
    bg: '#f3f0ea', fg: '#111111', sub: '#6b665e', accent: '#c8102e', onAccent: '#ffffff', surface: '#ffffff', dark: '#111111', light: '#f3f0ea',
    display: MINCHO, serif: MINCHO, mono: MONO, displayWeight: 800,
    backdrop: 'paper', tints: ['#e9e3d8'], corners: false, runningHead: true, timeline: false,
    transition: 'cut', enter: 'rise', camera: 'push', glow: 0, radius: '0',
  },
  saas: {
    ja: 'パステル SaaS',
    desc: '淡い緑と青のグラデーションの霞に、すりガラスのカード。見出しの一語だけ細いセリフ体の斜体。プロダクト紹介の定番。',
    bg: '#f2f6f4', fg: '#16201c', sub: '#5d6b66', accent: '#1e7a5a', onAccent: '#ffffff', surface: 'rgba(255,255,255,0.78)', dark: '#16201c', light: '#f2f6f4',
    display: SANS, serif: SERIF, mono: MONO, displayWeight: 600,
    backdrop: 'mesh', tints: ['#bfe8d3', '#c9daf5', '#e7f1c9'], corners: false, runningHead: true, timeline: false,
    transition: 'blur', enter: 'fade-up', camera: 'float', glow: 0, radius: '0.5em',
  },
  tech: {
    ja: 'ダークテック',
    desc: '炭色の方眼に、橙の差し色と等幅のラベル。下端に工程のタイムライン。仕組みを見せる解説映像に。',
    bg: '#1c1d20', fg: '#f4f2ee', sub: '#8d8b87', accent: '#ff6a1a', onAccent: '#111111', surface: '#26282c', dark: '#111214', light: '#f4f2ee',
    display: SANS, serif: SERIF, mono: MONO, displayWeight: 700,
    backdrop: 'grid', tints: ['#ff6a1a'], corners: false, runningHead: true, timeline: true,
    transition: 'slide', enter: 'fade-up', camera: 'push', glow: 0, radius: '0.35em',
  },
  brand: {
    ja: 'ボールドブランド',
    desc: '黒と鮮やかな橙が交互に画面を塗る。極太の数字と斜体のセリフ、四隅のカギ。アプリのショーリールのような勢い。',
    bg: '#161210', fg: '#f6f1ea', sub: '#a39a90', accent: '#ff5a0a', onAccent: '#161210', surface: '#221c18', dark: '#161210', light: '#f4efe6',
    display: CONDENSED, serif: SERIF, mono: MONO, displayWeight: 400,
    backdrop: 'solid', tints: ['#ff5a0a'], corners: true, runningHead: true, timeline: false,
    transition: 'block', enter: 'slam', camera: 'crash-zoom', glow: 0, radius: '0.3em',
  },
  neon: {
    ja: 'ネオン',
    desc: '濃紺の夜にシアンとマゼンタの光る文字。丸い極太の書体が弾む。ゲームやアプリの PV に。',
    bg: '#0b1024', fg: '#eafcff', sub: '#7f8bb3', accent: '#27e1ff', onAccent: '#0b1024', surface: 'rgba(20,30,70,0.8)', dark: '#050814', light: '#eafcff',
    display: ROUND, serif: ROUND, mono: MONO, displayWeight: 900,
    backdrop: 'stars', tints: ['#27e1ff', '#ff3dc8'], corners: false, runningHead: false, timeline: false,
    transition: 'zoom', enter: 'pop', camera: 'beat-punch', glow: 0.35, radius: '0.6em',
  },
  mono: {
    ja: 'モノクロ網点',
    desc: '灰色の網点と白い太字。報道の資料映像のような無彩色で、言葉だけに下線が走る。',
    bg: '#2b2b2b', fg: '#ffffff', sub: '#a5a5a5', accent: '#ffffff', onAccent: '#111111', surface: '#3a3a3a', dark: '#161616', light: '#e9e9e9',
    display: SANS, serif: SERIF, mono: MONO, displayWeight: 800,
    backdrop: 'halftone', tints: ['#444444'], corners: false, runningHead: true, timeline: false,
    transition: 'slide', enter: 'whip-in', camera: 'handheld', glow: 0, radius: '0.2em',
  },
  aqua: {
    ja: '深い水',
    desc: '群青のグラデーションに光る球が浮かび、ガラスのカードが漂う。AI や未来的なサービスの紹介に。',
    bg: '#06142e', fg: '#f1fbff', sub: '#8fb2c9', accent: '#2fd6e0', onAccent: '#06142e', surface: 'rgba(255,255,255,0.1)', dark: '#030a18', light: '#e7f6fb',
    display: SANS, serif: SERIF, mono: MONO, displayWeight: 600,
    backdrop: 'spheres', tints: ['#1f7fd6', '#2fd6e0', '#0c3a7a'], corners: false, runningHead: false, timeline: false,
    transition: 'blur', enter: 'surface', camera: 'float', glow: 0.1, radius: '0.7em',
  },
} satisfies Record<string, FilmLook>
export type FilmLookName = keyof typeof filmLooks

// ------------------------------------------------------------------ emphasis

/** One run of text with its emphasis. */
export interface TextRun {
  text: string
  accent?: boolean
  italic?: boolean
  strike?: boolean
  mark?: boolean
  /** A line break before this run. */
  br?: boolean
}

const EMPHASIS = /(\*[^*\n]+\*|_[^_\n]+_|~~[^~\n]+~~|==[^=\n]+==|\n)/g

/** Splits emphasis markup into runs (see {@link FilmText}). Unclosed markers stay literal. (Pure.) */
export function parseEmphasis(src: string): TextRun[] {
  const out: TextRun[] = []
  let br = false
  for (const part of String(src ?? '').split(EMPHASIS)) {
    if (!part) continue
    if (part === '\n') {
      br = true
      continue
    }
    const run: TextRun =
      part.startsWith('~~') && part.endsWith('~~') && part.length > 4
        ? { text: part.slice(2, -2), strike: true }
        : part.startsWith('==') && part.endsWith('==') && part.length > 4
          ? { text: part.slice(2, -2), mark: true }
          : part.startsWith('*') && part.endsWith('*') && part.length > 2
            ? { text: part.slice(1, -1), accent: true }
            : part.startsWith('_') && part.endsWith('_') && part.length > 2
              ? { text: part.slice(1, -1), italic: true }
              : { text: part }
    if (br) run.br = true
    br = false
    out.push(run)
  }
  return out
}

/** Plain text of emphasis markup (for captions, a11y, recaps). (Pure.) */
export function plainText(src: string): string {
  return parseEmphasis(src)
    .map((r) => (r.br ? ' ' : '') + r.text)
    .join('')
    .trim()
}

/** One animated unit of a text: a word (Latin) or a grapheme (CJK). */
interface TextUnit {
  text: string
  run: number
  blank: boolean
}

/** Mostly-Latin text animates word by word; everything else glyph by glyph. */
const isWordy = (s: string): boolean => {
  const letters = s.replace(/[\s\p{P}\p{S}\d]/gu, '')
  if (!letters) return true
  const latin = letters.replace(/[^\p{Script=Latin}]/gu, '').length
  return latin / letters.length > 0.6
}

function textUnits(runs: TextRun[]): TextUnit[] {
  const wordy = isWordy(runs.map((r) => r.text).join(''))
  const units: TextUnit[] = []
  runs.forEach((r, run) => {
    const parts = wordy ? r.text.split(/(\s+)/).filter(Boolean) : segmentGraphemes(r.text)
    for (const p of parts) units.push({ text: p, run, blank: p.trim() === '' })
  })
  return units
}

// ------------------------------------------------------------------ timing

/** Default seconds on screen per scene kind. */
const KIND_SECONDS: Record<SceneKind, number> = {
  title: 2.8, statement: 2.6, impact: 2.4, stat: 3.2, steps: 5, ui: 4.4, compare: 3.4,
  list: 3.8, quote: 3.4, countdown: 3.2, code: 3.8, mosaic: 3, lyric: 3, end: 3.6,
}
/** Seconds a transition spans, centred on the scene boundary. */
export const FILM_TRANSITION_SECONDS = 0.5
const DEFAULT_BPM = 112
const DEFAULT_FPS = 30
const MIN_SCENE = 0.8
const MAX_SCENE = 30

/** A scene placed on the timeline. */
export interface PlannedScene {
  index: number
  kind: SceneKind
  start: number
  end: number
  transition: FilmTransitionName
  seed: number
  label: string
  scene: FilmScene
}

export interface FilmPlan {
  width: number
  height: number
  aspect: FilmAspect
  fps: number
  bpm: number
  duration: number
  look: FilmLook
  lookName: FilmLookName
  brand: FilmBrand
  locale: string
  scenes: PlannedScene[]
  title: string
}

const fin = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/**
 * Lays a script out on a timeline: validates names (unknown kinds, looks,
 * aspects or transitions throw YURA-019 listing the real ones), clamps every
 * number, snaps scene lengths to whole beats. (Pure.)
 */
export function planFilm(script: FilmScript): FilmPlan {
  if (!script || !Array.isArray(script.scenes) || script.scenes.length === 0)
    throw new YuraError(CODES.UNKNOWN_MOTION, 'A film needs at least one scene.', "Pass { scenes: [{ kind: 'title', text: '…' }] }.")
  const check = (what: string, name: string | undefined, table: object): void => {
    if (name !== undefined && !Object.prototype.hasOwnProperty.call(table, name))
      throw new YuraError(CODES.UNKNOWN_MOTION, `Unknown film ${what} "${name}".`, `Available: ${Object.keys(table).join(', ')}.`)
  }
  check('look', script.look, filmLooks)
  check('aspect', script.aspect, FILM_ASPECTS)
  const lookName = script.look ?? 'saas'
  const look = filmLooks[lookName]
  const aspect = script.aspect ?? '16:9'
  const { width, height } = FILM_ASPECTS[aspect]
  const bpm = Math.min(220, Math.max(40, fin(script.bpm, DEFAULT_BPM)))
  const beat = 60 / bpm
  const seed = Math.floor(fin(script.seed, 1))
  let t = 0
  const scenes = script.scenes.map((scene, index): PlannedScene => {
    check('scene kind', scene?.kind, filmScenes)
    check('transition', scene.transition, filmTransitions)
    const want = Math.min(MAX_SCENE, Math.max(MIN_SCENE, fin(scene.duration, KIND_SECONDS[scene.kind])))
    const dur = Math.max(1, Math.round(want / beat)) * beat
    const planned: PlannedScene = {
      index,
      kind: scene.kind,
      start: t,
      end: t + dur,
      transition: index === 0 ? 'cut' : (scene.transition ?? look.transition),
      seed: Math.floor(hash01(seed, index, 7) * 1e6),
      label: scene.label ?? scene.kind,
      scene,
    }
    t += dur
    return planned
  })
  return {
    width,
    height,
    aspect,
    fps: Math.min(60, Math.max(12, Math.round(fin(script.fps, DEFAULT_FPS)))),
    bpm,
    duration: t,
    look,
    lookName,
    brand: { name: script.brand?.name ?? script.title ?? 'Yura', tagline: script.brand?.tagline, url: script.brand?.url, cta: script.brand?.cta },
    locale: script.locale ?? 'en-US',
    scenes,
    title: script.title ?? script.brand?.name ?? '',
  }
}

// ------------------------------------------------------------------ styles

/** Inline styles per element key; `$text` replaces the element's text. */
export type FilmStyles = Record<string, Record<string, string>>

const r4 = (v: number): string => String(Math.round((Number.isFinite(v) ? v : 0) * 10000) / 10000)
const put = (out: FilmStyles, key: string, style: Record<string, string>): void => {
  out[key] = { ...(out[key] ?? {}), ...style }
}
/** 0..1 progress of a sub-animation starting at `at` lasting `dur`. */
const prog = (t: number, at: number, dur: number): number => clamp01((t - at) / Math.max(1e-6, dur))

// ------------------------------------------------------------------ text

interface TextOpts {
  cls?: string
  tag?: string
}

/**
 * The text treatment of the scene being laid out or drawn. filmMarkup and
 * filmFrame set it around each scene (synchronously), so every text helper of
 * a scene picks up that scene's `treat` without threading it through every
 * recipe.
 */
let activeTreat: { name: TreatmentName; seed: number } | null = null
function withTreat<T>(scene: PlannedScene, fn: () => T): T {
  const name = (scene.scene as SceneBase).treat
  activeTreat = name ? { name, seed: scene.seed } : null
  try {
    return fn()
  } finally {
    activeTreat = null
  }
}

/** Markup for animated text with emphasis. Each unit is `data-f="{key}.{i}"`. (Pure.) */
function textHTML(key: string, src: FilmText, o: TextOpts = {}): string {
  const runs = parseEmphasis(src)
  const units = textUnits(runs)
  const treat = activeTreat ? treatmentStyles(activeTreat.name, units.map((u) => u.text), activeTreat.seed) : null
  let html = ''
  let openRun = -1
  const close = (): void => {
    if (openRun >= 0) {
      const r = runs[openRun]
      if (r.strike) html += `<span data-f="${key}.x${openRun}" style="position:absolute;left:-0.04em;right:-0.04em;top:52%;height:0.07em;background:currentColor;transform:scaleX(0);transform-origin:0 50%"></span>`
      html += '</span>'
    }
    openRun = -1
  }
  units.forEach((u, i) => {
    if (u.run !== openRun) {
      close()
      const r = runs[u.run]
      if (r.br) html += '<br>'
      const style = [
        'position:relative',
        'display:inline',
        r.accent ? 'color:var(--f-accent)' : '',
        r.italic ? 'font-family:var(--f-serif);font-style:italic;font-weight:400' : '',
        r.strike ? 'color:var(--f-sub)' : '',
      ]
        .filter(Boolean)
        .join(';')
      html += `<span style="${style}">`
      if (r.mark) html += `<span data-f="${key}.m${u.run}" style="position:absolute;left:-0.08em;right:-0.08em;top:18%;bottom:6%;background:var(--f-mark);transform:scaleX(0);transform-origin:0 50%;z-index:-1;border-radius:0.08em"></span>`
      openRun = u.run
    }
    const extra = treat ? cssText(treat.glyphs[i]) : ''
    html += u.blank ? escapeHtml(u.text).replace(/ /g, '&#32;') : `<span data-f="${key}.${i}" style="display:inline-block;white-space:pre${extra ? `;${extra}` : ''}">${escapeHtml(u.text)}</span>`
  })
  close()
  if (treat?.wrap) html = `${escapeHtml(treat.wrap[0])}${html}${escapeHtml(treat.wrap[1])}`
  const tag = o.tag ?? 'div'
  const block = treat ? cssText(treat.block) : ''
  return `<${tag} class="${o.cls ?? ''}" style="position:relative${block ? `;${block}` : ''}">${html}</${tag}>`
}

/**
 * Styles for animated text at local time `t`: the entrance recipe (from the
 * lyric-motion vocabulary) staggered over the units, then strike lines and
 * highlighter marks drawing in. (Pure.)
 */
function textFrame(out: FilmStyles, key: string, src: FilmText, t: number, o: { enter: EnterName; at?: number; dur?: number; seed?: number }): void {
  const runs = parseEmphasis(src)
  const units = textUnits(runs)
  const recipe = motions.enter[o.enter] ?? motions.enter.fade
  const at = o.at ?? 0
  const dur = o.dur ?? 0.9
  const p = prog(t, at, dur)
  const n = units.length
  const seed = o.seed ?? 1
  const live = activeTreat ? treatmentLive(activeTreat.name, t - at, units.map((u) => u.text), activeTreat.seed) : null
  const base = activeTreat ? treatmentStyles(activeTreat.name, units.map((u) => u.text), activeTreat.seed).glyphs : null
  units.forEach((u, i) => {
    if (u.blank) return
    if (live) put(out, `${key}.${i}`, live[i])
    const rank = glyphRank(recipe.order ?? 'ltr', i, n, seed)
    const gp = glyphProgress(p, rank, recipe.stagger ?? 0.5)
    const g = { i, n, seed, char: u.text, rank }
    const pose = composePose(identityPose(), recipe.pose(gp, g))
    const s = poseToStyle(pose)
    const style: Record<string, string> = {
      transform: s.transform,
      opacity: s.opacity,
      filter: s.filter,
      clipPath: s.clipPath,
      // Outline and fill fall back to the scene's treatment when the motion leaves them at rest.
      WebkitTextStroke: s.textStroke || base?.[i]?.WebkitTextStroke || '',
      WebkitTextFillColor: s.fillColor || base?.[i]?.WebkitTextFillColor || '',
    }
    if (recipe.origin) style.transformOrigin = recipe.origin
    style.$text = pose.char ?? u.text
    put(out, `${key}.${i}`, style)
  })
  runs.forEach((r, k) => {
    const q = outCubic(prog(t, at + dur + 0.15, 0.45))
    if (r.strike) put(out, `${key}.x${k}`, { transform: `scaleX(${r4(q)})` })
    if (r.mark) put(out, `${key}.m${k}`, { transform: `scaleX(${r4(q)})` })
  })
}

/** A plain fade-and-rise for supporting elements. */
function rise(out: FilmStyles, key: string, t: number, at: number, dur = 0.6, dist = 0.6): void {
  const q = outCubic(prog(t, at, dur))
  put(out, key, { opacity: r4(q), transform: `translateY(${r4((1 - q) * dist)}em)` })
}

// ------------------------------------------------------------------ numbers

/** Formats a stat value with fixed decimals in a locale (invalid locales fall back to en-US). (Pure.) */
export function formatStat(v: number, o: { decimals?: number; locale?: string; prefix?: string; suffix?: string } = {}): string {
  const d = Math.min(4, Math.max(0, Math.floor(fin(o.decimals, 0))))
  const n = fin(v, 0)
  let s: string
  try {
    s = new Intl.NumberFormat(o.locale ?? 'en-US', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n)
  } catch {
    s = n.toFixed(d)
  }
  return `${o.prefix ?? ''}${s}${o.suffix ?? ''}`
}

// ------------------------------------------------------------------ scene recipes

/** What a scene recipe knows while it draws. */
export interface SceneContext {
  plan: FilmPlan
  scene: PlannedScene
  look: FilmLook
  tall: boolean
  /** Scene length in seconds. */
  dur: number
}

interface SceneRecipe {
  ja: string
  desc: string
  markup(s: never, c: SceneContext): string
  frame(out: FilmStyles, s: never, c: SceneContext, t: number): void
}

const center = (inner: string, extra = ''): string =>
  `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 8%;${extra}">${inner}</div>`
const left = (inner: string, extra = ''): string =>
  `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;text-align:left;padding:0 9%;${extra}">${inner}</div>`
const H1 = 'font-family:var(--f-display);font-weight:var(--f-weight);font-size:2.3em;line-height:1.08;letter-spacing:-0.02em;text-shadow:var(--f-glow)'
const H2 = 'font-family:var(--f-display);font-weight:var(--f-weight);font-size:1.5em;line-height:1.15;letter-spacing:-0.01em;text-shadow:var(--f-glow)'
/** Logical px per em at a plan's size: taller frames get a larger unit (they are read on phones). */
export function filmUnit(plan: { width: number; height: number }): number {
  return plan.height > plan.width ? plan.width / 14 : Math.min(plan.width, plan.height) / 18
}

/** Rough width of a line in em: full-width (CJK) glyphs 1em, Latin letters ~0.56em, spaces ~0.28em. (Pure.) */
export function lineEm(text: string): number {
  let w = 0
  for (const ch of plainText(text).replace(/\s+/g, ' ')) w += ch === ' ' ? 0.28 : /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(ch) ? 1 : /[A-Z0-9%@#&MW]/.test(ch) ? 0.66 : 0.52
  return w
}

/**
 * A headline size (em of the film unit) that keeps the longest `\n` line inside
 * `share` of the frame width: `base` when it fits, smaller when it would not.
 * Fitting happens at layout time from the text alone, so export and preview agree. (Pure.)
 */
export function fitEm(c: SceneContext, text: string, base: number, share = 0.84): number {
  const longest = Math.max(1, ...String(text ?? '').split('\n').map(lineEm))
  const room = (c.plan.width * share) / filmUnit(c.plan)
  // Round down: a fitted headline may never end up a pixel wider than the room.
  return Math.floor(Math.min(base, room / longest) * 1000) / 1000
}
const fs = (em: number): string => `font-size:${em}em`

const KICK = 'font-family:var(--f-mono);font-size:0.42em;letter-spacing:0.18em;text-transform:uppercase;color:var(--f-accent);margin-bottom:1.4em'
const SUB = 'font-size:0.62em;line-height:1.5;color:var(--f-sub);margin-top:1em;max-width:28em'
const CARD = 'background:var(--f-surface);border-radius:var(--f-radius);box-shadow:0 1.2em 3em rgba(0,0,0,0.18);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);border:1px solid rgba(255,255,255,0.18)'

/** Dot-chart geometry: columns × rows. */
const DOT_COLS = 24
const DOT_ROWS = 10
const BARS = 7
const WAVE_BARS = 36

export const filmScenes = {
  title: {
    ja: 'タイトル',
    desc: '小さなラベルと、一語だけ色や斜体を効かせた大見出し。問いかけのフック、映像の一枚目に。',
    markup: (s: { kicker?: string; text: string; sub?: string }, c) =>
      (c.tall ? center : left)(
        (s.kicker ? `<div data-f="k" style="${KICK}">${escapeHtml(plainText(s.kicker))}</div>` : '') +
          `<div style="${H1};${fs(fitEm(c, s.text, 2.3, c.tall ? 0.84 : 0.8))}">${textHTML('h', s.text)}</div>` +
          (s.sub ? `<div data-f="sub" style="${SUB}">${textHTML('sb', s.sub)}</div>` : ''),
      ),
    frame: (out, s: { kicker?: string; text: string; sub?: string }, c, t) => {
      if (s.kicker) rise(out, 'k', t, 0.05, 0.5, 0.4)
      textFrame(out, 'h', s.text, t, { enter: c.look.enter, at: 0.15, dur: 0.9, seed: c.scene.seed })
      if (s.sub) rise(out, 'sub', t, 0.9)
    },
  },
  statement: {
    ja: 'ステートメント',
    desc: '中央に一行。言葉が一つずつ立ち上がり、強調語に色・斜体・下線・打ち消しが入る。',
    markup: (s: { text: string; sub?: string }, c) =>
      center(`<div style="${H1};${fs(fitEm(c, s.text, 2))}">${textHTML('h', s.text)}</div>` + (s.sub ? `<div data-f="sub" style="${SUB}">${textHTML('sb', s.sub)}</div>` : '')),
    frame: (out, s: { text: string; sub?: string }, c, t) => {
      textFrame(out, 'h', s.text, t, { enter: c.look.enter, at: 0.1, dur: 1.1, seed: c.scene.seed })
      if (s.sub) rise(out, 'sub', t, 1.1)
      put(out, 'root', { transform: `scale(${r4(1 + (t / c.dur) * 0.035)})` })
    },
  },
  impact: {
    ja: 'インパクト',
    desc: '画面いっぱいの一、二文字と、脇に添える縦書きの一行。和文の CM のような強い決め。',
    markup: (s: { text: string; side?: string }, c) => {
      const big = `<div style="font-family:var(--f-display);font-weight:900;font-size:${c.tall ? 6 : 7.5}em;line-height:1;letter-spacing:-0.04em">${textHTML('h', s.text)}</div>`
      const side = s.side
        ? `<div data-f="side" style="writing-mode:vertical-rl;font-family:var(--f-display);font-weight:var(--f-weight);font-size:1.25em;line-height:1.4;letter-spacing:0.08em">${textHTML('sd', s.side)}</div>`
        : ''
      return center(`<div style="display:flex;align-items:center;gap:1.2em">${big}${side}</div>`)
    },
    frame: (out, s: { text: string; side?: string }, c, t) => {
      textFrame(out, 'h', s.text, t, { enter: 'slam', at: 0.05, dur: 0.55, seed: c.scene.seed })
      if (s.side) textFrame(out, 'sd', s.side, t, { enter: 'wipe-down', at: 0.55, dur: 0.9, seed: c.scene.seed })
    },
  },
  stat: {
    ja: '数字',
    desc: '大きな数字が数え上がり、下に説明。点の群れ・輪・棒のグラフが一緒に満ちていく。',
    markup: (s: { label?: string; viz?: string }, c) => {
      const viz = s.viz ?? 'dots'
      const num = `<div data-f="num" style="font-family:var(--f-display);font-weight:var(--f-weight);font-size:4.2em;line-height:1;letter-spacing:-0.03em;font-variant-numeric:tabular-nums;text-shadow:var(--f-glow)">0</div>`
      const label = s.label ? `<div data-f="lab" style="font-family:var(--f-serif);font-style:italic;font-size:0.95em;color:var(--f-fg);margin-top:0.3em">${escapeHtml(plainText(s.label))}</div>` : ''
      let chart = ''
      if (viz === 'dots') {
        let dots = ''
        for (let i = 0; i < DOT_COLS * DOT_ROWS; i++) dots += `<i data-f="d${i}" style="display:block;width:0.2em;height:0.2em;border-radius:50%;background:var(--f-sub);opacity:0"></i>`
        chart = `<div style="display:grid;grid-template-columns:repeat(${DOT_COLS},0.2em);gap:0.2em;margin-top:1.1em">${dots}</div>`
      } else if (viz === 'ring') {
        chart = `<svg viewBox="0 0 100 100" style="width:5.2em;height:5.2em;margin-top:0.9em;transform:rotate(-90deg)"><circle cx="50" cy="50" r="42" fill="none" stroke="var(--f-sub)" stroke-opacity="0.25" stroke-width="7"/><circle data-f="ring" cx="50" cy="50" r="42" fill="none" stroke="var(--f-accent)" stroke-width="7" stroke-linecap="round" pathLength="100" stroke-dasharray="0 100"/></svg>`
      } else if (viz === 'bars') {
        let bars = ''
        for (let i = 0; i < BARS; i++) bars += `<i data-f="b${i}" style="display:block;width:0.55em;height:100%;background:${i === BARS - 1 ? 'var(--f-accent)' : 'var(--f-sub)'};transform-origin:50% 100%;transform:scaleY(0);border-radius:0.08em"></i>`
        chart = `<div style="display:flex;gap:0.3em;align-items:flex-end;height:3.4em;margin-top:1em">${bars}</div>`
      }
      return (c.tall ? center : center)(num + label + chart)
    },
    frame: (out, s: { value: number; decimals?: number; prefix?: string; suffix?: string; label?: string; viz?: string; share?: number }, c, t) => {
      const q = outExpo(prog(t, 0.15, Math.min(1.8, c.dur * 0.55)))
      put(out, 'num', { $text: formatStat(fin(s.value, 0) * q, { decimals: s.decimals, locale: c.plan.locale, prefix: s.prefix, suffix: s.suffix }), transform: `scale(${r4(0.92 + 0.08 * outBack(prog(t, 0, 0.5)))})`, opacity: r4(prog(t, 0, 0.25)) })
      if (s.label) rise(out, 'lab', t, 0.5)
      const share = clamp01(fin(s.share, 0.3))
      const viz = s.viz ?? 'dots'
      if (viz === 'dots') {
        const total = DOT_COLS * DOT_ROWS
        const lit = Math.round(total * share)
        for (let i = 0; i < total; i++) {
          const col = i % DOT_COLS
          const on = col >= Math.floor(DOT_COLS * (0.5 - share / 2)) && col < Math.floor(DOT_COLS * (0.5 - share / 2)) + Math.max(1, Math.round(DOT_COLS * share))
          const appear = prog(t, 0.2 + hash01(c.scene.seed, i, 3) * 0.9, 0.25)
          const hot = on && lit > 0 ? prog(t, 1.2 + (i / total) * 0.4, 0.3) : 0
          put(out, `d${i}`, { opacity: r4(appear * (0.55 + 0.45 * hot)), background: hot > 0.5 ? 'var(--f-accent)' : 'var(--f-sub)' })
        }
      } else if (viz === 'ring') {
        put(out, 'ring', { strokeDasharray: `${r4(share * 100 * q)} 100` })
      } else if (viz === 'bars') {
        for (let i = 0; i < BARS; i++) {
          const h = 0.25 + (0.75 * (i + 1)) / BARS - (i === BARS - 1 ? 0 : hash01(c.scene.seed, i, 4) * 0.15)
          put(out, `b${i}`, { transform: `scaleY(${r4(h * outBack(prog(t, 0.2 + i * 0.09, 0.5)))})` })
        }
      }
    },
  },
  steps: {
    ja: '手順',
    desc: '上に「01 02 03」の工程タブ、中央に今の工程の見出しと説明。時間とともに次の工程へ進む。',
    markup: (s: { steps: { title: string; text?: string }[] }, c) => {
      const steps = s.steps.length ? s.steps : [{ title: '' }]
      const tabs = steps
        .map((st, i) => `<div data-f="tab${i}" style="font-family:var(--f-mono);font-size:0.36em;padding:0.55em 1.1em;border-radius:99em;border:1px solid var(--f-sub);white-space:nowrap">${String(i + 1).padStart(2, '0')}&nbsp;&nbsp;${escapeHtml(plainText(st.title))}</div>`)
        .join('')
      const panels = steps
        .map(
          (st, i) =>
            `<div data-f="p${i}" style="position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:${c.tall ? 'center' : 'flex-start'};text-align:${c.tall ? 'center' : 'left'};padding:0 9%">` +
            `<div style="${KICK}">STEP ${String(i + 1).padStart(2, '0')}</div><div style="${H1};${fs(fitEm(c, st.title, 1.9, 0.8))}">${textHTML(`h${i}`, st.title)}</div>` +
            (st.text ? `<div style="${SUB}">${textHTML(`t${i}`, st.text)}</div>` : '') +
            `</div>`,
        )
        .join('')
      return `<div style="position:absolute;left:0;right:0;top:9%;display:flex;gap:0.5em;justify-content:center;flex-wrap:wrap;padding:0 6%">${tabs}</div>${panels}`
    },
    frame: (out, s: { steps: { title: string; text?: string }[] }, c, t) => {
      const n = Math.max(1, s.steps.length)
      const each = c.dur / n
      for (let i = 0; i < n; i++) {
        const lt = t - i * each
        const active = t >= i * each && (t < (i + 1) * each || i === n - 1)
        put(out, `tab${i}`, { background: active ? 'var(--f-accent)' : 'transparent', color: active ? 'var(--f-on-accent)' : 'var(--f-sub)', borderColor: active ? 'var(--f-accent)' : 'var(--f-sub)' })
        const outQ = i < n - 1 ? prog(t, (i + 1) * each - 0.25, 0.25) : 0
        put(out, `p${i}`, { opacity: active || (lt >= 0 && outQ < 1) ? r4(1 - outQ) : '0', transform: `translateX(${r4(-outQ * 1.5)}em)` })
        const st = s.steps[i]
        if (!st) continue
        textFrame(out, `h${i}`, st.title, lt, { enter: c.look.enter, at: 0.05, dur: 0.7, seed: c.scene.seed + i })
        if (st.text) textFrame(out, `t${i}`, st.text, lt, { enter: 'fade', at: 0.45, dur: 0.6, seed: c.scene.seed + i })
      }
    },
  },
  ui: {
    ja: 'UI カード',
    desc: 'すりガラスのカードに、項目・チャット・チェックリスト・音声波形・ボタン。「You」のカーソルが来てボタンを押す。',
    markup: (s: { kicker?: string; text?: string; card: FilmCard }, c) => {
      const k = s.card ?? {}
      let body = ''
      if (k.title) body += `<div style="font-weight:700;font-size:0.52em;margin-bottom:0.9em;display:flex;align-items:center;gap:0.5em"><i style="width:0.6em;height:0.6em;border-radius:50%;background:var(--f-accent);display:inline-block"></i>${escapeHtml(k.title)}</div>`
      if (k.wave) {
        let bars = ''
        for (let i = 0; i < WAVE_BARS; i++) bars += `<i data-f="w${i}" style="display:block;width:0.09em;height:100%;background:var(--f-accent);border-radius:1em;transform:scaleY(0.1)"></i>`
        body += `<div style="display:flex;gap:0.07em;align-items:center;height:1.1em;margin-bottom:0.8em">${bars}</div>`
      }
      if (k.chat) body += `<div data-f="chat" style="font-size:0.46em;line-height:1.55;margin-bottom:0.9em;min-height:1.5em"></div>`
      for (let i = 0; i < Math.min(6, Math.max(0, Math.floor(fin(k.lines, 0)))); i++)
        body += `<div data-f="ln${i}" style="height:0.22em;border-radius:1em;background:var(--f-sub);opacity:0.25;margin:0 0 0.35em;width:${60 + hash01(i, 3, 5) * 35}%;transform-origin:0 50%"></div>`
      ;(k.checklist ?? []).slice(0, 6).forEach((item, i) => {
        body += `<div data-f="ck${i}" style="display:flex;align-items:center;gap:0.6em;font-size:0.44em;margin:0.5em 0"><span data-f="cb${i}" style="width:1.1em;height:1.1em;border-radius:0.3em;border:0.12em solid var(--f-sub);display:inline-flex;align-items:center;justify-content:center;font-size:0.9em;color:var(--f-on-accent)"></span>${escapeHtml(item)}</div>`
      })
      if (k.button)
        body += `<div style="margin-top:0.8em"><span data-f="btn" style="display:inline-block;font-size:0.44em;font-weight:700;padding:0.7em 1.4em;border-radius:99em;background:var(--f-accent);color:var(--f-on-accent);position:relative">${escapeHtml(k.button)}<i data-f="rip" style="position:absolute;left:50%;top:50%;width:3em;height:3em;margin:-1.5em 0 0 -1.5em;border-radius:50%;border:0.12em solid var(--f-accent);opacity:0"></i></span></div>`
      const card = `<div data-f="card" style="${CARD};padding:1.1em 1.3em;width:${c.tall ? 15 : 13}em;text-align:left;color:var(--f-fg)">${body}</div>`
      const copy =
        s.kicker || s.text
          ? `<div style="flex:1;min-width:0">${s.kicker ? `<div data-f="k" style="${KICK}">${escapeHtml(plainText(s.kicker))}</div>` : ''}${s.text ? `<div style="${H2}">${textHTML('h', s.text)}</div>` : ''}</div>`
          : ''
      const cursor = k.button
        ? `<div data-f="cur" style="position:absolute;left:0;top:0;z-index:3;pointer-events:none"><svg viewBox="0 0 24 24" style="width:0.8em;height:0.8em;filter:drop-shadow(0 0.05em 0.1em rgba(0,0,0,0.35))"><path d="M3 2l7 19 2.5-7.5L20 11z" fill="#111" stroke="#fff" stroke-width="1.5"/></svg><span style="display:inline-block;margin-left:0.2em;font-size:0.3em;padding:0.3em 0.7em;border-radius:99em;background:#111;color:#fff;font-family:var(--f-mono)">${escapeHtml(k.cursor ?? 'You')}</span></div>`
        : ''
      const row = c.tall
        ? `<div style="display:flex;flex-direction:column;gap:1.4em;align-items:center;text-align:center">${copy}${card}</div>`
        : `<div style="display:flex;gap:2.2em;align-items:center;width:100%">${copy}${card}</div>`
      return `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:0 8%">${row}</div>${cursor}`
    },
    frame: (out, s: { kicker?: string; text?: string; card: FilmCard }, c, t) => {
      const k = s.card ?? {}
      if (s.kicker) rise(out, 'k', t, 0.05, 0.5)
      if (s.text) textFrame(out, 'h', s.text, t, { enter: c.look.enter, at: 0.15, dur: 0.8, seed: c.scene.seed })
      const cq = outBack(prog(t, 0.25, 0.7))
      put(out, 'card', { opacity: r4(prog(t, 0.25, 0.3)), transform: `translateY(${r4((1 - cq) * 1.2)}em) scale(${r4(0.94 + 0.06 * cq)})` })
      for (let i = 0; i < WAVE_BARS; i++) {
        const amp = k.wave ? 0.15 + 0.85 * Math.abs(Math.sin(t * 7 + i * 0.7) * Math.sin(t * 3.1 + i * 0.23)) * prog(t, 0.6, 0.4) : 0
        if (k.wave) put(out, `w${i}`, { transform: `scaleY(${r4(Math.max(0.1, amp))})` })
      }
      if (k.chat) {
        const chars = Array.from(k.chat)
        const shown = Math.floor(chars.length * prog(t, 0.8, Math.min(2, c.dur * 0.4)))
        put(out, 'chat', { $text: chars.slice(0, shown).join('') + (shown < chars.length && Math.floor(t * 3) % 2 === 0 ? '▍' : '') })
      }
      const lines = Math.min(6, Math.max(0, Math.floor(fin(k.lines, 0))))
      for (let i = 0; i < lines; i++) put(out, `ln${i}`, { transform: `scaleX(${r4(outCubic(prog(t, 0.6 + i * 0.12, 0.5)))})` })
      ;(k.checklist ?? []).slice(0, 6).forEach((_, i) => {
        const q = prog(t, 0.9 + i * 0.35, 0.3)
        rise(out, `ck${i}`, t, 0.6 + i * 0.12, 0.4, 0.3)
        put(out, `cb${i}`, { background: q > 0 ? 'var(--f-accent)' : 'transparent', borderColor: q > 0 ? 'var(--f-accent)' : 'var(--f-sub)', $text: q > 0.4 ? '✓' : '' })
      })
      if (k.button) {
        // The cursor glides in from the lower right, clicks at 62% of the scene, then rests.
        const clickAt = c.dur * 0.62
        const m = inOutCubic(prog(t, clickAt - 1.1, 1))
        const target = c.tall ? { x: 0.5, y: 0.66 } : { x: 0.74, y: 0.64 }
        const x = 1.05 + (target.x - 1.05) * m
        const y = 1.05 + (target.y - 1.05) * m
        const press = t >= clickAt && t < clickAt + 0.18
        put(out, 'cur', { transform: `translate(${r4(x * c.plan.width)}px, ${r4(y * c.plan.height)}px) scale(${press ? 0.85 : 1})`, opacity: r4(prog(t, clickAt - 1.2, 0.2)) })
        const rq = prog(t, clickAt, 0.6)
        put(out, 'rip', { opacity: r4(rq > 0 && rq < 1 ? 1 - rq : 0), transform: `scale(${r4(0.3 + rq * 1.4)})` })
        put(out, 'btn', { transform: `scale(${press ? 0.94 : 1})` })
      }
    },
  },
  compare: {
    ja: '言い換え',
    desc: '前の言葉に打ち消し線が走り、下から新しい言葉が色付きでせり上がる。「〜ではなく、〜」。',
    markup: (s: { before: string; after: string; kicker?: string }, c) =>
      center(
        (s.kicker ? `<div data-f="k" style="${KICK}">${escapeHtml(plainText(s.kicker))}</div>` : '') +
          `<div data-f="bw" style="${H1};${fs(fitEm(c, s.before, 2.3))};position:relative;color:var(--f-sub)">${textHTML('b', s.before)}<span data-f="strike" style="position:absolute;left:-0.05em;right:-0.05em;top:54%;height:0.08em;background:var(--f-accent);transform:scaleX(0);transform-origin:0 50%"></span></div>` +
          `<div style="${H1};${fs(fitEm(c, s.after, 2.3))};color:var(--f-accent);margin-top:0.2em">${textHTML('a', s.after)}</div>`,
      ),
    frame: (out, s: { before: string; after: string; kicker?: string }, c, t) => {
      if (s.kicker) rise(out, 'k', t, 0, 0.5)
      textFrame(out, 'b', s.before, t, { enter: 'fade-up', at: 0.05, dur: 0.7, seed: c.scene.seed })
      put(out, 'strike', { transform: `scaleX(${r4(outCubic(prog(t, 0.95, 0.45)))})` })
      textFrame(out, 'a', s.after, t, { enter: c.look.enter, at: 1.35, dur: 0.8, seed: c.scene.seed + 1 })
    },
  },
  list: {
    ja: 'リスト',
    desc: '見出しの下に項目が順に並び、チェックが一つずつ入っていく。機能一覧や「できること」に。',
    markup: (s: { title?: string; items: string[] }, c) =>
      (c.tall ? center : left)(
        (s.title ? `<div style="${H2};margin-bottom:0.8em">${textHTML('h', s.title)}</div>` : '') +
          (s.items ?? [])
            .slice(0, 8)
            .map((it, i) => `<div data-f="it${i}" style="display:flex;align-items:center;gap:0.7em;font-size:0.8em;margin:0.3em 0"><span data-f="ic${i}" style="width:1.05em;height:1.05em;border-radius:50%;background:var(--f-accent);color:var(--f-on-accent);display:inline-flex;align-items:center;justify-content:center;font-size:0.8em;flex:none">✓</span><span>${textHTML(`i${i}`, it, { tag: 'span' })}</span></div>`)
            .join(''),
      ),
    frame: (out, s: { title?: string; items: string[] }, c, t) => {
      if (s.title) textFrame(out, 'h', s.title, t, { enter: c.look.enter, at: 0.05, dur: 0.7, seed: c.scene.seed })
      const items = (s.items ?? []).slice(0, 8)
      const gap = Math.min(0.45, (c.dur - 1.4) / Math.max(1, items.length))
      items.forEach((_, i) => {
        rise(out, `it${i}`, t, 0.5 + i * gap, 0.45, 0.5)
        put(out, `ic${i}`, { transform: `scale(${r4(outBack(prog(t, 0.65 + i * gap, 0.35)))})` })
      })
    },
  },
  quote: {
    ja: '引用',
    desc: '大きな引用符と、斜体のセリフで組んだ一言。お客様の声や決め台詞に。',
    markup: (s: { text: string; author?: string }) =>
      center(
        `<div data-f="q" style="font-family:var(--f-serif);font-size:4em;line-height:0.6;color:var(--f-accent);height:0.5em">“</div>` +
          `<div style="font-family:var(--f-serif);font-style:italic;font-size:1.7em;line-height:1.25;max-width:18em">${textHTML('h', s.text)}</div>` +
          (s.author ? `<div data-f="au" style="font-family:var(--f-mono);font-size:0.4em;letter-spacing:0.16em;margin-top:1.6em;color:var(--f-sub)">— ${escapeHtml(s.author)}</div>` : ''),
      ),
    frame: (out, s: { text: string; author?: string }, c, t) => {
      put(out, 'q', { transform: `scale(${r4(outBack(prog(t, 0, 0.5)))})` })
      textFrame(out, 'h', s.text, t, { enter: 'blur-in', at: 0.2, dur: 1.2, seed: c.scene.seed })
      if (s.author) rise(out, 'au', t, 1.3)
    },
  },
  countdown: {
    ja: 'カウントダウン',
    desc: '輪が減っていき、数字が一つずつ減る。締め切り、発売、スタートまでの高揚。',
    markup: (s: { text?: string }) =>
      center(
        `<div style="position:relative;width:5em;height:5em"><svg viewBox="0 0 100 100" style="position:absolute;inset:0;transform:rotate(-90deg)"><circle cx="50" cy="50" r="45" fill="none" stroke="var(--f-sub)" stroke-opacity="0.25" stroke-width="4"/><circle data-f="ring" cx="50" cy="50" r="45" fill="none" stroke="var(--f-accent)" stroke-width="4" pathLength="100" stroke-dasharray="100 100"/></svg>` +
          `<div data-f="n" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:var(--f-display);font-weight:var(--f-weight);font-size:2.4em;font-variant-numeric:tabular-nums">0</div></div>` +
          (s.text ? `<div style="${H2};margin-top:0.7em">${textHTML('h', s.text)}</div>` : ''),
      ),
    frame: (out, s: { from?: number; text?: string }, c, t) => {
      const from = Math.max(1, Math.min(99, Math.floor(fin(s.from, 3))))
      const u = clamp01(t / c.dur)
      const n = Math.max(0, from - Math.floor(u * (from + 1)))
      const beat = frac(u * (from + 1))
      put(out, 'n', { $text: String(n), transform: `scale(${r4(1 + 0.25 * Math.exp(-beat * 8))})` })
      put(out, 'ring', { strokeDasharray: `${r4((1 - u) * 100)} 100` })
      if (s.text) textFrame(out, 'h', s.text, t, { enter: c.look.enter, at: 0.2, dur: 0.8, seed: c.scene.seed })
    },
  },
  code: {
    ja: 'ターミナル',
    desc: '黒いウィンドウに、プロンプトやコードが一文字ずつ打ち込まれていく。点滅するカーソル付き。',
    markup: (s: { lines: string[]; title?: string }, c) => {
      const lines = (s.lines ?? []).slice(0, 10)
      return center(
        `<div data-f="win" style="width:${c.tall ? 16 : 24}em;max-width:92%;background:#0e0f12;color:#e8e6e3;border-radius:0.45em;box-shadow:0 1.5em 4em rgba(0,0,0,0.4);text-align:left;overflow:hidden;border:1px solid rgba(255,255,255,0.08)">` +
          `<div style="display:flex;gap:0.35em;align-items:center;padding:0.55em 0.8em;background:#1a1b1f;font-size:0.36em;font-family:var(--f-mono);color:#8a8986"><i style="width:0.9em;height:0.9em;border-radius:50%;background:#ff5f57;display:inline-block"></i><i style="width:0.9em;height:0.9em;border-radius:50%;background:#febc2e;display:inline-block"></i><i style="width:0.9em;height:0.9em;border-radius:50%;background:#28c840;display:inline-block"></i><span style="margin-left:0.8em">${escapeHtml(s.title ?? 'terminal')}</span></div>` +
          `<div style="padding:1em 1.3em;font-family:var(--f-mono);font-size:0.72em;line-height:1.65;min-height:${Math.max(4, lines.length + 1) * 1.65}em;white-space:pre-wrap">` +
          lines.map((_, i) => `<div data-f="l${i}"></div>`).join('') +
          `</div></div>`,
      )
    },
    frame: (out, s: { lines: string[] }, c, t) => {
      const lines = (s.lines ?? []).slice(0, 10)
      put(out, 'win', { opacity: r4(prog(t, 0, 0.3)), transform: `translateY(${r4((1 - outCubic(prog(t, 0, 0.5))) * 1)}em)` })
      const total = lines.reduce((n, l) => n + Array.from(l).length, 0)
      const rate = total / Math.max(0.5, c.dur * 0.7)
      let budget = Math.floor(Math.max(0, t - 0.4) * rate)
      let caretLine = -1
      lines.forEach((l, i) => {
        const chars = Array.from(l)
        const shown = Math.max(0, Math.min(chars.length, budget))
        budget -= chars.length
        if (shown > 0 || caretLine === -1) caretLine = shown < chars.length && caretLine === -1 ? i : caretLine
        const caret = i === caretLine && Math.floor(t * 2.5) % 2 === 0 ? '▍' : ''
        const text = chars.slice(0, shown).join('')
        put(out, `l${i}`, { $text: text + caret, color: l.startsWith('>') || l.startsWith('$') ? 'var(--f-accent)' : '#e8e6e3' })
      })
    },
  },
  mosaic: {
    ja: 'モザイク',
    desc: 'それまでの場面の言葉がタイルになって画面を埋め尽くす、振り返りの一枚。',
    markup: (s: { text?: string }, c) => {
      const recap = recapTexts(c.plan, c.scene.index)
      const cols = c.tall ? 2 : 3
      const rows = c.tall ? 4 : 3
      const tiles = Array.from({ length: cols * rows }, (_, i) => {
        const word = recap[i % Math.max(1, recap.length)] ?? ''
        // Three tones that all differ from the backdrop: accent, dark, and the secondary text colour.
        const tone = i % 3 === 0 ? 'background:var(--f-accent);color:var(--f-on-accent)' : i % 3 === 1 ? 'background:var(--f-dark);color:var(--f-light)' : 'background:var(--f-sub);color:var(--f-light)'
        return `<div data-f="t${i}" style="${tone};display:flex;align-items:center;justify-content:center;text-align:center;padding:0.6em;font-family:var(--f-display);font-weight:var(--f-weight);font-size:0.8em;line-height:1.2;overflow:hidden">${escapeHtml(word)}</div>`
      }).join('')
      const over = s.text ? `<div data-f="ov" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center"><div style="background:var(--f-dark);color:var(--f-light);padding:0.4em 0.9em;${H2}">${textHTML('h', s.text)}</div></div>` : ''
      return `<div style="position:absolute;inset:4%;display:grid;grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr);gap:0.25em">${tiles}</div>${over}`
    },
    frame: (out, s: { text?: string }, c, t) => {
      const n = c.tall ? 8 : 9
      for (let i = 0; i < n; i++) {
        const q = outBack(prog(t, 0.05 + hash01(c.scene.seed, i, 9) * 0.6, 0.45))
        put(out, `t${i}`, { transform: `scale(${r4(q)})`, opacity: r4(clamp01(q * 2)) })
      }
      if (s.text) {
        put(out, 'ov', { opacity: r4(prog(t, 1, 0.3)) })
        textFrame(out, 'h', s.text, t, { enter: 'slam', at: 1, dur: 0.6, seed: c.scene.seed })
      }
    },
  },
  lyric: {
    ja: 'リリック',
    desc: 'リリックモーション辞典の登場・保持・退場で一行を見せる。歌詞や決め台詞に、全238表現が使える。',
    markup: (s: { text: string }, c) => center(`<div style="${H1};${fs(fitEm(c, s.text, 2.2))}">${textHTML('h', s.text)}</div>`),
    frame: (out, s: { text: string; enter?: EnterName; hold?: HoldName; exit?: ExitName }, c, t) => {
      const enter = s.enter ?? c.look.enter
      textFrame(out, 'h', s.text, t, { enter, at: 0.05, dur: 0.9, seed: c.scene.seed })
      const units = textUnits(parseEmphasis(s.text))
      const hold = motions.hold[s.hold ?? 'float'] ?? motions.hold.still
      const exit = motions.exit[s.exit ?? 'fade'] ?? motions.exit.fade
      const exitAt = c.dur - 0.6
      const pe = prog(t, exitAt, 0.55)
      units.forEach((u, i) => {
        if (u.blank || t < 0.95) return
        const g = { i, n: units.length, seed: c.scene.seed, char: u.text, rank: glyphRank(exit.order ?? 'ltr', i, units.length, c.scene.seed) }
        const pose = composePose(identityPose(), hold.pose(t - 0.95, g, 60 / c.plan.bpm))
        if (pe > 0) composePose(pose, exit.pose(glyphProgress(pe, g.rank, exit.stagger ?? 0.5), g))
        const st = poseToStyle(pose)
        put(out, `h.${i}`, { transform: st.transform, opacity: st.opacity, filter: st.filter, clipPath: st.clipPath, $text: pose.char ?? u.text })
      })
    },
  },
  end: {
    ja: 'エンドカード',
    desc: 'ロゴの文字組み、ひとこと、行動を促すボタンと URL。映像の締めの一枚。',
    markup: (s: { text?: string }, c) =>
      center(
        `<div style="font-family:var(--f-display);font-weight:var(--f-weight);${fs(fitEm(c, c.plan.brand.name, 2.6))};letter-spacing:-0.02em;text-shadow:var(--f-glow)">${textHTML('logo', c.plan.brand.name)}</div>` +
          (s.text || c.plan.brand.tagline ? `<div data-f="tag" style="font-family:var(--f-serif);font-style:italic;font-size:0.95em;margin-top:0.35em;color:var(--f-sub)">${escapeHtml(plainText(s.text ?? c.plan.brand.tagline ?? ''))}</div>` : '') +
          (c.plan.brand.cta ? `<div data-f="cta" style="margin-top:1.3em;font-size:0.5em;font-weight:700;padding:0.8em 1.8em;border-radius:99em;background:var(--f-accent);color:var(--f-on-accent)">${escapeHtml(c.plan.brand.cta)} →</div>` : '') +
          (c.plan.brand.url ? `<div data-f="url" style="margin-top:1.1em;font-family:var(--f-mono);font-size:0.4em;letter-spacing:0.1em;color:var(--f-sub)">${escapeHtml(c.plan.brand.url)}</div>` : ''),
      ),
    frame: (out, _s: { text?: string }, c, t) => {
      textFrame(out, 'logo', c.plan.brand.name, t, { enter: 'tracking-in', at: 0.1, dur: 1, seed: c.scene.seed })
      rise(out, 'tag', t, 0.8)
      const q = outBack(prog(t, 1.2, 0.5))
      const pulse = 1 + 0.04 * Math.max(0, Math.sin((t - 1.7) * TAU * (c.plan.bpm / 120)))
      put(out, 'cta', { transform: `scale(${r4(q * (t > 1.7 ? pulse : 1))})`, opacity: r4(clamp01(q * 2)) })
      rise(out, 'url', t, 1.5)
    },
  },
} satisfies Record<SceneKind, SceneRecipe>

/** Headlines of the scenes before `index` (for the recap mosaic). (Pure.) */
export function recapTexts(plan: FilmPlan, index: number): string[] {
  const out: string[] = []
  for (const p of plan.scenes.slice(0, index)) {
    const s = p.scene as { text?: string; before?: string; value?: number; steps?: { title: string }[] }
    if (s.text) out.push(plainText(s.text))
    else if (s.steps) out.push(...s.steps.map((st) => plainText(st.title)))
    else if (typeof s.value === 'number') out.push(formatStat(s.value, { locale: plan.locale }))
  }
  return out.filter(Boolean)
}

// ------------------------------------------------------------------ transitions

/** How a scene takes over from the one before. */
export type FilmTransitionName =
  | 'cut' | 'fade' | 'slide' | 'zoom' | 'blur' | 'block' | 'rise'
  | 'clock' | 'diagonal' | 'iris' | 'doors' | 'blinds' | 'checker' | 'cube'
  | 'spin' | 'cover' | 'uncover' | 'zoom-through' | 'flash' | 'ink' | 'pixelate' | 'whip'

export const filmTransitions = {
  cut: { ja: 'カット', desc: 'つなぎなしで切り替える。和文の CM やテンポの速い編集に。' },
  fade: { ja: 'フェード', desc: '前の場面が溶けて次に替わる。落ち着いたつなぎ。' },
  slide: { ja: 'スライド', desc: '画面ごと横へ押し出されて次の場面が入る。手順を追う解説映像に。' },
  zoom: { ja: 'ズームパンチ', desc: '次の場面が手前から飛び込み、前の場面は奥へ沈む。勢いのある PV に。' },
  blur: { ja: 'ブラー', desc: 'ぼけながら入れ替わる。すりガラスの SaaS 映像の定番。' },
  block: { ja: '色面ワイプ', desc: 'アクセント色の面が画面を横切り、通り過ぎた後ろが次の場面。ブランド映像の切り替え。' },
  rise: { ja: 'せり上がり', desc: '次の場面が下から画面ごとせり上がって前を押し上げる。縦長の SNS 動画に。' },
  clock: { ja: 'クロックワイプ', desc: '時計の針が一周するように、扇形に次の場面が現れる。時間の経過、場面の区切り。' },
  diagonal: { ja: '斜め帯ワイプ', desc: '斜めの境界線が画面を横切り、その後ろに次の場面が現れる。' },
  iris: { ja: 'アイリスイン', desc: '中心から丸い窓が開くように次の場面が広がる。古い映画やアニメの場面転換。' },
  doors: { ja: '観音開き', desc: '画面の中央から左右へ扉が開くように次の場面が現れる。披露、開幕。' },
  blinds: { ja: 'ブラインド転換', desc: '細い横縞が太っていって次の場面に置き換わる。スライドショーの定番。' },
  checker: { ja: '市松転換', desc: '市松模様のマス目から次の場面が覗き、埋まっていく。ポップで機械的なつなぎ。' },
  cube: { ja: 'キューブ', desc: '箱を回すように、画面が立体的に横へ回転して次の面が出てくる。' },
  spin: { ja: '回転イン', desc: '次の場面が回転しながら小さな点から広がって入ってくる。遊び心のあるつなぎ。' },
  cover: { ja: 'カバー', desc: '次の場面が横から滑り込んで、前の場面の上に被さる。' },
  uncover: { ja: 'アンカバー', desc: '前の場面が横へ滑り去り、その下から次の場面が現れる。' },
  'zoom-through': { ja: 'ズームスルー', desc: '前の場面の中へ突き抜けるように拡大し、その先に次の場面がある。' },
  flash: { ja: 'フラッシュ転換', desc: '一瞬白く飛んで次の場面になる。決め、サビ、写真を撮る瞬間。' },
  ink: { ja: 'インク', desc: '墨が広がるように色の円が画面を覆い、引くと次の場面。和、アート、情緒。' },
  pixelate: { ja: 'モザイク転換', desc: '画面が粗いモザイクになって崩れ、次の場面がモザイクから結像する。デジタル。' },
  whip: { ja: 'ホイップパン', desc: 'カメラを横に振ったように両方の場面が流れてぶれ、次の場面で止まる。' },
} satisfies Record<FilmTransitionName, { ja: string; desc: string }>

/** Transitions that swap at the boundary under a full-frame overlay (both scenes are never on screen together). */
const HARD = new Set<FilmTransitionName>(['cut', 'block', 'flash', 'ink'])

interface LayerFx {
  opacity: number
  tf: string[]
  blur: number
  filter: string[]
  mask: string
  origin: string
  z: number
}

/** The incoming scene at transition progress q (0 → 1). */
function incoming(name: FilmTransitionName, q: number, fx: LayerFx): void {
  const pct = (v: number): string => `${r4(v)}%`
  switch (name) {
    case 'fade':
      fx.opacity = q
      break
    case 'slide':
    case 'cover':
      fx.tf.push(`translateX(${pct((1 - q) * 100)})`)
      break
    case 'rise':
      fx.tf.push(`translateY(${pct((1 - q) * 100)})`)
      break
    case 'zoom':
      fx.tf.push(`scale(${r4(1.35 - 0.35 * q)})`)
      fx.opacity = q
      fx.blur = (1 - q) * 0.4
      break
    case 'blur':
      fx.opacity = q
      fx.blur = (1 - q) * 0.6
      fx.tf.push(`scale(${r4(1.04 - 0.04 * q)})`)
      break
    case 'clock':
      fx.mask = `conic-gradient(from 0deg at 50% 50%, #000 ${r4(q * 360)}deg, transparent ${r4(q * 360)}deg)`
      break
    case 'diagonal':
      fx.mask = `linear-gradient(115deg, #000 ${pct(q * 130 - 15)}, transparent ${pct(q * 130 - 5)})`
      break
    case 'iris':
      fx.mask = `radial-gradient(circle at 50% 50%, #000 ${pct(q * 75)}, transparent ${pct(q * 75 + 0.5)})`
      break
    case 'doors':
      fx.mask = `linear-gradient(90deg, transparent ${pct(50 - q * 50)}, #000 ${pct(50 - q * 50)}, #000 ${pct(50 + q * 50)}, transparent ${pct(50 + q * 50)})`
      break
    case 'blinds':
      fx.mask = `repeating-linear-gradient(180deg, #000 0 ${pct(q * 10)}, transparent ${pct(q * 10)} 10%)`
      break
    case 'checker': {
      // Two passes: the "black" squares open first, then the "white" ones.
      const a = clamp01(q * 2)
      const b = clamp01(q * 2 - 1)
      fx.mask = `conic-gradient(rgba(0,0,0,${r4(a)}) 25%, rgba(0,0,0,${r4(b)}) 0 50%, rgba(0,0,0,${r4(a)}) 0 75%, rgba(0,0,0,${r4(b)}) 0)`
      break
    }
    case 'cube':
      fx.tf.push(`perspective(80em) translateX(${pct((1 - q) * 50)}) rotateY(${r4((1 - q) * 90)}deg) translateX(${pct((1 - q) * 50)})`)
      fx.origin = '0% 50%'
      break
    case 'spin':
      fx.tf.push(`rotate(${r4((1 - q) * -180)}deg) scale(${r4(q)})`)
      break
    case 'zoom-through':
      fx.tf.push(`scale(${r4(0.6 + 0.4 * q)})`)
      fx.opacity = q
      break
    case 'pixelate':
      fx.opacity = q > 0.5 ? 1 : 0
      if (q < 1) fx.filter.push(`url(#yura-fx-mosaic-${Math.min(3, Math.floor((1 - q) * 4))})`)
      break
    case 'whip':
      fx.tf.push(`translateX(${pct((1 - q) * 100)})`)
      if (q < 1) fx.filter.push(`url(#yura-fx-smear-${Math.min(3, Math.floor(Math.sin(q * Math.PI) * 4))})`)
      break
    case 'uncover':
      fx.z = -1
      break
  }
}

/** The outgoing scene at transition progress q (0 → 1). */
function outgoing(name: FilmTransitionName, q: number, fx: LayerFx): void {
  const pct = (v: number): string => `${r4(v)}%`
  switch (name) {
    case 'fade':
    case 'blur':
      fx.opacity *= 1 - q
      if (name === 'blur') fx.blur += q * 0.6
      break
    case 'slide':
      fx.tf.push(`translateX(${pct(-q * 100)})`)
      break
    case 'rise':
      fx.tf.push(`translateY(${pct(-q * 100)})`)
      break
    case 'zoom':
      fx.tf.push(`scale(${r4(1 - 0.12 * q)})`)
      fx.opacity *= 1 - q
      fx.blur += q * 0.3
      break
    case 'cube':
      fx.tf.push(`perspective(80em) translateX(${pct(-q * 50)}) rotateY(${r4(-q * 90)}deg) translateX(${pct(-q * 50)})`)
      fx.origin = '100% 50%'
      break
    case 'uncover':
      fx.tf.push(`translateX(${pct(-q * 100)})`)
      fx.z = 1
      break
    case 'zoom-through':
      fx.tf.push(`scale(${r4(1 + 2 * q * q)})`)
      fx.opacity *= 1 - q
      break
    case 'pixelate':
      fx.opacity *= q < 0.5 ? 1 : 0
      if (q > 0) fx.filter.push(`url(#yura-fx-mosaic-${Math.min(3, Math.floor(q * 4))})`)
      break
    case 'whip':
      fx.tf.push(`translateX(${pct(-q * 100)})`)
      if (q > 0) fx.filter.push(`url(#yura-fx-smear-${Math.min(3, Math.floor(Math.sin(q * Math.PI) * 4))})`)
      break
    case 'spin':
      fx.opacity *= 1 - q * 0.5
      break
    // Mask-revealed transitions leave the outgoing scene untouched underneath.
  }
}

/**
 * Styles for a scene layer at time `t`: hidden outside its span, fully in
 * the middle, and blended with its neighbour by the transition around each
 * boundary (transforms, masks, 3D turns, filters). (Pure.)
 */
export function sceneEnvelope(plan: FilmPlan, index: number, t: number): { layer: Record<string, string>; visible: boolean } {
  const s = plan.scenes[index]
  const T = FILM_TRANSITION_SECONDS
  const next = plan.scenes[index + 1]
  const inName = s.transition
  const outName = next?.transition ?? 'cut'
  const hidden = { layer: { opacity: '0', transform: 'none', filter: 'none', visibility: 'hidden', WebkitMaskImage: 'none', maskImage: 'none', zIndex: '0', transformOrigin: '50% 50%' }, visible: false }
  if (!Number.isFinite(t)) return hidden
  // A soft transition spans [boundary - T/2, boundary + T/2] with both scenes on screen; hard ones swap at the boundary.
  const soft = (n: FilmTransitionName): boolean => !HARD.has(n)
  const inStart = soft(inName) ? s.start - T / 2 : s.start
  // The last scene holds past the end, so the final frame is never blank.
  const outEnd = !next ? Infinity : soft(outName) ? s.end + T / 2 : s.end
  if (t < inStart || t >= outEnd) return hidden
  const fx: LayerFx = { opacity: 1, tf: [], blur: 0, filter: [], mask: 'none', origin: '50% 50%', z: 0 }
  if (soft(inName) && t < s.start + T / 2) incoming(inName, inOutCubic(clamp01((t - inStart) / T)), fx)
  if (next && soft(outName) && t > s.end - T / 2) outgoing(outName, inOutCubic(clamp01((t - (s.end - T / 2)) / T)), fx)
  if (fx.blur > 1e-3) fx.filter.unshift(`blur(${r4(fx.blur)}em)`)
  return {
    layer: {
      opacity: r4(clamp01(fx.opacity)),
      transform: fx.tf.length ? fx.tf.join(' ') : 'none',
      filter: fx.filter.length ? fx.filter.join(' ') : 'none',
      visibility: 'visible',
      WebkitMaskImage: fx.mask,
      maskImage: fx.mask,
      zIndex: String(fx.z),
      transformOrigin: fx.origin,
    },
    visible: true,
  }
}

/** The full-frame overlay of hard transitions (accent wipe, white flash, ink blot) at time t. (Pure.) */
function transitionOverlay(plan: FilmPlan, t: number): Record<string, string> {
  const T = FILM_TRANSITION_SECONDS * 1.2
  for (const s of plan.scenes) {
    if (s.index === 0 || (s.transition !== 'block' && s.transition !== 'flash' && s.transition !== 'ink')) continue
    if (t < s.start - T / 2 || t >= s.start + T / 2) continue
    const q = clamp01((t - (s.start - T / 2)) / T)
    if (s.transition === 'block') {
      const a = q < 0.5 ? 1 - inCubic(q * 2) : 0
      const b = q < 0.5 ? 0 : outCubic((q - 0.5) * 2)
      return { opacity: '1', background: 'var(--f-accent)', clipPath: `inset(0 ${r4(a * 100)}% 0 ${r4(b * 100)}%)` }
    }
    if (s.transition === 'flash') return { opacity: r4(Math.pow(Math.sin(q * Math.PI), 1.5) * 0.92), background: '#ffffff', clipPath: 'none' }
    const r = Math.sin(q * Math.PI) * 80
    return { opacity: '1', background: 'var(--f-accent)', clipPath: `circle(${r4(r)}% at ${r4(40 + 20 * q)}% ${r4(55 - 10 * q)}%)` }
  }
  return { opacity: '0', clipPath: 'none' }
}

// ------------------------------------------------------------------ camera

/** A 2D camera move over a scene: u 0..1 through the scene, t seconds in, beat 0..1 phase. */
export const filmCameras = {
  none: { ja: '固定', desc: 'カメラを動かさない。言葉と動きだけで見せる。', at: () => ({}) },
  push: { ja: 'ゆっくり寄る', desc: '場面の始めから終わりまで、わずかに寄っていく。集中と余韻。', at: (u: number) => ({ tf: `scale(${r4(1 + 0.06 * u)})` }) },
  pull: { ja: '引き', desc: '寄りから始めて、ゆっくり引いていく。広がり、解放。', at: (u: number) => ({ tf: `scale(${r4(1.08 - 0.08 * u)})` }) },
  'pan-left': { ja: '左パン', desc: '画面がゆっくり左へ流れる。時間の流れ、旅。', at: (u: number) => ({ tf: `scale(1.08) translateX(${r4(3 - 6 * u)}%)` }) },
  'pan-right': { ja: '右パン', desc: '画面がゆっくり右へ流れる。視線を次へ送る。', at: (u: number) => ({ tf: `scale(1.08) translateX(${r4(-3 + 6 * u)}%)` }) },
  'tilt-up': { ja: 'ティルトアップ', desc: '下から上へ視線が上がっていく。希望、見上げる。', at: (u: number) => ({ tf: `scale(1.08) translateY(${r4(-3 + 6 * u)}%)` }) },
  'tilt-down': { ja: 'ティルトダウン', desc: '上から下へ視線が降りていく。着地、落ち着き。', at: (u: number) => ({ tf: `scale(1.08) translateY(${r4(3 - 6 * u)}%)` }) },
  dutch: { ja: 'ダッチ', desc: '画面がじわじわ傾いていく。不安、緊張、非日常。', at: (u: number) => ({ tf: `rotate(${r4(-5 * u)}deg) scale(${r4(1 + 0.08 * u)})` }) },
  handheld: { ja: '手持ち', desc: '手で構えたように細かく揺れ続ける。ドキュメンタリー、臨場感。', at: (_u: number, t: number) => ({ tf: `translate(${r4(Math.sin(t * 2.3) * 0.5 + Math.sin(t * 5.1) * 0.2)}%, ${r4(Math.cos(t * 1.9) * 0.4 + Math.sin(t * 4.3) * 0.2)}%) rotate(${r4(Math.sin(t * 1.3) * 0.4)}deg) scale(1.03)` }) },
  earthquake: { ja: '地震', desc: '激しく揺れ続ける。混乱、爆発、ホラー。', at: (_u: number, t: number) => ({ tf: `translate(${r4(Math.sin(t * 43) * 1.2)}%, ${r4(Math.cos(t * 37) * 1)}%) scale(1.05)` }) },
  pendulum: { ja: '振り子', desc: '振り子のように左右へゆっくり傾き続ける。揺れる気持ち。', at: (_u: number, t: number) => ({ tf: `rotate(${r4(Math.sin(t * 1.6) * 3)}deg) scale(1.06)` }) },
  'barrel-roll': { ja: 'バレルロール', desc: '場面の頭で画面がくるりと一回転して止まる。派手な切り替え、ゲーム。', at: (u: number) => ({ tf: `rotate(${r4((1 - outCubic(clamp01(u * 3))) * 360)}deg)` }) },
  'focus-in': { ja: 'ピント合わせ', desc: 'ぼけた状態から、ピントが合って場面が始まる。目覚め、回想の終わり。', at: (u: number) => ({ blur: (1 - outCubic(clamp01(u * 3))) * 0.5 }) },
  'rack-focus': { ja: 'ピン送り', desc: '場面の途中で一度ピントが外れ、また合う。視点の移動。', at: (u: number) => ({ blur: Math.max(0, Math.sin(clamp01((u - 0.4) * 3) * Math.PI)) * 0.4 }) },
  vertigo: { ja: 'めまい', desc: '画面が奥へ伸びながら縮むように歪む。動揺、覚醒。', at: (u: number) => ({ tf: `perspective(40em) translateZ(${r4(-6 * u)}em) scale(${r4(1 + 0.2 * u)})` }) },
  spiral: { ja: '渦ズーム', desc: '回りながら寄っていく。陶酔、吸い込まれる感覚。', at: (u: number) => ({ tf: `rotate(${r4(u * 8)}deg) scale(${r4(1 + 0.12 * u)})` }) },
  'snap-pan': { ja: 'スナップパン', desc: '場面の頭で横から勢いよく振り込まれて止まる。テンポのよい編集。', at: (u: number) => ({ tf: `translateX(${r4((1 - outExpo(clamp01(u * 4))) * 30)}%)` }) },
  jelly: { ja: 'ぷるん', desc: '場面の頭で画面がゼリーのように震えて落ち着く。かわいい、ポップ。', at: (u: number) => { const w = Math.sin(u * 40) * Math.exp(-u * 12); return { tf: `scale(${r4(1 + w * 0.05)}, ${r4(1 - w * 0.05)})` } } },
  'crash-zoom': { ja: 'クラッシュズーム', desc: '場面の頭で一気に寄って、そのまま張り付く。衝撃、発見。', at: (u: number) => ({ tf: `scale(${r4(1 + 0.25 * outExpo(clamp01(u * 5)))})` }) },
  bounce: { ja: 'バウンス', desc: '画面が上から落ちてきて弾んで止まる。楽しさ、登場。', at: (u: number) => ({ tf: `translateY(${r4(-(1 - outBounceK(clamp01(u * 2.5))) * 20)}%)` }) },
  'drift-diag': { ja: '斜めドリフト', desc: '画面がゆっくり斜めに流れる。浮遊感、映画的な移動。', at: (u: number) => ({ tf: `scale(1.08) translate(${r4(-3 + 6 * u)}%, ${r4(2 - 4 * u)}%)` }) },
  'step-zoom': { ja: '段階ズーム', desc: '拍ごとにカクッ、カクッと寄っていく。緊張の高まり、リズム。', at: (u: number) => ({ tf: `scale(${r4(1 + Math.floor(u * 4) * 0.05)})` }) },
  'beat-punch': { ja: '拍でズーム', desc: '拍の頭ごとに画面が寄って戻る。音楽と映像が一体になる。', at: (_u: number, _t: number, beat: number) => ({ tf: `scale(${r4(1 + 0.05 * Math.exp(-beat * 7))})` }) },
  float: { ja: '浮遊', desc: '水に浮かぶように、ほとんど分からない程度に漂う。', at: (_u: number, t: number) => ({ tf: `translate(${r4(Math.sin(t * 0.5) * 0.8)}%, ${r4(Math.sin(t * 0.37) * 0.6)}%) scale(1.03)` }) },
  orbit: { ja: '周回', desc: '画面が立体的にゆっくり回り込む。奥行き、空間の広がり。', at: (u: number) => ({ tf: `perspective(60em) rotateY(${r4(-8 + 16 * u)}deg) scale(1.04)` }) },
} satisfies Record<string, { ja: string; desc: string; at(u: number, t: number, beat: number): { tf?: string; blur?: number } }>
export type FilmCameraName = keyof typeof filmCameras

/** Bounce easing local to the camera table (lands at 1 with decaying hops). */
function outBounceK(t: number): number {
  const n = 7.5625
  const d = 2.75
  if (t < 1 / d) return n * t * t
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375
  return n * (t -= 2.625 / d) * t + 0.984375
}

// ------------------------------------------------------------------ frame

/** A scene's screen effects as timed entries (names validated, durations defaulted). (Pure.) */
export function sceneFx(s: PlannedScene): { name: FxName; at: number; dur: number }[] {
  const raw = (s.scene as SceneBase).fx
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
  return list
    .map((f) => (typeof f === 'string' ? { name: f } : f))
    .filter((f) => Object.prototype.hasOwnProperty.call(screenFx, f.name))
    .map((f) => ({ name: f.name, at: Math.max(0, fin(f.at, 0)), dur: Math.max(0.05, fin(f.dur, screenFx[f.name].dur)) }))
}

/** Index of the scene playing at `t` (the last one after the end). (Pure.) */
export function sceneAt(plan: FilmPlan, t: number): number {
  const tt = Number.isFinite(t) ? t : 0
  for (let i = plan.scenes.length - 1; i >= 0; i--) if (tt >= plan.scenes[i].start) return i
  return 0
}

/**
 * Every element's style at second `t`: backdrop, each visible scene (its
 * layer envelope and its own elements, keyed `s{index}:{key}`), transition
 * overlay, running head, timeline, captions. The whole picture as data. (Pure.)
 */
export function filmFrame(plan: FilmPlan, t: number): FilmStyles {
  const out: FilmStyles = {}
  const tt = Math.min(plan.duration, Math.max(0, Number.isFinite(t) ? t : 0))
  const look = plan.look
  const tall = plan.height > plan.width
  const cur = sceneAt(plan, tt)
  // Backdrop drifts slowly — alive even when nothing else moves.
  look.tints.forEach((_, i) => {
    const a = tt * 0.12 + i * 2.1
    put(out, `bg:${i}`, { transform: `translate(${r4(Math.sin(a) * 6)}%, ${r4(Math.cos(a * 0.8) * 5)}%) scale(${r4(1 + 0.06 * Math.sin(a * 0.6))})` })
  })
  put(out, 'bg:grid', { backgroundPosition: `0 ${r4((tt * 12) % 60)}px` })
  plan.scenes.forEach((s, i) => {
    const env = sceneEnvelope(plan, i, tt)
    const block = (s.scene as SceneBase).block
    put(out, `s${i}`, { ...env.layer, background: block === 'accent' ? 'var(--f-accent)' : block === 'dark' ? 'var(--f-dark)' : block === 'light' ? 'var(--f-light)' : 'transparent', color: block === 'accent' ? 'var(--f-on-accent)' : block === 'dark' ? 'var(--f-light)' : block === 'light' ? 'var(--f-dark)' : 'var(--f-fg)' })
    if (!env.visible) return
    const recipe = filmScenes[s.kind] as SceneRecipe
    const local: FilmStyles = {}
    const lt = tt - s.start
    withTreat(s, () => recipe.frame(local, s.scene as never, { plan, scene: s, look, tall, dur: s.end - s.start }, lt))
    for (const [k, v] of Object.entries(local)) put(out, `s${i}:${k}`, v)
    // Camera: a 2D move over the whole scene (backdrop and content together).
    const sb = s.scene as SceneBase
    const cam = filmCameras[sb.camera ?? look.camera] ?? filmCameras.none
    const c: { tf?: string; blur?: number } = cam.at(clamp01(lt / (s.end - s.start)), lt, frac((lt * plan.bpm) / 60))
    put(out, `s${i}:cam`, { transform: c.tf ?? 'none', filter: c.blur && c.blur > 1e-3 ? `blur(${r4(c.blur)}em)` : 'none' })
    if (sb.bg) for (const [k, v] of Object.entries(backdropFrame(sb.bg, tt, s.seed, `s${i}:bd:`))) put(out, k, v)
  })
  put(out, 'wipe', transitionOverlay(plan, tt))
  // Screen effects: every scene's timed effects that are running now, combined.
  const active = []
  for (const s of plan.scenes) {
    for (const f of sceneFx(s)) {
      const p = (tt - (s.start + f.at)) / f.dur
      if (p >= 0 && p <= 1) active.push(fxFrame(f.name, p, s.seed))
    }
  }
  const fx = combineFx(active)
  put(out, 'pic', fx.root)
  put(out, 'fxo', { background: 'none', backdropFilter: 'none', WebkitBackdropFilter: 'none', WebkitMaskImage: 'none', maskImage: 'none', WebkitMask: 'none', mask: 'none', mixBlendMode: 'normal', filter: 'none', backgroundImage: 'none', ...fx.overlay })
  // Captions follow the playing scene, fading at its edges.
  const sc = plan.scenes[cur]
  const cap = (sc.scene as SceneBase).caption
  const cq = cap ? Math.min(prog(tt, sc.start + 0.3, 0.3), 1 - prog(tt, sc.end - 0.3, 0.25)) : 0
  put(out, 'cap', { opacity: r4(cq), $text: cap ? plainText(cap) : '' })
  if (look.timeline) {
    const u = plan.duration > 0 ? tt / plan.duration : 0
    put(out, 'tl:fill', { transform: `scaleX(${r4(u)})` })
    plan.scenes.forEach((s, i) => put(out, `tl:${i}`, { color: i === cur ? 'var(--f-accent)' : 'var(--f-sub)' }))
  }
  put(out, 'rh:n', { $text: `${String(cur + 1).padStart(2, '0')} / ${String(plan.scenes.length).padStart(2, '0')}` })
  return out
}

// ------------------------------------------------------------------ markup

/** CSS custom properties for a look. (Pure.) */
export function lookVars(look: FilmLook): Record<string, string> {
  return {
    '--f-bg': look.bg,
    '--f-fg': look.fg,
    '--f-sub': look.sub,
    '--f-accent': look.accent,
    '--f-on-accent': look.onAccent,
    '--f-surface': look.surface,
    '--f-dark': look.dark,
    '--f-light': look.light,
    '--f-display': look.display,
    '--f-serif': look.serif,
    '--f-mono': look.mono,
    '--f-weight': String(look.displayWeight),
    '--f-radius': look.radius,
    '--f-glow': look.glow > 0 ? `0 0 ${look.glow}em ${look.accent}` : 'none',
    '--f-mark': `${look.accent}40`,
    // Shared names so treatments, backdrops and stage decor pick up the look's palette.
    '--yura-bg': look.bg,
    '--yura-fg': look.fg,
    '--yura-accent': look.accent,
    '--yura-accent2': look.sub,
    '--yura-dim': look.dark,
  }
}

/** Paper-grain tile. Percent-encoded and quoted with &quot; so it can sit inside a style="…" attribute. */
const NOISE = `url(&quot;data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'><filter id='p'><feTurbulence type='fractalNoise' baseFrequency='0.04' numOctaves='4' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(#p)' opacity='0.35'/></svg>",
)}&quot;)`

function backdropHTML(plan: FilmPlan): string {
  const look = plan.look
  const abs = 'position:absolute;inset:0;pointer-events:none'
  switch (look.backdrop) {
    case 'mesh':
      return look.tints.map((c, i) => `<div data-f="bg:${i}" style="position:absolute;width:70%;height:90%;left:${[-15, 45, 10][i % 3]}%;top:${[-20, 20, 45][i % 3]}%;background:radial-gradient(closest-side, ${c}, transparent);filter:blur(40px);opacity:0.9"></div>`).join('')
    case 'grid':
      return `<div data-f="bg:grid" style="${abs};background-image:linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px),linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px);background-size:60px 60px"></div><div data-f="bg:0" style="position:absolute;width:60%;height:60%;left:20%;top:20%;background:radial-gradient(closest-side, ${look.tints[0]}22, transparent)"></div><div style="${abs};background:radial-gradient(ellipse at 50% 45%, transparent 40%, rgba(0,0,0,0.55))"></div>`
    case 'paper':
      return `<div style="${abs};background-image:${NOISE};mix-blend-mode:multiply;opacity:0.5"></div>`
    case 'spheres':
      return look.tints
        .map((c, i) => {
          const size = [22, 12, 30][i % 3]
          return `<div data-f="bg:${i}" style="position:absolute;width:${size}vmin;height:${size}vmin;left:${[8, 72, 60][i % 3]}%;top:${[12, 58, -10][i % 3]}%;border-radius:50%;background:radial-gradient(circle at 32% 30%, #ffffffcc, ${c} 35%, ${look.bg} 95%);box-shadow:0 0 6vmin ${c}55"></div>`
        })
        .join('') + `<div style="${abs};background:radial-gradient(ellipse at 50% 120%, ${look.tints[0]}55, transparent 60%)"></div>`
    case 'halftone':
      return `<div data-f="bg:grid" style="${abs};background-image:radial-gradient(rgba(255,255,255,0.12) 28%, transparent 30%);background-size:14px 14px"></div><div style="${abs};background-image:${NOISE};opacity:0.6"></div>`
    case 'stars': {
      let stars = ''
      for (let i = 0; i < 70; i++) stars += `<i style="position:absolute;left:${r4(hash01(i, 1, 81) * 100)}%;top:${r4(hash01(i, 2, 81) * 100)}%;width:${hash01(i, 3, 81) < 0.8 ? 2 : 3}px;height:${hash01(i, 3, 81) < 0.8 ? 2 : 3}px;border-radius:50%;background:${look.tints[i % look.tints.length]};opacity:${r4(0.3 + hash01(i, 4, 81) * 0.6)}"></i>`
      return `<div style="${abs}">${stars}</div><div style="${abs};background:radial-gradient(ellipse at 50% 50%, ${look.tints[0]}18, transparent 65%)"></div>`
    }
    default:
      return ''
  }
}

/**
 * The film's static markup at its logical resolution: backdrop, one layer per
 * scene, the block wipe, frame marks, running head, timeline and caption.
 * Elements that move carry `data-f` keys matching {@link filmFrame}. (Pure.)
 */
export function filmMarkup(plan: FilmPlan): string {
  const look = plan.look
  const tall = plan.height > plan.width
  const vars = Object.entries(lookVars(look))
    .map(([k, v]) => `${k}:${v}`)
    .join(';')
  const unit = Math.round(filmUnit(plan))
  const scenes = plan.scenes
    .map((s) => {
      const recipe = filmScenes[s.kind] as SceneRecipe
      const inner = withTreat(s, () => recipe.markup(s.scene as never, { plan, scene: s, look, tall, dur: s.end - s.start }))
      // Scene keys are namespaced so every scene can reuse short keys like "h".
      const scoped = inner.replace(/data-f="([^"]+)"/g, `data-f="s${s.index}:$1"`)
      const bgName = (s.scene as SceneBase).bg
      // Scene backdrops take the look's colours; their animated layers join the frame keys.
      const bg = bgName ? backdropMarkup(bgName, s.seed, `s${s.index}:bd:`).replace(/data-bd="/g, 'data-f="') : ''
      return `<section data-f="s${s.index}" aria-hidden="true" style="position:absolute;inset:0;visibility:hidden;will-change:transform,opacity;overflow:hidden"><div data-f="s${s.index}:cam" style="position:absolute;inset:0">${bg}<div data-f="s${s.index}:root" style="position:absolute;inset:0">${scoped}</div></div></section>`
    })
    .join('')
  const edge = 'position:absolute;width:2.2%;height:2.2%;border-color:var(--f-fg);border-style:solid;opacity:0.6'
  const corners = look.corners
    ? `<div style="${edge};left:3%;top:3%;border-width:2px 0 0 2px"></div><div style="${edge};right:3%;top:3%;border-width:2px 2px 0 0"></div><div style="${edge};left:3%;bottom:3%;border-width:0 0 2px 2px"></div><div style="${edge};right:3%;bottom:3%;border-width:0 2px 2px 0"></div>`
    : ''
  const head = look.runningHead
    ? `<div style="position:absolute;left:4.5%;top:4.5%;font-family:var(--f-mono);font-size:0.3em;letter-spacing:0.2em;text-transform:uppercase;color:var(--f-fg);opacity:0.75">${escapeHtml(plan.brand.name)}</div><div data-f="rh:n" style="position:absolute;right:4.5%;top:4.5%;font-family:var(--f-mono);font-size:0.3em;letter-spacing:0.2em;color:var(--f-sub)"></div>`
    : ''
  const timeline = look.timeline
    ? `<div style="position:absolute;left:4.5%;right:4.5%;bottom:5%;font-family:var(--f-mono);font-size:0.26em;letter-spacing:0.14em;text-transform:uppercase"><div style="height:2px;background:rgba(255,255,255,0.12);position:relative"><div data-f="tl:fill" style="position:absolute;inset:0;background:var(--f-accent);transform-origin:0 50%;transform:scaleX(0)"></div></div><div style="display:flex;justify-content:space-between;margin-top:0.9em">${plan.scenes.map((s) => `<span data-f="tl:${s.index}">${escapeHtml(s.label)}</span>`).join('')}</div></div>`
    : ''
  const caption = `<div style="position:absolute;left:0;right:0;bottom:${look.timeline ? 11 : 7}%;display:flex;justify-content:center;pointer-events:none"><div data-f="cap" style="max-width:80%;text-align:center;font-size:0.46em;line-height:1.4;padding:0.45em 1em;border-radius:0.5em;background:${look.backdrop === 'mesh' ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.55)'};color:${look.backdrop === 'mesh' ? 'var(--f-fg)' : '#ffffff'};opacity:0"></div></div>`
  return (
    `<div data-yura-film style="position:absolute;left:0;top:0;width:${plan.width}px;height:${plan.height}px;overflow:hidden;background:var(--f-bg);color:var(--f-fg);font-family:var(--f-display);font-size:${unit}px;transform-origin:0 0;${vars}">` +
    FX_SVG_DEFS +
    `<div data-f="pic" style="position:absolute;inset:0">` +
    `<div style="position:absolute;inset:0;overflow:hidden">${backdropHTML(plan)}</div>` +
    scenes +
    `<div data-f="wipe" style="position:absolute;inset:0;background:var(--f-accent);opacity:0;pointer-events:none"></div>` +
    `</div>` +
    `<div data-f="fxo" style="position:absolute;inset:0;opacity:0;pointer-events:none"></div>` +
    corners +
    head +
    timeline +
    caption +
    `</div>`
  )
}

// ------------------------------------------------------------------ DOM shell

/** Options for {@link yuraFilm}. */
export interface FilmOptions {
  /** Start playing at once (preview). Default true. */
  autoplay?: boolean
  /** Loop the preview. Default true. */
  loop?: boolean
  /** External clock in seconds (e.g. an <audio> element's currentTime). */
  clock?: () => number
  /** Injectable document (tests). */
  document?: Document
}

/** Handle returned by {@link yuraFilm}. */
export interface FilmRun {
  readonly element: HTMLElement
  readonly plan: FilmPlan
  /** Draw second `t` now (frame-exact; what an export calls). */
  render(t: number): void
  play(): void
  pause(): void
  /** Refit to the host box (automatic on resize). */
  fit(): void
  stop(): void
}

/**
 * Mounts a film into `target` and plays it. The picture is laid out at the
 * plan's logical resolution and scaled to fit the host (letterboxed), so a
 * 1920×1080 film looks the same in a phone and on a 4K screen.
 */
export function yuraFilm(target: Element | string, script: FilmScript, opts: FilmOptions = {}): FilmRun {
  const doc = opts.document ?? (globalThis as { document?: Document }).document
  if (!doc) throw new YuraError(CODES.TARGET_NOT_FOUND, 'yuraFilm needs a DOM.', 'Call it in the browser, or pass { document } in tests.')
  const host = typeof target === 'string' ? doc.querySelector<HTMLElement>(target) : (target as HTMLElement)
  if (!host) throw new YuraError(CODES.TARGET_NOT_FOUND, `yuraFilm target "${String(target)}" was not found.`, 'Pass an element or a selector that matches one.')
  const plan = planFilm(script)
  const wrap = doc.createElement('div')
  wrap.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;background:#000'
  wrap.innerHTML = filmMarkup(plan)
  host.appendChild(wrap)
  const root = wrap.firstElementChild as HTMLElement
  root.setAttribute('role', 'img')
  root.setAttribute('aria-label', plan.scenes.map((s) => recapTexts({ ...plan, scenes: [s] }, 1).join(' ')).join(' / '))
  const els = new Map<string, HTMLElement>()
  root.querySelectorAll<HTMLElement>('[data-f]').forEach((el) => els.set(el.getAttribute('data-f') as string, el))
  const last = new Map<string, string>()

  const render = (t: number): void => {
    const frame = filmFrame(plan, t)
    for (const [key, style] of Object.entries(frame)) {
      const el = els.get(key)
      if (!el) continue
      for (const [prop, value] of Object.entries(style)) {
        const id = `${key}|${prop}`
        if (last.get(id) === value) continue
        last.set(id, value)
        if (prop === '$text') el.textContent = value
        else (el.style as unknown as Record<string, string>)[prop] = value
      }
    }
  }

  const fit = (): void => {
    const w = host.clientWidth || plan.width
    const h = host.clientHeight || plan.height
    const k = Math.min(w / plan.width, h / plan.height)
    root.style.transform = `translate(${(w - plan.width * k) / 2}px, ${(h - plan.height * k) / 2}px) scale(${k})`
  }

  const loop = opts.loop ?? true
  let playing = false
  let raf = 0
  let origin = 0
  let pausedAt = 0
  const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000
  const tick = (): void => {
    if (!playing) return
    let t = opts.clock ? opts.clock() : now() - origin
    if (loop && plan.duration > 0) t = ((t % plan.duration) + plan.duration) % plan.duration
    render(t)
    raf = requestAnimationFrame(tick)
  }
  let ro: ResizeObserver | null = null
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(fit)
    ro.observe(host)
  }
  fit()
  render(0)
  const run: FilmRun = {
    element: root,
    plan,
    render,
    play() {
      if (playing) return
      playing = true
      origin = now() - pausedAt
      if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(tick)
    },
    pause() {
      playing = false
      pausedAt = now() - origin
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
    },
    fit,
    stop() {
      run.pause()
      ro?.disconnect()
      wrap.remove()
    },
  }
  if (opts.autoplay ?? true) run.play()
  return run
}
