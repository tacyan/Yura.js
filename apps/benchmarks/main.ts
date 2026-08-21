/**
 * Honest benchmark harness: every cell renders alone into the same stage,
 * measured from requestAnimationFrame deltas — median FPS + p95 frame time.
 * Yura cells run the full HDR pipeline; Three.js cells draw raw additive
 * points (deliberately less work — disclosed on the page).
 */
import { yura, shapes } from 'yura'
import * as THREE from 'three'

const COUNTS = [100_000, 250_000, 500_000, 1_000_000]
const WARMUP_MS = 1200
const SAMPLE_MS = 3500
const SETTLE_MS = 400
const DPR = Math.min(devicePixelRatio || 1, 2)

const stage = document.getElementById('stage')!
const statusEl = document.getElementById('status')!
const rowsEl = document.getElementById('rows')!
const chartsEl = document.getElementById('charts')!
const envEl = document.getElementById('env')!
const contendersEl = document.getElementById('contenders')!
const exportBtn = document.getElementById('export') as HTMLButtonElement
const copyBtn = document.getElementById('copy') as HTMLButtonElement

interface Runner {
  dispose(): void
  /** Set after start; lets a cell report backend fallbacks honestly. */
  note?: string
}

interface Contender {
  id: string
  label: string
  color: string
  desc: string
  available(): boolean | string
  start(count: number): Promise<Runner>
}

interface CellResult {
  contender: string
  label: string
  color: string
  particles: number
  medianFps: number | null
  p95FrameMs: number | null
  capped: boolean
  note: string
}

const results: CellResult[] = []
let refreshHz = 60

// ---------------------------------------------------------------- sampling

function raf(): Promise<number> {
  return new Promise((r) => requestAnimationFrame(r))
}

async function sampleDeltas(ms: number): Promise<number[]> {
  const deltas: number[] = []
  let last = await raf()
  const end = last + ms
  while (true) {
    const now = await raf()
    deltas.push(now - last)
    last = now
    if (now >= end) break
  }
  return deltas
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

/**
 * Estimate the display refresh rate from an idle rAF sample. Uses the fast
 * quartile (page-load jank only ever makes frames SLOWER) and snaps to
 * standard rates so a busy load can't report nonsense like "20 Hz".
 */
async function measureRefresh(): Promise<number> {
  const deltas = await sampleDeltas(700)
  const hz = 1000 / Math.max(percentile(deltas, 25), 1)
  for (const std of [30, 60, 75, 90, 120, 144, 165, 240]) {
    if (Math.abs(hz - std) / std < 0.08) return std
  }
  return Math.round(hz)
}

// ---------------------------------------------------------------- contenders

/** Identical target data for every contender that simulates toward a galaxy. */
const galaxySpec = shapes.galaxy()

function yuraContender(id: string, label: string, color: string, backend: 'webgpu' | 'webgl2'): Contender {
  return {
    id,
    label,
    color,
    desc: 'full pipeline: GPU sim + trails + bloom + streaks + nebula + ACES',
    available: () =>
      backend === 'webgpu' && !('gpu' in navigator)
        ? 'WebGPU unavailable in this browser'
        : true,
    async start(count) {
      const holder = document.createElement('div')
      holder.style.cssText = 'position:absolute;inset:0;'
      stage.appendChild(holder)
      const app = yura(holder, { quality: 'high', backend })
      await app.particles(count).run()
      const actual = app.stats.backend
      return {
        note: actual === backend ? '' : `fell back to ${actual}`,
        dispose() {
          app.dispose()
          holder.remove()
        },
      }
    },
  }
}

/** Shared Three.js scaffolding: renderer + camera with Yura-like framing. */
function threeSetup(): { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera } {
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' })
  renderer.setPixelRatio(DPR)
  renderer.setSize(stage.clientWidth, stage.clientHeight)
  stage.appendChild(renderer.domElement)
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x000208)
  const camera = new THREE.PerspectiveCamera(50, stage.clientWidth / stage.clientHeight, 0.1, 200)
  camera.position.set(0, 3, 26)
  return { renderer, scene, camera }
}

function threeLoop(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  onFrame: (dt: number, t: number) => void,
): () => void {
  let rafId = 0
  let last = performance.now()
  let t = 0
  const tick = (now: number) => {
    const dt = Math.min((now - last) / 1000, 1 / 30)
    last = now
    t += dt
    const angle = Math.sin(t * 0.12) * 0.45
    camera.position.set(Math.sin(angle) * 26, 3, Math.cos(angle) * 26)
    camera.lookAt(0, 0, 0)
    onFrame(dt, t)
    renderer.render(scene, camera)
    rafId = requestAnimationFrame(tick)
  }
  rafId = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(rafId)
}

/** The same flow-noise field Yura's simulation shader uses, ported to JS. */
function flowField(px: number, py: number, pz: number, t: number, out: [number, number, number]): void {
  out[0] = Math.sin(py * 1.7 + t) + Math.cos(pz * 1.3 - t * 0.7)
  out[1] = Math.sin(pz * 1.9 + t * 0.8) + Math.cos(px * 1.1 + t * 0.6)
  out[2] = Math.sin(px * 1.3 - t * 0.9) + Math.cos(py * 1.7 + t * 0.5)
}

const threeCpu: Contender = {
  id: 'three-cpu',
  label: 'Three.js · CPU sim',
  color: '#fb7185',
  desc: 'typical impl: typed-array update per frame, raw additive points, no post',
  available: () => true,
  async start(count) {
    const { renderer, scene, camera } = threeSetup()
    const targets = (await galaxySpec.generate(count)) as Float32Array
    const pos = new Float32Array(count * 3)
    const vel = new Float32Array(count * 3)
    const col = new Float32Array(count * 3)
    const a = [0.02, 0.71, 0.83] // cyan-ish
    const b = [0.65, 0.55, 0.98] // violet-ish
    for (let i = 0; i < count; i++) {
      const r = 14 + Math.random() * 8
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(2 * Math.random() - 1)
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta)
      pos[i * 3 + 1] = r * Math.cos(phi)
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
      const w = targets[i * 4 + 3]
      col[i * 3] = a[0] + (b[0] - a[0]) * w
      col[i * 3 + 1] = a[1] + (b[1] - a[1]) * w
      col[i * 3 + 2] = a[2] + (b[2] - a[2]) * w
    }
    const geo = new THREE.BufferGeometry()
    const posAttr = new THREE.BufferAttribute(pos, 3)
    posAttr.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('position', posAttr)
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
    const mat = new THREE.PointsMaterial({
      size: 0.05,
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    const points = new THREE.Points(geo, mat)
    points.frustumCulled = false
    scene.add(points)

    // Same forces as Yura's compute shader: attraction + flow noise + swirl,
    // exponential damping, speed clamp — just on the CPU.
    const f: [number, number, number] = [0, 0, 0]
    const stop = threeLoop(renderer, scene, camera, (dt, t) => {
      const attraction = 4.0
      const damping = Math.exp(-2.6 * dt)
      const noiseStrength = 0.6
      const swirl = 0.1
      const maxSpeed = 30
      const ft = t * 0.4
      for (let i = 0; i < count; i++) {
        const o3 = i * 3
        const o4 = i * 4
        let x = pos[o3], y = pos[o3 + 1], z = pos[o3 + 2]
        let vx = vel[o3], vy = vel[o3 + 1], vz = vel[o3 + 2]
        vx += (targets[o4] - x) * attraction * dt
        vy += (targets[o4 + 1] - y) * attraction * dt
        vz += (targets[o4 + 2] - z) * attraction * dt
        flowField(x * 0.14, y * 0.14, z * 0.14, ft, f)
        vx += f[0] * noiseStrength * dt
        vy += f[1] * noiseStrength * dt
        vz += f[2] * noiseStrength * dt
        vx += -z * swirl * dt
        vz += x * swirl * dt
        const sp = Math.sqrt(vx * vx + vy * vy + vz * vz)
        if (sp > maxSpeed) {
          const k = maxSpeed / sp
          vx *= k; vy *= k; vz *= k
        }
        vx *= damping; vy *= damping; vz *= damping
        pos[o3] = x + vx * dt
        pos[o3 + 1] = y + vy * dt
        pos[o3 + 2] = z + vz * dt
        vel[o3] = vx; vel[o3 + 1] = vy; vel[o3 + 2] = vz
      }
      posAttr.needsUpdate = true
    })
    return {
      dispose() {
        stop()
        geo.dispose()
        mat.dispose()
        renderer.dispose()
        renderer.domElement.remove()
      },
    }
  },
}

const threeGpu: Contender = {
  id: 'three-gpu',
  label: 'Three.js · GPU vertex',
  color: '#fbbf24',
  desc: 'stateless vertex-shader orbits, zero uploads, raw additive points, no post',
  available: () => true,
  async start(count) {
    const { renderer, scene, camera } = threeSetup()
    const seeds = new Float32Array(count * 4)
    for (let i = 0; i < count; i++) {
      const t = Math.pow(Math.random(), 0.65)
      seeds[i * 4] = t * 11 // orbit radius
      seeds[i * 4 + 1] = Math.random() * Math.PI * 2 // initial angle
      seeds[i * 4 + 2] = (Math.random() * 2 - 1) * (0.6 * (1.1 - t) + 0.1) // y scatter
      seeds[i * 4 + 3] = t // palette
    }
    const geo = new THREE.BufferGeometry()
    // three needs a `position` attribute to know the draw count; the shader
    // derives the real position from the seed instead.
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
    geo.setAttribute('seed', new THREE.BufferAttribute(seeds, 4))
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uSizePx: { value: 5.5 * DPR } },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute vec4 seed;
        uniform float uTime;
        uniform float uSizePx;
        varying vec3 vCol;
        void main() {
          float r = seed.x;
          float speed = 0.55 / max(r * 0.28, 0.35);
          float a = seed.y + uTime * speed + r * 0.45;
          vec3 p = vec3(cos(a) * r, seed.z + sin(uTime * 0.7 + seed.y * 7.0) * 0.12, sin(a) * r);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(uSizePx / max(-mv.z * 0.06, 0.4), 1.0, 24.0);
          vCol = mix(vec3(0.02, 0.71, 0.83), vec3(0.65, 0.55, 0.98), seed.w) * 0.55;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec3 vCol;
        void main() {
          vec2 c = gl_PointCoord * 2.0 - 1.0;
          float d2 = dot(c, c);
          if (d2 > 1.0) discard;
          gl_FragColor = vec4(vCol * (1.0 - d2), 1.0);
        }
      `,
    })
    const points = new THREE.Points(geo, mat)
    points.frustumCulled = false
    scene.add(points)
    const stop = threeLoop(renderer, scene, camera, (_dt, t) => {
      mat.uniforms.uTime.value = t
    })
    return {
      dispose() {
        stop()
        geo.dispose()
        mat.dispose()
        renderer.dispose()
        renderer.domElement.remove()
      },
    }
  },
}

const CONTENDERS: Contender[] = [
  yuraContender('yura-webgpu', 'Yura.js · WebGPU', '#22d3ee', 'webgpu'),
  yuraContender('yura-webgl2', 'Yura.js · WebGL2 fallback', '#a78bfa', 'webgl2'),
  threeCpu,
  threeGpu,
]

// ---------------------------------------------------------------- UI

const enabled = new Map<string, boolean>(CONTENDERS.map((c) => [c.id, true]))

for (const c of CONTENDERS) {
  const label = document.createElement('label')
  const avail = c.available()
  const blocked = typeof avail === 'string'
  label.innerHTML =
    `<input type="checkbox" ${blocked ? 'disabled' : 'checked'} data-id="${c.id}">` +
    `<span class="swatch" style="background:${c.color}"></span>` +
    `<span>${c.label}${blocked ? ` — <em>${avail}</em>` : ''}</span>`
  label.title = c.desc
  contendersEl.appendChild(label)
  if (blocked) enabled.set(c.id, false)
  label.querySelector('input')!.addEventListener('change', (e) => {
    enabled.set(c.id, (e.target as HTMLInputElement).checked)
  })
}
const runLabel = document.createElement('button')
runLabel.id = 'run'
runLabel.textContent = 'Run benchmark'
contendersEl.appendChild(runLabel)

function setStatus(text: string, idle = false): void {
  statusEl.textContent = text
  statusEl.classList.toggle('idle', idle)
}

function fmtCount(n: number): string {
  return n >= 1_000_000 ? `${n / 1_000_000}M` : `${n / 1000}k`
}

function renderTable(): void {
  rowsEl.innerHTML = ''
  for (const r of results) {
    const tr = document.createElement('tr')
    const fps = r.medianFps === null ? '<span class="fail">—</span>' : r.medianFps.toFixed(1)
    const p95 = r.p95FrameMs === null ? '—' : `${r.p95FrameMs.toFixed(1)} ms`
    const notes = [r.capped ? `<span class="capped">at vsync cap (≥${Math.round(refreshHz)} Hz)</span>` : '', r.note]
      .filter(Boolean)
      .join(' · ')
    tr.innerHTML =
      `<td><span class="dot" style="background:${r.color}"></span>${r.label}</td>` +
      `<td class="num">${fmtCount(r.particles)}</td>` +
      `<td class="num">${fps}</td>` +
      `<td class="num">${p95}</td>` +
      `<td>${notes}</td>`
    rowsEl.appendChild(tr)
  }
}

function renderCharts(): void {
  chartsEl.innerHTML = ''
  for (const count of COUNTS) {
    const group = results.filter((r) => r.particles === count && r.medianFps !== null)
    if (!group.length) continue
    const div = document.createElement('div')
    div.className = 'chart-group'
    div.innerHTML = `<h3>${fmtCount(count)} particles — median FPS</h3>`
    const max = Math.max(...group.map((r) => r.medianFps!), refreshHz)
    for (const r of group) {
      const row = document.createElement('div')
      row.className = 'bar-row'
      row.innerHTML =
        `<div class="bar-label"><span class="dot" style="background:${r.color};width:9px;height:9px;border-radius:3px;display:inline-block;margin-right:7px"></span>${r.label}</div>` +
        `<div class="bar-track"><div class="bar-fill" style="background:${r.color}"></div></div>` +
        `<div class="bar-val">${r.medianFps!.toFixed(1)}${r.capped ? ' ⏸' : ''}</div>`
      div.appendChild(row)
      requestAnimationFrame(() => {
        ;(row.querySelector('.bar-fill') as HTMLElement).style.width = `${(r.medianFps! / max) * 100}%`
      })
    }
    chartsEl.appendChild(div)
  }
}

// ---------------------------------------------------------------- env info

async function fillEnv(): Promise<void> {
  const bits: string[] = []
  refreshHz = await measureRefresh()
  bits.push(`display refresh <b>≈ ${refreshHz} Hz</b>`)
  bits.push(`devicePixelRatio <b>${devicePixelRatio}</b> (render cap ×2)`)
  bits.push(`stage <b>${stage.clientWidth}×${stage.clientHeight}</b> css px`)
  if ('gpu' in navigator && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
      const info = adapter && (adapter as GPUAdapter & { info?: { vendor?: string; architecture?: string; description?: string } }).info
      if (info) {
        const gpu = [info.vendor, info.architecture, info.description].filter(Boolean).join(' · ')
        bits.push(`GPU <b>${gpu || 'unknown'}</b>`)
      } else {
        bits.push(`GPU <b>WebGPU adapter acquired</b>`)
      }
    } catch {
      bits.push(`GPU <b>WebGPU adapter query failed</b>`)
    }
  } else {
    bits.push(`GPU <b>no WebGPU — WebGL2 cells only</b>`)
  }
  bits.push(`UA <b>${navigator.userAgent.replace(/^Mozilla\/5\.0\s*/, '').slice(0, 72)}</b>`)
  envEl.innerHTML = bits.map((b) => `<span>${b}</span>`).join('')
}

// ---------------------------------------------------------------- run loop

async function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function runSweep(): Promise<void> {
  runLabel.disabled = true
  results.length = 0
  renderTable()
  renderCharts()
  // Re-measure on a quiet page: a load-time estimate can be junk.
  setStatus('measuring display refresh…')
  refreshHz = await measureRefresh()
  const cells = COUNTS.flatMap((count) =>
    CONTENDERS.filter((c) => enabled.get(c.id)).map((c) => ({ c, count })),
  )
  let i = 0
  for (const { c, count } of cells) {
    i++
    setStatus(`[${i}/${cells.length}] ${c.label} — ${fmtCount(count)} particles: starting…`)
    let runner: Runner | null = null
    const result: CellResult = {
      contender: c.id,
      label: c.label,
      color: c.color,
      particles: count,
      medianFps: null,
      p95FrameMs: null,
      capped: false,
      note: '',
    }
    try {
      runner = await c.start(count)
      if (runner.note) result.note = runner.note
      setStatus(`[${i}/${cells.length}] ${c.label} — ${fmtCount(count)}: warming up…`)
      await wait(WARMUP_MS)
      setStatus(`[${i}/${cells.length}] ${c.label} — ${fmtCount(count)}: sampling ${SAMPLE_MS / 1000}s…`)
      const deltas = await sampleDeltas(SAMPLE_MS)
      const med = median(deltas)
      result.medianFps = 1000 / med
      result.p95FrameMs = percentile(deltas, 95)
      result.capped = result.medianFps >= refreshHz * 0.97
    } catch (err) {
      result.note = `failed: ${(err as Error).message}`
    } finally {
      runner?.dispose()
    }
    results.push(result)
    renderTable()
    renderCharts()
    await wait(SETTLE_MS)
  }
  setStatus(`Done — ${cells.length} cells measured. Run it again: numbers move a little; that's honesty too.`, true)
  runLabel.disabled = false
  exportBtn.disabled = false
  copyBtn.disabled = false
}

runLabel.addEventListener('click', () => void runSweep())

exportBtn.addEventListener('click', () => {
  const payload = {
    date: new Date().toISOString(),
    refreshHz,
    dpr: devicePixelRatio,
    stage: { w: stage.clientWidth, h: stage.clientHeight },
    ua: navigator.userAgent,
    method: { warmupMs: WARMUP_MS, sampleMs: SAMPLE_MS, metric: 'median FPS + p95 frame ms from rAF deltas' },
    results,
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `yura-bench-${Date.now()}.json`
  a.click()
  URL.revokeObjectURL(a.href)
})

copyBtn.addEventListener('click', () => {
  const lines = [
    '| Engine | Particles | Median FPS | p95 frame | Note |',
    '| --- | ---: | ---: | ---: | --- |',
    ...results.map((r) =>
      `| ${r.label} | ${fmtCount(r.particles)} | ${r.medianFps?.toFixed(1) ?? '—'} | ${
        r.p95FrameMs ? r.p95FrameMs.toFixed(1) + ' ms' : '—'
      } | ${[r.capped ? 'vsync-capped' : '', r.note].filter(Boolean).join(' · ')} |`,
    ),
    '',
    `_Measured live: ${Math.round(refreshHz)} Hz display, DPR ${devicePixelRatio}, ${stage.clientWidth}×${stage.clientHeight} stage. Yura cells include full HDR post; Three.js cells draw raw points (no post)._`,
  ]
  void navigator.clipboard.writeText(lines.join('\n'))
  copyBtn.textContent = 'Copied ✓'
  setTimeout(() => (copyBtn.textContent = 'Copy Markdown table'), 1500)
})

void fillEnv()
