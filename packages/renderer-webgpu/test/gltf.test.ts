import { test, expect } from 'bun:test'
import { parseGLB } from '../src/gltf'

/** Build a minimal valid GLB with one triangle in memory. */
function makeTriangleGLB(): ArrayBuffer {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const indices = new Uint16Array([0, 1, 2])
  const binLen = positions.byteLength + indices.byteLength
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: binLen }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    nodes: [{ mesh: 0, translation: [1, 0, 0] }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  }
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4
  const padded = new Uint8Array(jsonBytes.length + jsonPad).fill(0x20)
  padded.set(jsonBytes)
  jsonBytes = padded

  const total = 12 + 8 + jsonBytes.length + 8 + binLen
  const buf = new ArrayBuffer(total)
  const dv = new DataView(buf)
  const u8 = new Uint8Array(buf)
  dv.setUint32(0, 0x46546c67, true)
  dv.setUint32(4, 2, true)
  dv.setUint32(8, total, true)
  dv.setUint32(12, jsonBytes.length, true)
  dv.setUint32(16, 0x4e4f534a, true)
  u8.set(jsonBytes, 20)
  const binStart = 20 + jsonBytes.length
  dv.setUint32(binStart, binLen, true)
  dv.setUint32(binStart + 4, 0x004e4942, true)
  u8.set(new Uint8Array(positions.buffer), binStart + 8)
  u8.set(new Uint8Array(indices.buffer), binStart + 8 + positions.byteLength)
  return buf
}

test('parseGLB reads a minimal triangle GLB with node transform', async () => {
  const model = await parseGLB(makeTriangleGLB())
  expect(model.primitives.length).toBe(1)
  const p = model.primitives[0]
  expect(p.positions.length).toBe(9)
  expect(Array.from(p.indices)).toEqual([0, 1, 2])
  // Node translation [1,0,0] shifts the bounds.
  expect(model.min[0]).toBeCloseTo(1)
  expect(model.max[0]).toBeCloseTo(2)
  expect(model.materials.length).toBe(1) // default material injected
})

test('parseGLB rejects non-GLB data with YURA-020', async () => {
  let code = ''
  try {
    await parseGLB(new ArrayBuffer(64))
  } catch (e) {
    code = (e as { code?: string }).code ?? ''
  }
  expect(code).toBe('YURA-020')
})
