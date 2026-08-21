import { YuraError, CODES, identity, multiply, trsToMat4, transformPoint, type Vec3 } from '@yura/core'

/**
 * Minimal glTF 2.0 / GLB loader (F-011). Supported subset:
 * POSITION/NORMAL/TEXCOORD_0 attributes, u8/u16/u32 indices, node hierarchies
 * (matrix or TRS), pbrMetallicRoughness + normal/emissive/occlusion textures,
 * embedded (bufferView) and external (uri) images. No skinning, animation,
 * sparse accessors, or Draco. Unknown features are ignored, never fatal.
 */

export interface GLTFPrimitive {
  positions: Float32Array<ArrayBuffer>
  normals: Float32Array<ArrayBuffer>
  uvs: Float32Array<ArrayBuffer>
  indices: Uint32Array<ArrayBuffer>
  materialIndex: number
  world: Float32Array
}

export interface GLTFMaterial {
  baseColorFactor: [number, number, number, number]
  metallicFactor: number
  roughnessFactor: number
  emissiveFactor: [number, number, number]
  baseColorImage: number
  mrImage: number
  normalImage: number
  emissiveImage: number
  occlusionImage: number
}

export interface GLTFModel {
  primitives: GLTFPrimitive[]
  materials: GLTFMaterial[]
  images: ImageBitmap[]
  min: Vec3
  max: Vec3
}

interface GltfJson {
  buffers?: Array<{ byteLength: number; uri?: string }>
  bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }>
  accessors?: Array<{
    bufferView?: number
    byteOffset?: number
    componentType: number
    normalized?: boolean
    count: number
    type: string
  }>
  images?: Array<{ bufferView?: number; mimeType?: string; uri?: string }>
  textures?: Array<{ source?: number }>
  samplers?: unknown[]
  materials?: Array<{
    pbrMetallicRoughness?: {
      baseColorFactor?: number[]
      baseColorTexture?: { index: number }
      metallicFactor?: number
      roughnessFactor?: number
      metallicRoughnessTexture?: { index: number }
    }
    normalTexture?: { index: number }
    occlusionTexture?: { index: number }
    emissiveTexture?: { index: number }
    emissiveFactor?: number[]
  }>
  meshes?: Array<{ primitives: Array<{ attributes: Record<string, number>; indices?: number; material?: number; mode?: number }> }>
  nodes?: Array<{
    children?: number[]
    matrix?: number[]
    translation?: number[]
    rotation?: number[]
    scale?: number[]
    mesh?: number
  }>
  scenes?: Array<{ nodes?: number[] }>
  scene?: number
}

const COMP_SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }
const TYPE_COMPS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }

export async function loadGLB(url: string): Promise<GLTFModel> {
  let buf: ArrayBuffer
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    buf = await res.arrayBuffer()
  } catch (err) {
    throw new YuraError(
      CODES.ASSET_LOAD_FAILED,
      `Could not fetch model "${url}" (${(err as Error).message}).`,
      `Check the URL is reachable and CORS-enabled:\n  yura('#app').model('/model.glb')`,
    )
  }
  return parseGLB(buf, url)
}

export async function parseGLB(buf: ArrayBuffer, baseUrl = ''): Promise<GLTFModel> {
  const view = new DataView(buf)
  if (buf.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) {
    throw new YuraError(CODES.ASSET_LOAD_FAILED, 'Not a GLB file (bad magic).', 'Export your model as .glb (binary glTF 2.0).')
  }
  let json: GltfJson | null = null
  let bin: Uint8Array<ArrayBuffer> | null = null
  let offset = 12
  while (offset + 8 <= buf.byteLength) {
    const len = view.getUint32(offset, true)
    const type = view.getUint32(offset + 4, true)
    const start = offset + 8
    if (type === 0x4e4f534a) {
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, start, len))) as GltfJson
    } else if (type === 0x004e4942) {
      bin = new Uint8Array(buf.slice(start, start + len))
    }
    offset = start + len
  }
  if (!json) {
    throw new YuraError(CODES.ASSET_LOAD_FAILED, 'GLB is missing its JSON chunk.')
  }

  const buffers: Uint8Array[] = []
  for (const b of json.buffers ?? []) {
    if (b.uri) {
      const res = await fetch(new URL(b.uri, baseUrl).href)
      buffers.push(new Uint8Array(await res.arrayBuffer()))
    } else {
      buffers.push(bin ?? new Uint8Array(0))
    }
  }

  const readAccessor = (idx: number): { data: Float32Array<ArrayBuffer>; comps: number; count: number } => {
    const acc = json!.accessors![idx]
    const comps = TYPE_COMPS[acc.type]
    const compSize = COMP_SIZE[acc.componentType]
    const out = new Float32Array(acc.count * comps)
    if (acc.bufferView === undefined) return { data: out, comps, count: acc.count }
    const bv = json!.bufferViews![acc.bufferView]
    const src = buffers[bv.buffer]
    const base = src.byteOffset + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0)
    const stride = bv.byteStride ?? comps * compSize
    const dv = new DataView(src.buffer)
    for (let i = 0; i < acc.count; i++) {
      for (let c = 0; c < comps; c++) {
        const o = base + i * stride + c * compSize
        let v: number
        switch (acc.componentType) {
          case 5126: v = dv.getFloat32(o, true); break
          case 5125: v = dv.getUint32(o, true); break
          case 5123: v = dv.getUint16(o, true); if (acc.normalized) v /= 65535; break
          case 5121: v = dv.getUint8(o); if (acc.normalized) v /= 255; break
          case 5122: v = dv.getInt16(o, true); if (acc.normalized) v = Math.max(v / 32767, -1); break
          default: v = dv.getInt8(o); if (acc.normalized) v = Math.max(v / 127, -1); break
        }
        out[i * comps + c] = v
      }
    }
    return { data: out, comps, count: acc.count }
  }

  // Images: decode embedded or external to ImageBitmaps.
  const images: ImageBitmap[] = []
  for (const img of json.images ?? []) {
    let blob: Blob
    if (img.bufferView !== undefined) {
      const bv = json.bufferViews![img.bufferView]
      const src = buffers[bv.buffer]
      const bytes = src.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength)
      blob = new Blob([bytes.slice()], { type: img.mimeType ?? 'image/png' })
    } else if (img.uri) {
      const res = await fetch(new URL(img.uri, baseUrl).href)
      blob = await res.blob()
    } else {
      blob = new Blob()
    }
    images.push(await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }))
  }

  const textureImage = (texIndex: number | undefined): number => {
    if (texIndex === undefined) return -1
    const src = json!.textures?.[texIndex]?.source
    return src === undefined ? -1 : src
  }

  const materials: GLTFMaterial[] = (json.materials ?? []).map((m) => {
    const pbr = m.pbrMetallicRoughness ?? {}
    return {
      baseColorFactor: (pbr.baseColorFactor ?? [1, 1, 1, 1]) as [number, number, number, number],
      metallicFactor: pbr.metallicFactor ?? 1,
      roughnessFactor: pbr.roughnessFactor ?? 1,
      emissiveFactor: (m.emissiveFactor ?? [0, 0, 0]) as [number, number, number],
      baseColorImage: textureImage(pbr.baseColorTexture?.index),
      mrImage: textureImage(pbr.metallicRoughnessTexture?.index),
      normalImage: textureImage(m.normalTexture?.index),
      emissiveImage: textureImage(m.emissiveTexture?.index),
      occlusionImage: textureImage(m.occlusionTexture?.index),
    }
  })
  if (materials.length === 0) {
    materials.push({
      baseColorFactor: [0.8, 0.8, 0.85, 1],
      metallicFactor: 0.2,
      roughnessFactor: 0.5,
      emissiveFactor: [0, 0, 0],
      baseColorImage: -1,
      mrImage: -1,
      normalImage: -1,
      emissiveImage: -1,
      occlusionImage: -1,
    })
  }

  // Walk the node hierarchy collecting world-transformed primitives.
  const primitives: GLTFPrimitive[] = []
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]

  const visit = (nodeIdx: number, parent: Float32Array): void => {
    const node = json!.nodes![nodeIdx]
    let local: Float32Array
    if (node.matrix) {
      local = new Float32Array(node.matrix)
    } else {
      local = trsToMat4(
        (node.translation ?? [0, 0, 0]) as Vec3,
        (node.rotation ?? [0, 0, 0, 1]) as [number, number, number, number],
        (node.scale ?? [1, 1, 1]) as Vec3,
      )
    }
    const world = multiply(parent, local)
    if (node.mesh !== undefined) {
      for (const prim of json!.meshes![node.mesh].primitives) {
        if (prim.mode !== undefined && prim.mode !== 4) continue // triangles only
        const posAcc = prim.attributes['POSITION']
        if (posAcc === undefined) continue
        const pos = readAccessor(posAcc)
        const norm = prim.attributes['NORMAL'] !== undefined
          ? readAccessor(prim.attributes['NORMAL']).data
          : new Float32Array(pos.count * 3)
        const uv = prim.attributes['TEXCOORD_0'] !== undefined
          ? readAccessor(prim.attributes['TEXCOORD_0']).data
          : new Float32Array(pos.count * 2)
        let indices: Uint32Array<ArrayBuffer>
        if (prim.indices !== undefined) {
          const idxData = readAccessor(prim.indices).data
          indices = new Uint32Array(idxData.length)
          for (let i = 0; i < idxData.length; i++) indices[i] = idxData[i]
        } else {
          indices = new Uint32Array(pos.count)
          for (let i = 0; i < pos.count; i++) indices[i] = i
        }
        for (let i = 0; i < pos.count; i++) {
          const p = transformPoint(world, [pos.data[i * 3], pos.data[i * 3 + 1], pos.data[i * 3 + 2]])
          for (let a = 0; a < 3; a++) {
            if (p[a] < min[a]) min[a] = p[a]
            if (p[a] > max[a]) max[a] = p[a]
          }
        }
        primitives.push({
          positions: pos.data,
          normals: norm as Float32Array<ArrayBuffer>,
          uvs: uv as Float32Array<ArrayBuffer>,
          indices,
          materialIndex: Math.min(prim.material ?? 0, materials.length - 1),
          world,
        })
      }
    }
    for (const child of node.children ?? []) visit(child, world)
  }

  const sceneNodes = json.scenes?.[json.scene ?? 0]?.nodes ?? (json.nodes ? json.nodes.map((_, i) => i) : [])
  const roots = new Set(sceneNodes)
  if (json.scenes === undefined && json.nodes) {
    // No scene: treat only unparented nodes as roots.
    for (const n of json.nodes) for (const c of n.children ?? []) roots.delete(c)
  }
  for (const idx of roots) visit(idx, identity())

  if (primitives.length === 0) {
    throw new YuraError(CODES.ASSET_LOAD_FAILED, 'Model contains no triangle meshes.')
  }
  return { primitives, materials, images, min, max }
}
