import { YuraError, CODES } from '@yura/core'

/**
 * A shape produces one vec4 target per particle: xyz position plus w, a 0..1
 * palette coordinate the renderer maps across the color gradient. Generation
 * is CPU-side and runs once per morph step, never per frame.
 */
export interface ShapeSpec {
  readonly kind: string
  generate(n: number): Float32Array<ArrayBuffer> | Promise<Float32Array<ArrayBuffer>>
}

function gauss(): number {
  let u = 0
  let v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

export function galaxy(options: { radius?: number; arms?: number; twist?: number; tilt?: number } = {}): ShapeSpec {
  // The camera sits near the horizon, so an untilted XZ disc reads as a thin
  // bar. The default tilt leans the disc toward the viewer.
  const { radius = 11, arms = 3, twist = 0.45, tilt = 0.55 } = options
  const cosT = Math.cos(tilt)
  const sinT = Math.sin(tilt)
  return {
    kind: 'galaxy',
    generate(n) {
      const out = new Float32Array(n * 4)
      const bulge = Math.floor(n * 0.15)
      for (let i = 0; i < n; i++) {
        let x: number, y: number, z: number, w: number
        if (i < bulge) {
          x = gauss() * 1.6
          y = gauss() * 1.1
          z = gauss() * 1.6
          w = Math.random() * 0.15 // hot core
        } else {
          const t = Math.pow(Math.random(), 0.65)
          const r = t * radius
          const arm = i % arms
          const a = arm * ((Math.PI * 2) / arms) + r * twist + gauss() * 0.18
          x = Math.cos(a) * r + gauss() * 0.35
          z = Math.sin(a) * r + gauss() * 0.35
          y = gauss() * (0.5 * (1.1 - t) + 0.08)
          w = t // core -> rim gradient
        }
        const ty = y * cosT - z * sinT
        const tz = y * sinT + z * cosT
        out[i * 4] = x
        out[i * 4 + 1] = ty
        out[i * 4 + 2] = tz
        out[i * 4 + 3] = w
      }
      return out
    },
  }
}

export function sphere(options: { radius?: number } = {}): ShapeSpec {
  const { radius = 8 } = options
  return {
    kind: 'sphere',
    generate(n) {
      const out = new Float32Array(n * 4)
      for (let i = 0; i < n; i++) {
        const theta = Math.random() * Math.PI * 2
        const phi = Math.acos(2 * Math.random() - 1)
        const r = radius * (0.92 + Math.random() * 0.08)
        const y = r * Math.cos(phi)
        out[i * 4] = r * Math.sin(phi) * Math.cos(theta)
        out[i * 4 + 1] = y
        out[i * 4 + 2] = r * Math.sin(phi) * Math.sin(theta)
        out[i * 4 + 3] = (y / radius + 1) / 2 // pole-to-pole gradient
      }
      return out
    },
  }
}

export function ring(options: { radius?: number; thickness?: number } = {}): ShapeSpec {
  const { radius = 8, thickness = 1.2 } = options
  return {
    kind: 'ring',
    generate(n) {
      const out = new Float32Array(n * 4)
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2
        const b = Math.random() * Math.PI * 2
        const cx = Math.cos(a) * radius
        const cz = Math.sin(a) * radius
        out[i * 4] = cx + Math.cos(a) * Math.cos(b) * thickness
        out[i * 4 + 1] = Math.sin(b) * thickness
        out[i * 4 + 2] = cz + Math.sin(a) * Math.cos(b) * thickness
        out[i * 4 + 3] = a / (Math.PI * 2) // gradient sweeps around the ring
      }
      return out
    },
  }
}

/** Spiral funnel — a tornado of light, dramatic mid-morph. */
export function vortex(options: { height?: number; radius?: number; turns?: number } = {}): ShapeSpec {
  const { height = 13, radius = 8, turns = 3.5 } = options
  return {
    kind: 'vortex',
    generate(n) {
      const out = new Float32Array(n * 4)
      for (let i = 0; i < n; i++) {
        const u = Math.random()
        const y = (u - 0.5) * height
        const r = 0.8 + Math.pow(u, 1.6) * radius + gauss() * 0.3
        const a = u * turns * Math.PI * 2 + gauss() * 0.15 + (i % 2) * Math.PI
        out[i * 4] = Math.cos(a) * r + gauss() * 0.25
        out[i * 4 + 1] = y
        out[i * 4 + 2] = Math.sin(a) * r + gauss() * 0.25
        out[i * 4 + 3] = u // bottom-to-top gradient
      }
      return out
    },
  }
}

/** Wide drifting band — pairs with high noise for aurora-style motion. */
export function flow(options: { width?: number } = {}): ShapeSpec {
  const { width = 14 } = options
  return {
    kind: 'flow',
    generate(n) {
      const out = new Float32Array(n * 4)
      for (let i = 0; i < n; i++) {
        const x = (Math.random() * 2 - 1) * width
        out[i * 4] = x
        out[i * 4 + 1] = Math.sin(x * 0.3) * 2 + gauss() * 1.5
        out[i * 4 + 2] = gauss() * 3
        out[i * 4 + 3] = (x / width + 1) / 2 // horizontal gradient
      }
      return out
    },
  }
}

// ---- kinetic typography (text v2) ----

export type TextAlign = 'left' | 'center' | 'right'

export interface TextOptions {
  /** CSS font shorthand; weight rides inside it ('900 250px …'). px sizes auto-shrink to fit. */
  font?: string
  /** World-space width the full canvas span maps to. */
  worldWidth?: number
  /** Extra tracking between graphemes, in em (fractions of the font size). */
  letterSpacing?: number
  /** Vertical gap between lines, in em. Only matters for multi-line ('\n') text. */
  lineGap?: number
  /** Horizontal alignment of lines inside the text block. */
  align?: TextAlign
}

/**
 * Splits a string into user-perceived characters (graphemes). Uses
 * Intl.Segmenter('ja') when available so CJK, combining marks, and compound
 * emoji stay whole; falls back to Array.from (surrogate-pair safe) elsewhere.
 * (Pure; exported for tests — `useIntl: false` forces the fallback.)
 */
export function segmentGraphemes(str: string, useIntl = true): string[] {
  if (useIntl && typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const seg = new Intl.Segmenter('ja', { granularity: 'grapheme' })
    return Array.from(seg.segment(str), (s) => s.segment)
  }
  return Array.from(str)
}

/**
 * Palette/delay coordinate for one particle of a text shape: characters own
 * contiguous [i/count, (i+1)/count) bands in reading order, and `intraX`
 * (0..1 across the glyph, clamped) spreads particles inside the band. This
 * per-CHARACTER ordering is what makes a morph sweep land char-by-char
 * instead of pixel-column-by-column. (Pure; exported for tests.)
 */
export function charCoord(charIndex: number, intraX: number, charCount: number): number {
  if (charCount <= 0) return 0
  const intra = Math.min(Math.max(intraX, 0), 1)
  return Math.min((charIndex + intra) / charCount, 1)
}

export interface LinePlacement {
  /** Left edge of the line inside a box of the given width. */
  x: number
  /** Line center offset from the block's vertical center (down = positive). */
  y: number
}

/**
 * Multi-line layout: stacks lines around the vertical center and aligns each
 * horizontally inside `boxWidth`. (Pure; exported for tests.)
 */
export function layoutLines(
  lineWidths: number[],
  lineHeight: number,
  lineGap: number,
  align: TextAlign,
  boxWidth: number,
): LinePlacement[] {
  const count = lineWidths.length
  const totalH = count * lineHeight + Math.max(count - 1, 0) * lineGap
  return lineWidths.map((w, i) => ({
    x: align === 'left' ? 0 : align === 'right' ? boxWidth - w : (boxWidth - w) / 2,
    y: -totalH / 2 + lineHeight / 2 + i * (lineHeight + lineGap),
  }))
}

/**
 * Samples pixels from rasterized text. Browser-only (uses canvas 2D).
 *
 * v2: multi-line via '\n', per-grapheme segmentation (CJK first-class), and a
 * per-CHARACTER palette/delay coordinate in reading order — see charCoord().
 * Backward compatible with the v1 `{ font, worldWidth }` call sites.
 */
export function text(str: string, options: TextOptions = {}): ShapeSpec {
  const {
    font = '900 250px system-ui, Arial, sans-serif',
    worldWidth = 20,
    letterSpacing = 0,
    lineGap = 0.22,
    align = 'center',
  } = options
  return {
    kind: 'text',
    generate(n) {
      const lines = str.split('\n').map((line) => segmentGraphemes(line))
      const charCount = lines.reduce((sum, gs) => sum + gs.length, 0)
      const W = 1024
      const H = Math.min(1600, 400 * Math.max(lines.length, 1))
      // Glyph cells recorded during draw: which character owns which x-range.
      interface Cell {
        index: number
        x0: number
        x1: number
      }
      const rows: Cell[][] = []
      const rowY: number[] = []

      const candidates = rasterize((ctx, w, h) => {
        ctx.fillStyle = '#fff'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        ctx.font = font
        // Long strings (CJK especially) overflow the fixed canvas at the
        // requested size, clipping the outer glyphs. Shrink px-sized fonts
        // so the widest line AND the stacked line block fit; other units
        // fall through unscaled.
        const pxMatch = /(\d+(?:\.\d+)?)px/.exec(font)
        let fontPx = pxMatch ? Number(pxMatch[1]) : 250
        const measureLine = (gs: string[]): number =>
          gs.reduce((sum, g) => sum + ctx.measureText(g).width, 0) +
          letterSpacing * fontPx * Math.max(gs.length - 1, 0)
        let widths = lines.map(measureLine)
        const blockH = () =>
          lines.length * fontPx * 1.06 + (lines.length - 1) * fontPx * lineGap
        const fit = Math.min(
          1,
          (w * 0.94) / Math.max(1, ...widths),
          (h * 0.9) / Math.max(blockH(), 1),
        )
        if (fit < 1 && pxMatch) {
          fontPx = Math.max(8, Math.floor(fontPx * fit))
          ctx.font = font.replace(/(\d+(?:\.\d+)?)px/, `${fontPx}px`)
          widths = lines.map(measureLine)
        }

        const margin = w * 0.03
        const placed = layoutLines(widths, fontPx * 1.06, fontPx * lineGap, align, w - margin * 2)
        let index = 0
        lines.forEach((gs, li) => {
          const cells: Cell[] = []
          const y = h / 2 + placed[li].y
          rows.push(cells)
          rowY.push(y)
          let x = margin + placed[li].x
          for (const g of gs) {
            const adv = Math.max(ctx.measureText(g).width, 1)
            if (g.trim() !== '') {
              ctx.fillText(g, x, y)
              cells.push({ index, x0: x, x1: x + adv })
            }
            // Whitespace advances the pen and keeps its char index, so the
            // sweep breathes naturally at word gaps.
            x += adv + letterSpacing * fontPx
            index++
          }
        })
      }, W, H)

      const pairCount = candidates.length / 2
      if (pairCount === 0 || charCount === 0) {
        // Degenerate input: fall through to the tiny-sphere fallback.
        return sampleCandidates(candidates, W, H, n, worldWidth)
      }

      // Per-candidate coordinate: nearest drawn row by y, then the owning
      // glyph cell by x (overhang pixels clamp into the nearest band).
      const coords = new Float32Array(pairCount)
      for (let i = 0; i < pairCount; i++) {
        const px = candidates[i * 2]
        const py = candidates[i * 2 + 1]
        let row = 0
        let bestD = Infinity
        for (let r = 0; r < rowY.length; r++) {
          const d = Math.abs(py - rowY[r])
          if (rows[r].length > 0 && d < bestD) {
            bestD = d
            row = r
          }
        }
        const cells = rows[row]
        let cell = cells[0]
        for (const c of cells) {
          if (px >= c.x0) cell = c
          else break
        }
        const intra = (px - cell.x0) / Math.max(cell.x1 - cell.x0, 1)
        coords[i] = charCoord(cell.index, intra, charCount)
      }

      const out = new Float32Array(n * 4)
      const s = worldWidth / W
      for (let i = 0; i < n; i++) {
        const pick = (Math.random() * pairCount) | 0
        const px = candidates[pick * 2] + Math.random()
        const py = candidates[pick * 2 + 1] + Math.random()
        out[i * 4] = (px - W / 2) * s
        out[i * 4 + 1] = -(py - H / 2) * s
        out[i * 4 + 2] = gauss() * 0.3
        out[i * 4 + 3] = coords[pick]
      }
      return out
    },
  }
}

/** Samples an image's bright/opaque pixels. Browser-only, async. */
export function image(url: string, options: { worldWidth?: number; threshold?: number } = {}): ShapeSpec {
  const { worldWidth = 14, threshold = 0.12 } = options
  return {
    kind: 'image',
    async generate(n) {
      let bitmap: ImageBitmap
      try {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        bitmap = await createImageBitmap(await res.blob())
      } catch (err) {
        throw new YuraError(
          CODES.ASSET_LOAD_FAILED,
          `Could not load image "${url}" (${(err as Error).message}).`,
          `Check the URL is reachable and CORS-enabled, e.g.\n  shapes.image('/portrait.png')`,
        )
      }
      const maxW = 300
      const scale = Math.min(1, maxW / bitmap.width)
      const w = Math.max(1, Math.round(bitmap.width * scale))
      const h = Math.max(1, Math.round(bitmap.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(bitmap, 0, 0, w, h)
      const data = ctx.getImageData(0, 0, w, h).data
      const candidates: number[] = []
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const o = (y * w + x) * 4
          const lum = (0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2]) / 255
          const alpha = data[o + 3] / 255
          if (lum * alpha > threshold) {
            candidates.push(x, y)
          }
        }
      }
      return sampleCandidates(candidates, w, h, n, worldWidth)
    },
  }
}

function rasterize(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, w: number, h: number): number[] {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  draw(ctx, w, h)
  const data = ctx.getImageData(0, 0, w, h).data
  const candidates: number[] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 128) {
        candidates.push(x, y)
      }
    }
  }
  return candidates
}

function sampleCandidates(candidates: number[], w: number, h: number, n: number, worldWidth: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(n * 4)
  const pairCount = candidates.length / 2
  if (pairCount === 0) {
    // Degenerate input (empty text/image): tiny sphere instead of a crash.
    return sphere({ radius: 2 }).generate(n) as Float32Array<ArrayBuffer>
  }
  // Palette coordinate = normalized x across the sampled pixels, so gradients
  // sweep across letters / image features rather than the whole canvas.
  let minX = Infinity
  let maxX = -Infinity
  for (let i = 0; i < pairCount; i++) {
    const x = candidates[i * 2]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
  }
  const spanX = Math.max(maxX - minX, 1)
  const s = worldWidth / w
  for (let i = 0; i < n; i++) {
    const pick = (Math.random() * pairCount) | 0
    const px = candidates[pick * 2] + Math.random()
    const py = candidates[pick * 2 + 1] + Math.random()
    out[i * 4] = (px - w / 2) * s
    out[i * 4 + 1] = -(py - h / 2) * s
    out[i * 4 + 2] = gauss() * 0.3
    out[i * 4 + 3] = (candidates[pick * 2] - minX) / spanX
  }
  return out
}

export const shapes = { galaxy, sphere, ring, vortex, flow, text, image }
