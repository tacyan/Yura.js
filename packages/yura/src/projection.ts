import { YuraError, CODES, warnCode } from '@yura/core'

/**
 * Projection mapping for anything on a web page — a {@link lyricStage}, a
 * canvas, a video, a whole section — both on screen and through real
 * projectors onto walls, buildings and objects.
 *
 *   corner pin     four-point perspective warp (a homography as CSS matrix3d),
 *                  so the picture lands exactly on a surface seen at an angle
 *   orientation    flip for rear projection, rotate for a projector on its side
 *   edge blending  gamma-correct soft edges where two projectors overlap, with
 *                  black-level lift so the overlap's doubled black disappears
 *   mask           a polygon outside of which nothing is lit (no spill onto the sky)
 *   tiles          how N projectors split one wide picture, with overlaps
 *   sync           one timeline shared by several windows (one per projector)
 *                  on the same origin, via BroadcastChannel, so every output
 *                  plays the same frame
 *   calibration    drag / nudge the corners on the real surface, a test
 *                  pattern to align by, and a JSON config to save and reload
 *
 * Every coordinate is normalised to the output (0..1), never pixels, so a
 * calibration made on one machine loads on any other resolution. The math is
 * pure and exported (and tested); only {@link projectionMapping} and
 * {@link projectionSync} touch the DOM or the clock.
 */

// ------------------------------------------------------------------ types

export interface Point {
  x: number
  y: number
}
/** Four corners in order: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Point, Point, Point, Point]
/** A 3×3 homography, row-major, with h[8] = 1. */
export type Homography = [number, number, number, number, number, number, number, number, number]

/** The unit square: no warp. */
export const IDENTITY_QUAD: Readonly<Quad> = Object.freeze([
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
]) as Readonly<Quad>

const unitQuad = (): Quad => IDENTITY_QUAD.map((p) => ({ ...p })) as Quad
const fin = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback)
const clamp = (v: number, lo: number, hi: number): number => (Number.isNaN(v) ? lo : Math.min(hi, Math.max(lo, v)))

// ------------------------------------------------------------------ homography

/**
 * The homography that maps `src` onto `dst` (4 point pairs), or null when the
 * corners are degenerate (three in a line, two coincident, non-finite). (Pure.)
 */
export function homography(src: Readonly<Quad>, dst: Readonly<Quad>): Homography | null {
  // Solve the 8×8 system  A·h = b  for h0..h7 (h8 = 1) by Gauss-Jordan with partial pivoting.
  const a: number[][] = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]
    const { x: u, y: v } = dst[i]
    if (![x, y, u, v].every(Number.isFinite)) return null
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u])
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v])
  }
  const n = 8
  for (let c = 0; c < n; c++) {
    let pivot = c
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r
    if (Math.abs(a[pivot][c]) < 1e-12) return null
    ;[a[c], a[pivot]] = [a[pivot], a[c]]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = a[r][c] / a[c][c]
      if (f === 0) continue
      for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k]
    }
  }
  const h = a.map((row, i) => row[n] / row[i])
  if (!h.every(Number.isFinite)) return null
  // A quad that folds over itself (a "bow tie") solves, but maps some of the
  // picture through infinity: reject it like any other unusable warp.
  const hh: Homography = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1]
  const w = src.map((p) => hh[6] * p.x + hh[7] * p.y + 1)
  if (!(w.every((v) => v > 1e-9) || w.every((v) => v < -1e-9))) return null
  return hh
}

/** Maps a point through a homography (a point sent to infinity maps to 0,0 rather than NaN). (Pure.) */
export function applyHomography(h: Readonly<Homography>, p: Point): Point {
  const w = h[6] * p.x + h[7] * p.y + h[8]
  if (!Number.isFinite(w) || Math.abs(w) < 1e-12) return { x: 0, y: 0 }
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w }
}

/**
 * CSS `matrix3d()` that warps a `width`×`height` box (transform-origin 0 0)
 * so its corners land on `corners` — given normalised to the same box.
 * Degenerate corners give `none` (no warp) rather than a broken transform.
 * (Pure.)
 */
export function cornerPinMatrix3d(width: number, height: number, corners: Readonly<Quad>): string {
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) return 'none'
  const src: Quad = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ]
  const dst = corners.map((p) => ({ x: p.x * width, y: p.y * height })) as Quad
  const h = homography(src, dst)
  if (!h) return 'none'
  // Row-major 3×3 → column-major 4×4 with z passed through.
  const m = [h[0], h[3], 0, h[6], h[1], h[4], 0, h[7], 0, 0, 1, 0, h[2], h[5], 0, h[8]]
  return `matrix3d(${m.map((v) => String(Math.round(v * 1e9) / 1e9)).join(', ')})`
}

// ------------------------------------------------------------------ orientation

/** 0 / 90 / 180 / 270 degrees clockwise. */
export type QuarterTurn = 0 | 90 | 180 | 270

/**
 * Re-orders corners for a mirrored or rotated projector. Flips and quarter
 * turns only change which output corner each picture corner goes to, so they
 * compose with any corner pin at no cost. (Pure.)
 */
export function orientCorners(corners: Readonly<Quad>, o: { flipX?: boolean; flipY?: boolean; rotate?: number } = {}): Quad {
  // Index permutation on [TL, TR, BR, BL].
  let idx = [0, 1, 2, 3]
  const turns = ((Math.round(fin(o.rotate ?? 0) / 90) % 4) + 4) % 4
  for (let k = 0; k < turns; k++) idx = [idx[3], idx[0], idx[1], idx[2]]
  if (o.flipX) idx = [idx[1], idx[0], idx[3], idx[2]]
  if (o.flipY) idx = [idx[3], idx[2], idx[1], idx[0]]
  return idx.map((i) => ({ ...corners[i] })) as Quad
}

/** Moves one corner by (dx, dy) in normalised units; corners stay within one frame of the output. (Pure.) */
export function nudgeCorner(corners: Readonly<Quad>, index: number, dx: number, dy: number): Quad {
  const out = corners.map((p) => ({ ...p })) as Quad
  const i = clamp(Math.round(fin(index)), 0, 3)
  out[i] = { x: clamp(out[i].x + fin(dx), -1, 2), y: clamp(out[i].y + fin(dy), -1, 2) }
  return out
}

// ------------------------------------------------------------------ edge blending

/**
 * Soft-edge weight in linear light across an overlap: 1 at the inner edge
 * (u = 0), 0 at the outer edge (u = 1). The curve is symmetric —
 * `w(u) + w(1 − u) = 1` — so two projectors overlapping by the same band sum
 * to exactly one projector's light everywhere. `curve` 1 is a linear ramp;
 * higher values flatten both ends (hides small misalignment). (Pure.)
 */
export function blendWeight(u: number, curve = 2): number {
  const x = 1 - clamp(fin(u), 0, 1)
  const p = Math.max(1, fin(curve, 2))
  return x < 0.5 ? 0.5 * (2 * x) ** p : 1 - 0.5 * (2 * (1 - x)) ** p
}

/**
 * The pixel multiplier that produces {@link blendWeight} of light on a
 * projector with the given display gamma (≈2.2 for most). (Pure.)
 */
export function blendPixel(u: number, gamma = 2.2, curve = 2): number {
  const g = fin(gamma, 2.2) > 0 ? fin(gamma, 2.2) : 2.2
  return blendWeight(u, curve) ** (1 / g)
}

/** A projector edge. */
export type Edge = 'left' | 'right' | 'top' | 'bottom'
/** Soft-edge band widths as a share of the output (0..0.5 each). */
export interface EdgeBlend {
  left?: number
  right?: number
  top?: number
  bottom?: number
  /** Projector gamma. Default 2.2. */
  gamma?: number
  /** Blend curve (see {@link blendWeight}). Default 2. */
  curve?: number
}

/** Stops sampled along a blend band — enough that 8-bit banding stays invisible. */
const BLEND_STOPS = 24

/**
 * A CSS gradient that darkens one edge band to its soft-edge level: black
 * with alpha `1 − pixel multiplier`, from the outer edge inwards. Empty when
 * the band has no width. (Pure.)
 */
export function blendGradient(edge: Edge, width: number, opts: { gamma?: number; curve?: number } = {}): string {
  const w = clamp(fin(width), 0, 0.5)
  if (w <= 0) return ''
  const dir = { left: 'to right', right: 'to left', top: 'to bottom', bottom: 'to top' }[edge]
  const stops: string[] = []
  for (let k = 0; k <= BLEND_STOPS; k++) {
    const s = k / BLEND_STOPS
    // s runs from the outer edge (u = 1) to the inner edge of the band (u = 0).
    const alpha = 1 - blendPixel(1 - s, opts.gamma, opts.curve)
    stops.push(`rgba(0,0,0,${Math.round(alpha * 10000) / 10000}) ${Math.round(s * w * 1e6) / 1e4}%`)
  }
  return `linear-gradient(${dir}, ${stops.join(', ')}, rgba(0,0,0,0) ${Math.round(w * 1e6) / 1e4}%)`
}

// ------------------------------------------------------------------ tiles

/** One projector's slice of a wide picture. */
export interface ProjectorTile {
  /** Left and width of the slice, as a share of the whole picture (0..1). */
  x: number
  width: number
  /** Soft-edge band on each side, as a share of the slice (0 on an outer edge). */
  blendLeft: number
  blendRight: number
}

/**
 * Splits a wide picture across `count` side-by-side projectors that overlap
 * by `overlap` of a slice (0..0.5). The slices tile the picture exactly:
 * the first starts at 0, the last ends at 1, and neighbours share the band.
 * (Pure.)
 */
export function projectorTiles(count: number, overlap = 0.15): ProjectorTile[] {
  const n = Math.max(1, Math.floor(fin(count, 1)))
  const o = n === 1 ? 0 : clamp(fin(overlap), 0, 0.5)
  const width = 1 / (n - (n - 1) * o)
  return Array.from({ length: n }, (_, i) => ({
    x: i * width * (1 - o),
    width,
    blendLeft: i > 0 ? o : 0,
    blendRight: i < n - 1 ? o : 0,
  }))
}

// ------------------------------------------------------------------ config

/** Everything a projection is calibrated with — plain JSON, safe to save and share. */
export interface ProjectionConfig {
  /** Where the picture's corners land, normalised to the output. */
  corners: Quad
  flipX: boolean
  flipY: boolean
  rotate: QuarterTurn
  blend: Required<EdgeBlend>
  /** Raise black outside the blend bands to match the overlap (0..0.3). */
  blackLevel: number
  /** Overall brightness multiplier (0..2). */
  brightness: number
  /** Only this polygon is lit (normalised points); empty = the whole output. */
  mask: Point[]
  /** Which slice of the picture this output shows (multi-projector); the full picture by default. */
  viewport: { x: number; y: number; width: number; height: number }
}

/** The config of an unwarped, unblended, full-frame output. */
export function defaultProjectionConfig(): ProjectionConfig {
  return {
    corners: unitQuad(),
    flipX: false,
    flipY: false,
    rotate: 0,
    blend: { left: 0, right: 0, top: 0, bottom: 0, gamma: 2.2, curve: 2 },
    blackLevel: 0,
    brightness: 1,
    mask: [],
    viewport: { x: 0, y: 0, width: 1, height: 1 },
  }
}

/** Upper bound on mask polygon points read from untrusted config. */
const MAX_MASK_POINTS = 256

/**
 * Validates untrusted config (a saved JSON file, a URL, localStorage) by one
 * policy: every field is checked and clamped, anything unusable falls back to
 * its default, and corners that cannot warp (degenerate or folded) reset to
 * the full frame with a YURA-022 note. Never throws, never lets NaN through.
 */
export function normalizeProjectionConfig(raw: unknown): ProjectionConfig {
  const d = defaultProjectionConfig()
  if (!raw || typeof raw !== 'object') return d
  const r = raw as Record<string, unknown>
  const num = (v: unknown, lo: number, hi: number, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback)
  const point = (v: unknown, fallback: Point): Point => {
    if (!v || typeof v !== 'object') return { ...fallback }
    const p = v as Record<string, unknown>
    return { x: num(p.x, -1, 2, fallback.x), y: num(p.y, -1, 2, fallback.y) }
  }
  if (Array.isArray(r.corners) && r.corners.length === 4) {
    const q = r.corners.map((p, i) => point(p, d.corners[i])) as Quad
    if (homography(IDENTITY_QUAD, q)) d.corners = q
    else warnCode(CODES.PROJECTION_INVALID, 'The projection corners are degenerate or folded over; using the full frame.')
  }
  d.flipX = r.flipX === true
  d.flipY = r.flipY === true
  const rot = typeof r.rotate === 'number' && Number.isFinite(r.rotate) ? (((Math.round(r.rotate / 90) % 4) + 4) % 4) * 90 : 0
  d.rotate = rot as QuarterTurn
  if (r.blend && typeof r.blend === 'object') {
    const b = r.blend as Record<string, unknown>
    d.blend = {
      left: num(b.left, 0, 0.5, 0),
      right: num(b.right, 0, 0.5, 0),
      top: num(b.top, 0, 0.5, 0),
      bottom: num(b.bottom, 0, 0.5, 0),
      gamma: num(b.gamma, 1, 4, 2.2),
      curve: num(b.curve, 1, 8, 2),
    }
  }
  d.blackLevel = num(r.blackLevel, 0, 0.3, 0)
  d.brightness = num(r.brightness, 0, 2, 1)
  if (Array.isArray(r.mask)) d.mask = r.mask.slice(0, MAX_MASK_POINTS).map((p) => point(p, { x: 0, y: 0 }))
  if (d.mask.length < 3) d.mask = []
  if (r.viewport && typeof r.viewport === 'object') {
    const v = r.viewport as Record<string, unknown>
    const x = num(v.x, 0, 0.99, 0)
    const y = num(v.y, 0, 0.99, 0)
    d.viewport = { x, y, width: num(v.width, 0.01, 1 - x, 1 - x), height: num(v.height, 0.01, 1 - y, 1 - y) }
  }
  return d
}

/** CSS for a viewport slice: scale the picture up and shift it so the slice fills the output. (Pure.) */
export function viewportTransform(v: ProjectionConfig['viewport']): string {
  if (v.x === 0 && v.y === 0 && v.width === 1 && v.height === 1) return 'none'
  const r = (n: number): number => Math.round(n * 1e6) / 1e6
  return `scale(${r(1 / v.width)}, ${r(1 / v.height)}) translate(${r(-v.x * 100)}%, ${r(-v.y * 100)}%)`
}

/** CSS clip-path for a mask polygon ('none' without one). (Pure.) */
export function maskClipPath(mask: readonly Point[]): string {
  if (mask.length < 3) return 'none'
  return `polygon(${mask.map((p) => `${Math.round(p.x * 1e5) / 1e3}% ${Math.round(p.y * 1e5) / 1e3}%`).join(', ')})`
}

// ------------------------------------------------------------------ test pattern

/**
 * An alignment test pattern as SVG markup: a 16×9 grid, diagonals, a centre
 * circle (it looks round on the wall when the warp is right), corner numbers
 * matching the calibration keys, and an 11-step grey scale for gamma and
 * black level. Scales with its box. (Pure.)
 */
export function testPatternMarkup(opts: { color?: string; label?: string } = {}): string {
  const c = /^#[0-9a-f]{3,8}$/i.test(opts.color ?? '') ? (opts.color as string) : '#ffffff'
  const lines: string[] = []
  for (let i = 0; i <= 16; i++) lines.push(`<line x1="${i * 100}" y1="0" x2="${i * 100}" y2="900" stroke-width="${i % 4 ? 1 : 3}"/>`)
  for (let j = 0; j <= 9; j++) lines.push(`<line x1="0" y1="${j * 100}" x2="1600" y2="${j * 100}" stroke-width="${j % 3 ? 1 : 3}"/>`)
  const steps = Array.from({ length: 11 }, (_, k) => {
    const v = Math.round((k / 10) * 255)
    return `<rect x="${250 + k * 100}" y="760" width="100" height="60" fill="rgb(${v},${v},${v})" stroke="none"/>`
  }).join('')
  const label = (opts.label ?? '').replace(/[<>&"']/g, '')
  const corner = (n: number, x: number, y: number, anchor: string): string =>
    `<text x="${x}" y="${y}" font-size="64" font-family="system-ui, sans-serif" text-anchor="${anchor}" fill="${c}" stroke="none">${n}</text>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none" fill="none" stroke="${c}">` +
    lines.join('') +
    `<line x1="0" y1="0" x2="1600" y2="900"/><line x1="1600" y1="0" x2="0" y2="900"/>` +
    `<circle cx="800" cy="450" r="400" stroke-width="3"/><circle cx="800" cy="450" r="12" fill="${c}"/>` +
    steps +
    corner(1, 30, 80, 'start') +
    corner(2, 1570, 80, 'end') +
    corner(3, 1570, 870, 'end') +
    corner(4, 30, 870, 'start') +
    (label ? `<text x="800" y="120" font-size="40" font-family="system-ui, sans-serif" text-anchor="middle" fill="${c}" stroke="none">${label}</text>` : '') +
    `</svg>`
  )
}

// ------------------------------------------------------------------ calibration keys

/** Normalised step of one arrow-key nudge, and with Shift (coarse) / Alt (fine). */
export const NUDGE_STEP = 0.001
export const NUDGE_STEP_COARSE = 0.01
export const NUDGE_STEP_FINE = 0.0001

/** A calibration action decoded from a key press. */
export type CalibrationAction =
  | { kind: 'select'; corner: number }
  | { kind: 'next' }
  | { kind: 'nudge'; dx: number; dy: number }
  | { kind: 'reset' }
  | { kind: 'pattern' }
  | { kind: 'exit' }

/** Decodes a key press into a calibration action (null = not a calibration key). (Pure.) */
export function calibrationKey(e: { key: string; shiftKey?: boolean; altKey?: boolean }): CalibrationAction | null {
  const step = e.shiftKey ? NUDGE_STEP_COARSE : e.altKey ? NUDGE_STEP_FINE : NUDGE_STEP
  switch (e.key) {
    case '1':
    case '2':
    case '3':
    case '4':
      return { kind: 'select', corner: Number(e.key) - 1 }
    case 'Tab':
      return { kind: 'next' }
    case 'ArrowLeft':
      return { kind: 'nudge', dx: -step, dy: 0 }
    case 'ArrowRight':
      return { kind: 'nudge', dx: step, dy: 0 }
    case 'ArrowUp':
      return { kind: 'nudge', dx: 0, dy: -step }
    case 'ArrowDown':
      return { kind: 'nudge', dx: 0, dy: step }
    case 'r':
    case 'R':
      return { kind: 'reset' }
    case 't':
    case 'T':
      return { kind: 'pattern' }
    case 'Escape':
      return { kind: 'exit' }
    default:
      return null
  }
}

// ------------------------------------------------------------------ DOM shell

/** Options for {@link projectionMapping}. Any {@link ProjectionConfig} field can be given directly. */
export interface ProjectionOptions extends Partial<Omit<ProjectionConfig, 'blend'>> {
  blend?: EdgeBlend
  /** Start in calibration mode (handles, test pattern, keys). Default false. */
  calibrate?: boolean
  /** Show the test pattern (also toggled with T while calibrating). Default: same as `calibrate`. */
  pattern?: boolean
  /** Remember the calibration in this browser under this key (optional; storage failures are ignored). */
  storageKey?: string
  /** Fill the whole viewport with a fixed black output (a projector window). Default false. */
  fullscreen?: boolean
  /** Called with the new config after every calibration change. */
  onChange?(config: ProjectionConfig): void
  /** Injectable window (tests); defaults to the global one. */
  window?: Window
}

/** Handle returned by {@link projectionMapping}. */
export interface ProjectionRun {
  /** The black output box that holds the warped content and the overlays. */
  readonly element: HTMLElement
  config(): ProjectionConfig
  /** Replace part of the config; re-renders at once. */
  set(patch: Partial<Omit<ProjectionConfig, 'blend'>> & { blend?: EdgeBlend }): void
  calibrate(on: boolean): void
  /** Show or hide the alignment test pattern. */
  pattern(on: boolean): void
  /** Ask the browser for full screen on the output (call it from a user gesture). */
  requestFullscreen(): Promise<void>
  /** Re-measure (automatic on resize where ResizeObserver exists). */
  refresh(): void
  /** Undo everything: unwarp, remove overlays, put the content back where it was. */
  stop(): void
}

/** Calibration handle diameter, em. */
const HANDLE_EM = 2.4
const HANDLE_IDLE = '#00e5ff'
const HANDLE_ACTIVE = '#ffd400'
/** Keeps a fullscreen output above page chrome. */
const FULLSCREEN_Z = '2147483000'

/**
 * Projection-maps `target` (an element or selector): wraps it in a black
 * output box, corner-pins it, and lays soft edges, black-level lift and a
 * spill mask over the output. With `calibrate`, four numbered handles can be
 * dragged (or chosen with 1–4 / Tab and nudged with the arrow keys; Shift
 * coarse, Alt fine), T toggles the test pattern, R resets, Esc finishes.
 */
export function projectionMapping(target: Element | string, opts: ProjectionOptions = {}): ProjectionRun {
  const win = opts.window ?? (globalThis as unknown as { window?: Window }).window
  const doc = win?.document
  if (!win || !doc) throw new YuraError(CODES.TARGET_NOT_FOUND, 'projectionMapping needs a DOM (window.document).', 'Call it in the browser, or pass { window } in tests.')
  const content = typeof target === 'string' ? doc.querySelector<HTMLElement>(target) : (target as HTMLElement)
  if (!content || !content.parentNode)
    throw new YuraError(CODES.TARGET_NOT_FOUND, `projectionMapping target ${typeof target === 'string' ? `"${target}" ` : ''}was not found in the document.`, 'Pass an element that is attached to the page, or a selector that matches one.')

  const storage = (() => {
    try {
      return opts.storageKey ? win.localStorage : null
    } catch {
      return null
    }
  })()
  const loadSaved = (): unknown => {
    if (!storage || !opts.storageKey) return null
    try {
      const s = storage.getItem(opts.storageKey)
      return s ? JSON.parse(s) : null
    } catch {
      return null
    }
  }
  const base = defaultProjectionConfig()
  let cfg = normalizeProjectionConfig(loadSaved() ?? { ...base, ...opts, blend: { ...base.blend, ...opts.blend } })

  // Output box: takes the content's place (or the whole viewport), black, clipped.
  const output = doc.createElement('div')
  output.setAttribute('data-yura-projection', '')
  const parent = content.parentNode
  const originalStyle = content.getAttribute('style')
  parent.insertBefore(output, content)
  Object.assign(output.style, {
    position: opts.fullscreen ? 'fixed' : 'relative',
    overflow: 'hidden',
    background: '#000000',
    ...(opts.fullscreen ? { inset: '0', zIndex: FULLSCREEN_Z } : { width: '100%' }),
  })
  // stage: the corner pin. slice: which part of the picture this output shows. Both compose.
  const stage = doc.createElement('div')
  Object.assign(stage.style, { position: 'absolute', inset: '0', transformOrigin: '0 0' })
  const slice = doc.createElement('div')
  Object.assign(slice.style, { position: 'absolute', inset: '0', transformOrigin: '0 0' })
  output.appendChild(stage)
  stage.appendChild(slice)
  slice.appendChild(content)
  Object.assign(content.style, { position: 'absolute', inset: '0', width: '100%', height: '100%' })

  const layer = (z: string): HTMLDivElement => {
    const d = doc.createElement('div')
    Object.assign(d.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: z })
    output.appendChild(d)
    return d
  }
  const pattern = doc.createElement('div')
  Object.assign(pattern.style, { position: 'absolute', inset: '0', pointerEvents: 'none', display: 'none', zIndex: '2' })
  pattern.innerHTML = testPatternMarkup({ label: '1–4 / Tab: corner · arrows: nudge (Shift ×10, Alt ×0.1) · T: pattern · R: reset · Esc: done' })
  stage.appendChild(pattern)
  const lift = layer('3')
  const blends = (['left', 'right', 'top', 'bottom'] as const).map((edge) => ({ edge, el: layer('4') }))
  const handles = [0, 1, 2, 3].map((i) => {
    const h = doc.createElement('div')
    h.textContent = String(i + 1)
    h.setAttribute('role', 'slider')
    h.setAttribute('aria-label', `Projection corner ${i + 1}`)
    Object.assign(h.style, {
      position: 'absolute',
      width: `${HANDLE_EM}em`,
      height: `${HANDLE_EM}em`,
      margin: `-${HANDLE_EM / 2}em 0 0 -${HANDLE_EM / 2}em`,
      borderRadius: '50%',
      border: `0.15em solid ${HANDLE_IDLE}`,
      background: 'rgba(0,0,0,0.6)',
      color: '#ffffff',
      font: '700 0.8em/1 system-ui, sans-serif',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      cursor: 'move',
      zIndex: '5',
      touchAction: 'none',
      userSelect: 'none',
    })
    output.appendChild(h)
    return h
  })

  let calibrating = opts.calibrate ?? false
  let showPattern = opts.pattern ?? calibrating
  let selected = 0
  let width = 0
  let height = 0

  const emit = (): void => {
    if (storage && opts.storageKey) {
      try {
        storage.setItem(opts.storageKey, JSON.stringify(cfg))
      } catch {
        // Storage full or blocked: the calibration still applies for this session.
      }
    }
    opts.onChange?.(cfg)
  }

  const render = (): void => {
    const dst = orientCorners(cfg.corners, { flipX: cfg.flipX, flipY: cfg.flipY, rotate: cfg.rotate })
    stage.style.transform = cornerPinMatrix3d(width, height, dst)
    slice.style.transform = viewportTransform(cfg.viewport)
    stage.style.filter = cfg.brightness !== 1 ? `brightness(${cfg.brightness})` : ''
    output.style.clipPath = maskClipPath(cfg.mask)
    pattern.style.display = showPattern ? 'block' : 'none'
    for (const { edge, el } of blends) el.style.background = blendGradient(edge, cfg.blend[edge], cfg.blend) || 'none'
    // The overlap shows two projectors' black, so everything outside the bands is lifted to match.
    const b = cfg.blend
    if (cfg.blackLevel > 0 && b.left + b.right + b.top + b.bottom > 0) {
      const v = Math.round(cfg.blackLevel * 255)
      Object.assign(lift.style, {
        display: 'block',
        background: `rgb(${v},${v},${v})`,
        mixBlendMode: 'lighten',
        clipPath: `inset(${b.top * 100}% ${b.right * 100}% ${b.bottom * 100}% ${b.left * 100}%)`,
      })
    } else lift.style.display = 'none'
    handles.forEach((h, i) => {
      h.style.display = calibrating ? 'flex' : 'none'
      h.style.left = `${cfg.corners[i].x * 100}%`
      h.style.top = `${cfg.corners[i].y * 100}%`
      h.style.borderColor = i === selected ? HANDLE_ACTIVE : HANDLE_IDLE
      h.setAttribute('aria-valuetext', `${Math.round(cfg.corners[i].x * 1000) / 10}%, ${Math.round(cfg.corners[i].y * 1000) / 10}%`)
    })
  }

  const measure = (): void => {
    const r = output.getBoundingClientRect()
    width = r.width
    height = r.height
    render()
  }

  // ---- calibration input
  const onKey = (e: KeyboardEvent): void => {
    if (!calibrating) return
    const a = calibrationKey(e)
    if (!a) return
    e.preventDefault()
    if (a.kind === 'select') selected = a.corner
    else if (a.kind === 'next') selected = (selected + 1) % 4
    else if (a.kind === 'nudge') cfg = { ...cfg, corners: nudgeCorner(cfg.corners, selected, a.dx, a.dy) }
    else if (a.kind === 'reset') cfg = { ...cfg, corners: unitQuad() }
    else if (a.kind === 'pattern') showPattern = !showPattern
    else calibrating = false
    render()
    if (a.kind === 'nudge' || a.kind === 'reset') emit()
  }
  let dragging = -1
  const onDown = (i: number) => (e: PointerEvent): void => {
    dragging = i
    selected = i
    ;(e.target as Element | null)?.setPointerCapture?.(e.pointerId)
    e.preventDefault()
    render()
  }
  const onMove = (e: PointerEvent): void => {
    if (dragging < 0) return
    const r = output.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) return
    const c = cfg.corners[dragging]
    cfg = { ...cfg, corners: nudgeCorner(cfg.corners, dragging, (e.clientX - r.left) / r.width - c.x, (e.clientY - r.top) / r.height - c.y) }
    render()
  }
  const onUp = (): void => {
    if (dragging >= 0) emit()
    dragging = -1
  }
  const downs = handles.map((h, i) => {
    const f = onDown(i) as EventListener
    h.addEventListener('pointerdown', f)
    return f
  })
  output.addEventListener('pointermove', onMove as EventListener)
  output.addEventListener('pointerup', onUp)
  output.addEventListener('pointercancel', onUp)
  win.addEventListener('keydown', onKey as EventListener)

  // In the page flow the output keeps the content's aspect: measure the content's natural box once.
  if (!opts.fullscreen) {
    const ratio = (() => {
      const r = content.getBoundingClientRect?.()
      return r && r.width > 0 && r.height > 0 ? r.height / r.width : 9 / 16
    })()
    output.style.aspectRatio = `${Math.round((1 / ratio) * 10000) / 10000}`
  }
  let ro: { disconnect(): void } | null = null
  const RO = (win as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver
  if (typeof RO === 'function') {
    const o = new RO(measure)
    o.observe(output)
    ro = o
  } else win.addEventListener('resize', measure)
  measure()

  return {
    element: output,
    config: () => normalizeProjectionConfig(JSON.parse(JSON.stringify(cfg))),
    set(patch) {
      cfg = normalizeProjectionConfig({ ...cfg, ...patch, blend: { ...cfg.blend, ...patch.blend } })
      render()
      emit()
    },
    calibrate(on) {
      calibrating = on
      if (opts.pattern === undefined) showPattern = on
      render()
    },
    pattern(on) {
      showPattern = on
      render()
    },
    async requestFullscreen() {
      const el = output as HTMLElement & { requestFullscreen?: () => Promise<void> }
      if (typeof el.requestFullscreen === 'function') await el.requestFullscreen()
    },
    refresh: measure,
    stop() {
      win.removeEventListener('keydown', onKey as EventListener)
      win.removeEventListener('resize', measure)
      output.removeEventListener('pointermove', onMove as EventListener)
      output.removeEventListener('pointerup', onUp)
      output.removeEventListener('pointercancel', onUp)
      handles.forEach((h, i) => h.removeEventListener('pointerdown', downs[i]))
      ro?.disconnect()
      parent.insertBefore(content, output)
      output.remove()
      if (originalStyle === null) content.removeAttribute('style')
      else content.setAttribute('style', originalStyle)
    },
  }
}

// ------------------------------------------------------------------ sync

/** Clock message on a projection sync channel. */
interface SyncMessage {
  kind: 'yura-projection-clock'
  /** Leader's timeline seconds at `sentAt`. */
  t: number
  /** Leader's wall clock (ms since the epoch) when it sent. */
  sentAt: number
  /** True while the leader's timeline is running. */
  playing: boolean
}

/** Latency beyond this is a stalled leader, not delivery delay (seconds). */
const MAX_SYNC_LATENCY = 2
/** Leader broadcast interval. */
const SYNC_INTERVAL_MS = 250
/** Followers slew toward the leader at this rate instead of jumping (1/s). */
const SYNC_SLEW = 4
/** A follower further off than this snaps (seconds). */
const SYNC_SNAP = 0.25
/** Longest frame step the follower's slew integrates (seconds). */
const SYNC_MAX_STEP = 0.1

/**
 * A follower's estimate of the leader's timeline from one message: the
 * leader's time plus how long ago it was sent (windows on one machine share
 * the wall clock). A paused leader is not extrapolated. (Pure.)
 */
export function syncedTime(msg: { t: number; sentAt: number; playing: boolean }, nowMs: number): number {
  const t = fin(msg.t)
  if (!msg.playing) return t
  return t + clamp((fin(nowMs) - fin(msg.sentAt)) / 1000, 0, MAX_SYNC_LATENCY)
}

/** Handle for {@link projectionSync}. */
export interface ProjectionSync {
  /** The shared timeline in seconds — pass it as `clock` to lyricStage / kineticLyrics. */
  clock(): number
  /** Stop broadcasting (leader) / listening (follower) and close the channel. */
  stop(): void
}

/**
 * Shares one timeline between several windows (one per projector) so every
 * output plays the same frame. The leader owns the clock (by default the
 * seconds since it started, or e.g. an `<audio>` element's currentTime) and
 * broadcasts it four times a second; followers return the leader's time,
 * slewing smoothly and snapping only on big jumps (a seek). Uses
 * BroadcastChannel (same origin: windows and tabs of one browser). Where it
 * is missing, each window simply runs its own clock.
 */
export function projectionSync(opts: { role: 'leader' | 'follower'; channel?: string; clock?: () => number; playing?: () => boolean }): ProjectionSync {
  const BC = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel
  const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000
  const start = now()
  const own = opts.clock ?? ((): number => now() - start)
  const bc = typeof BC === 'function' ? new BC(opts.channel ?? 'yura-projection') : null
  if (opts.role === 'leader') {
    const send = (): void => {
      const msg: SyncMessage = { kind: 'yura-projection-clock', t: own(), sentAt: Date.now(), playing: opts.playing?.() ?? true }
      bc?.postMessage(msg)
    }
    const timer = setInterval(send, SYNC_INTERVAL_MS)
    send()
    return {
      clock: own,
      stop() {
        clearInterval(timer)
        bc?.close()
      },
    }
  }
  let offset = 0
  let target = 0
  let have = false
  let last = now()
  const onMsg = (e: MessageEvent): void => {
    const m = e.data as SyncMessage | null
    if (!m || m.kind !== 'yura-projection-clock') return
    const want = syncedTime(m, Date.now()) - now()
    if (!Number.isFinite(want)) return
    if (!have || Math.abs(want - offset) > SYNC_SNAP) offset = want
    target = want
    have = true
  }
  bc?.addEventListener('message', onMsg as EventListener)
  return {
    clock() {
      const local = now()
      const dt = Math.min(SYNC_MAX_STEP, Math.max(0, local - last))
      last = local
      if (!have) return own()
      offset += (target - offset) * Math.min(1, dt * SYNC_SLEW)
      return local + offset
    },
    stop() {
      bc?.removeEventListener('message', onMsg as EventListener)
      bc?.close()
    },
  }
}
