/**
 * Procedural mesh generators — Three.js-class primitives with zero assets.
 * All meshes are CCW-wound (front face out) with per-vertex normals and UVs,
 * ready for the PBR pipeline.
 */

export interface MeshGeometry {
  positions: Float32Array<ArrayBuffer>
  normals: Float32Array<ArrayBuffer>
  uvs: Float32Array<ArrayBuffer>
  indices: Uint32Array<ArrayBuffer>
}

function build(verts: number[], norms: number[], uvs: number[], indices: number[]): MeshGeometry {
  return {
    positions: new Float32Array(verts),
    normals: new Float32Array(norms),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
  }
}

export function sphereMesh(radius = 1, widthSegments = 40, heightSegments = 24): MeshGeometry {
  const verts: number[] = [], norms: number[] = [], uvs: number[] = [], indices: number[] = []
  for (let iy = 0; iy <= heightSegments; iy++) {
    const v = iy / heightSegments
    const phi = v * Math.PI
    for (let ix = 0; ix <= widthSegments; ix++) {
      const u = ix / widthSegments
      const theta = u * Math.PI * 2
      const nx = -Math.cos(theta) * Math.sin(phi)
      const ny = Math.cos(phi)
      const nz = Math.sin(theta) * Math.sin(phi)
      verts.push(nx * radius, ny * radius, nz * radius)
      norms.push(nx, ny, nz)
      uvs.push(u, v)
    }
  }
  const row = widthSegments + 1
  for (let iy = 0; iy < heightSegments; iy++) {
    for (let ix = 0; ix < widthSegments; ix++) {
      const a = iy * row + ix
      const b = a + row
      indices.push(a, b, a + 1, b, b + 1, a + 1)
    }
  }
  return build(verts, norms, uvs, indices)
}

export function boxMesh(width = 1, height = 1, depth = 1): MeshGeometry {
  const h: [number, number, number] = [width / 2, height / 2, depth / 2]
  const faces: Array<{ n: number[]; u: number[]; v: number[] }> = [
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  ]
  const verts: number[] = [], norms: number[] = [], uvs: number[] = [], indices: number[] = []
  for (const f of faces) {
    const base = verts.length / 3
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      verts.push(
        (f.n[0] + f.u[0] * su + f.v[0] * sv) * h[0],
        (f.n[1] + f.u[1] * su + f.v[1] * sv) * h[1],
        (f.n[2] + f.u[2] * su + f.v[2] * sv) * h[2],
      )
      norms.push(f.n[0], f.n[1], f.n[2])
      uvs.push(su * 0.5 + 0.5, sv * 0.5 + 0.5)
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  return build(verts, norms, uvs, indices)
}

export function planeMesh(size = 10, tiles = 5): MeshGeometry {
  const s = size / 2
  return build(
    [-s, 0, -s, s, 0, -s, s, 0, s, -s, 0, s],
    [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
    [0, 0, tiles, 0, tiles, tiles, 0, tiles],
    [0, 2, 1, 0, 3, 2],
  )
}

export function discMesh(radius = 1, segments = 40): MeshGeometry {
  const verts: number[] = [0, 0, 0], norms: number[] = [0, 1, 0], uvs: number[] = [0.5, 0.5]
  const indices: number[] = []
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2
    const x = Math.cos(a), z = Math.sin(a)
    verts.push(x * radius, 0, z * radius)
    norms.push(0, 1, 0)
    uvs.push(0.5 + x * 0.5, 0.5 + z * 0.5)
    if (i > 0) indices.push(0, i + 1, i)
  }
  return build(verts, norms, uvs, indices)
}

export function torusMesh(radius = 1, tube = 0.35, radialSegments = 48, tubularSegments = 24): MeshGeometry {
  const verts: number[] = [], norms: number[] = [], uvs: number[] = [], indices: number[] = []
  for (let j = 0; j <= tubularSegments; j++) {
    const v = (j / tubularSegments) * Math.PI * 2
    for (let i = 0; i <= radialSegments; i++) {
      const u = (i / radialSegments) * Math.PI * 2
      const cx = Math.cos(u), sx = Math.sin(u)
      verts.push((radius + tube * Math.cos(v)) * cx, tube * Math.sin(v), (radius + tube * Math.cos(v)) * sx)
      norms.push(Math.cos(v) * cx, Math.sin(v), Math.cos(v) * sx)
      uvs.push(i / radialSegments, j / tubularSegments)
    }
  }
  const row = radialSegments + 1
  for (let j = 0; j < tubularSegments; j++) {
    for (let i = 0; i < radialSegments; i++) {
      const a = j * row + i
      const b = a + row
      indices.push(a, a + 1, b, a + 1, b + 1, b)
    }
  }
  return build(verts, norms, uvs, indices)
}

export function cylinderMesh(radius = 0.5, height = 1, segments = 36): MeshGeometry {
  const verts: number[] = [], norms: number[] = [], uvs: number[] = [], indices: number[] = []
  const hh = height / 2
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2
    const x = Math.cos(a), z = Math.sin(a)
    verts.push(x * radius, -hh, z * radius, x * radius, hh, z * radius)
    norms.push(x, 0, z, x, 0, z)
    uvs.push(i / segments, 0, i / segments, 1)
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3)
  }
  // Caps
  for (const top of [1, -1]) {
    const center = verts.length / 3
    verts.push(0, hh * top, 0)
    norms.push(0, top, 0)
    uvs.push(0.5, 0.5)
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2
      const x = Math.cos(a), z = Math.sin(a)
      verts.push(x * radius, hh * top, z * radius)
      norms.push(0, top, 0)
      uvs.push(0.5 + x * 0.5, 0.5 + z * 0.5)
      if (i > 0) {
        if (top === 1) indices.push(center, center + i + 1, center + i)
        else indices.push(center, center + i, center + i + 1)
      }
    }
  }
  return build(verts, norms, uvs, indices)
}

/** The classic beauty primitive — a (p,q) torus knot. */
export function torusKnotMesh(radius = 1, tube = 0.3, tubularSegments = 180, radialSegments = 14, p = 2, q = 3): MeshGeometry {
  const verts: number[] = [], norms: number[] = [], uvs: number[] = [], indices: number[] = []
  const point = (u: number): [number, number, number] => {
    const cu = Math.cos(u), su = Math.sin(u)
    const quOverP = (q / p) * u
    const cs = Math.cos(quOverP)
    return [radius * (2 + cs) * 0.5 * cu, radius * (2 + cs) * 0.5 * su, radius * Math.sin(quOverP) * 0.5]
  }
  for (let i = 0; i <= tubularSegments; i++) {
    const u = (i / tubularSegments) * p * Math.PI * 2
    const p1 = point(u)
    const p2 = point(u + 0.01)
    let tx = p2[0] - p1[0], ty = p2[1] - p1[1], tz = p2[2] - p1[2]
    let nx = p2[0] + p1[0], ny = p2[1] + p1[1], nz = p2[2] + p1[2]
    let bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx
    nx = by * tz - bz * ty; ny = bz * tx - bx * tz; nz = bx * ty - by * tx
    const bl = Math.hypot(bx, by, bz) || 1
    const nl = Math.hypot(nx, ny, nz) || 1
    bx /= bl; by /= bl; bz /= bl
    nx /= nl; ny /= nl; nz /= nl
    for (let j = 0; j <= radialSegments; j++) {
      const v = (j / radialSegments) * Math.PI * 2
      const cx = -tube * Math.cos(v)
      const cy = tube * Math.sin(v)
      const px = p1[0] + (cx * nx + cy * bx)
      const py = p1[1] + (cx * ny + cy * by)
      const pz = p1[2] + (cx * nz + cy * bz)
      verts.push(px, py, pz)
      const dl = Math.hypot(px - p1[0], py - p1[1], pz - p1[2]) || 1
      norms.push((px - p1[0]) / dl, (py - p1[1]) / dl, (pz - p1[2]) / dl)
      uvs.push(i / tubularSegments, j / radialSegments)
    }
  }
  const row = radialSegments + 1
  for (let i = 0; i < tubularSegments; i++) {
    for (let j = 0; j < radialSegments; j++) {
      const a = i * row + j
      const b = a + row
      indices.push(a, b, a + 1, b, b + 1, a + 1)
    }
  }
  return build(verts, norms, uvs, indices)
}

export const meshes = {
  sphere: sphereMesh,
  box: boxMesh,
  plane: planeMesh,
  disc: discMesh,
  torus: torusMesh,
  cylinder: cylinderMesh,
  torusKnot: torusKnotMesh,
}
