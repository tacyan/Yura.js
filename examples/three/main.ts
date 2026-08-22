/**
 * Yura.js × Three.js — a normal Three scene (meshes, lights, orbit camera)
 * with Yura's 500k-particle galaxy composited around a Three object.
 *
 * The whole Yura integration is the three lines marked with ★ below.
 * Everything else is a plain Three.js scene.
 */
import * as THREE from 'three'
import { yuraLayer } from 'yura/three'
import { shapes } from 'yura'

const stage = document.getElementById('stage')!

// --- A regular Three.js scene ------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
renderer.toneMapping = THREE.ACESFilmicToneMapping
stage.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x04050c) // deep-space navy — the live-stage ambiance

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 200)

// Centerpiece the swarm will orbit — an iridescent knot. MeshNormalMaterial
// needs no lights and gives the soft pastel-rainbow shading on its own.
const knot = new THREE.Mesh(
  new THREE.TorusKnotGeometry(1, 0.42, 256, 48),
  new THREE.MeshNormalMaterial(),
)
knot.position.set(0, 1.6, 0)
scene.add(knot)

// Minimal orbit control (drag + wheel + inertia) — no addons needed.
let yaw = 0.6
let pitch = 0.42
let dist = 9
let vyaw = 0.05
let vpitch = 0
let dragging = false
let px = 0
let py = 0
const el = renderer.domElement
el.style.touchAction = 'none'
el.addEventListener('pointerdown', (e) => {
  dragging = true
  px = e.clientX
  py = e.clientY
  el.setPointerCapture?.(e.pointerId)
})
el.addEventListener('pointermove', (e) => {
  if (!dragging) return
  vyaw = (e.clientX - px) * 0.005
  vpitch = (e.clientY - py) * 0.005
  yaw += vyaw
  pitch = Math.min(Math.max(pitch + vpitch, -0.1), 1.3)
  px = e.clientX
  py = e.clientY
})
el.addEventListener('pointerup', () => (dragging = false))
el.addEventListener('pointerleave', () => (dragging = false))
el.addEventListener('wheel', (e) => {
  e.preventDefault()
  dist = Math.min(Math.max(dist * (1 + e.deltaY * 0.001), 4), 24)
}, { passive: false })

// --- ★ The Yura integration (3 lines) ---------------------------------------

const fx = await yuraLayer(renderer, camera, { preset: 'neon-galaxy', particles: 500_000, radius: 3.4 }) // ★ 1
fx.attach(knot) // ★ 2 — the galaxy follows the torus knot
// ★ 3 is fx.sync() inside the render loop below.

// -----------------------------------------------------------------------------

// Slow shape cycle: galaxy → vortex → sphere → particle text.
const cycle = [shapes.vortex(), shapes.sphere(), shapes.text('YURA'), shapes.galaxy()]
let cycleIdx = 0
setInterval(() => {
  void fx.morphTo(cycle[cycleIdx++ % cycle.length])
}, 8000)

renderer.setAnimationLoop((t: number) => {
  const time = t / 1000
  if (!dragging) {
    vyaw *= 0.95
    vpitch *= 0.95
    yaw += vyaw + 0.0012 // idle auto-rotate
    pitch = Math.min(Math.max(pitch + vpitch, -0.1), 1.3)
  }
  camera.position.set(
    Math.sin(yaw) * Math.cos(pitch) * dist,
    1.6 + Math.sin(pitch) * dist,
    Math.cos(yaw) * Math.cos(pitch) * dist,
  )
  camera.lookAt(0, 1.2, 0)

  knot.rotation.y = time * 0.25
  knot.rotation.x = Math.sin(time * 0.17) * 0.3

  renderer.render(scene, camera)
  fx.sync() // ★ 3 — after render, so the swarm tracks this frame's camera
})

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

// HUD.
const hud = document.getElementById('hud')!
setInterval(() => {
  const s = fx.stats
  hud.textContent = `three.js ${THREE.REVISION} + yura ${s.backend} · ${s.fps} fps · ${(s.particles / 1000).toFixed(0)}k particles`
}, 500)
