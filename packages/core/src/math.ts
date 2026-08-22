import { CODES, warnCode } from './errors'

export type Vec3 = [number, number, number]
export type Vec4 = [number, number, number, number]

/** Right-handed perspective projection with WebGPU [0, 1] clip-space depth. */
export function perspective(fovy: number, aspect: number, near: number, far: number): Float32Array<ArrayBuffer> {
  const f = 1 / Math.tan(fovy / 2)
  const out = new Float32Array(16)
  out[0] = f / aspect
  out[5] = f
  out[10] = far / (near - far)
  out[11] = -1
  out[14] = (far * near) / (near - far)
  return out
}

/** Orthographic projection with WebGPU [0, 1] clip-space depth. */
export function ortho(left: number, right: number, bottom: number, top: number, near: number, far: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(16)
  out[0] = 2 / (right - left)
  out[5] = 2 / (top - bottom)
  out[10] = 1 / (near - far)
  out[12] = -(right + left) / (right - left)
  out[13] = -(top + bottom) / (top - bottom)
  out[14] = near / (near - far)
  out[15] = 1
  return out
}

export function lookAt(eye: Vec3, center: Vec3, up: Vec3): Float32Array<ArrayBuffer> {
  const [ex, ey, ez] = eye
  const [cx, cy, cz] = center
  const [ux, uy, uz] = up
  let zx = ex - cx
  let zy = ey - cy
  let zz = ez - cz
  let len = Math.hypot(zx, zy, zz) || 1
  zx /= len; zy /= len; zz /= len
  let xx = uy * zz - uz * zy
  let xy = uz * zx - ux * zz
  let xz = ux * zy - uy * zx
  len = Math.hypot(xx, xy, xz) || 1
  xx /= len; xy /= len; xz /= len
  const yx = zy * xz - zz * xy
  const yy = zz * xx - zx * xz
  const yz = zx * xy - zy * xx
  const out = new Float32Array(16)
  out[0] = xx; out[1] = yx; out[2] = zx
  out[4] = xy; out[5] = yy; out[6] = zy
  out[8] = xz; out[9] = yz; out[10] = zz
  out[12] = -(xx * ex + xy * ey + xz * ez)
  out[13] = -(yx * ex + yy * ey + yz * ez)
  out[14] = -(zx * ex + zy * ey + zz * ez)
  out[15] = 1
  return out
}

/** out = a * b (column-major, gl-matrix convention). */
export function multiply(a: Float32Array, b: Float32Array): Float32Array<ArrayBuffer> {
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4]
    const b1 = b[c * 4 + 1]
    const b2 = b[c * 4 + 2]
    const b3 = b[c * 4 + 3]
    out[c * 4] = b0 * a[0] + b1 * a[4] + b2 * a[8] + b3 * a[12]
    out[c * 4 + 1] = b0 * a[1] + b1 * a[5] + b2 * a[9] + b3 * a[13]
    out[c * 4 + 2] = b0 * a[2] + b1 * a[6] + b2 * a[10] + b3 * a[14]
    out[c * 4 + 3] = b0 * a[3] + b1 * a[7] + b2 * a[11] + b3 * a[15]
  }
  return out
}

export function invert(m: Float32Array): Float32Array<ArrayBuffer> | null {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3]
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7]
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11]
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15]

  const b00 = a00 * a11 - a01 * a10
  const b01 = a00 * a12 - a02 * a10
  const b02 = a00 * a13 - a03 * a10
  const b03 = a01 * a12 - a02 * a11
  const b04 = a01 * a13 - a03 * a11
  const b05 = a02 * a13 - a03 * a12
  const b06 = a20 * a31 - a21 * a30
  const b07 = a20 * a32 - a22 * a30
  const b08 = a20 * a33 - a23 * a30
  const b09 = a21 * a32 - a22 * a31
  const b10 = a21 * a33 - a23 * a31
  const b11 = a22 * a33 - a23 * a32

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
  if (!det) return null
  det = 1 / det

  const out = new Float32Array(16)
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det
  return out
}

export function transform4(m: Float32Array, v: Vec4): Vec4 {
  const [x, y, z, w] = v
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12] * w,
    m[1] * x + m[5] * y + m[9] * z + m[13] * w,
    m[2] * x + m[6] * y + m[10] * z + m[14] * w,
    m[3] * x + m[7] * y + m[11] * z + m[15] * w,
  ]
}

export function identity(): Float32Array<ArrayBuffer> {
  const out = new Float32Array(16)
  out[0] = out[5] = out[10] = out[15] = 1
  return out
}

/** Compose translation, quaternion rotation, and scale into a mat4. */
export function trsToMat4(t: Vec3, q: Vec4, s: Vec3): Float32Array<ArrayBuffer> {
  let [x, y, z, w] = q
  // The rotation formula below assumes a unit quaternion; a denormalized one
  // (e.g. huge components from a corrupt asset) overflows the Float32 output to
  // +/-Infinity. Normalize only when |q|^2 strays from 1 by more than a 1e-6
  // relative tolerance, so already-unit quaternions pass through bit-for-bit.
  // A zero or non-finite length has no meaningful direction: fall back to the
  // identity rotation.
  const lenSq = x * x + y * y + z * z + w * w
  if (lenSq === 0 || !Number.isFinite(lenSq)) {
    x = 0; y = 0; z = 0; w = 1
  } else if (Math.abs(lenSq - 1) > 1e-6) {
    const inv = 1 / Math.sqrt(lenSq)
    x *= inv; y *= inv; z *= inv; w *= inv
  }
  const x2 = x + x, y2 = y + y, z2 = z + z
  const xx = x * x2, xy = x * y2, xz = x * z2
  const yy = y * y2, yz = y * z2, zz = z * z2
  const wx = w * x2, wy = w * y2, wz = w * z2
  const [sx, sy, sz] = s
  const out = new Float32Array(16)
  out[0] = (1 - (yy + zz)) * sx
  out[1] = (xy + wz) * sx
  out[2] = (xz - wy) * sx
  out[4] = (xy - wz) * sy
  out[5] = (1 - (xx + zz)) * sy
  out[6] = (yz + wx) * sy
  out[8] = (xz + wy) * sz
  out[9] = (yz - wx) * sz
  out[10] = (1 - (xx + yy)) * sz
  out[12] = t[0]
  out[13] = t[1]
  out[14] = t[2]
  out[15] = 1
  return out
}

/** Euler angles (radians, XYZ order) to quaternion. */
export function eulerToQuat(x: number, y: number, z: number): Vec4 {
  const c1 = Math.cos(x / 2), s1 = Math.sin(x / 2)
  const c2 = Math.cos(y / 2), s2 = Math.sin(y / 2)
  const c3 = Math.cos(z / 2), s3 = Math.sin(z / 2)
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ]
}

export function transformPoint(m: Float32Array, p: Vec3): Vec3 {
  const [x, y, z] = p
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ]
}

/**
 * sRGB hex ("#8b5cf6") to linear RGB, for HDR-correct colors.
 *
 * Accepts "#rgb", "#rrggbb", and "#rrggbbaa" (alpha ignored), with or without
 * the leading "#". Anything else (named colors, wrong lengths, non-hex
 * digits) warns once per call and falls back to white so NaN never reaches a
 * color buffer. The result is always three finite components.
 */
export function hexToLinear(hex: string): Vec3 {
  const h = typeof hex === 'string' ? hex.replace('#', '') : ''
  let full: string
  if (/^[0-9a-fA-F]{3}$/.test(h)) {
    full = h.split('').map((c) => c + c).join('')
  } else if (/^[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(h)) {
    full = h.slice(0, 6)
  } else {
    warnCode(
      CODES.INVALID_COLOR,
      `Unsupported color "${hex}". Use "#rgb", "#rrggbb", or "#rrggbbaa". Falling back to white.`,
    )
    return [1, 1, 1]
  }
  const r = parseInt(full.slice(0, 2), 16) / 255
  const g = parseInt(full.slice(2, 4), 16) / 255
  const b = parseInt(full.slice(4, 6), 16) / 255
  const toLin = (c: number) => Math.pow(c, 2.2)
  return [toLin(r), toLin(g), toLin(b)]
}
