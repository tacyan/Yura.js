import { test, expect } from 'bun:test'
import { galaxy, sphere, ring, vortex, flow, box, cone, helix, text, image } from '../src/shapes'
import { YuraError, CODES } from '@yura/core'

const N = 5000

test('text accepts the vertical (tategaki) option without breaking the API', () => {
  expect(text('ゆらめくヒカリ', { vertical: true }).kind).toBe('text')
  expect(text('よこがき').kind).toBe('text') // default stays horizontal / v1-compatible
})

for (const [name, spec] of [
  ['galaxy', galaxy()],
  ['sphere', sphere()],
  ['ring', ring()],
  ['vortex', vortex()],
  ['flow', flow()],
  ['box', box()],
  ['cone', cone()],
  ['helix', helix()],
] as const) {
  test(`${name} generates n*4 finite floats`, () => {
    const data = spec.generate(N) as Float32Array
    expect(data).toBeInstanceOf(Float32Array)
    expect(data.length).toBe(N * 4)
    for (let i = 0; i < data.length; i++) {
      if (!Number.isFinite(data[i])) {
        throw new Error(`non-finite value at index ${i}`)
      }
    }
  })
}

test('galaxy stays within its radius envelope', () => {
  const data = galaxy({ radius: 10 }).generate(N) as Float32Array
  let maxR = 0
  for (let i = 0; i < N; i++) {
    const r = Math.hypot(data[i * 4], data[i * 4 + 2])
    maxR = Math.max(maxR, r)
  }
  expect(maxR).toBeLessThan(16)
})

test('sphere points lie on the shell', () => {
  const data = sphere({ radius: 8 }).generate(N) as Float32Array
  for (let i = 0; i < 100; i++) {
    const r = Math.hypot(data[i * 4], data[i * 4 + 1], data[i * 4 + 2])
    expect(r).toBeGreaterThan(7)
    expect(r).toBeLessThan(8.2)
  }
})

test('box stays inside its size bounds', () => {
  const data = box({ size: [6, 8, 10] }).generate(N) as Float32Array
  let mx = 0
  let my = 0
  let mz = 0
  for (let i = 0; i < N; i++) {
    mx = Math.max(mx, Math.abs(data[i * 4]))
    my = Math.max(my, Math.abs(data[i * 4 + 1]))
    mz = Math.max(mz, Math.abs(data[i * 4 + 2]))
  }
  expect(mx).toBeLessThanOrEqual(3)
  expect(my).toBeLessThanOrEqual(4)
  expect(mz).toBeLessThanOrEqual(5)
})

test('cone stays inside its radius and height bounds', () => {
  const data = cone({ radius: 5, height: 10 }).generate(N) as Float32Array
  for (let i = 0; i < N; i++) {
    const y = data[i * 4 + 1]
    const r = Math.hypot(data[i * 4], data[i * 4 + 2])
    if (Math.abs(y) > 5.001) throw new Error(`y out of bounds at particle ${i}: ${y}`)
    const localRadius = 5 * ((5 - y) / 10)
    if (r > localRadius + 0.001) throw new Error(`r exceeds cone surface at particle ${i}: ${r}`)
  }
})

test('cone fills its volume uniformly along the height', () => {
  const data = cone({ radius: 5, height: 10 }).generate(N) as Float32Array
  let apexHalf = 0
  for (let i = 0; i < N; i++) {
    if (data[i * 4 + 1] > 0) apexHalf++
  }
  const frac = apexHalf / N
  expect(frac).toBeGreaterThan(0.08)
  expect(frac).toBeLessThan(0.18)
})

test('helix winds within its radius and spans its height', () => {
  const data = helix({ turns: 3, radius: 4, height: 10 }).generate(N) as Float32Array
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < N; i++) {
    const r = Math.hypot(data[i * 4], data[i * 4 + 2])
    expect(r).toBeGreaterThan(2)
    expect(r).toBeLessThan(6.5)
    minY = Math.min(minY, data[i * 4 + 1])
    maxY = Math.max(maxY, data[i * 4 + 1])
  }
  expect(minY).toBeLessThan(-4)
  expect(maxY).toBeGreaterThan(4)
  expect(minY).toBeGreaterThan(-7)
  expect(maxY).toBeLessThan(7)
})

// ---- image(): headless fetch + ImageBitmap + canvas fakes ------------------

interface FakeImgCanvas {
  width: number
  height: number
}

/**
 * Installs fetch/createImageBitmap/document fakes for image(). `bright` pixels
 * (in the SCALED canvas space) come back white+opaque from getImageData; all
 * other pixels are transparent black.
 */
function installImageEnv(opts: {
  bitmap: { width: number; height: number }
  bright: Array<{ x: number; y: number }>
  ok?: boolean
  status?: number
}): { canvases: FakeImgCanvas[]; uninstall: () => void } {
  const g = globalThis as Record<string, unknown>
  const prev = {
    fetch: g.fetch,
    createImageBitmap: g.createImageBitmap,
    document: g.document,
  }
  const canvases: FakeImgCanvas[] = []
  g.fetch = async () =>
    opts.ok === false
      ? { ok: false, status: opts.status ?? 404 }
      : { ok: true, blob: async () => ({}) }
  g.createImageBitmap = async () => ({ ...opts.bitmap })
  g.document = {
    createElement: () => {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: () => {},
          getImageData: (_x: number, _y: number, w: number, h: number) => {
            const data = new Uint8ClampedArray(w * h * 4)
            for (const p of opts.bright) {
              if (p.x < w && p.y < h) {
                const o = (p.y * w + p.x) * 4
                data[o] = data[o + 1] = data[o + 2] = 255
                data[o + 3] = 255
              }
            }
            return { data }
          },
        }),
      }
      canvases.push(canvas)
      return canvas
    },
  }
  return {
    canvases,
    uninstall: () => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete g[k]
        else g[k] = v
      }
    },
  }
}

test('image() samples only bright pixels and maps palette coords across them', async () => {
  const worldWidth = 8
  const env = installImageEnv({
    bitmap: { width: 4, height: 2 }, // <= 300px: drawn 1:1
    bright: [
      { x: 1, y: 0 },
      { x: 3, y: 1 },
    ],
  })
  try {
    const out = (await image('any.png', { worldWidth }).generate(200)) as Float32Array
    expect(env.canvases).toHaveLength(1)
    expect(env.canvases[0].width).toBe(4)
    expect(env.canvases[0].height).toBe(2)
    expect(out.length).toBe(200 * 4)
    const s = worldWidth / 4 // world units per source pixel
    for (let i = 0; i < 200; i++) {
      const x = out[i * 4]
      const y = out[i * 4 + 1]
      const w = out[i * 4 + 3]
      expect(Number.isFinite(out[i * 4 + 2])).toBe(true)
      // Palette coord = (px - minX) / spanX with px in {1, 3}: exactly 0 or 1,
      // and it must agree with which bright pixel the particle sits on.
      if (w === 0) {
        expect(x).toBeGreaterThanOrEqual((1 - 2) * s)
        expect(x).toBeLessThan((2 - 2) * s)
      } else {
        expect(w).toBe(1)
        expect(x).toBeGreaterThanOrEqual((3 - 2) * s)
        expect(x).toBeLessThan((4 - 2) * s)
      }
      // Both bright pixels live in rows 0-1: y stays inside the image band.
      expect(y).toBeGreaterThan(-(2 - 1) * s - 1e-6)
      expect(y).toBeLessThanOrEqual((1 - 0) * s + 1e-6)
    }
  } finally {
    env.uninstall()
  }
})

test('image() downscales large bitmaps to 300px and survives a single bright pixel', async () => {
  const env = installImageEnv({
    bitmap: { width: 600, height: 300 }, // scale = 0.5
    bright: [{ x: 10, y: 20 }],
  })
  try {
    const out = (await image('big.png').generate(32)) as Float32Array
    expect(env.canvases[0].width).toBe(300)
    expect(env.canvases[0].height).toBe(150)
    expect(out.length).toBe(32 * 4)
    // A single candidate: spanX clamps to 1, every palette coord collapses to 0.
    for (let i = 0; i < 32; i++) expect(out[i * 4 + 3]).toBe(0)
  } finally {
    env.uninstall()
  }
})

test('image() wraps load failures in YURA asset errors', async () => {
  const env = installImageEnv({ bitmap: { width: 1, height: 1 }, bright: [], ok: false, status: 404 })
  try {
    let err: unknown = null
    try {
      await image('https://nowhere.example/missing.png').generate(4)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(YuraError)
    expect((err as YuraError).code).toBe(CODES.ASSET_LOAD_FAILED)
    expect((err as YuraError).message).toContain('missing.png')
  } finally {
    env.uninstall()
  }
})
