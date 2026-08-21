import {
  perspective,
  lookAt,
  multiply,
  invert,
  transform4,
  CODES,
  warnCode,
  type Vec3,
} from '@yura/core'
import type { LookParams, MotionParams, RendererOptions, ExternalCamera } from '@yura/renderer-webgpu'
import {
  SIM_VS,
  RENDER_VS,
  RENDER_FS,
  FS_TRIANGLE_VS,
  FADE_FS,
  BRIGHT_FS,
  BLUR_FS,
  COMPOSITE_FS,
} from './shaders'

/**
 * WebGL2 particle fallback (F-002): the same visual system as the WebGPU
 * renderer — transform-feedback simulation, additive point sprites, trail
 * accumulation, bloom + streaks + nebula + ACES — for browsers without
 * WebGPU. API-compatible with WebGPUParticleRenderer so the app can swap
 * backends transparently.
 */
export class WebGL2ParticleRenderer {
  readonly count: number
  onDeviceLost: (() => void) | null = null

  look: LookParams
  motion: MotionParams
  colorA: Vec3
  colorB: Vec3
  morphT = 0
  morphBoost = 0
  pointerWorld: Vec3 = [0, 0, 0]
  pointerStrength = 0
  parallax: [number, number] = [0, 0]
  /** When set, replaces the internal sway camera (external engine adapters). */
  externalCamera: ExternalCamera | null = null

  private gl: WebGL2RenderingContext
  private canvas: HTMLCanvasElement
  private simProgram!: WebGLProgram
  private renderProgram!: WebGLProgram
  private fadeProgram!: WebGLProgram
  private brightProgram!: WebGLProgram
  private blurProgram!: WebGLProgram
  private compositeProgram!: WebGLProgram

  private posBuf: [WebGLBuffer, WebGLBuffer]
  private velBuf: [WebGLBuffer, WebGLBuffer]
  private targetABuf: WebGLBuffer
  private targetBBuf: WebGLBuffer
  private simVAO: [WebGLVertexArrayObject, WebGLVertexArrayObject]
  private renderVAO: [WebGLVertexArrayObject, WebGLVertexArrayObject]
  private tf: WebGLTransformFeedback
  private cur = 0

  private hdrTex: WebGLTexture | null = null
  private hdrFBO: WebGLFramebuffer | null = null
  private bloomTex: [WebGLTexture | null, WebGLTexture | null, WebGLTexture | null] = [null, null, null]
  private bloomFBO: [WebGLFramebuffer | null, WebGLFramebuffer | null, WebGLFramebuffer | null] = [null, null, null]

  private width = 0
  private height = 0
  private disposed = false
  private sceneNeedsClear = true

  private eye: Vec3 = [0, 3, 26]
  private center: Vec3 = [0, 0, 0]
  private viewProj: Float32Array = new Float32Array(16)
  private uniforms = new Map<string, Record<string, WebGLUniformLocation | null>>()

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext, opts: RendererOptions) {
    this.canvas = canvas
    this.gl = gl
    this.count = opts.count
    this.look = opts.look
    this.motion = opts.motion
    this.colorA = opts.colorA
    this.colorB = opts.colorB
    this.posBuf = [gl.createBuffer()!, gl.createBuffer()!]
    this.velBuf = [gl.createBuffer()!, gl.createBuffer()!]
    this.targetABuf = gl.createBuffer()!
    this.targetBBuf = gl.createBuffer()!
    this.simVAO = [gl.createVertexArray()!, gl.createVertexArray()!]
    this.renderVAO = [gl.createVertexArray()!, gl.createVertexArray()!]
    this.tf = gl.createTransformFeedback()!
  }

  static create(canvas: HTMLCanvasElement, opts: RendererOptions): WebGL2ParticleRenderer | null {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false })
    if (!gl) return null
    if (!gl.getExtension('EXT_color_buffer_float')) {
      warnCode(CODES.ADAPTER_FAILED, 'WebGL2 lacks EXT_color_buffer_float; falling back to poster.')
      return null
    }
    const r = new WebGL2ParticleRenderer(canvas, gl, opts)
    if (!r.initPrograms()) return null
    r.initBuffers()
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      if (!r.disposed) r.onDeviceLost?.()
    })
    return r
  }

  private compile(vsSrc: string, fsSrc: string, tfVaryings?: string[]): WebGLProgram | null {
    const gl = this.gl
    const make = (type: number, src: string): WebGLShader | null => {
      const sh = gl.createShader(type)!
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        warnCode(CODES.ADAPTER_FAILED, `WebGL2 shader compile failed: ${gl.getShaderInfoLog(sh)}`)
        return null
      }
      return sh
    }
    const vs = make(gl.VERTEX_SHADER, vsSrc)
    const fs = make(gl.FRAGMENT_SHADER, fsSrc)
    if (!vs || !fs) return null
    const prog = gl.createProgram()!
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    if (tfVaryings) gl.transformFeedbackVaryings(prog, tfVaryings, gl.SEPARATE_ATTRIBS)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      warnCode(CODES.ADAPTER_FAILED, `WebGL2 program link failed: ${gl.getProgramInfoLog(prog)}`)
      return null
    }
    return prog
  }

  private u(programName: string, program: WebGLProgram, name: string): WebGLUniformLocation | null {
    let map = this.uniforms.get(programName)
    if (!map) {
      map = {}
      this.uniforms.set(programName, map)
    }
    if (!(name in map)) map[name] = this.gl.getUniformLocation(program, name)
    return map[name]
  }

  private initPrograms(): boolean {
    const dummyFS = `#version 300 es
precision highp float;
out vec4 o;
void main() { o = vec4(0.0); }
`
    const sim = this.compile(SIM_VS, dummyFS, ['tfPos', 'tfVel'])
    const render = this.compile(RENDER_VS, RENDER_FS)
    const fade = this.compile(FS_TRIANGLE_VS, FADE_FS)
    const bright = this.compile(FS_TRIANGLE_VS, BRIGHT_FS)
    const blur = this.compile(FS_TRIANGLE_VS, BLUR_FS)
    const composite = this.compile(FS_TRIANGLE_VS, COMPOSITE_FS)
    if (!sim || !render || !fade || !bright || !blur || !composite) return false
    this.simProgram = sim
    this.renderProgram = render
    this.fadeProgram = fade
    this.brightProgram = bright
    this.blurProgram = blur
    this.compositeProgram = composite
    return true
  }

  private initBuffers(): void {
    const gl = this.gl
    const n = this.count
    const init = new Float32Array(n * 4)
    for (let i = 0; i < n; i++) {
      const r = 14 + Math.random() * 8
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      init[i * 4] = r * Math.sin(phi) * Math.cos(theta)
      init[i * 4 + 1] = r * Math.cos(phi)
      init[i * 4 + 2] = r * Math.sin(phi) * Math.sin(theta)
      init[i * 4 + 3] = Math.random()
    }
    const zero = new Float32Array(n * 4)
    const alloc = (buf: WebGLBuffer, data: Float32Array) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_COPY)
    }
    alloc(this.posBuf[0], init)
    alloc(this.posBuf[1], init)
    alloc(this.velBuf[0], zero)
    alloc(this.velBuf[1], zero)
    alloc(this.targetABuf, zero)
    alloc(this.targetBBuf, zero)

    const attr = (loc: number, buf: WebGLBuffer) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 0, 0)
    }
    for (const i of [0, 1] as const) {
      gl.bindVertexArray(this.simVAO[i])
      attr(0, this.posBuf[i])
      attr(1, this.velBuf[i])
      attr(2, this.targetABuf)
      attr(3, this.targetBBuf)
      gl.bindVertexArray(this.renderVAO[i])
      attr(0, this.posBuf[i])
      attr(1, this.velBuf[i])
    }
    gl.bindVertexArray(null)
  }

  writeTargetA(data: Float32Array<ArrayBuffer>): void {
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.targetABuf)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data)
  }

  writeTargetB(data: Float32Array<ArrayBuffer>): void {
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.targetBBuf)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data)
  }

  resize(width: number, height: number): void {
    width = Math.max(1, Math.floor(width))
    height = Math.max(1, Math.floor(height))
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height
    this.canvas.width = width
    this.canvas.height = height
    this.sceneNeedsClear = true

    const gl = this.gl
    const makeTarget = (w: number, h: number): { tex: WebGLTexture; fbo: WebGLFramebuffer } => {
      const tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, w, h)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      const fbo = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
      return { tex, fbo }
    }
    if (this.hdrTex) gl.deleteTexture(this.hdrTex)
    if (this.hdrFBO) gl.deleteFramebuffer(this.hdrFBO)
    for (let i = 0; i < 3; i++) {
      if (this.bloomTex[i]) gl.deleteTexture(this.bloomTex[i])
      if (this.bloomFBO[i]) gl.deleteFramebuffer(this.bloomFBO[i])
    }
    const hdr = makeTarget(width, height)
    this.hdrTex = hdr.tex
    this.hdrFBO = hdr.fbo
    const hw = Math.max(1, width >> 1)
    const hh = Math.max(1, height >> 1)
    for (let i = 0; i < 3; i++) {
      const t = makeTarget(hw, hh)
      this.bloomTex[i] = t.tex
      this.bloomFBO[i] = t.fbo
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  pointerToWorld(ndcX: number, ndcY: number): Vec3 | null {
    const inv = invert(this.viewProj)
    if (!inv) return null
    const p0h = transform4(inv, [ndcX, ndcY, 0, 1])
    const p1h = transform4(inv, [ndcX, ndcY, 1, 1])
    const p0: Vec3 = [p0h[0] / p0h[3], p0h[1] / p0h[3], p0h[2] / p0h[3]]
    const p1: Vec3 = [p1h[0] / p1h[3], p1h[1] / p1h[3], p1h[2] / p1h[3]]
    let dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2]
    const dl = Math.hypot(dx, dy, dz) || 1
    dx /= dl; dy /= dl; dz /= dl
    let nx = this.eye[0] - this.center[0]
    let ny = this.eye[1] - this.center[1]
    let nz = this.eye[2] - this.center[2]
    const nl = Math.hypot(nx, ny, nz) || 1
    nx /= nl; ny /= nl; nz /= nl
    const denom = dx * nx + dy * ny + dz * nz
    if (Math.abs(denom) < 1e-6) return null
    const t = -(p0[0] * nx + p0[1] * ny + p0[2] * nz) / denom
    return [p0[0] + dx * t, p0[1] + dy * t, p0[2] + dz * t]
  }

  frame(dt: number, time: number, activeCount: number): void {
    if (this.disposed || !this.hdrFBO) return
    const gl = this.gl
    const n = Math.max(1, Math.min(this.count, Math.floor(activeCount)))

    const aspect = this.width / this.height
    const ext = this.externalCamera
    if (ext) {
      this.eye = ext.eye
      this.viewProj = ext.viewProj
    } else {
      const angle = Math.sin(time * 0.12) * 0.45
      const radius = 26
      this.eye = [
        Math.sin(angle) * radius + this.parallax[0] * 2.2,
        3 + this.parallax[1] * 1.6,
        Math.cos(angle) * radius,
      ]
      const proj = perspective((50 * Math.PI) / 180, aspect, 0.1, 200)
      const view = lookAt(this.eye, this.center, [0, 1, 0])
      this.viewProj = multiply(proj, view)
    }

    // --- Simulation via transform feedback ---
    const next = 1 - this.cur
    gl.useProgram(this.simProgram)
    const su = (name: string) => this.u('sim', this.simProgram, name)
    gl.uniform1f(su('uDt'), dt)
    gl.uniform1f(su('uTime'), time)
    gl.uniform1f(su('uMorphT'), this.morphT)
    gl.uniform1f(su('uAttraction'), this.motion.attraction)
    gl.uniform1f(su('uDamping'), this.motion.damping)
    gl.uniform1f(su('uNoiseScale'), this.motion.noiseScale)
    gl.uniform1f(su('uNoiseStrength'), this.motion.noiseStrength)
    gl.uniform1f(su('uSwirl'), this.motion.swirl)
    gl.uniform1f(su('uMaxSpeed'), this.motion.maxSpeed)
    gl.uniform1f(su('uBoost'), this.morphBoost)
    gl.uniform4f(su('uPointer'), this.pointerWorld[0], this.pointerWorld[1], this.pointerWorld[2], this.pointerStrength)
    gl.bindVertexArray(this.simVAO[this.cur])
    gl.enable(gl.RASTERIZER_DISCARD)
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.tf)
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.posBuf[next])
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 1, this.velBuf[next])
    gl.beginTransformFeedback(gl.POINTS)
    gl.drawArrays(gl.POINTS, 0, n)
    gl.endTransformFeedback()
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null)
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 1, null)
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null)
    gl.disable(gl.RASTERIZER_DISCARD)
    this.cur = next

    // --- Trail fade + particles into the HDR accumulation buffer ---
    const trail = Math.max(this.look.trail, 0)
    const fadeAlpha = trail > 0.02 ? 1 - Math.exp(-dt / trail) : 1
    const trailComp = trail > 0.02 ? Math.min(Math.max(fadeAlpha * 1.4, 0.06), 1) : 1
    // Match the WebGPU renderer: brighten survivors when the governor sheds
    // particles so low quality levels don't fade to black.
    const countComp = Math.min(Math.pow(this.count / n, 0.7), 4)

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdrFBO)
    gl.viewport(0, 0, this.width, this.height)
    gl.disable(gl.DEPTH_TEST)
    if (this.sceneNeedsClear) {
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      this.sceneNeedsClear = false
    }
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(this.fadeProgram)
    gl.uniform1f(this.u('fade', this.fadeProgram, 'uFade'), fadeAlpha)
    gl.bindVertexArray(null)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    gl.blendFunc(gl.ONE, gl.ONE)
    gl.useProgram(this.renderProgram)
    const ru = (name: string) => this.u('render', this.renderProgram, name)
    gl.uniformMatrix4fv(ru('uViewProj'), false, this.viewProj)
    const fovY = ext?.fovY ?? (50 * Math.PI) / 180
    const sizePx =
      ((this.look.particleSize * (ext?.sizeScale ?? 1)) * this.height) / (2 * Math.tan(fovY / 2))
    gl.uniform1f(ru('uSizePx'), sizePx)
    gl.uniform1f(ru('uIntensity'), this.look.intensity * trailComp * countComp)
    gl.uniform1f(ru('uSpeedColorMix'), this.motion.speedColorMix)
    gl.uniform1f(ru('uTime'), time)
    gl.uniform1f(ru('uTwinkle'), this.look.twinkle)
    gl.uniform3f(ru('uColorA'), this.colorA[0], this.colorA[1], this.colorA[2])
    gl.uniform3f(ru('uColorB'), this.colorB[0], this.colorB[1], this.colorB[2])
    gl.uniform3f(ru('uColorHot'), this.look.hot[0], this.look.hot[1], this.look.hot[2])
    gl.bindVertexArray(this.renderVAO[this.cur])
    gl.drawArrays(gl.POINTS, 0, n)
    gl.bindVertexArray(null)
    gl.disable(gl.BLEND)

    // --- Post chain ---
    const hw = Math.max(1, this.width >> 1)
    const hh = Math.max(1, this.height >> 1)
    const fullscreen = (
      program: WebGLProgram,
      fbo: WebGLFramebuffer | null,
      w: number,
      h: number,
      bind: () => void,
    ) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.viewport(0, 0, w, h)
      gl.useProgram(program)
      bind()
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    const bindTex = (unit: number, tex: WebGLTexture | null) => {
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, tex)
    }

    fullscreen(this.brightProgram, this.bloomFBO[0], hw, hh, () => {
      bindTex(0, this.hdrTex)
      gl.uniform1i(this.u('bright', this.brightProgram, 'uSrc'), 0)
      gl.uniform1f(this.u('bright', this.brightProgram, 'uThreshold'), this.look.bloomThreshold)
    })
    const blur = (srcIdx: number, dstIdx: number, dx: number, dy: number) => {
      fullscreen(this.blurProgram, this.bloomFBO[dstIdx], hw, hh, () => {
        bindTex(0, this.bloomTex[srcIdx])
        gl.uniform1i(this.u('blur', this.blurProgram, 'uSrc'), 0)
        gl.uniform2f(this.u('blur', this.blurProgram, 'uDir'), dx, dy)
      })
    }
    blur(0, 1, 1 / hw, 0)
    blur(1, 0, 0, 1 / hh)
    blur(0, 1, 3.5 / hw, 0)
    blur(1, 2, 10 / hw, 0)

    fullscreen(this.compositeProgram, null, this.width, this.height, () => {
      const cu = (name: string) => this.u('composite', this.compositeProgram, name)
      bindTex(0, this.hdrTex)
      bindTex(1, this.bloomTex[0])
      bindTex(2, this.bloomTex[2])
      gl.uniform1i(cu('uScene'), 0)
      gl.uniform1i(cu('uBloom'), 1)
      gl.uniform1i(cu('uStreak'), 2)
      gl.uniform1f(cu('uBloomStrength'), this.look.bloomStrength)
      gl.uniform1f(cu('uExposure'), this.look.exposure)
      gl.uniform1f(cu('uVignette'), this.look.vignette)
      gl.uniform1f(cu('uGrain'), this.look.grain)
      gl.uniform1f(cu('uTime'), time)
      gl.uniform1f(cu('uAberration'), this.look.aberration)
      gl.uniform1f(cu('uStreakStrength'), this.look.streak)
      gl.uniform1f(cu('uNebula'), this.look.nebula)
      gl.uniform1f(cu('uStars'), this.look.stars)
      gl.uniform1f(cu('uAspect'), aspect)
      const mid: Vec3 = [
        (this.colorA[0] + this.colorB[0]) / 2,
        (this.colorA[1] + this.colorB[1]) / 2,
        (this.colorA[2] + this.colorB[2]) / 2,
      ]
      gl.uniform3f(cu('uTintA'), this.look.background[0], this.look.background[1], this.look.background[2])
      gl.uniform3f(cu('uTintB'), mid[0], mid[1], mid[2])
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const gl = this.gl
    for (const b of [...this.posBuf, ...this.velBuf, this.targetABuf, this.targetBBuf]) gl.deleteBuffer(b)
    if (this.hdrTex) gl.deleteTexture(this.hdrTex)
    if (this.hdrFBO) gl.deleteFramebuffer(this.hdrFBO)
    for (let i = 0; i < 3; i++) {
      if (this.bloomTex[i]) gl.deleteTexture(this.bloomTex[i])
      if (this.bloomFBO[i]) gl.deleteFramebuffer(this.bloomFBO[i])
    }
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
