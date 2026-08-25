import { test, expect } from 'bun:test'
import { loadGLB, parseGLB } from '../src/gltf'
import { CODES } from '@yura/core'

// ---------------------------------------------------------------------------
// GLB binary builders (assemble minimal GLB structures in-memory; no file I/O)
// ---------------------------------------------------------------------------

const GLB_MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942
const ASSET_LOAD_FAILED = 'YURA-020'

const align4 = (n: number): number => (n + 3) & ~3

interface RawChunk {
  type: number
  data: Uint8Array
}

/** Assemble a GLB container from arbitrary chunks (magic/version overridable). */
function buildGLBChunks(chunks: RawChunk[], opts: { magic?: number; version?: number } = {}): ArrayBuffer {
  const padded = chunks.map((c) => {
    const body = new Uint8Array(align4(c.data.length)).fill(c.type === CHUNK_JSON ? 0x20 : 0)
    body.set(c.data)
    return { type: c.type, body }
  })
  const total = 12 + padded.reduce((sum, c) => sum + 8 + c.body.length, 0)
  const buf = new ArrayBuffer(total)
  const dv = new DataView(buf)
  const u8 = new Uint8Array(buf)
  dv.setUint32(0, opts.magic ?? GLB_MAGIC, true)
  dv.setUint32(4, opts.version ?? 2, true)
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

/** Build a GLB from a glTF JSON object plus an optional BIN chunk. */
function buildGLB(json: object, bin?: Uint8Array): ArrayBuffer {
  const chunks: RawChunk[] = [{ type: CHUNK_JSON, data: new TextEncoder().encode(JSON.stringify(json)) }]
  if (bin) chunks.push({ type: CHUNK_BIN, data: bin })
  return buildGLBChunks(chunks)
}

/** Concatenate typed arrays into one BIN payload, 4-byte aligning each part. */
function packBin(parts: ArrayBufferView[]): { bin: Uint8Array<ArrayBuffer>; offsets: number[] } {
  const offsets: number[] = []
  let off = 0
  for (const p of parts) {
    off = align4(off)
    offsets.push(off)
    off += p.byteLength
  }
  const bin = new Uint8Array(align4(off))
  parts.forEach((p, i) => bin.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), offsets[i]))
  return { bin, offsets }
}

/** Right triangle in the XY plane: (0,0,0) (1,0,0) (0,1,0). */
const TRI = [0, 0, 0, 1, 0, 0, 0, 1, 0]

/** Minimal single-triangle asset: f32 positions + u16 indices in one buffer. */
function triangleAsset(nodeExtra: object = {}): { json: Record<string, unknown>; bin: Uint8Array<ArrayBuffer> } {
  const positions = new Float32Array(TRI)
  const indices = new Uint16Array([0, 1, 2])
  const { bin, offsets } = packBin([positions, indices])
  const json: Record<string, unknown> = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: offsets[0], byteLength: positions.byteLength },
      { buffer: 0, byteOffset: offsets[1], byteLength: indices.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    nodes: [{ mesh: 0, ...nodeExtra }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  }
  return { json, bin }
}

async function caught(p: Promise<unknown>): Promise<{ code?: string; message?: string }> {
  try {
    await p
  } catch (e) {
    return e as { code?: string; message?: string }
  }
  throw new Error('expected promise to reject')
}

/** Swap in a fetch mock for the duration of run(); returns requested URLs. */
async function withMockFetch(impl: (url: string) => Response | Promise<Response>, run: () => Promise<void>): Promise<string[]> {
  const calls: string[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    return impl(url)
  }) as typeof fetch
  try {
    await run()
  } finally {
    globalThis.fetch = orig
  }
  return calls
}

/** Stub createImageBitmap (absent in Bun); returns the blob MIME types seen. */
async function withStubImageBitmap(run: () => Promise<void>): Promise<string[]> {
  const types: string[] = []
  const g = globalThis as { createImageBitmap?: typeof createImageBitmap }
  const orig = g.createImageBitmap
  g.createImageBitmap = (async (src: ImageBitmapSource) => {
    types.push(src instanceof Blob ? src.type : '')
    return { width: 1, height: 1, close() {} } as ImageBitmap
  }) as typeof createImageBitmap
  try {
    await run()
  } finally {
    if (orig) g.createImageBitmap = orig
    else delete g.createImageBitmap
  }
  return types
}

// ---------------------------------------------------------------------------
// Happy path + defaults
// ---------------------------------------------------------------------------

test('parseGLB reads a minimal triangle GLB with node transform', async () => {
  const { json, bin } = triangleAsset({ translation: [1, 0, 0] })
  const model = await parseGLB(buildGLB(json, bin))
  expect(model.primitives.length).toBe(1)
  const p = model.primitives[0]
  expect(p.positions.length).toBe(9)
  expect(Array.from(p.indices)).toEqual([0, 1, 2])
  expect(model.min[0]).toBeCloseTo(1)
  expect(model.max[0]).toBeCloseTo(2)
  expect(model.materials.length).toBe(1)
})

test('parseGLB synthesizes a default PBR material when the file has none', async () => {
  const { json, bin } = triangleAsset()
  const model = await parseGLB(buildGLB(json, bin))
  expect(model.materials.length).toBe(1)
  const m = model.materials[0]
  expect(m.baseColorFactor).toEqual([0.8, 0.8, 0.85, 1])
  expect(m.metallicFactor).toBeCloseTo(0.2)
  expect(m.roughnessFactor).toBeCloseTo(0.5)
  expect(m.emissiveFactor).toEqual([0, 0, 0])
  expect(m.baseColorImage).toBe(-1)
  expect(m.mrImage).toBe(-1)
  expect(m.normalImage).toBe(-1)
  expect(m.emissiveImage).toBe(-1)
  expect(m.occlusionImage).toBe(-1)
  expect(model.primitives[0].materialIndex).toBe(0)
  expect(model.images.length).toBe(0)
})

// ---------------------------------------------------------------------------
// GLB container: magic / chunk boundary abnormal cases
// ---------------------------------------------------------------------------

test('parseGLB rejects non-GLB data with YURA-020', async () => {
  const err = await caught(parseGLB(new ArrayBuffer(64)))
  expect(err.code).toBe(ASSET_LOAD_FAILED)
})

test('parseGLB rejects a buffer shorter than the GLB header', async () => {
  const err = await caught(parseGLB(new ArrayBuffer(0)))
  expect(err.code).toBe(ASSET_LOAD_FAILED)
})

test('parseGLB rejects a GLB whose JSON chunk is missing', async () => {
  const binOnly = buildGLBChunks([{ type: CHUNK_BIN, data: new Uint8Array([1, 2, 3, 4]) }])
  const err = await caught(parseGLB(binOnly))
  expect(err.code).toBe(ASSET_LOAD_FAILED)
  expect(err.message).toContain('JSON chunk')
})

test('parseGLB ignores unknown chunk types', async () => {
  const { json, bin } = triangleAsset()
  const glb = buildGLBChunks([
    { type: 0x12345678, data: new Uint8Array([9, 9, 9, 9]) },
    { type: CHUNK_JSON, data: new TextEncoder().encode(JSON.stringify(json)) },
    { type: CHUNK_BIN, data: bin },
  ])
  const model = await parseGLB(glb)
  expect(model.primitives.length).toBe(1)
})

test('parseGLB rejects a chunk whose declared length overruns the buffer', async () => {
  const buf = new ArrayBuffer(20)
  const dv = new DataView(buf)
  dv.setUint32(0, GLB_MAGIC, true)
  dv.setUint32(4, 2, true)
  dv.setUint32(8, 20, true)
  dv.setUint32(12, 0x1000, true) // declared chunk length far past the buffer end
  dv.setUint32(16, CHUNK_JSON, true)
  const err = await caught(parseGLB(buf))
  expect(err.code).toBe(ASSET_LOAD_FAILED)
  expect(err.message).toContain('declares 4096 bytes')
})

test('parseGLB rejects a BIN chunk that overruns instead of silently truncating', async () => {
  const { json, bin } = triangleAsset()
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const glb = buildGLBChunks([
    { type: CHUNK_JSON, data: jsonBytes },
    { type: CHUNK_BIN, data: bin },
  ])
  // Inflate the BIN chunk's declared length past the end of the buffer.
  const binHeader = 12 + 8 + align4(jsonBytes.length)
  const dv = new DataView(glb)
  dv.setUint32(binHeader, dv.getUint32(binHeader, true) + 64, true)
  const err = await caught(parseGLB(glb))
  expect(err.code).toBe(ASSET_LOAD_FAILED)
})

test('parseGLB rejects an unsupported GLB container version with YURA-020', async () => {
  const { json, bin } = triangleAsset()
  const glb = buildGLBChunks(
    [
      { type: CHUNK_JSON, data: new TextEncoder().encode(JSON.stringify(json)) },
      { type: CHUNK_BIN, data: bin },
    ],
    { version: 1 },
  )
  const err = await caught(parseGLB(glb))
  expect(err.code).toBe(ASSET_LOAD_FAILED)
  expect(err.message).toContain('version 1')
})

// ---------------------------------------------------------------------------
// loadGLB fetch wrapper
// ---------------------------------------------------------------------------

test('loadGLB wraps network failures in YURA-020 with the URL', async () => {
  await withMockFetch(
    () => {
      throw new Error('boom')
    },
    async () => {
      const err = await caught(loadGLB('http://test.local/missing.glb'))
      expect(err.code).toBe(ASSET_LOAD_FAILED)
      expect(err.message).toContain('http://test.local/missing.glb')
      expect(err.message).toContain('boom')
    },
  )
})

test('loadGLB wraps non-2xx responses in YURA-020', async () => {
  await withMockFetch(
    () => new Response('nope', { status: 404 }),
    async () => {
      const err = await caught(loadGLB('http://test.local/gone.glb'))
      expect(err.code).toBe(ASSET_LOAD_FAILED)
      expect(err.message).toContain('HTTP 404')
    },
  )
})

test('loadGLB fetches and parses a GLB on success', async () => {
  const { json, bin } = triangleAsset()
  const glb = buildGLB(json, bin)
  const calls = await withMockFetch(
    () => new Response(glb),
    async () => {
      const model = await loadGLB('http://test.local/tri.glb')
      expect(model.primitives.length).toBe(1)
    },
  )
  expect(calls).toEqual(['http://test.local/tri.glb'])
})

test('parseGLB fetches external buffers referenced by uri', async () => {
  const { json, bin } = triangleAsset()
  json.buffers = [{ byteLength: bin.byteLength, uri: 'geometry.bin' }]
  const glb = buildGLB(json) // no BIN chunk on purpose
  const calls = await withMockFetch(
    () => new Response(bin),
    async () => {
      const model = await parseGLB(glb, 'http://test.local/assets/model.glb')
      expect(model.primitives.length).toBe(1)
      expect(Array.from(model.primitives[0].indices)).toEqual([0, 1, 2])
    },
  )
  expect(calls).toEqual(['http://test.local/assets/geometry.bin'])
})

// ---------------------------------------------------------------------------
// Accessor decoding: component types, normalization, stride, offsets
// ---------------------------------------------------------------------------

test('parseGLB zero-fills accessors that have no bufferView', async () => {
  const json = {
    asset: { version: '2.0' },
    accessors: [{ componentType: 5126, count: 3, type: 'VEC3' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
  }
  const model = await parseGLB(buildGLB(json))
  const p = model.primitives[0]
  expect(Array.from(p.positions)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0])
  // No indices accessor: identity index buffer is synthesized.
  expect(Array.from(p.indices)).toEqual([0, 1, 2])
  expect(model.min).toEqual([0, 0, 0])
  expect(model.max).toEqual([0, 0, 0])
})

test('parseGLB decodes every component type with normalization', async () => {
  const positions = new Float32Array(TRI)
  const normA = new Int16Array([32767, 0, 0, 0, 32767, 0, 0, 0, -32768]) // 5122 normalized
  const uvA = new Uint8Array([0, 255, 255, 0, 128, 64]) // 5121 normalized
  const idxA = new Uint32Array([0, 1, 2]) // 5125
  const normB = new Int8Array([127, 0, 0, 0, 127, 0, -128, 0, 0]) // 5120 normalized
  const uvB = new Uint16Array([0, 65535, 32768, 0, 65535, 65535]) // 5123 normalized
  const { bin, offsets } = packBin([positions, normA, uvA, idxA, normB, uvB])
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [positions, normA, uvA, idxA, normB, uvB].map((arr, i) => ({
      buffer: 0,
      byteOffset: offsets[i],
      byteLength: arr.byteLength,
    })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5122, count: 3, type: 'VEC3', normalized: true },
      { bufferView: 2, componentType: 5121, count: 3, type: 'VEC2', normalized: true },
      { bufferView: 3, componentType: 5125, count: 3, type: 'SCALAR' },
      { bufferView: 4, componentType: 5120, count: 3, type: 'VEC3', normalized: true },
      { bufferView: 5, componentType: 5123, count: 3, type: 'VEC2', normalized: true },
    ],
    meshes: [
      {
        primitives: [
          { attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3 },
          { attributes: { POSITION: 0, NORMAL: 4, TEXCOORD_0: 5 } },
        ],
      },
    ],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
  }
  const model = await parseGLB(buildGLB(json, bin))
  expect(model.primitives.length).toBe(2)
  const [a, b] = model.primitives
  // Int16 normalized: 32767 -> 1, -32768 clamps to -1.
  expect(a.normals[0]).toBeCloseTo(1)
  expect(a.normals[4]).toBeCloseTo(1)
  expect(a.normals[8]).toBeCloseTo(-1)
  // Uint8 normalized: 255 -> 1, 128 -> 128/255.
  expect(a.uvs[1]).toBeCloseTo(1)
  expect(a.uvs[4]).toBeCloseTo(128 / 255)
  expect(a.uvs[5]).toBeCloseTo(64 / 255)
  // Uint32 indices.
  expect(Array.from(a.indices)).toEqual([0, 1, 2])
  // Int8 normalized: 127 -> 1, -128 clamps to -1.
  expect(b.normals[0]).toBeCloseTo(1)
  expect(b.normals[6]).toBeCloseTo(-1)
  // Uint16 normalized: 65535 -> 1, 32768 -> 32768/65535.
  expect(b.uvs[0]).toBeCloseTo(0)
  expect(b.uvs[1]).toBeCloseTo(1)
  expect(b.uvs[2]).toBeCloseTo(32768 / 65535)
})

test('parseGLB keeps uint32 indices above 2^24 exact', async () => {
  const positions = new Float32Array(TRI)
  const big = 2 ** 24 + 1 // 16777217 is not representable in a Float32
  const indices = new Uint32Array([0, 1, big])
  const { bin, offsets } = packBin([positions, indices])
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: offsets[0], byteLength: positions.byteLength },
      { buffer: 0, byteOffset: offsets[1], byteLength: indices.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5125, count: 3, type: 'SCALAR' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
  }
  // The fixture is deliberately out of range — a primitive with 2^24 vertices
  // is not something a test can build — so the range check rejects it. That
  // still proves the original property: the reported value is 16777217, not
  // the 16777216 a Float32 round-trip would produce. readIndices stays on the
  // integer path.
  const err = await caught(parseGLB(buildGLB(json, bin)))
  expect(err.code).toBe(CODES.ASSET_LOAD_FAILED)
  expect(err.message).toContain(String(big))
  expect(err.message).not.toContain(String(2 ** 24))
})

test('parseGLB reads uint8 indices and zero-fills index accessors without a bufferView', async () => {
  const positions = new Float32Array(TRI)
  const idx8 = new Uint8Array([2, 1, 0])
  const { bin, offsets } = packBin([positions, idx8])
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: offsets[0], byteLength: positions.byteLength },
      { buffer: 0, byteOffset: offsets[1], byteLength: idx8.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5121, count: 3, type: 'SCALAR' },
      { componentType: 5125, count: 3, type: 'SCALAR' },
    ],
    meshes: [
      {
        primitives: [
          { attributes: { POSITION: 0 }, indices: 1 },
          { attributes: { POSITION: 0 }, indices: 2 },
        ],
      },
    ],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
  }
  const model = await parseGLB(buildGLB(json, bin))
  expect(Array.from(model.primitives[0].indices)).toEqual([2, 1, 0])
  expect(Array.from(model.primitives[1].indices)).toEqual([0, 0, 0])
})

test('parseGLB honors byteStride and byteOffset for interleaved vertex data', async () => {
  // Per-vertex layout: [x, y, z, u, v] as f32 -> stride 20 bytes.
  const interleaved = new Float32Array([
    0, 0, 0, 0.5, 0.25,
    2, 0, 0, 1, 0,
    0, 2, 0, 0, 1,
  ])
  const junkPrefix = new Uint8Array(4) // exercised via bufferView.byteOffset
  const { bin, offsets } = packBin([junkPrefix, interleaved])
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: offsets[1], byteLength: interleaved.byteLength, byteStride: 20 }],
    accessors: [
      { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 0, byteOffset: 12, componentType: 5126, count: 3, type: 'VEC2' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 } }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
  }
  const model = await parseGLB(buildGLB(json, bin))
  const p = model.primitives[0]
  expect(Array.from(p.positions)).toEqual([0, 0, 0, 2, 0, 0, 0, 2, 0])
  expect(Array.from(p.uvs)).toEqual([0.5, 0.25, 1, 0, 0, 1])
  expect(model.max[0]).toBeCloseTo(2)
  expect(model.max[1]).toBeCloseTo(2)
})

// ---------------------------------------------------------------------------
// Materials and textures
// ---------------------------------------------------------------------------

test('parseGLB resolves PBR factors and texture->image indices', async () => {
  const { json, bin } = triangleAsset()
  json.textures = [{ source: 2 }, { source: 0 }, {}] // last one has no source
  json.materials = [
    {
      pbrMetallicRoughness: {
        baseColorFactor: [0.1, 0.2, 0.3, 0.4],
        metallicFactor: 0.7,
        roughnessFactor: 0.3,
        baseColorTexture: { index: 0 },
        metallicRoughnessTexture: { index: 1 },
      },
      normalTexture: { index: 0 },
      emissiveTexture: { index: 2 },
      occlusionTexture: { index: 1 },
      emissiveFactor: [1, 0.5, 0],
    },
    {}, // spec defaults, no textures
  ]
  json.meshes = [
    {
      primitives: [
        { attributes: { POSITION: 0 }, indices: 1, material: 0 },
        { attributes: { POSITION: 0 }, indices: 1, material: 1 },
      ],
    },
  ]
  const model = await parseGLB(buildGLB(json, bin))
  expect(model.materials.length).toBe(2)
  const [m0, m1] = model.materials
  expect(m0.baseColorFactor).toEqual([0.1, 0.2, 0.3, 0.4])
  expect(m0.metallicFactor).toBeCloseTo(0.7)
  expect(m0.roughnessFactor).toBeCloseTo(0.3)
  expect(m0.emissiveFactor).toEqual([1, 0.5, 0])
  expect(m0.baseColorImage).toBe(2) // texture 0 -> image 2
  expect(m0.mrImage).toBe(0) // texture 1 -> image 0
  expect(m0.normalImage).toBe(2)
  expect(m0.emissiveImage).toBe(-1) // texture 2 has no source
  expect(m0.occlusionImage).toBe(0)
  // glTF spec defaults for an empty material.
  expect(m1.baseColorFactor).toEqual([1, 1, 1, 1])
  expect(m1.metallicFactor).toBe(1)
  expect(m1.roughnessFactor).toBe(1)
  expect(m1.emissiveFactor).toEqual([0, 0, 0])
  expect(m1.baseColorImage).toBe(-1)
  expect(model.primitives[0].materialIndex).toBe(0)
  expect(model.primitives[1].materialIndex).toBe(1)
})

test('parseGLB decodes embedded, external, and empty images', async () => {
  const positions = new Float32Array(TRI)
  const imgBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
  const { bin, offsets } = packBin([positions, imgBytes])
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: offsets[0], byteLength: positions.byteLength },
      { buffer: 0, byteOffset: offsets[1], byteLength: imgBytes.byteLength },
    ],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    images: [
      { bufferView: 1, mimeType: 'image/jpeg' }, // embedded, explicit MIME
      { bufferView: 1 }, // embedded, default MIME
      { uri: 'tex.png' }, // external
      {}, // neither bufferView nor uri
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
  }
  let fetchCalls: string[] = []
  const types = await withStubImageBitmap(async () => {
    fetchCalls = await withMockFetch(
      () => new Response(imgBytes, { headers: { 'Content-Type': 'image/webp' } }),
      async () => {
        const model = await parseGLB(buildGLB(json, bin), 'http://test.local/dir/model.glb')
        expect(model.images.length).toBe(4)
      },
    )
  })
  expect(fetchCalls).toEqual(['http://test.local/dir/tex.png'])
  expect(types.length).toBe(4)
  expect(types[0]).toBe('image/jpeg')
  expect(types[1]).toBe('image/png') // default MIME for embedded images
  expect(types[3]).toBe('') // empty Blob fallback
})

// ---------------------------------------------------------------------------
// Scene graph traversal
// ---------------------------------------------------------------------------

test('parseGLB applies node matrix transforms and infers roots without scenes', async () => {
  const { json, bin } = triangleAsset()
  // Parent translates +1 in X (TRS); child carries the mesh with a matrix
  // translating +2 in Z (column-major). No scenes: roots must be inferred.
  json.nodes = [
    { children: [1], translation: [1, 0, 0] },
    { mesh: 0, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 2, 1] },
  ]
  delete json.scenes
  delete json.scene
  const model = await parseGLB(buildGLB(json, bin))
  // The child is reachable only through the parent: exactly one primitive.
  expect(model.primitives.length).toBe(1)
  expect(model.min[0]).toBeCloseTo(1)
  expect(model.max[0]).toBeCloseTo(2)
  expect(model.min[2]).toBeCloseTo(2)
  expect(model.max[2]).toBeCloseTo(2)
})

test('parseGLB visits children once when scenes exist but declare no node list', async () => {
  const { json, bin } = triangleAsset()
  json.nodes = [{ children: [1], translation: [1, 0, 0] }, { mesh: 0 }]
  json.scenes = [{}] // scene present, but without an explicit root list
  const model = await parseGLB(buildGLB(json, bin))
  // Node 1 must be visited only via its parent, never again as a root.
  expect(model.primitives.length).toBe(1)
  expect(model.min[0]).toBeCloseTo(1)
  expect(model.max[0]).toBeCloseTo(2)
})

test('parseGLB skips non-triangle and position-less primitives, clamps material index', async () => {
  const { json, bin } = triangleAsset()
  json.materials = [{}]
  json.meshes = [
    {
      primitives: [
        { attributes: { POSITION: 0 }, indices: 1, mode: 1 }, // LINES: skipped
        { attributes: {} }, // no POSITION: skipped
        { attributes: { POSITION: 0 }, indices: 1, mode: 4, material: 3 }, // kept, material out of range
      ],
    },
  ]
  const model = await parseGLB(buildGLB(json, bin))
  expect(model.primitives.length).toBe(1)
  expect(model.primitives[0].materialIndex).toBe(0) // clamped to materials.length - 1
})

test('parseGLB rejects a model with no triangle meshes', async () => {
  const { json, bin } = triangleAsset()
  json.meshes = [{ primitives: [{ attributes: { POSITION: 0 }, mode: 0 }] }]
  const err = await caught(parseGLB(buildGLB(json, bin)))
  expect(err.code).toBe(ASSET_LOAD_FAILED)
  expect(err.message).toContain('no triangle meshes')
})

// --- Corrupt files must surface as YURA-020, never as garbage or a crash ----
//
// parseGLB validates every index and every byte range, but four holes let a
// bad .glb through: a zero byteStride collapsed the mesh to a point, indices
// past the vertex array and short attribute accessors reached the GPU, and a
// node cycle that did not touch a scene root recursed until the stack blew.

test('a zero byteStride reads tightly packed instead of collapsing the mesh', async () => {
  const { json, bin } = triangleAsset()
  // glTF's schema puts byteStride in 4..252, but exporters do emit 0 for
  // "tightly packed", which is also what an absent byteStride means.
  ;(json.bufferViews as Array<Record<string, unknown>>)[0].byteStride = 0
  const model = await parseGLB(buildGLB(json, bin))
  expect(Array.from(model.primitives[0].positions)).toEqual(TRI)
})

test('an index past the end of the vertex array is rejected', async () => {
  const positions = new Float32Array(TRI)
  const indices = new Uint16Array([0, 1, 99]) // only 3 vertices exist
  const { bin, offsets } = packBin([positions, indices])
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: offsets[0], byteLength: positions.byteLength },
      { buffer: 0, byteOffset: offsets[1], byteLength: indices.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  }
  const err = await caught(parseGLB(buildGLB(json, bin)))
  expect(err.code).toBe(CODES.ASSET_LOAD_FAILED)
  expect(err.message).toContain('99')
})

test('an attribute accessor shorter than POSITION is rejected', async () => {
  const positions = new Float32Array(TRI)
  const normals = new Float32Array([0, 0, 1]) // one vertex, not three
  const indices = new Uint16Array([0, 1, 2])
  const { bin, offsets } = packBin([positions, normals, indices])
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: offsets[0], byteLength: positions.byteLength },
      { buffer: 0, byteOffset: offsets[1], byteLength: normals.byteLength },
      { buffer: 0, byteOffset: offsets[2], byteLength: indices.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 1, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  }
  const err = await caught(parseGLB(buildGLB(json, bin)))
  expect(err.code).toBe(CODES.ASSET_LOAD_FAILED)
  expect(err.message).toContain('NORMAL')
})

test('a node cycle below the scene root is rejected, not recursed into', async () => {
  const { json, bin } = triangleAsset()
  // 0 -> 1 -> 2 -> 1. Root pruning only removes nodes that appear as a child,
  // so node 0 stays a root and the walk falls into the 1/2 loop.
  json.nodes = [{ children: [1] }, { children: [2] }, { children: [1], mesh: 0 }]
  json.scenes = [{ nodes: [0] }]
  const err = await caught(parseGLB(buildGLB(json, bin)))
  expect(err.code).toBe(CODES.ASSET_LOAD_FAILED)
  expect(err.message).toContain('cycle')
})
