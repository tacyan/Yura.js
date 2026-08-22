/**
 * Deterministic fuzz tests for the GLB parser (parseGLB / loadGLB).
 *
 * Contract under test: whatever bytes are thrown at the parser, the ONLY
 * exception that may escape is a YuraError (code YURA-*). Raw RangeError /
 * TypeError / SyntaxError leaking out is a bug.
 *
 * Randomness is a seeded LCG implemented below (no Math.random) so every
 * run is reproducible: the assertion messages carry the seed and case
 * number needed to replay a failure.
 */
import { test, expect } from 'bun:test'
import { parseGLB, loadGLB } from '../src/gltf'

const SEED = 0x5eed01

/** Deterministic 32-bit LCG (numerical recipes constants). */
function makeLcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

const randInt = (rng: () => number, min: number, maxIncl: number): number =>
  min + Math.floor(rng() * (maxIncl - min + 1))

/** Structural YuraError check (no cross-package instanceof dependency). */
const isYuraError = (e: unknown): boolean => {
  if (!(e instanceof Error) || e.name !== 'YuraError') return false
  const code = (e as Error & { code?: unknown }).code
  return typeof code === 'string' && code.startsWith('YURA-')
}

const describeError = (e: unknown): string => {
  if (e instanceof Error) return `${e.constructor.name}: ${e.message.split('\n')[0].slice(0, 140)}`
  return `${typeof e}: ${String(e).slice(0, 140)}`
}

/** Runs one parse case; returns a leak description if a non-YuraError escaped. */
async function runCase(buf: ArrayBuffer): Promise<string | null> {
  try {
    await parseGLB(buf)
    return null
  } catch (e) {
    return isYuraError(e) ? null : describeError(e)
  }
}

function report(leaks: string[], total: number, corpus: string): void {
  if (leaks.length === 0) return
  throw new Error(
    `[fuzz seed=0x${SEED.toString(16)} corpus=${corpus}] ` +
      `${leaks.length}/${total} cases leaked a non-YuraError exception:\n` +
      leaks
        .slice(0, 6)
        .map((l) => `  ${l}`)
        .join('\n') +
      (leaks.length > 6 ? `\n  ... and ${leaks.length - 6} more` : ''),
  )
}

// ---------------------------------------------------------------------------
// Valid base GLB fixture (triangle, no external URIs, no images).
// ---------------------------------------------------------------------------

const GLB_MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942
const align4 = (n: number): number => (n + 3) & ~3

function buildGLB(
  chunks: Array<{ type: number; data: Uint8Array }>,
  header: { magic?: number; version?: number } = {},
): ArrayBuffer {
  const padded = chunks.map((c) => {
    const body = new Uint8Array(align4(c.data.length)).fill(c.type === CHUNK_JSON ? 0x20 : 0)
    body.set(c.data)
    return { type: c.type, body }
  })
  const total = 12 + padded.reduce((sum, c) => sum + 8 + c.body.length, 0)
  const buf = new ArrayBuffer(total)
  const dv = new DataView(buf)
  const u8 = new Uint8Array(buf)
  dv.setUint32(0, header.magic ?? GLB_MAGIC, true)
  dv.setUint32(4, header.version ?? 2, true)
  dv.setUint32(8, total, true)
  let off = 12
  for (const c of padded) {
    dv.setUint32(off, c.body.length, true)
    dv.setUint32(off + 4, c.type, true)
    u8.set(c.body, off + 8)
    off += 8 + c.body.length
  }
  return buf
}

function validGLB(): ArrayBuffer {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const indices = new Uint16Array([0, 1, 2])
  const idxOffset = align4(positions.byteLength)
  const bin = new Uint8Array(align4(idxOffset + indices.byteLength))
  bin.set(new Uint8Array(positions.buffer), 0)
  bin.set(new Uint8Array(indices.buffer), idxOffset)
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: idxOffset, byteLength: indices.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [1, 0.5, 0.25, 1],
          metallicFactor: 0.3,
          roughnessFactor: 0.7,
        },
        emissiveFactor: [0, 0, 0],
      },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    nodes: [{ mesh: 0, translation: [1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  }
  return buildGLB([
    { type: CHUNK_JSON, data: new TextEncoder().encode(JSON.stringify(json)) },
    { type: CHUNK_BIN, data: bin },
  ])
}

/**
 * Replaces globalThis.fetch for the duration of `run` so no fuzz case can
 * touch the network (keeps every case deterministic). Restored afterwards.
 */
async function withFetch<T>(
  impl: ((url: string) => Response) | null,
  run: () => Promise<T>,
): Promise<T> {
  const orig = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (!impl) throw new Error('fuzz: unexpected network access')
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    return impl(url)
  }) as typeof fetch
  try {
    return await run()
  } finally {
    globalThis.fetch = orig
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('fuzz sanity: the untouched base GLB parses cleanly', async () => {
  await withFetch(null, async () => {
    const model = await parseGLB(validGLB())
    expect(model.primitives.length).toBe(1)
    expect(model.materials.length).toBe(1)
  })
})

test('parseGLB throws only YuraError on random byte streams', async () => {
  const CASES = 120
  const rng = makeLcg(SEED ^ 0x101)
  const leaks: string[] = []
  await withFetch(null, async () => {
    for (let i = 0; i < CASES; i++) {
      const len = randInt(rng, 0, 192)
      const u8 = new Uint8Array(len)
      for (let j = 0; j < len; j++) u8[j] = randInt(rng, 0, 255)
      // style 0: fully random; style 1: valid GLB header + random tail;
      // style 2: valid header + declared JSON chunk full of random bytes.
      const style = i % 3
      if (style >= 1 && len >= 12) {
        const dv = new DataView(u8.buffer)
        dv.setUint32(0, GLB_MAGIC, true)
        dv.setUint32(4, 2, true)
        dv.setUint32(8, len, true)
        if (style === 2 && len >= 20) {
          dv.setUint32(12, len - 20, true)
          dv.setUint32(16, CHUNK_JSON, true)
        }
      }
      const leak = await runCase(u8.buffer)
      if (leak) leaks.push(`case=${i} len=${len} style=${style} -> ${leak}`)
    }
  })
  report(leaks, CASES, 'random-bytes')
})

test('parseGLB throws only YuraError on 1-byte mutations of a valid GLB', async () => {
  const CASES = 280
  const base = new Uint8Array(validGLB())
  const rng = makeLcg(SEED ^ 0x202)
  const leaks: string[] = []
  await withFetch(null, async () => {
    for (let i = 0; i < CASES; i++) {
      const copy = base.slice()
      // First cases walk the 12-byte header + first chunk header byte by
      // byte (magic / version / length / chunk length / chunk type), the
      // rest hit seeded random positions (JSON body, BIN payload, padding).
      const pos = i < 24 ? i % copy.length : randInt(rng, 0, copy.length - 1)
      const flip = randInt(rng, 1, 255)
      copy[pos] = copy[pos] ^ flip
      const leak = await runCase(copy.buffer)
      if (leak) leaks.push(`case=${i} pos=${pos} xor=0x${flip.toString(16)} -> ${leak}`)
    }
  })
  report(leaks, CASES, '1-byte-mutation')
})

test('loadGLB throws only YuraError for mutated payloads and network failures', async () => {
  const CASES = 60
  const base = new Uint8Array(validGLB())
  const rng = makeLcg(SEED ^ 0x303)
  const leaks: string[] = []
  let current: () => Response = () => new Response(base.slice())
  await withFetch(
    (url) => current(),
    async () => {
      for (let i = 0; i < CASES; i++) {
        const mode = i % 6
        let mustReject = false
        if (mode === 4) {
          current = () => {
            throw new Error('fuzz: network down')
          }
          mustReject = true
        } else if (mode === 5) {
          current = () => new Response('teapot', { status: 418 })
          mustReject = true
        } else {
          const copy = base.slice()
          const pos = randInt(rng, 0, copy.length - 1)
          copy[pos] = copy[pos] ^ randInt(rng, 1, 255)
          current = () => new Response(copy)
        }
        try {
          await loadGLB('http://fuzz.local/model.glb')
          if (mustReject) leaks.push(`case=${i} mode=${mode} -> resolved but a rejection was required`)
        } catch (e) {
          if (!isYuraError(e)) leaks.push(`case=${i} mode=${mode} -> ${describeError(e)}`)
        }
      }
    },
  )
  report(leaks, CASES, 'loadGLB')
})
