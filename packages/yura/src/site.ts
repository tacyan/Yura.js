import { YuraError, CODES } from '@yura/core'
import { motions, type EnterName } from './motions'
import { stageThemes, type StageThemeName } from './stage-themes'
import { schemeVars, defineLyricStage } from './stage'
import type { ThreeNamespace } from './stage-world'
import {
  splitText,
  textRevealStyles,
  blockReveals,
  blockRevealAt,
  viewProgress,
  parallaxShift,
  marqueeStep,
  countAt,
  magneticOffset,
  follow,
  loaderAt,
  type BlockRevealName,
} from './site-motion'

/**
 * yuraSite — turns a plain HTML page into a studio-grade motion site.
 *
 * One call wires every `data-yura-*` attribute on the page to one shared
 * frame loop:
 *
 *   data-yura-text="rise"        split-text reveal (any kinetic entrance)
 *   data-yura-reveal="curtain"   block reveal (fade-up, mask, wipe, curtain, zoom, iris, blinds)
 *   data-yura-stagger="0.08"     reveal a container's children one after another
 *   data-yura-marquee="0.06"     endless ticker that speeds up and skews with scrolling
 *   data-yura-parallax="0.2"     depth drift while scrolling
 *   data-yura-counter="1200"     count-up when it comes into view
 *   data-yura-magnetic           element leans toward the pointer
 *   data-yura-scheme="1"         the whole page recolours to theme scheme #1 while this section is centred
 *   data-yura-scrub              a tall section that pins a <yura-lyric-stage> and plays it with the scroll
 *   data-yura-cursor="View"      label the follower cursor shows over this element
 *
 * plus an opening loader, a follower cursor, a scroll progress bar, and a
 * base stylesheet (theme colours and type as CSS variables, button / link /
 * label utilities). Everything is measured at runtime; nothing assumes a
 * screen size. With reduced motion, content simply appears.
 */

/** Window surface yuraSite uses — a real `window` satisfies it; tests inject happy-dom. */
export type SiteWindow = Window & typeof globalThis

export interface SiteOptions {
  /** Colour / type direction shared with the lyric stages. Default 'noir'. */
  theme?: StageThemeName
  /** Which of the theme's schemes the page starts in. Default 0. */
  scheme?: number
  /** Your THREE namespace: registers <yura-lyric-stage> with a 3D world. */
  three?: ThreeNamespace
  /** Inject the base stylesheet (colours, type, utilities). Default true. */
  base?: boolean
  /** Follower cursor on fine pointers. Default true. */
  cursor?: boolean
  /** Thin scroll progress bar at the top. Default true. */
  progress?: boolean
  /** Opening loader: counter + title, then a double curtain lifts. Default off. */
  opening?: boolean | { title?: string; seconds?: number; once?: boolean }
  /** Force reduced motion on/off (default: the OS setting). */
  reducedMotion?: boolean
  /** Injection points for tests / non-browser hosts. */
  window?: SiteWindow
  scheduler?: { request(cb: () => void): number; cancel(h: number): void }
  now?: () => number
}

export interface SiteRun {
  /** Scan the page again (after adding content). */
  refresh(): void
  /** Switch theme at runtime. */
  setTheme(name: StageThemeName, scheme?: number): void
  /** Remove every listener, overlay and injected style; content is left fully visible. */
  destroy(): void
}

// ------------------------------------------------------------------ constants

const DEFAULT_THEME: StageThemeName = 'noir'
/** Reveals start once an element is this far into the viewport (share of its height). */
const TRIGGER_SHARE = 0.12
const TEXT_SECONDS = 1.2
const BLOCK_SECONDS = 1.3
const COUNTER_SECONDS = 2
const DEFAULT_TEXT: EnterName = 'rise'
const DEFAULT_BLOCK: BlockRevealName = 'fade-up'
const DEFAULT_MARQUEE_SPEED = 0.06
const MAGNET_RADIUS_SHARE = 1.4
const CURSOR_RATE = 18
const RING_RATE = 9
const VELOCITY_RATE = 6
const MAX_DT = 0.1
const LOADER_SECONDS = 1.6
const LOADER_ONCE_KEY = 'yura-site-opened'
const STYLE_ID = 'yura-site-style'
const COLOR_ROLES = ['bg', 'fg', 'sub', 'accent', 'accent2', 'dim'] as const
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
const FINE_POINTER_QUERY = '(hover: hover) and (pointer: fine)'
const INTERACTIVE = 'a, button, input, select, textarea, [role="button"], [data-yura-cursor]'

/** Base stylesheet: theme tokens → page, plus a small kit of studio-site utilities. */
function baseCss(): string {
  return `
:root{color-scheme:light dark}
html.yura-js [data-yura-text]:not([data-yura-armed]),html.yura-js [data-yura-reveal]:not([data-yura-stagger]):not([data-yura-armed]),html.yura-js [data-yura-stagger]>*:not([data-yura-armed]){opacity:0}
html.yura-site{background:var(--yura-bg);color:var(--yura-fg);transition:--yura-bg .9s ease,--yura-fg .9s ease,--yura-sub .9s ease,--yura-accent .9s ease,--yura-accent2 .9s ease,--yura-dim .9s ease}
html.yura-site body{background:var(--yura-bg);color:var(--yura-fg);font-family:var(--yura-display);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
html.yura-site ::selection{background:var(--yura-accent);color:var(--yura-bg)}
.yura-c{display:inline-block;will-change:transform,opacity}
.yura-w{display:inline-block;white-space:nowrap}
.yura-display{font-size:clamp(2.6rem,9vw,9rem);line-height:.95;letter-spacing:-.02em;font-weight:900}
.yura-title{font-size:clamp(1.8rem,4.6vw,4.2rem);line-height:1.12;letter-spacing:-.01em;font-weight:800}
.yura-eyebrow{font-family:var(--yura-mono);font-size:.78rem;letter-spacing:.24em;text-transform:uppercase;color:var(--yura-sub)}
.yura-lead{font-size:clamp(1rem,1.4vw,1.2rem);line-height:1.9;color:var(--yura-sub)}
.yura-serif{font-family:var(--yura-serif)}
.yura-btn{position:relative;display:inline-flex;align-items:center;gap:.6em;padding:1.05em 1.9em;border-radius:999px;border:1px solid currentColor;color:var(--yura-fg);background:transparent;font:inherit;font-weight:700;letter-spacing:.04em;text-decoration:none;cursor:pointer;overflow:hidden;isolation:isolate;transition:color .45s cubic-bezier(.7,0,.2,1)}
.yura-btn::before{content:"";position:absolute;inset:0;z-index:-1;background:var(--yura-accent);border-radius:inherit;transform:translateY(101%);transition:transform .45s cubic-bezier(.7,0,.2,1)}
.yura-btn:hover,.yura-btn:focus-visible{color:var(--yura-bg);border-color:var(--yura-accent)}
.yura-btn:hover::before,.yura-btn:focus-visible::before{transform:translateY(0)}
.yura-link{color:inherit;text-decoration:none;background:linear-gradient(currentColor,currentColor) 0 100%/0 1px no-repeat;transition:background-size .5s cubic-bezier(.7,0,.2,1)}
.yura-link:hover,.yura-link:focus-visible{background-size:100% 1px}
.yura-rule{border:0;border-top:1px solid var(--yura-sub);opacity:.4}
[data-yura-marquee]{overflow:hidden;white-space:nowrap}
[data-yura-marquee]>.yura-track{display:inline-flex;will-change:transform}
[data-yura-scrub]{position:relative;height:var(--yura-scrub-length,400vh)}
[data-yura-scrub]>yura-lyric-stage{position:sticky;top:0;height:100vh;height:100svh;aspect-ratio:auto}
.yura-cursor{position:fixed;left:0;top:0;z-index:2147483646;pointer-events:none;mix-blend-mode:difference}
.yura-cursor-dot{width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:#fff}
.yura-cursor-ring{width:40px;height:40px;margin:-20px 0 0 -20px;border-radius:50%;border:1px solid #fff;display:grid;place-items:center;font:600 11px/1 var(--yura-mono,monospace);letter-spacing:.08em;color:#fff;transition:width .35s cubic-bezier(.7,0,.2,1),height .35s cubic-bezier(.7,0,.2,1),margin .35s cubic-bezier(.7,0,.2,1),background-color .35s}
.yura-cursor-ring.is-hover{width:84px;height:84px;margin:-42px 0 0 -42px;background:#fff;color:#000}
.yura-progress{position:fixed;left:0;top:0;right:0;height:2px;z-index:2147483645;background:var(--yura-accent);transform-origin:0 50%;transform:scaleX(0);pointer-events:none}
.yura-loader{position:fixed;inset:0;z-index:2147483647;pointer-events:none}
.yura-loader>div{position:absolute;inset:0}
.yura-loader-accent{background:var(--yura-accent)}
.yura-loader-main{background:var(--yura-bg);color:var(--yura-fg);display:flex;flex-direction:column;justify-content:flex-end;padding:5vmin}
.yura-loader-title{font-family:var(--yura-display);font-weight:900;font-size:clamp(2rem,7vw,6rem);line-height:1}
.yura-loader-count{font-family:var(--yura-mono);font-size:clamp(3rem,14vw,12rem);line-height:.9;align-self:flex-end;font-variant-numeric:tabular-nums}
@media (prefers-reduced-motion: reduce){.yura-btn,.yura-btn::before,.yura-link{transition:none}}
`
}

/** Registers the colour tokens as animatable properties so scheme changes cross-fade. */
function registerColorProperties(win: SiteWindow, initial: Record<string, string>): void {
  const reg = (win as unknown as { CSS?: { registerProperty?(def: object): void } }).CSS?.registerProperty
  if (typeof reg !== 'function') return
  for (const role of COLOR_ROLES) {
    try {
      reg.call((win as unknown as { CSS: object }).CSS, { name: `--yura-${role}`, syntax: '<color>', inherits: true, initialValue: initial[`--yura-${role}`] ?? '#000000' })
    } catch {
      // Already registered (a second yuraSite on the page) — fine.
    }
  }
}

// ------------------------------------------------------------------ items

interface Reveal {
  el: HTMLElement
  delay: number
  duration: number
  started: number | null
  apply(p: number): void
  finish(): void
}

interface Marquee {
  el: HTMLElement
  track: HTMLElement
  copies: number
  speed: number
  offset: number
}

interface Counter {
  el: HTMLElement
  target: number
  decimals: number
  prefix: string
  suffix: string
  started: number | null
}

interface Magnet {
  el: HTMLElement
  strength: number
  x: number
  y: number
}

const num = (v: string | null | undefined, fallback: number): number => {
  const n = Number.parseFloat(v ?? '')
  return Number.isFinite(n) ? n : fallback
}

/**
 * Wraps every character of an element's text in `.yura-c` spans (words kept
 * together in `.yura-w`), preserving inline markup and line breaks. Links,
 * buttons and other non-text elements animate as one unit. Returns the
 * character spans in reading order.
 */
export function splitElement(el: HTMLElement): HTMLElement[] {
  const doc = el.ownerDocument
  const chars: HTMLElement[] = []
  const SPLIT_INTO = new Set(['SPAN', 'EM', 'STRONG', 'B', 'I', 'SMALL', 'MARK', 'SUB', 'SUP', 'U', 'S'])
  const walk = (parent: Node): void => {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === 3) {
        const frag = doc.createDocumentFragment()
        for (const tok of splitText(node.textContent ?? '')) {
          if (tok.kind === 'space') {
            frag.appendChild(doc.createTextNode(tok.chars.join('')))
            continue
          }
          const w = doc.createElement('span')
          w.className = 'yura-w'
          w.setAttribute('aria-hidden', 'true')
          for (const ch of tok.chars) {
            const c = doc.createElement('span')
            c.className = 'yura-c'
            c.textContent = ch
            w.appendChild(c)
            chars.push(c)
          }
          frag.appendChild(w)
        }
        parent.replaceChild(frag, node)
      } else if (node.nodeType === 1) {
        const child = node as HTMLElement
        if (child.tagName === 'BR') continue
        if (SPLIT_INTO.has(child.tagName) && !child.classList.contains('yura-w')) walk(child)
        else {
          // Interactive or replaced content moves as a single glyph and stays accessible.
          const c = doc.createElement('span')
          c.className = 'yura-c'
          parent.replaceChild(c, child)
          c.appendChild(child)
          chars.push(c)
        }
      }
    }
  }
  const label = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  const hasInteractive = !!el.querySelector('a, button, input, select, textarea')
  walk(el)
  if (label && !hasInteractive && !el.hasAttribute('aria-label')) el.setAttribute('aria-label', label)
  if (hasInteractive) for (const w of Array.from(el.querySelectorAll('.yura-w'))) w.removeAttribute('aria-hidden')
  return chars
}

// ------------------------------------------------------------------ yuraSite

/**
 * Enhances the current page. Safe to call before or after content loads;
 * call `refresh()` after inserting new `data-yura-*` elements.
 */
export function yuraSite(opts: SiteOptions = {}): SiteRun {
  const win = opts.window ?? (typeof window !== 'undefined' ? (window as SiteWindow) : undefined)
  if (!win) throw new YuraError(CODES.TARGET_NOT_FOUND, 'yuraSite() needs a browser window.', `yuraSite({ window })  // or call it from a page script`)
  const doc = win.document
  const html = doc.documentElement
  const matches = (q: string): boolean => {
    try {
      return typeof win.matchMedia === 'function' && win.matchMedia(q).matches
    } catch {
      return false
    }
  }
  const reduced = opts.reducedMotion ?? matches(REDUCED_MOTION_QUERY)
  const scheduler = opts.scheduler ?? {
    request: (cb: () => void) => win.requestAnimationFrame(cb),
    cancel: (h: number) => win.cancelAnimationFrame(h),
  }
  const now = opts.now ?? (() => win.performance.now() / 1000)

  if (opts.theme !== undefined && !Object.prototype.hasOwnProperty.call(stageThemes, opts.theme)) {
    throw new YuraError(CODES.UNKNOWN_MOTION, `Unknown site theme "${opts.theme}". Available: ${Object.keys(stageThemes).join(', ')}.`, `yuraSite({ theme: 'noir' })`)
  }
  let themeName: StageThemeName = opts.theme ?? DEFAULT_THEME
  let currentScheme = -1

  // Styles + tokens.
  html.classList.add('yura-js', 'yura-site')
  let style: HTMLStyleElement | null = null
  if (opts.base !== false && !doc.getElementById(STYLE_ID)) {
    style = doc.createElement('style')
    style.id = STYLE_ID
    style.textContent = baseCss()
    doc.head.appendChild(style)
  }
  const applyScheme = (index: number): void => {
    const theme = stageThemes[themeName]
    const k = ((Math.floor(index) % theme.schemes.length) + theme.schemes.length) % theme.schemes.length
    if (k === currentScheme) return
    currentScheme = k
    for (const [key, v] of Object.entries(schemeVars(theme.schemes[k], theme))) html.style.setProperty(key, v)
  }
  const baseScheme = Number.isFinite(opts.scheme) ? (opts.scheme as number) : 0
  registerColorProperties(win, schemeVars(stageThemes[themeName].schemes[0], stageThemes[themeName]))
  applyScheme(baseScheme)

  if (opts.three) defineLyricStage({ three: opts.three })

  // ---------------------------------------------------------------- state
  const reveals: Reveal[] = []
  const pending: Reveal[] = []
  const marquees: Marquee[] = []
  const parallax: { el: HTMLElement; factor: number }[] = []
  const counters: Counter[] = []
  const magnets: Magnet[] = []
  const schemeSections: { el: HTMLElement; scheme: number }[] = []
  const scrubs: { el: HTMLElement }[] = []
  const seen = new WeakSet<Element>()
  const cleanups: (() => void)[] = []

  const vh = (): number => win.innerHeight || html.clientHeight || 1

  const armText = (el: HTMLElement, delay: number): void => {
    const name = (el.getAttribute('data-yura-text') || DEFAULT_TEXT) as EnterName
    const effect: EnterName = Object.prototype.hasOwnProperty.call(motions.enter, name) ? name : DEFAULT_TEXT
    const chars = splitElement(el)
    const text = chars.map((c) => (c.childElementCount ? '' : (c.textContent ?? '')))
    const seed = Math.floor(num(el.getAttribute('data-yura-seed'), chars.length + 1))
    const origin = (motions.enter[effect] as { origin?: string }).origin
    if (origin) for (const c of chars) c.style.transformOrigin = origin
    const apply = (p: number): void => {
      const styles = textRevealStyles(effect, text, p, seed)
      styles.forEach((s, i) => {
        const c = chars[i]
        if (!c.childElementCount && c.textContent !== s.char) c.textContent = s.char
        c.style.transform = s.transform
        c.style.opacity = s.opacity
        c.style.filter = s.filter
        c.style.clipPath = s.clipPath
        c.style.textShadow = s.textShadow === 'none' ? '' : s.textShadow
      })
    }
    const r: Reveal = {
      el,
      delay: num(el.getAttribute('data-yura-delay'), delay),
      duration: Math.max(0.05, num(el.getAttribute('data-yura-duration'), TEXT_SECONDS + Math.min(chars.length, 40) * 0.012)),
      started: null,
      apply,
      finish() {
        chars.forEach((c, i) => {
          if (!c.childElementCount) c.textContent = text[i]
          c.style.cssText = origin ? `transform-origin:${origin}` : ''
        })
        el.setAttribute('data-yura-done', '')
      },
    }
    track(r)
  }

  const armBlock = (el: HTMLElement, effectAttr: string | null, delay: number): void => {
    const name = (effectAttr || DEFAULT_BLOCK) as BlockRevealName
    const effect: BlockRevealName = Object.prototype.hasOwnProperty.call(blockReveals, name) ? name : DEFAULT_BLOCK
    let curtain: HTMLElement | null = null
    if (effect === 'curtain') {
      if (win.getComputedStyle(el).position === 'static') el.style.position = 'relative'
      curtain = doc.createElement('span')
      curtain.setAttribute('aria-hidden', 'true')
      curtain.style.cssText = 'position:absolute;inset:0;background:var(--yura-accent);transform-origin:0 50%;transform:scaleX(0);pointer-events:none;z-index:2'
      el.appendChild(curtain)
    }
    const apply = (p: number): void => {
      const f = blockRevealAt(effect, p)
      // The curtain lives inside the element, so only the element's children fade.
      if (curtain) {
        for (const child of Array.from(el.children)) if (child !== curtain) (child as HTMLElement).style.opacity = f.opacity
        curtain.style.transform = f.curtain.transform
        curtain.style.opacity = f.curtain.opacity
      } else {
        el.style.opacity = f.opacity
        el.style.transform = f.transform
        el.style.clipPath = f.clipPath
      }
    }
    track({
      el,
      delay: num(el.getAttribute('data-yura-delay'), delay),
      duration: Math.max(0.05, num(el.getAttribute('data-yura-duration'), BLOCK_SECONDS)),
      started: null,
      apply,
      finish() {
        if (curtain) {
          curtain.remove()
          for (const child of Array.from(el.children)) (child as HTMLElement).style.opacity = ''
        } else {
          el.style.opacity = ''
          el.style.transform = ''
          el.style.clipPath = ''
        }
        el.setAttribute('data-yura-done', '')
      },
    })
  }

  const track = (r: Reveal): void => {
    if (reduced) {
      r.finish()
    } else {
      r.apply(0)
      reveals.push(r)
      pending.push(r)
    }
    r.el.setAttribute('data-yura-armed', '')
  }

  const armMarquee = (el: HTMLElement): void => {
    const unit = doc.createElement('div')
    unit.style.cssText = 'display:inline-flex;flex:none'
    while (el.firstChild) unit.appendChild(el.firstChild)
    const trackEl = doc.createElement('div')
    trackEl.className = 'yura-track'
    trackEl.appendChild(unit)
    el.appendChild(trackEl)
    // Enough copies to cover the box twice, measured now (never assumed).
    const unitW = unit.getBoundingClientRect().width
    const boxW = el.getBoundingClientRect().width
    const copies = unitW > 0 ? Math.max(2, Math.ceil((boxW * 2) / unitW) + 1) : 4
    for (let i = 1; i < copies; i++) {
      const c = unit.cloneNode(true) as HTMLElement
      c.setAttribute('aria-hidden', 'true')
      trackEl.appendChild(c)
    }
    marquees.push({ el, track: trackEl, copies, speed: num(el.getAttribute('data-yura-marquee'), DEFAULT_MARQUEE_SPEED), offset: 0 })
  }

  const armCounter = (el: HTMLElement): void => {
    const raw = el.getAttribute('data-yura-counter') || el.textContent || '0'
    const target = num(raw.replace(/[^\d.\-]/g, ''), 0)
    const decimals = Math.floor(num(el.getAttribute('data-yura-decimals'), (raw.split('.')[1] ?? '').replace(/\D/g, '').length))
    const c: Counter = { el, target, decimals, prefix: el.getAttribute('data-yura-prefix') ?? '', suffix: el.getAttribute('data-yura-suffix') ?? '', started: null }
    el.setAttribute('aria-label', `${c.prefix}${countAt(target, 1, decimals)}${c.suffix}`)
    el.textContent = `${c.prefix}${countAt(target, reduced ? 1 : 0, decimals)}${c.suffix}`
    if (!reduced) counters.push(c)
  }

  const scan = (): void => {
    const all = <T extends Element = HTMLElement>(sel: string) => Array.from(doc.querySelectorAll<T & HTMLElement>(sel))
    const fresh = (el: Element): boolean => {
      if (seen.has(el)) return false
      seen.add(el)
      return true
    }
    for (const el of all('[data-yura-text]')) if (fresh(el)) armText(el, 0)
    // On a stagger container, data-yura-reveal names the CHILDREN's effect — the container itself stays put.
    for (const el of all('[data-yura-reveal]')) {
      if (el.hasAttribute('data-yura-stagger') || el.parentElement?.hasAttribute('data-yura-stagger')) continue
      if (fresh(el)) armBlock(el, el.getAttribute('data-yura-reveal'), 0)
    }
    for (const parent of all('[data-yura-stagger]')) {
      if (!fresh(parent)) continue
      const step = num(parent.getAttribute('data-yura-stagger'), 0.08)
      parent.setAttribute('data-yura-armed', '')
      Array.from(parent.children).forEach((child, i) => {
        seen.add(child)
        const effect = child.getAttribute('data-yura-reveal') ?? parent.getAttribute('data-yura-reveal')
        armBlock(child as HTMLElement, effect, i * step)
      })
    }
    for (const el of all('[data-yura-marquee]')) if (fresh(el)) armMarquee(el)
    for (const el of all('[data-yura-parallax]')) if (fresh(el) && !reduced) parallax.push({ el, factor: num(el.getAttribute('data-yura-parallax'), 0.15) })
    for (const el of all('[data-yura-counter]')) if (fresh(el)) armCounter(el)
    for (const el of all('[data-yura-magnetic]')) if (fresh(el) && !reduced) magnets.push({ el, strength: num(el.getAttribute('data-yura-magnetic'), 0.35), x: 0, y: 0 })
    for (const el of all('[data-yura-scheme]')) if (fresh(el)) schemeSections.push({ el, scheme: num(el.getAttribute('data-yura-scheme'), 0) })
    for (const el of all('[data-yura-scrub]')) {
      if (!fresh(el)) continue
      const len = el.getAttribute('data-yura-scrub')
      if (len) el.style.setProperty('--yura-scrub-length', len)
      scrubs.push({ el })
    }
  }

  // ---------------------------------------------------------------- pointer + cursor
  let px = -1e4
  let py = -1e4
  const onMove = (e: PointerEvent): void => {
    px = e.clientX
    py = e.clientY
  }
  win.addEventListener('pointermove', onMove, { passive: true })
  cleanups.push(() => win.removeEventListener('pointermove', onMove))

  let cursorDot: HTMLElement | null = null
  let cursorRing: HTMLElement | null = null
  if (opts.cursor !== false && !reduced && matches(FINE_POINTER_QUERY)) {
    cursorDot = doc.createElement('div')
    cursorDot.className = 'yura-cursor yura-cursor-dot'
    cursorRing = doc.createElement('div')
    cursorRing.className = 'yura-cursor yura-cursor-ring'
    for (const c of [cursorDot, cursorRing]) {
      c.setAttribute('aria-hidden', 'true')
      doc.body.appendChild(c)
    }
    const onOver = (e: Event): void => {
      const t = (e.target as Element | null)?.closest?.(INTERACTIVE) as HTMLElement | null
      cursorRing?.classList.toggle('is-hover', !!t)
      if (cursorRing) cursorRing.textContent = t?.getAttribute('data-yura-cursor') ?? ''
    }
    doc.addEventListener('pointerover', onOver)
    cleanups.push(() => doc.removeEventListener('pointerover', onOver))
  }
  let dotX = px
  let dotY = py
  let ringX = px
  let ringY = py

  let bar: HTMLElement | null = null
  if (opts.progress !== false) {
    bar = doc.createElement('div')
    bar.className = 'yura-progress'
    bar.setAttribute('aria-hidden', 'true')
    doc.body.appendChild(bar)
  }

  // ---------------------------------------------------------------- scrubbed lyric stages
  // A <yura-lyric-stage> inside [data-yura-scrub] plays with the scroll: its clock is the section's pin progress.
  const scrubClock = (section: HTMLElement) => (): number => {
    const stage = section.querySelector('yura-lyric-stage') as (HTMLElement & { lyricSpan?: number }) | null
    const r = section.getBoundingClientRect()
    const travel = r.height - vh()
    const p = travel > 0 ? Math.min(1, Math.max(0, -r.top / travel)) : 0
    return p * (stage?.lyricSpan ?? 0)
  }

  // ---------------------------------------------------------------- opening
  const openingOpts = typeof opts.opening === 'object' ? opts.opening : opts.opening ? {} : null
  let loader: { root: HTMLElement; main: HTMLElement; accent: HTMLElement; count: HTMLElement; start: number; liftAt: number } | null = null
  let skipOpening = !openingOpts || reduced
  if (openingOpts && openingOpts.once !== false && !skipOpening) {
    try {
      if (win.sessionStorage.getItem(LOADER_ONCE_KEY)) skipOpening = true
      else win.sessionStorage.setItem(LOADER_ONCE_KEY, '1')
    } catch {
      // Storage blocked: just play it.
    }
  }
  if (openingOpts && !skipOpening) {
    const root = doc.createElement('div')
    root.className = 'yura-loader'
    root.setAttribute('aria-hidden', 'true')
    const accent = doc.createElement('div')
    accent.className = 'yura-loader-accent'
    const main = doc.createElement('div')
    main.className = 'yura-loader-main'
    const title = doc.createElement('div')
    title.className = 'yura-loader-title'
    title.textContent = openingOpts.title ?? doc.title ?? ''
    const count = doc.createElement('div')
    count.className = 'yura-loader-count'
    count.textContent = '000'
    main.append(title, count)
    root.append(accent, main)
    doc.body.appendChild(root)
    loader = { root, main, accent, count, start: now(), liftAt: Number.NaN }
  }
  const pageReady = (): boolean => doc.readyState === 'complete'

  // ---------------------------------------------------------------- frame loop
  let last = now()
  let lastScroll = win.scrollY
  let velocity = 0
  let handle: number | null = null
  let stopped = false

  const frame = (): void => {
    if (stopped) return
    const t = now()
    const dt = Math.min(Math.max(t - last, 0), MAX_DT)
    last = t
    const h = vh()

    // Scroll velocity (px/s), smoothed.
    const sy = win.scrollY
    if (dt > 0) velocity = follow(velocity, (sy - lastScroll) / dt, dt, VELOCITY_RATE)
    lastScroll = sy

    // Opening loader gates everything else.
    if (loader) {
      const f = loaderAt(t - loader.start, openingOpts?.seconds ?? LOADER_SECONDS, pageReady(), loader.liftAt)
      if (f.count >= 100 && !Number.isFinite(loader.liftAt)) loader.liftAt = t - loader.start
      loader.count.textContent = String(f.count).padStart(3, '0')
      loader.main.style.transform = `translateY(${f.curtain}%)`
      loader.accent.style.transform = `translateY(${f.accent}%)`
      if (f.done) {
        loader.root.remove()
        loader = null
      }
    }
    const gated = loader !== null && !Number.isFinite(loader.liftAt)

    // READ phase: every layout read happens before any write this frame.
    const pendingRects = gated ? [] : pending.map((r) => r.el.getBoundingClientRect())
    const counterRects = counters.map((c) => (c.started === null ? c.el.getBoundingClientRect() : null))
    const parallaxRects = parallax.map((p) => p.el.getBoundingClientRect())
    const marqueeRects = marquees.map((m) => m.el.getBoundingClientRect())
    const magnetRects = magnets.map((m) => m.el.getBoundingClientRect())
    const sectionRects = schemeSections.map((s) => s.el.getBoundingClientRect())
    const docH = Math.max(1, (doc.documentElement.scrollHeight || 0) - h)

    // Triggers.
    for (let i = pending.length - 1; i >= 0 && !gated; i--) {
      const r = pendingRects[i]
      if (r.top < h - Math.min(r.height, h) * TRIGGER_SHARE && r.bottom > 0) {
        pending[i].started = t
        pending.splice(i, 1)
      } else if (r.bottom <= 0) {
        // Already scrolled past (a reload mid-page): show it without a show.
        pending[i].started = t - 1e3
        pending.splice(i, 1)
      }
    }

    // WRITE phase.
    for (let i = reveals.length - 1; i >= 0; i--) {
      const r = reveals[i]
      if (r.started === null) continue
      const p = (t - r.started - r.delay) / r.duration
      if (p >= 1) {
        r.finish()
        reveals.splice(i, 1)
      } else if (p > 0) r.apply(p)
    }
    counters.forEach((c, i) => {
      const r = counterRects[i]
      if (c.started === null && r && r.top < h * (1 - TRIGGER_SHARE) && r.bottom > 0 && !gated) c.started = t
      if (c.started !== null) c.el.textContent = `${c.prefix}${countAt(c.target, (t - c.started) / COUNTER_SECONDS, c.decimals)}${c.suffix}`
    })
    for (let i = counters.length - 1; i >= 0; i--) {
      const c = counters[i]
      if (c.started !== null && t - c.started >= COUNTER_SECONDS) counters.splice(i, 1)
    }
    parallax.forEach((p, i) => {
      const r = parallaxRects[i]
      if (r.bottom < -h || r.top > h * 2) return
      p.el.style.transform = `translate3d(0, ${parallaxShift(r.top, r.height, h, p.factor).toFixed(2)}px, 0)`
    })
    marquees.forEach((m, i) => {
      const r = marqueeRects[i]
      if (r.bottom < 0 || r.top > h || reduced) return
      const s = marqueeStep(m.offset, dt, m.speed, velocity)
      m.offset = s.offset
      m.track.style.transform = `translate3d(${(-m.offset * 100) / m.copies}%, 0, 0) skewX(${s.skew.toFixed(2)}deg)`
    })
    magnets.forEach((m, i) => {
      const r = magnetRects[i]
      const radius = Math.max(r.width, r.height) * MAGNET_RADIUS_SHARE
      // Measure from the element's resting centre (undo its current pull).
      const target = magneticOffset(px - (r.left + r.width / 2 - m.x), py - (r.top + r.height / 2 - m.y), radius, m.strength)
      m.x = follow(m.x, target.x, dt, RING_RATE)
      m.y = follow(m.y, target.y, dt, RING_RATE)
      m.el.style.transform = Math.abs(m.x) + Math.abs(m.y) > 0.01 ? `translate3d(${m.x.toFixed(2)}px, ${m.y.toFixed(2)}px, 0)` : ''
    })
    if (schemeSections.length) {
      let pick = -1
      sectionRects.forEach((r, i) => {
        if (r.top <= h / 2 && r.bottom > h / 2) pick = i
      })
      applyScheme(pick >= 0 ? schemeSections[pick].scheme : baseScheme)
    }
    if (bar) bar.style.transform = `scaleX(${(Math.min(1, Math.max(0, sy / docH))).toFixed(4)})`
    if (cursorDot && cursorRing) {
      dotX = follow(dotX, px, dt, CURSOR_RATE)
      dotY = follow(dotY, py, dt, CURSOR_RATE)
      ringX = follow(ringX, px, dt, RING_RATE)
      ringY = follow(ringY, py, dt, RING_RATE)
      cursorDot.style.transform = `translate3d(${dotX.toFixed(1)}px, ${dotY.toFixed(1)}px, 0)`
      cursorRing.style.transform = `translate3d(${ringX.toFixed(1)}px, ${ringY.toFixed(1)}px, 0)`
    }

    handle = scheduler.request(frame)
  }

  scan()
  // Scrub sections: hand each stage its scroll clock before it starts.
  for (const s of scrubs) {
    const stage = s.el.querySelector('yura-lyric-stage') as (HTMLElement & { scrubClock?: () => number }) | null
    if (stage) {
      stage.scrubClock = scrubClock(s.el)
      stage.setAttribute('loop', 'false')
    }
  }
  handle = scheduler.request(frame)

  return {
    refresh: scan,
    setTheme(name, scheme) {
      if (!Object.prototype.hasOwnProperty.call(stageThemes, name)) {
        throw new YuraError(CODES.UNKNOWN_MOTION, `Unknown site theme "${name}". Available: ${Object.keys(stageThemes).join(', ')}.`, `site.setTheme('noir')`)
      }
      themeName = name
      currentScheme = -1
      applyScheme(scheme ?? baseScheme)
    },
    destroy() {
      if (stopped) return
      stopped = true
      if (handle !== null) scheduler.cancel(handle)
      for (const c of cleanups) c()
      for (const r of reveals) r.finish()
      reveals.length = 0
      pending.length = 0
      cursorDot?.remove()
      cursorRing?.remove()
      bar?.remove()
      loader?.root.remove()
      style?.remove()
      for (const m of magnets) m.el.style.transform = ''
      for (const p of parallax) p.el.style.transform = ''
      for (const c of counters) c.el.textContent = `${c.prefix}${countAt(c.target, 1, c.decimals)}${c.suffix}`
      html.classList.remove('yura-js', 'yura-site')
    },
  }
}

/** The one-line head snippet that prevents a flash of un-hidden content before yuraSite loads. */
export const YURA_HEAD_SNIPPET = `<script>document.documentElement.classList.add('yura-js')</script>`
