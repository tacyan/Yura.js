import { test, expect, describe, afterEach } from 'bun:test'
import { Window } from 'happy-dom'
import { YuraError, CODES } from '@yura/core'
import {
  splitText,
  textRevealStyles,
  blockReveals,
  blockRevealAt,
  viewProgress,
  pinProgress,
  parallaxShift,
  marqueeStep,
  countAt,
  magneticOffset,
  follow,
  loaderAt,
  LOADER_LIFT_SECONDS,
} from '../src/site-motion'
import { yuraSite, splitElement, type SiteWindow } from '../src/site'
import { motions } from '../src/motions'
import { stageThemes } from '../src/stage-themes'

// ------------------------------------------------------------------ pure

describe('splitText', () => {
  test('CJK graphemes are their own words; Latin words stay whole; spaces merge', () => {
    const toks = splitText('夜明け  the dawn!')
    expect(toks.map((t) => [t.kind, t.chars.join('')])).toEqual([
      ['word', '夜'],
      ['word', '明'],
      ['word', 'け'],
      ['space', '  '],
      ['word', 'the'],
      ['space', ' '],
      ['word', 'dawn!'],
    ])
  })

  test('emoji and combining sequences stay one grapheme', () => {
    const toks = splitText('👨‍👩‍👧 が')
    expect(toks[0].chars).toEqual(['👨‍👩‍👧'])
    expect(splitText('')).toEqual([])
  })
})

describe('reveal math', () => {
  test('every text reveal ends exactly at rest and starts hidden', () => {
    const chars = Array.from('夜明けの色を')
    for (const name of Object.keys(motions.enter) as (keyof typeof motions.enter)[]) {
      for (const s of textRevealStyles(name, chars, 1)) {
        expect({ name, s }).toEqual({ name, s: { transform: 'none', opacity: '1', filter: 'none', clipPath: 'none', textShadow: 'none', char: s.char } })
      }
      expect(textRevealStyles(name, chars, 1).map((s) => s.char).join('')).toBe('夜明けの色を')
      for (const v of [NaN, -1, Infinity]) expect(textRevealStyles(name, chars, v).length).toBe(chars.length)
    }
  })

  test('every block reveal rests at p ≥ 1, hides at p = 0, and stays finite', () => {
    for (const name of Object.keys(blockReveals) as (keyof typeof blockReveals)[]) {
      expect(blockRevealAt(name, 1)).toEqual({ opacity: '1', transform: 'none', clipPath: 'none', curtain: { transform: 'scaleX(0)', opacity: '0' } })
      const start = blockRevealAt(name, 0)
      const hidden = start.opacity === '0' || /inset\(100%|inset\(0 100%|circle\(0%|inset\(50% 0 50%/.test(start.clipPath)
      expect({ name, hidden }).toEqual({ name, hidden: true })
      for (let k = 0; k <= 20; k++) {
        const f = blockRevealAt(name, k / 20)
        expect({ name, k, bad: /NaN|Infinity|undefined/.test(JSON.stringify(f)) }).toEqual({ name, k, bad: false })
      }
      expect(blockRevealAt(name, NaN).opacity).toBeDefined()
    }
  })

  test('the curtain covers the element at mid-reveal', () => {
    const mid = blockRevealAt('curtain', 0.49)
    expect(mid.opacity).toBe('0')
    expect(mid.curtain.opacity).toBe('1')
    const late = blockRevealAt('curtain', 0.75)
    expect(late.opacity).toBe('1')
    expect(late.curtain.transform).toContain('translateX')
  })
})

describe('scroll math', () => {
  test('view and pin progress clamp to 0..1 and survive nonsense', () => {
    expect(viewProgress(800, 200, 800)).toBe(0)
    expect(viewProgress(-200, 200, 800)).toBe(1)
    expect(viewProgress(300, 200, 800)).toBeCloseTo(0.5)
    expect(viewProgress(NaN, NaN, NaN)).toBe(0)
    expect(pinProgress(0, 3000, 800)).toBe(0)
    expect(pinProgress(-2200, 3000, 800)).toBe(1)
    expect(pinProgress(-1100, 3000, 800)).toBeCloseTo(0.5)
    expect(pinProgress(-10, 500, 800)).toBe(1) // shorter than the viewport: done once it scrolls
    expect(pinProgress(NaN, 3000, 800)).toBe(0)
  })

  test('parallax is zero when centred and opposes the offset', () => {
    expect(parallaxShift(300, 200, 800, 0.3)).toBeCloseTo(0)
    expect(parallaxShift(700, 200, 800, 0.3)).toBeLessThan(0)
    expect(parallaxShift(NaN, 1, 1, 1)).toBe(-0)
  })

  test('marquee offset wraps, speeds up and flips with scroll direction', () => {
    let o = 0
    for (let k = 0; k < 500; k++) {
      o = marqueeStep(o, 1 / 60, 0.3, k % 2 ? 5000 : -5000).offset
      expect(o >= 0 && o < 1).toBe(true)
    }
    const idle = marqueeStep(0.5, 0.1, 0.1, 0)
    const fast = marqueeStep(0.5, 0.1, 0.1, 3000)
    const up = marqueeStep(0.5, 0.1, 0.1, -3000)
    expect(fast.offset - 0.5).toBeGreaterThan(idle.offset - 0.5)
    expect(up.offset).toBeLessThan(0.5)
    expect(idle.skew === 0 || Object.is(idle.skew, -0)).toBe(true)
    const bad = marqueeStep(NaN, NaN, NaN, NaN)
    expect(Number.isFinite(bad.offset) && Number.isFinite(bad.skew)).toBe(true)
  })
})

describe('counters, magnets, smoothing, loader', () => {
  test('count-up formats for the locale and lands on the target', () => {
    expect(countAt(1200, 1, 0, 'en-US')).toBe('1,200')
    expect(countAt(12.8, 1, 1, 'en-US')).toBe('12.8')
    expect(countAt(1200, 0, 0, 'en-US')).toBe('0')
    expect(countAt(NaN, 0.5, 0, 'en-US')).toBe('0')
    expect(countAt(5, 1, 99, 'en-US')).toBe('5.000000')
    expect(countAt(5, 1, 0, 'not a locale ✗')).toBe('5')
  })

  test('magnetic pull fades with distance and never exceeds the offset', () => {
    expect(magneticOffset(200, 0, 100)).toEqual({ x: 0, y: 0 })
    const near = magneticOffset(10, 0, 100, 0.5)
    expect(near.x).toBeGreaterThan(0)
    expect(near.x).toBeLessThan(10)
    expect(magneticOffset(NaN, 5, 100)).toEqual({ x: 0, y: 0 }) // no pointer yet → no pull
    expect(magneticOffset(5, 5, 0)).toEqual({ x: 0, y: 0 })
  })

  test('follow is frame-rate independent', () => {
    const once = follow(0, 100, 0.2, 5)
    const twice = follow(follow(0, 100, 0.1, 5), 100, 0.1, 5)
    expect(once).toBeCloseTo(twice, 10)
    expect(follow(0, 100, NaN, 5)).toBe(0)
    expect(follow(0, 100, 1e9, 5)).toBeCloseTo(100)
  })

  test('the loader holds at 99 until the page is ready, then lifts and finishes', () => {
    expect(loaderAt(10, 1.6, false).count).toBe(99)
    expect(loaderAt(10, 1.6, true).count).toBe(100)
    expect(loaderAt(0, 1.6, true).count).toBe(0)
    const mid = loaderAt(2 + LOADER_LIFT_SECONDS / 2, 1.6, true, 2)
    expect(mid.curtain).toBeLessThan(0)
    expect(mid.accent).toBeGreaterThan(mid.curtain) // the accent curtain trails
    expect(loaderAt(2 + LOADER_LIFT_SECONDS, 1.6, true, 2).done).toBe(true)
    expect(loaderAt(NaN, NaN, true).count).toBe(0)
  })
})

// ------------------------------------------------------------------ DOM (happy-dom)

interface Harness {
  win: SiteWindow
  doc: Document
  tick(seconds: number, frames?: number): void
  setTop(el: Element, top: number, height?: number): void
}

/**
 * A real DOM (happy-dom) with a manual clock and scheduler, and layout
 * controlled by the test: happy-dom has no layout engine, so every element
 * reports the rect the test assigns (default: far below the fold).
 */
const open: Window[] = []
afterEach(async () => {
  for (const w of open.splice(0)) await w.happyDOM.close()
})

async function harness(html: string): Promise<Harness> {
  const raw = new Window({ width: 1280, height: 800, url: 'https://example.test/' })
  open.push(raw)
  const win = raw as unknown as SiteWindow
  const doc = win.document
  doc.write(`<!doctype html><html><head><title>Test</title></head><body>${html}</body></html>`)
  await raw.happyDOM.waitUntilComplete() // readyState → 'complete', as after a real page load
  const rects = new WeakMap<Element, { top: number; height: number }>()
  const Proto = (win as unknown as { HTMLElement: { prototype: HTMLElement } }).HTMLElement.prototype
  Proto.getBoundingClientRect = function (this: Element) {
    const r = rects.get(this) ?? { top: 5000, height: 100 }
    return { top: r.top, bottom: r.top + r.height, left: 0, right: 1280, width: 1280, height: r.height, x: 0, y: r.top, toJSON() {} } as DOMRect
  }
  return {
    win,
    doc,
    tick(seconds, frames = 1) {
      for (let i = 0; i < frames; i++) {
        clock += seconds / frames
        const cb = queue.shift()
        cb?.()
      }
    },
    setTop(el, top, height = 100) {
      rects.set(el, { top, height })
    },
  }
}
let clock = 0
let queue: (() => void)[] = []
const scheduler = {
  request(cb: () => void) {
    queue.push(cb)
    return queue.length
  },
  cancel() {
    queue = []
  },
}
const reset = () => {
  clock = 0
  queue = []
}
const opts = (h: Harness, extra: object = {}) => ({ window: h.win, scheduler, now: () => clock, cursor: false, reducedMotion: false, ...extra })

describe('yuraSite (happy-dom)', () => {
  test('splits text for reveals, keeps it readable, and settles it back to the original', async () => {
    reset()
    const h = await harness(`<h1 id="t" data-yura-text="rise">夜明けの<br><em>色</em>を see</h1>`)
    const run = yuraSite(opts(h))
    const el = h.doc.getElementById('t') as HTMLElement
    expect(el.getAttribute('aria-label')).toBe('夜明けの色を see')
    expect(el.querySelectorAll('.yura-c').length).toBe(9)
    expect(el.querySelector('br')).not.toBeNull()
    expect(el.querySelector('em .yura-c')).not.toBeNull()
    expect(el.hasAttribute('data-yura-armed')).toBe(true)
    h.setTop(el, 300)
    h.tick(0.016)
    h.tick(0.5)
    const mid = Array.from(el.querySelectorAll<HTMLElement>('.yura-c')).map((c) => c.style.transform)
    expect(mid.some((t) => t && t !== 'none')).toBe(true)
    h.tick(3)
    h.tick(0.016)
    expect(el.hasAttribute('data-yura-done')).toBe(true)
    expect(el.textContent).toBe('夜明けの色を see')
    run.destroy()
  })

  test('links inside a split heading stay whole and accessible', async () => {
    reset()
    const h = await harness(`<p id="p" data-yura-text="fade-up">read <a href="#x">more</a></p>`)
    yuraSite(opts(h))
    const p = h.doc.getElementById('p') as HTMLElement
    const a = p.querySelector('a') as HTMLElement
    expect(a.textContent).toBe('more')
    expect(a.parentElement?.className).toBe('yura-c')
    expect(p.hasAttribute('aria-label')).toBe(false)
    expect(p.querySelector('[aria-hidden]')).toBeNull()
  })

  test('stagger containers stay visible and arm every child with an increasing delay (regression)', async () => {
    reset()
    const h = await harness(`<ul id="u" data-yura-stagger="0.1" data-yura-reveal="curtain"><li>a</li><li>b</li><li>c</li></ul>`)
    yuraSite(opts(h))
    const ul = h.doc.getElementById('u') as HTMLElement
    // The container is armed (so the hide-until-armed CSS never applies) and never animated itself.
    expect(ul.hasAttribute('data-yura-armed')).toBe(true)
    expect(ul.style.opacity).toBe('')
    const lis = Array.from(ul.children) as HTMLElement[]
    for (const li of lis) expect(li.hasAttribute('data-yura-armed')).toBe(true)
    for (const li of lis) expect(li.querySelector('span[aria-hidden]')).not.toBeNull() // curtain panel
    const css = h.doc.getElementById('yura-site-style')?.textContent ?? ''
    expect(css).toContain('[data-yura-reveal]:not([data-yura-stagger]):not([data-yura-armed])')
    h.setTop(ul, 200)
    for (const li of lis) h.setTop(li, 200)
    h.tick(0.016)
    h.tick(0.3)
    // Staggered: the first item is further along than the last.
    const firstCurtain = (lis[0].querySelector('span[aria-hidden]') as HTMLElement).style.transform
    const lastCurtain = (lis[2].querySelector('span[aria-hidden]') as HTMLElement).style.transform
    expect(firstCurtain).not.toBe(lastCurtain)
    h.tick(4)
    h.tick(0.016)
    for (const li of lis) {
      expect(li.hasAttribute('data-yura-done')).toBe(true)
      expect(li.querySelector('span[aria-hidden]')).toBeNull() // curtain removed
    }
  })

  test('elements already scrolled past appear without animating', async () => {
    reset()
    const h = await harness(`<div id="d" data-yura-reveal="mask">x</div>`)
    yuraSite(opts(h))
    const d = h.doc.getElementById('d') as HTMLElement
    h.setTop(d, -900, 100)
    h.tick(0.016)
    h.tick(0.016)
    expect(d.hasAttribute('data-yura-done')).toBe(true)
    expect(d.style.clipPath).toBe('')
  })

  test('counters count up to the formatted target with prefix / suffix', async () => {
    reset()
    const h = await harness(`<b id="c" data-yura-counter="1200" data-yura-prefix="¥" data-yura-suffix="+">0</b>`)
    yuraSite(opts(h))
    const c = h.doc.getElementById('c') as HTMLElement
    expect(c.getAttribute('aria-label')).toContain('1,200')
    h.setTop(c, 100)
    h.tick(0.016)
    h.tick(0.5)
    expect(c.textContent).not.toBe('¥1,200+')
    h.tick(3)
    expect(c.textContent).toBe('¥1,200+')
  })

  test('marquees fill their box with hidden copies and move', async () => {
    reset()
    const h = await harness(`<div id="m" data-yura-marquee="0.5"><span>NEW SINGLE</span></div>`)
    yuraSite(opts(h))
    const m = h.doc.getElementById('m') as HTMLElement
    const track = m.querySelector('.yura-track') as HTMLElement
    expect(track.children.length).toBeGreaterThanOrEqual(2)
    expect(track.children[1].getAttribute('aria-hidden')).toBe('true')
    h.setTop(m, 100)
    h.tick(0.016)
    h.tick(0.1)
    expect(track.style.transform).toContain('translate3d(-')
  })

  test('scheme sections recolour the page while centred', async () => {
    reset()
    const h = await harness(`<section id="a" data-yura-scheme="0">a</section><section id="b" data-yura-scheme="1">b</section>`)
    yuraSite(opts(h, { theme: 'noir' }))
    const root = h.doc.documentElement
    const [s0, s1] = stageThemes.noir.schemes
    h.setTop(h.doc.getElementById('a') as Element, -100, 800)
    h.setTop(h.doc.getElementById('b') as Element, 700, 800)
    h.tick(0.016)
    expect(root.style.getPropertyValue('--yura-bg')).toBe(s0.bg)
    h.setTop(h.doc.getElementById('a') as Element, -900, 800)
    h.setTop(h.doc.getElementById('b') as Element, -100, 800)
    h.tick(0.016)
    expect(root.style.getPropertyValue('--yura-bg')).toBe(s1.bg)
  })

  test('reduced motion shows everything immediately', async () => {
    reset()
    const h = await harness(`<h2 id="t" data-yura-text="scramble">abc</h2><div id="r" data-yura-reveal="curtain">x</div><b id="c" data-yura-counter="7">0</b>`)
    yuraSite(opts(h, { reducedMotion: true, opening: true }))
    expect(h.doc.getElementById('t')?.hasAttribute('data-yura-done')).toBe(true)
    expect(h.doc.getElementById('r')?.hasAttribute('data-yura-done')).toBe(true)
    expect(h.doc.getElementById('c')?.textContent).toBe('7')
    expect(h.doc.querySelector('.yura-loader')).toBeNull()
  })

  test('the opening loader gates reveals until it lifts, then removes itself', async () => {
    reset()
    const h = await harness(`<div id="r" data-yura-reveal="fade-up">x</div>`)
    yuraSite(opts(h, { opening: { title: 'HELLO', once: false } }))
    const r = h.doc.getElementById('r') as HTMLElement
    h.setTop(r, 100)
    expect(h.doc.querySelector('.yura-loader-title')?.textContent).toBe('HELLO')
    h.tick(0.5)
    expect(r.hasAttribute('data-yura-done')).toBe(false)
    for (let i = 0; i < 40; i++) h.tick(0.2)
    expect(h.doc.querySelector('.yura-loader')).toBeNull()
    for (let i = 0; i < 20; i++) h.tick(0.2)
    expect(r.hasAttribute('data-yura-done')).toBe(true)
  })

  test('destroy leaves the page fully visible and clean; unknown themes throw YURA-019', async () => {
    reset()
    const h = await harness(`<h1 id="t" data-yura-text>hi</h1><button data-yura-magnetic>b</button>`)
    const run = yuraSite(opts(h, { progress: true }))
    expect(h.doc.querySelector('.yura-progress')).not.toBeNull()
    run.destroy()
    run.destroy()
    expect(h.doc.querySelector('.yura-progress')).toBeNull()
    expect(h.doc.getElementById('yura-site-style')).toBeNull()
    expect(h.doc.documentElement.classList.contains('yura-js')).toBe(false)
    expect(h.doc.getElementById('t')?.textContent).toBe('hi')
    try {
      yuraSite(opts(await harness(''), { theme: 'nope' }))
      throw new Error('expected a throw')
    } catch (e) {
      expect(e).toBeInstanceOf(YuraError)
      expect((e as YuraError).code).toBe(CODES.UNKNOWN_MOTION)
    }
    expect(() => run.setTheme('nope' as never)).toThrow(YuraError)
  })

  test('splitElement is idempotent over nested inline markup', async () => {
    const h = await harness(`<p id="p">a <strong>b c</strong></p>`)
    const p = h.doc.getElementById('p') as HTMLElement
    const chars = splitElement(p)
    expect(chars.map((c) => c.textContent)).toEqual(['a', 'b', 'c'])
    expect(p.textContent).toBe('a b c')
  })
})

test('docs/SITE.md documents every attribute and block reveal (doc drift guard)', async () => {
  const doc = await Bun.file(new URL('../../../docs/SITE.md', import.meta.url).pathname).text()
  const src = await Bun.file(new URL('../src/site.ts', import.meta.url).pathname).text()
  const attrs = new Set([...src.matchAll(/data-yura-[a-z]+/g)].map((m) => m[0]))
  for (const a of ['data-yura-armed', 'data-yura-done', 'data-yura-live']) attrs.delete(a)
  for (const a of attrs) expect({ a, documented: doc.includes(a) }).toEqual({ a, documented: true })
  for (const name of Object.keys(blockReveals)) expect({ name, documented: doc.includes(`\`${name}\``) }).toEqual({ name, documented: true })
})
