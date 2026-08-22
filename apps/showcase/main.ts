/**
 * YURA showcase — the flagship demo. One million GPU-simulated particles,
 * live look switching, and a prompt that morphs the swarm into any word.
 * Zero image assets; everything on screen is generated.
 */
import { yura, shapes, lyrics, eases, YURA_SHAPE_RADIUS, type YuraApp, type LyricsRun, type FxPool, type AttractorParams } from 'yura'

type LookId = 'neon-galaxy' | 'aurora' | 'cinematic' | 'cyberpunk' | 'helix-storm' | 'sakura'

const LOOKS: Array<{ id: LookId; label: string }> = [
  { id: 'neon-galaxy', label: 'Neon Galaxy' },
  { id: 'aurora', label: 'Aurora' },
  { id: 'cinematic', label: 'Cinematic' },
  { id: 'cyberpunk', label: 'Cyberpunk' },
  { id: 'helix-storm', label: 'Helix Storm' },
  { id: 'sakura', label: 'Sakura' }, // appended last → key 6, existing 1–5 untouched
]
const COUNTS = [
  { n: 250_000, label: '250k' },
  { n: 500_000, label: '500k' },
  { n: 1_000_000, label: '1M' },
  { n: 2_000_000, label: '2M · ludicrous' },
]
const MORPHS: Array<{ label: string; make: () => ReturnType<typeof shapes.galaxy> }> = [
  { label: 'galaxy', make: () => shapes.galaxy() },
  { label: 'vortex', make: () => shapes.vortex() },
  { label: 'helix', make: () => shapes.helix() },
  { label: 'ring', make: () => shapes.ring() },
  { label: 'sphere', make: () => shapes.sphere() },
  { label: 'box', make: () => shapes.box() },
  { label: 'cone', make: () => shapes.cone() },
  { label: 'flow', make: () => shapes.flow() },
]

const stage = document.getElementById('stage')!
const cover = document.getElementById('cover')!
const coverNote = document.getElementById('coverNote')!
const fpsEl = document.getElementById('fps')!
const particlesEl = document.getElementById('particles')!
const resEl = document.getElementById('res')!
const backendEl = document.getElementById('backend')!
const promptEl = document.getElementById('prompt') as HTMLInputElement
const lookRow = document.getElementById('lookRow')!
const countRow = document.getElementById('countRow')!
const spark = document.getElementById('spark') as HTMLCanvasElement
const sparkCtx = spark.getContext('2d')!

let app: YuraApp | null = null
let currentLook: LookId = 'neon-galaxy'
let currentCount = 1_000_000
let booting = false
let stormFx: FxPool | null = null // live fx pool while Helix Storm runs
let stopWells: (() => void) | null = null // cancels the binary-well orbit loop

/** ?backend=webgl2 forces the fallback renderer — same page, same UI. */
const forcedBackend = new URLSearchParams(location.search).get('backend')
const backendOpt = forcedBackend === 'webgl2' || forcedBackend === 'webgpu' ? forcedBackend : 'auto'

// ------------------------------------------------------------------ boot

async function boot(): Promise<void> {
  if (booting) return
  booting = true
  setLyricChipEnabled(false) // no silent click-swallowing while booting
  stopLyrics() // a rebooted app invalidates the running lyric timeline
  const storm = currentLook === 'helix-storm'
  coverNote.textContent = storm
    ? 'charging the helix storm'
    : `summoning ${currentCount.toLocaleString('en-US')} particles`
  cover.classList.remove('hidden')
  await new Promise((r) => setTimeout(r, 250)) // let the cover paint
  stopWells?.() // the wells' orbit loop must not outlive the app it steers
  stopWells = null
  app?.dispose()
  stormFx = null
  app = yura(stage, { quality: 'auto', backend: backendOpt })
  if (storm) helixStorm(app)
  else if (currentLook === 'sakura')
    // SAKURA — spring-dusk act. Not a preset: the curated look (screen blend +
    // reinhard, committed in looks.ts) rides the default swarm with a petal-pink
    // → pale-gold gradient, the look's own three-color palette.
    app.look('sakura').gradient('#f9a8d4', '#fde68a').particles(currentCount).interactive()
  else app.preset(currentLook).particles(currentCount).interactive()
  // Aurora only: a whisper of divergence-free curl-noise turbulence so the
  // sheets ripple like real solar wind. Every other look keeps its exact feel.
  if (currentLook === 'aurora') app.motion({ turbulence: 0.6 })
  // Sakura only: soft petal-flutter turbulence and a slower swirl — glyphs
  // shimmer like falling blossom without breaking the lyric shapes.
  if (currentLook === 'sakura') app.motion({ turbulence: 0.3, swirl: 0.06 })
  // Cyberpunk only: cursor gravity. interactive({ gravity }) injects the
  // pointer as a live attractor every frame, so the grid leans toward the
  // cursor at range while the classic short-range hover repulsor still parts
  // it up close — approach, never collapse. The other looks keep the exact
  // legacy pointer force field (gravity stays unset there).
  if (currentLook === 'cyberpunk') app.interactive({ gravity: CURSOR_GRAVITY })
  // Neon galaxy only: a binary pair of gravity wells slowly orbits the disc,
  // dragging the arms into local eddies — see binaryWells() below.
  if (currentLook === 'neon-galaxy') stopWells = binaryWells(app)
  await app.run()
  ;(window as unknown as { __yura: unknown }).__yura = app
  app.onStats((s) => {
    fpsEl.textContent = String(s.fps)
    particlesEl.textContent = (stormFx ? stormFx.alive : s.particles).toLocaleString('en-US')
    resEl.textContent = `×${s.resolutionScale.toFixed(2).replace(/0$/, '')}`
    backendEl.textContent = s.backend.toUpperCase()
    drawSpark()
  }, 250)
  cover.classList.add('hidden')
  booting = false
  setLyricChipEnabled(!storm) // lyric motion is a swarm act
  // Sakura opens as a lyric act: the look was tuned for kinetic typography
  // (soft screen-blend glow, gentle reinhard highlights), so its own petal
  // verses start sweeping in immediately. The chip still toggles them off.
  if (currentLook === 'sakura') startLyrics()
  syncChips()
}

// ------------------------------------------------------------- helix storm

/**
 * HELIX STORM — tonight's fx act. shapes.helix() from the registry becomes a
 * slowly swirling star-stream emitter, and every few seconds a directional
 * shower bursts down its axis: direction + spread aim it, shape 'disc' widens
 * the source, colorEnd fades cyan → deep violet, drag settles the sparks.
 */
function helixStorm(a: YuraApp): void {
  const scene = a.look('aurora').gradient('#67e8f9', '#c4b5fd').scene({ keyboard: false })
  stormFx = scene.fx
  const path = shapes.helix({ turns: 3, radius: 0.85, height: 2.3 }).generate(360) as Float32Array
  let shower = 2.6
  scene.onUpdate((_dt, _input, t) => {
    const c = Math.cos(t * 0.45)
    const s = Math.sin(t * 0.45)
    // eases.expo swells the stream's glow as the next shower approaches.
    const glow = 1.4 + 2.4 * eases.expo(Math.max(1 - (shower - t) / 0.9, 0))
    for (let k = 0; k < 3; k++) {
      const i = ((Math.random() * 360) | 0) * 4
      scene.burst([path[i] * c - path[i + 2] * s, path[i + 1], path[i] * s + path[i + 2] * c], {
        count: 2, speed: 0.14, life: 1.9, size: 0.026, gravity: 0, drag: 1.6,
        color: ['#67e8f9', '#c4b5fd'], colorEnd: '#312e81', intensity: glow,
      })
    }
    if (t < shower) return
    shower = t + 3.2
    scene.burst([0, 1.5, 0], {
      count: 260, direction: [0, -1, 0], spread: 0.24, shape: 'disc', radius: 0.55,
      speed: 2.4, life: 1.25, size: 0.05, gravity: -0.4, drag: 0.7,
      color: ['#67e8f9', '#a5f3fc', '#f0abfc'], colorEnd: '#4c1d95', intensity: 3,
    })
  })
}

// ------------------------------------------------------------ binary wells

/**
 * BINARY WELLS — the neon galaxy's gravity act. Two equal attractors orbit
 * the disc in counter-phase like a binary star pair, each dragging the
 * nearby arms into a slow eddy around itself (and gently warping the YURA
 * glyphs whenever the auto-cycle passes through text). Both sims re-pack
 * `motion.attractors` every frame, so mutating the well positions in place
 * IS the live-retune path — no per-frame API calls. All scales derive from
 * YURA_SHAPE_RADIUS so the pair stays mid-disc if the shapes ever grow.
 */
const WELL_PHASES = [0, Math.PI] // counter-phase: one well on each side of the core
const WELL_ORBIT_RADIUS = YURA_SHAPE_RADIUS * 0.4 // mid-disc, riding between the arms
const WELL_ORBIT_RATE = 0.12 // rad/s — one full revolution every ~52 s
const WELL_STRENGTH = 20 // accel = strength / (d² + radius²): a firm but calm tug
/**
 * CURSOR GRAVITY — the cyberpunk act's pull, fed to `.interactive({ gravity })`.
 * Same accel formula as the wells above; sized against WELL_STRENGTH ("firm
 * but calm") so the pointer reads as the strongest single attractor on stage
 * without whipping the swarm around. (Referenced from boot(), which is first
 * invoked further down the module — this const is initialized by then.)
 */
const CURSOR_GRAVITY = WELL_STRENGTH * 1.5
const WELL_SOFT_RADIUS = YURA_SHAPE_RADIUS * 0.2 // wide softening core — no slingshots
const WELL_BOB = YURA_SHAPE_RADIUS * 0.08 // slight counter-phase weave out of the plane

/** One well's center at orbital angle `phase` — boot and the orbit loop share it. */
function wellCenter(phase: number, out: [number, number, number]): void {
  out[0] = Math.cos(phase) * WELL_ORBIT_RADIUS
  out[1] = Math.sin(phase) * WELL_BOB // phase offset π flips the bob: counter-phase for free
  out[2] = Math.sin(phase) * WELL_ORBIT_RADIUS
}

/** Install the pair (before run()) and start their orbit; returns the cancel. */
function binaryWells(a: YuraApp): () => void {
  const wells: AttractorParams[] = WELL_PHASES.map((phase) => {
    const position: [number, number, number] = [0, 0, 0]
    wellCenter(phase, position)
    return { position, strength: WELL_STRENGTH, radius: WELL_SOFT_RADIUS }
  })
  a.motion({ attractors: wells }) // sticky: survives any later .preset() swap
  const t0 = performance.now()
  let raf = requestAnimationFrame(function orbit() {
    const t = (performance.now() - t0) / 1000
    for (let i = 0; i < wells.length; i++) {
      wellCenter(WELL_PHASES[i] + t * WELL_ORBIT_RATE, wells[i].position)
    }
    raf = requestAnimationFrame(orbit)
  })
  return () => cancelAnimationFrame(raf)
}

// ------------------------------------------------------------------ chips

function chip(label: string, cls = ''): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = `chip ${cls}`.trim()
  b.textContent = label
  return b
}

const lookChips = new Map<LookId, HTMLButtonElement>()
for (const l of LOOKS) {
  const b = chip(l.label)
  b.addEventListener('click', () => {
    currentLook = l.id
    void boot()
  })
  lookRow.appendChild(b)
  lookChips.set(l.id, b)
}
lookRow.appendChild(Object.assign(document.createElement('div'), { className: 'sep' }))
for (const m of MORPHS) {
  const b = chip(m.label, 'ghost')
  b.addEventListener('click', () => {
    if (currentLook === 'helix-storm') return // morphs are a swarm act
    promptEl.value = ''
    stopLyrics()
    void app?.morphNow(m.make())
  })
  lookRow.appendChild(b)
}

// ------------------------------------------------------------- lyric motion

/**
 * LYRIC MOTION — kinetic typography act. Two Japanese lines plus the brand
 * word, each swept in glyph by glyph (char-by-char sweep) by lyrics(),
 * looping until toggled off or interrupted by any other morph.
 */
const LYRIC_LINES = [
  { text: 'ゆらめく光', at: 0 },
  '百万の粒子が',
  '波のように踊る',
  { text: 'YURA', direction: 'center' as const },
]

/**
 * Sakura's own verses — spring dusk swept petal by petal, laid out as
 * tategaki (vertical writing): each verse is a column read top to bottom,
 * and the two-part line becomes a pair of columns read right to left.
 * Short, even lines (4-6 glyphs) keep the columns balanced on screen.
 */
const SAKURA_LINES = [
  { text: '桜ひらひら', at: 0 },
  '花びらの渦',
  '春の宵に\n舞い散る',
  { text: 'YURA', direction: 'center' as const },
]

let lyricRun: LyricsRun | null = null
const lyricChip = chip('lyric motion', 'ghost')

/** Start the loop with the verse set that fits the active look. */
function startLyrics(): void {
  if (!app) return
  const sakura = currentLook === 'sakura'
  // sweep 0.8 → strong per-character stagger: each glyph condenses in turn.
  // Sakura runs as tategaki (vertical: true): columns read right to left,
  // glyphs sweeping top to bottom like falling petals — a longer sweep and
  // a slower cadence give the vertical reading order room to breathe.
  lyricRun = sakura
    ? lyrics(app, SAKURA_LINES, { every: 3.6, sweep: 0.85, loop: true, loopTail: 3, vertical: true })
    : lyrics(app, LYRIC_LINES, { every: 3.4, sweep: 0.8, loop: true, loopTail: 3 })
  lyricChip.classList.add('on')
}

/**
 * The lyric act needs a live app: during boot the click used to be silently
 * swallowed by the `booting` guard. Disable the chip visibly instead
 * (native disabled + class for styling), re-enabling once boot completes.
 */
function setLyricChipEnabled(enabled: boolean): void {
  lyricChip.disabled = !enabled
  lyricChip.classList.toggle('disabled', !enabled)
}

function stopLyrics(): void {
  if (!lyricRun) return
  lyricRun.stop()
  lyricRun = null
  lyricChip.classList.remove('on')
}

lyricChip.addEventListener('click', () => {
  if (!app || booting) return
  if (lyricRun) {
    stopLyrics()
    void app.morphNow(shapes.galaxy())
    return
  }
  promptEl.value = ''
  startLyrics()
})
lookRow.appendChild(Object.assign(document.createElement('div'), { className: 'sep' }))
lookRow.appendChild(lyricChip)

const countChips = new Map<number, HTMLButtonElement>()
for (const c of COUNTS) {
  const b = chip(c.label, 'ghost')
  b.addEventListener('click', () => {
    currentCount = c.n
    void boot()
  })
  countRow.appendChild(b)
  countChips.set(c.n, b)
}

function syncChips(): void {
  for (const [id, b] of lookChips) b.classList.toggle('on', id === currentLook)
  for (const [n, b] of countChips) b.classList.toggle('on', n === currentCount)
}

// ------------------------------------------------------------------ prompt

promptEl.addEventListener('keydown', (e) => {
  // An IME confirm-Enter (isComposing / legacy 229) is not a submit — and
  // blurring mid-composition makes Chrome re-commit the text, doubling it.
  if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229 || !app || currentLook === 'helix-storm') return
  stopLyrics()
  const word = promptEl.value.trim()
  void app.morphNow(word ? word.toUpperCase() : shapes.galaxy())
  promptEl.blur()
})

window.addEventListener('keydown', (e) => {
  if (document.activeElement === promptEl || e.isComposing || !e.isTrusted || e.metaKey || e.ctrlKey || e.altKey) return
  const idx = Number(e.key) - 1
  if (idx >= 0 && idx < LOOKS.length) {
    currentLook = LOOKS[idx].id
    void boot()
  }
})

// ------------------------------------------------------------------ HUD

function drawSpark(): void {
  const w = spark.width
  const h = spark.height
  sparkCtx.clearRect(0, 0, w, h)
  const frames = app?.frames(88) ?? []
  const bw = w / 88
  for (let i = 0; i < frames.length; i++) {
    const ms = frames[i]
    const t = Math.min(ms / 40, 1)
    const bh = Math.max(t * h, 2)
    sparkCtx.fillStyle = ms < 9 ? '#34d399' : ms < 17.5 ? '#67e8f9' : ms < 34 ? '#fbbf24' : '#fb7185'
    sparkCtx.fillRect(i * bw, h - bh, bw - 1.2, bh)
  }
}

// ------------------------------------------------------------------ calm mode

let calmTimer = 0
function wake(): void {
  document.body.classList.remove('calm')
  clearTimeout(calmTimer)
  calmTimer = window.setTimeout(() => {
    if (document.activeElement !== promptEl) document.body.classList.add('calm')
  }, 4000) as unknown as number
}
window.addEventListener('pointermove', wake)
window.addEventListener('pointerdown', wake)
window.addEventListener('keydown', wake)
wake()

void boot()
