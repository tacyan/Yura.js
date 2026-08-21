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
scene.background = new THREE.Color(0x04050c)
scene.fog = new THREE.FogExp2(0x04050c, 0.028)

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 200)

// Lights: a dim key plus two colored points that echo the particle gradient.
scene.add(new THREE.AmbientLight(0x223344, 0.6))
const keyLight = new THREE.DirectionalLight(0xdde6ff, 1.2)
keyLight.position.set(6, 10, 4)
scene.add(keyLight)
const cyan = new THREE.PointLight(0x22d3ee, 60, 40)
cyan.position.set(5, 3, -4)
scene.add(cyan)
const violet = new THREE.PointLight(0x8b5cf6, 60, 40)
violet.position.set(-5, 2, 4)
scene.add(violet)

// Centerpiece the swarm will orbit.
const knot = new THREE.Mesh(
  new THREE.TorusKnotGeometry(1, 0.32, 220, 36),
  new THREE.MeshStandardMaterial({
    color: 0x8896b8,
    metalness: 0.95,
    roughness: 0.22,
    emissive: 0x0b1436,
    emissiveIntensity: 0.6,
  }),
)
knot.position.set(0, 1.6, 0)
scene.add(knot)

// Dark reflective floor.
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(26, 64),
  new THREE.MeshStandardMaterial({ color: 0x0a0e1e, metalness: 0.6, roughness: 0.4 }),
)
floor.rotation.x = -Math.PI / 2
floor.position.y = -1.4
scene.add(floor)

// A few drifting shards.
const shards: THREE.Mesh[] = []
const shardMat = new THREE.MeshStandardMaterial({
  color: 0x64748b,
  metalness: 0.9,
  roughness: 0.3,
  emissive: 0x164e63,
  emissiveIntensity: 0.9,
})
for (let i = 0; i < 6; i++) {
  const shard = new THREE.Mesh(new THREE.OctahedronGeometry(0.22 + (i % 3) * 0.09), shardMat)
  shards.push(shard)
  scene.add(shard)
}

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
  for (let i = 0; i < shards.length; i++) {
    const a = time * (0.12 + i * 0.03) + (i * Math.PI * 2) / shards.length
    const r = 4.6 + (i % 3)
    shards[i].position.set(Math.cos(a) * r, 1.6 + Math.sin(time * 0.6 + i * 2) * 0.9, Math.sin(a) * r)
    shards[i].rotation.set(time * 0.4 + i, time * 0.3, 0)
  }

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
