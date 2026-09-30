import { test, expect, describe, afterEach } from 'bun:test'
import { Window } from 'happy-dom'
import {
  homography,
  applyHomography,
  cornerPinMatrix3d,
  orientCorners,
  nudgeCorner,
  blendWeight,
  blendPixel,
  blendGradient,
  projectorTiles,
  defaultProjectionConfig,
  normalizeProjectionConfig,
  viewportTransform,
  maskClipPath,
  testPatternMarkup,
  calibrationKey,
  syncedTime,
  projectionMapping,
  IDENTITY_QUAD,
  NUDGE_STEP,
  NUDGE_STEP_COARSE,
  type Quad,
} from '../src/projection'

/** Seeded LCG — fuzz stays deterministic and failures print their seed. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

const KEYSTONE: Quad = [
  { x: 0.08, y: 0.05 },
  { x: 0.9, y: 0.12 },
  { x: 0.97, y: 0.94 },
  { x: 0.02, y: 0.86 },
]

describe('homography', () => {
  test('maps every source corner exactly onto its destination', () => {
    const h = homography(IDENTITY_QUAD, KEYSTONE)
    expect(h).not.toBeNull()
    IDENTITY_QUAD.forEach((p, i) => {
      const q = applyHomography(h!, p)
      expect(q.x).toBeCloseTo(KEYSTONE[i].x, 9)
      expect(q.y).toBeCloseTo(KEYSTONE[i].y, 9)
    })
  })

  test('identity to identity is the identity matrix', () => {
    const h = homography(IDENTITY_QUAD, IDENTITY_QUAD)!
    ;[1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => expect(h[i]).toBeCloseTo(v, 12))
  })

  test('degenerate, folded or non-finite corners give null instead of NaN', () => {
    const line: Quad = [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]
    const bowtie: Quad = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ]
    expect(homography(IDENTITY_QUAD, line)).toBeNull()
    expect(homography(IDENTITY_QUAD, bowtie)).toBeNull()
    expect(homography(IDENTITY_QUAD, [{ x: NaN, y: 0 }, KEYSTONE[1], KEYSTONE[2], KEYSTONE[3]])).toBeNull()
    expect(applyHomography([1, 0, 0, 0, 1, 0, 1, 0, -1], { x: 1, y: 0 })).toEqual({ x: 0, y: 0 })
  })

  test('fuzz: any convex quad round-trips its corners (seeded)', () => {
    const rand = lcg(2026)
    for (let k = 0; k < 300; k++) {
      const j = () => (rand() - 0.5) * 0.4
      const q: Quad = [
        { x: 0 + j(), y: 0 + j() },
        { x: 1 + j(), y: 0 + j() },
        { x: 1 + j(), y: 1 + j() },
        { x: 0 + j(), y: 1 + j() },
      ]
      const h = homography(IDENTITY_QUAD, q)
      expect({ k, ok: h !== null }).toEqual({ k, ok: true })
      IDENTITY_QUAD.forEach((p, i) => {
        const r = applyHomography(h!, p)
        expect({ k, i, err: Math.hypot(r.x - q[i].x, r.y - q[i].y) < 1e-9 }).toEqual({ k, i, err: true })
      })
    }
  })

  test('cornerPinMatrix3d is a finite matrix3d, and none for nothing to warp', () => {
    const m = cornerPinMatrix3d(1920, 1080, KEYSTONE)
    expect(m.startsWith('matrix3d(')).toBe(true)
    expect(m.split(',')).toHaveLength(16)
    expect(/NaN|Infinity/.test(m)).toBe(false)
    expect(cornerPinMatrix3d(0, 1080, KEYSTONE)).toBe('none')
    expect(cornerPinMatrix3d(NaN, 1080, KEYSTONE)).toBe('none')
    expect(cornerPinMatrix3d(100, 100, [KEYSTONE[0], KEYSTONE[0], KEYSTONE[0], KEYSTONE[0]])).toBe('none')
    // The identity pin is the identity matrix.
    expect(cornerPinMatrix3d(800, 600, IDENTITY_QUAD)).toBe('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)')
  })
})

describe('orientation and nudging', () => {
  test('flips and quarter turns permute corners; four turns or two flips are the identity', () => {
    expect(orientCorners(KEYSTONE, { flipX: true })[0]).toEqual(KEYSTONE[1])
    expect(orientCorners(KEYSTONE, { flipY: true })[0]).toEqual(KEYSTONE[3])
    expect(orientCorners(KEYSTONE, { rotate: 90 })[1]).toEqual(KEYSTONE[0])
    expect(orientCorners(KEYSTONE, { rotate: 360 })).toEqual(KEYSTONE)
    expect(orientCorners(orientCorners(KEYSTONE, { flipX: true }), { flipX: true })).toEqual(KEYSTONE)
    expect(orientCorners(KEYSTONE, { rotate: NaN })).toEqual(KEYSTONE)
    expect(orientCorners(KEYSTONE, { rotate: -90 })).toEqual(orientCorners(KEYSTONE, { rotate: 270 }))
  })

  test('nudge moves one corner, clamps to one frame around the output, ignores junk', () => {
    const q = nudgeCorner(IDENTITY_QUAD, 2, 0.1, -0.2)
    expect(q[2]).toEqual({ x: 1.1, y: 0.8 })
    expect(q[0]).toEqual(IDENTITY_QUAD[0])
    expect(nudgeCorner(IDENTITY_QUAD, 0, -9, 9)[0]).toEqual({ x: -1, y: 2 })
    expect(nudgeCorner(IDENTITY_QUAD, 7, NaN, Infinity)[3]).toEqual(IDENTITY_QUAD[3])
  })
})

describe('edge blending', () => {
  test('two overlapping projectors sum to one projector of light across the band', () => {
    for (const curve of [1, 2, 3.5]) {
      for (let k = 0; k <= 50; k++) {
        const u = k / 50
        expect(blendWeight(u, curve) + blendWeight(1 - u, curve)).toBeCloseTo(1, 12)
      }
      expect(blendWeight(0, curve)).toBe(1)
      expect(blendWeight(1, curve)).toBe(0)
    }
  })

  test('pixel values undo the projector gamma: pixel^gamma is the light weight', () => {
    for (let k = 0; k <= 20; k++) expect(blendPixel(k / 20, 2.2) ** 2.2).toBeCloseTo(blendWeight(k / 20), 10)
    expect(Number.isFinite(blendPixel(NaN, NaN, NaN))).toBe(true)
    expect(blendPixel(0.5, -3)).toBeCloseTo(blendWeight(0.5) ** (1 / 2.2), 10)
  })

  test('blend gradient: black at the outer edge, clear inside, empty without a band', () => {
    const g = blendGradient('left', 0.2)
    expect(g.startsWith('linear-gradient(to right, rgba(0,0,0,1) 0%')).toBe(true)
    expect(g.endsWith('rgba(0,0,0,0) 20%)')).toBe(true)
    expect(blendGradient('top', 0)).toBe('')
    expect(blendGradient('bottom', NaN)).toBe('')
    expect(blendGradient('right', 9)).toContain('50%)')
  })

  test('projector tiles cover the picture exactly and share their overlaps', () => {
    for (const n of [1, 2, 3, 5]) {
      const tiles = projectorTiles(n, 0.2)
      expect(tiles).toHaveLength(n)
      expect(tiles[0].x).toBe(0)
      expect(tiles[n - 1].x + tiles[n - 1].width).toBeCloseTo(1, 12)
      for (let i = 1; i < n; i++) {
        const overlap = tiles[i - 1].x + tiles[i - 1].width - tiles[i].x
        expect(overlap).toBeCloseTo(tiles[i].width * 0.2, 12)
      }
      expect(tiles[0].blendLeft).toBe(0)
      expect(tiles[n - 1].blendRight).toBe(0)
    }
    expect(projectorTiles(NaN)).toHaveLength(1)
    expect(projectorTiles(1, 0.4)[0]).toEqual({ x: 0, width: 1, blendLeft: 0, blendRight: 0 })
  })
})

describe('config', () => {
  test('untrusted config is clamped field by field and never lets NaN through', () => {
    const rand = lcg(7)
    const junk = [null, 1, 'x', NaN, Infinity, -1e308, {}, [], { x: 'a' }, true]
    for (let k = 0; k < 300; k++) {
      const pick = () => junk[Math.floor(rand() * junk.length)]
      const raw = {
        corners: rand() < 0.5 ? [pick(), pick(), pick(), pick()] : pick(),
        rotate: pick(),
        blend: rand() < 0.5 ? { left: pick(), right: pick(), gamma: pick(), curve: pick() } : pick(),
        blackLevel: pick(),
        brightness: pick(),
        mask: rand() < 0.5 ? [pick(), pick(), pick()] : pick(),
        viewport: rand() < 0.5 ? { x: pick(), y: pick(), width: pick(), height: pick() } : pick(),
      }
      const c = normalizeProjectionConfig(raw)
      expect({ k, bad: /NaN|Infinity|null/.test(JSON.stringify(c)) }).toEqual({ k, bad: false })
      expect([0, 90, 180, 270]).toContain(c.rotate)
      expect(c.viewport.x + c.viewport.width).toBeLessThanOrEqual(1 + 1e-12)
    }
    expect(normalizeProjectionConfig(undefined)).toEqual(defaultProjectionConfig())
  })

  test('valid config survives a JSON round trip unchanged', () => {
    const c = { ...defaultProjectionConfig(), corners: KEYSTONE, flipX: true, rotate: 180, blackLevel: 0.05, mask: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }] }
    expect(normalizeProjectionConfig(JSON.parse(JSON.stringify(c)))).toEqual(c as never)
  })

  test('degenerate corners fall back to the full frame', () => {
    const c = normalizeProjectionConfig({ corners: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }] })
    expect(c.corners).toEqual(defaultProjectionConfig().corners)
  })

  test('viewport and mask CSS', () => {
    expect(viewportTransform({ x: 0, y: 0, width: 1, height: 1 })).toBe('none')
    expect(viewportTransform({ x: 0.5, y: 0, width: 0.5, height: 1 })).toBe('scale(2, 1) translate(-50%, 0%)')
    expect(maskClipPath([])).toBe('none')
    expect(maskClipPath([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }])).toBe('polygon(0% 0%, 100% 0%, 50% 100%)')
  })

  test('test pattern is self-contained SVG and escapes its label', () => {
    const svg = testPatternMarkup({ label: '<script>x</script>', color: 'red;background:url(x)' })
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('stroke="#ffffff"') // the unsafe colour was rejected
  })

  test('calibration keys decode to actions', () => {
    expect(calibrationKey({ key: '3' })).toEqual({ kind: 'select', corner: 2 })
    expect(calibrationKey({ key: 'ArrowLeft' })).toEqual({ kind: 'nudge', dx: -NUDGE_STEP, dy: 0 })
    expect(calibrationKey({ key: 'ArrowDown', shiftKey: true })).toEqual({ kind: 'nudge', dx: 0, dy: NUDGE_STEP_COARSE })
    expect(calibrationKey({ key: 'Escape' })).toEqual({ kind: 'exit' })
    expect(calibrationKey({ key: 'q' })).toBeNull()
  })

  test('synced time extrapolates a playing leader, holds a paused one, and caps a stale message', () => {
    expect(syncedTime({ t: 10, sentAt: 1000, playing: true }, 1500)).toBeCloseTo(10.5, 12)
    expect(syncedTime({ t: 10, sentAt: 1000, playing: false }, 1500)).toBe(10)
    expect(syncedTime({ t: 10, sentAt: 1000, playing: true }, 999_999)).toBe(12)
    expect(syncedTime({ t: 10, sentAt: 2000, playing: true }, 1000)).toBe(10) // clock skew never rewinds
    expect(syncedTime({ t: NaN, sentAt: NaN, playing: true }, NaN)).toBe(0)
  })
})

describe('projectionMapping (DOM shell, happy-dom)', () => {
  let happy: Window | null = null
  afterEach(async () => {
    await happy?.happyDOM.close()
    happy = null
  })

  function page() {
    happy = new Window({ width: 1280, height: 720 })
    const doc = happy.document
    doc.body.innerHTML = '<main><section id="show" style="color: red">LYRICS</section><p id="after">after</p></main>'
    const show = doc.querySelector('#show') as unknown as HTMLElement
    ;(show as unknown as { getBoundingClientRect: () => object }).getBoundingClientRect = () => ({ left: 0, top: 0, width: 1600, height: 900, right: 1600, bottom: 900 })
    return { win: happy as unknown as Window & typeof globalThis, doc, show }
  }

  test('wraps the content, warps it, and stop() restores the page exactly', () => {
    const { win, doc, show } = page()
    const before = doc.body.innerHTML
    const run = projectionMapping('#show', { window: win as never, corners: KEYSTONE, blend: { right: 0.15 }, blackLevel: 0.04 })
    ;(run.element as unknown as { getBoundingClientRect: () => object }).getBoundingClientRect = () => ({ left: 0, top: 0, width: 1600, height: 900 })
    run.refresh()
    expect(run.element.getAttribute('data-yura-projection')).toBe('')
    expect(run.element.contains(show)).toBe(true)
    expect(doc.querySelector('#after')?.previousElementSibling).toBe(run.element as never)
    const html = run.element.innerHTML
    expect(html).toContain('matrix3d(')
    expect(html).toContain('linear-gradient(to left')
    run.stop()
    expect(doc.body.innerHTML).toBe(before)
  })

  test('calibration: keys select and nudge corners, report changes, and persist', () => {
    const { win } = page()
    const seen: number[] = []
    const run = projectionMapping('#show', { window: win as never, calibrate: true, storageKey: 'yura-test', onChange: (c) => seen.push(c.corners[1].x) })
    const key = (k: string, extra: object = {}) => win.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, ...extra }) as never)
    key('2')
    key('ArrowLeft', { shiftKey: true })
    expect(run.config().corners[1].x).toBeCloseTo(1 - NUDGE_STEP_COARSE, 12)
    expect(seen).toHaveLength(1)
    const stored = JSON.parse(win.localStorage.getItem('yura-test') as string)
    expect(stored.corners[1].x).toBeCloseTo(1 - NUDGE_STEP_COARSE, 12)
    key('Escape')
    key('ArrowLeft') // ignored once calibration is over
    expect(seen).toHaveLength(1)
    run.stop()
    // A new run picks the saved calibration back up.
    const again = projectionMapping('#show', { window: win as never, storageKey: 'yura-test' })
    expect(again.config().corners[1].x).toBeCloseTo(1 - NUDGE_STEP_COARSE, 12)
    again.stop()
  })

  test('set() validates like a loaded file; a missing target throws YURA-003', () => {
    const { win } = page()
    const run = projectionMapping('#show', { window: win as never })
    run.set({ brightness: 99, rotate: 450 as never, blend: { left: 0.1 } })
    expect(run.config().brightness).toBe(2)
    expect(run.config().rotate).toBe(90)
    expect(run.config().blend.left).toBe(0.1)
    run.stop()
    expect(() => projectionMapping('#nope', { window: win as never })).toThrow('YURA-003')
  })
})
