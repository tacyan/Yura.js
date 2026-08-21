import { test, expect } from 'bun:test'
import { YuraScene, SceneInput } from '../src/scene'
import { resolveMaterial, materials } from '../src/materials'

// Scenes run headless before attach(): physics and collisions are pure JS.

test('gravity pulls a dynamic body down and the ground stops it', () => {
  const scene = new YuraScene({ gravity: -20 })
  scene.add('plane', { size: 10 })
  const ball = scene.add('sphere', { radius: 0.5, position: [0, 5, 0], body: 'dynamic' })
  for (let i = 0; i < 600; i++) scene.step(1 / 60, i / 60)
  expect(ball.position[1]).toBeCloseTo(0.5, 1)
  expect(ball.grounded).toBe(true)
})

test('collision callbacks fire and remove() works', () => {
  const scene = new YuraScene({})
  const a = scene.add('sphere', { radius: 0.5, position: [0, 0, 0], body: 'dynamic' })
  const orb = scene.add('sphere', { radius: 0.5, position: [3, 0, 0], tag: 'orb' })
  let hits = 0
  a.onCollide((other) => {
    if (other.tag === 'orb') {
      hits++
      other.remove()
    }
  })
  a.velocity[0] = 10
  for (let i = 0; i < 120; i++) scene.step(1 / 60, i / 60)
  expect(hits).toBeGreaterThan(0)
  expect(scene.count('orb')).toBe(0)
})

test('solid objects push dynamic bodies out', () => {
  const scene = new YuraScene({})
  const wall = scene.add('sphere', { radius: 1, position: [3, 0, 0], solid: true })
  const ball = scene.add('sphere', { radius: 0.5, position: [0, 0, 0], body: 'dynamic' })
  ball.velocity[0] = 8
  for (let i = 0; i < 120; i++) scene.step(1 / 60, i / 60)
  const dist = Math.hypot(ball.position[0] - wall.position[0], ball.position[2] - wall.position[2])
  expect(dist).toBeGreaterThanOrEqual(1.49)
})

test('bounds bounce bodies back inside', () => {
  const scene = new YuraScene({ bounds: 5 })
  const ball = scene.add('sphere', { radius: 0.5, body: 'dynamic' })
  ball.velocity[0] = 30
  for (let i = 0; i < 120; i++) scene.step(1 / 60, i / 60)
  expect(Math.abs(ball.position[0])).toBeLessThanOrEqual(4.51)
})

test('material presets resolve', () => {
  expect(resolveMaterial('chrome').metallic).toBe(1)
  expect(resolveMaterial('#ff0000').color[0]).toBeGreaterThan(0.9)
  const n = materials.neon('#22d3ee')
  expect(Math.max(...n.emissive)).toBeGreaterThan(1)
})

// --- Jump intent: buffer, consume-on-use, coyote time -----------------------

test('a within-frame Space tap still registers as jump intent', () => {
  const input = new SceneInput()
  input.keyDown('Space')
  input.keyUp('Space') // released before the frame ever samples the key
  expect(input.jump).toBe(true)
})

test('jump is consumed on use and re-arms on the next keydown edge', () => {
  const input = new SceneInput()
  input.keyDown('Space')
  input.keyUp('Space')
  expect(input.jump).toBe(true)
  expect(input.jump).toBe(false) // consumed
  input.keyDown('Space')
  input.keyUp('Space')
  expect(input.jump).toBe(true) // new edge re-arms
})

test('a released tap expires after the ~150ms jump buffer', () => {
  const input = new SceneInput()
  input.keyDown('Space')
  input.keyUp('Space')
  for (let i = 0; i < 12; i++) input.endFrame(1 / 60) // 200ms of frames
  expect(input.jump).toBe(false)
})

test('reading jump while nothing can take off does not consume the buffer', () => {
  const input = new SceneInput()
  input.keyDown('Space')
  input.keyUp('Space')
  input.jumpEligible = false // airborne: scene reports no jump-capable body
  expect(input.jump).toBe(false)
  expect(input.jump).toBe(false)
  input.jumpEligible = true // landed within the buffer window
  expect(input.jump).toBe(true)
})

test('holding Space keeps the jump intent alive for re-jumps', () => {
  const input = new SceneInput()
  input.keyDown('Space')
  expect(input.jump).toBe(true)
  for (let i = 0; i < 30; i++) input.endFrame(1 / 60) // buffer long expired
  expect(input.jump).toBe(true) // still held
  input.keyUp('Space')
  expect(input.jump).toBe(false)
})

test('clearKeys (blur / tab-hide) drops held keys and jump intent', () => {
  const input = new SceneInput()
  input.keyDown('KeyD')
  input.keyDown('Space')
  expect(input.x).toBe(1)
  input.clearKeys()
  expect(input.x).toBe(0)
  expect(input.key('KeyD')).toBe(false)
  expect(input.jump).toBe(false)
})

test('a tap just before landing jumps on the landing frame (buffer + game loop)', () => {
  const scene = new YuraScene({ gravity: -22 })
  scene.add('plane', { size: 24 })
  const ball = scene.add('sphere', { radius: 0.45, position: [0, 3, 0], body: 'dynamic' })
  let jumped = false
  scene.onUpdate((_dt, input) => {
    if (input.jump && ball.grounded) {
      ball.velocity[1] = 8.5
      jumped = true
    }
  })
  // Fall for 0.4s (still airborne), then tap Space ~80ms before touchdown.
  let frame = 0
  for (; frame < 24; frame++) scene.step(1 / 60, frame / 60)
  expect(ball.grounded).toBe(false)
  scene.input.keyDown('Space')
  scene.input.keyUp('Space')
  let peak = 0
  for (; frame < 90; frame++) {
    scene.step(1 / 60, frame / 60)
    peak = Math.max(peak, ball.position[1])
  }
  expect(jumped).toBe(true)
  expect(peak).toBeGreaterThan(1.5) // actually took off, not just bounced
})

test('a tap far before landing expires instead of jumping', () => {
  const scene = new YuraScene({ gravity: -22 })
  scene.add('plane', { size: 24 })
  const ball = scene.add('sphere', { radius: 0.45, position: [0, 3, 0], body: 'dynamic' })
  let jumped = false
  scene.onUpdate((_dt, input) => {
    if (input.jump && ball.grounded) {
      ball.velocity[1] = 8.5
      jumped = true
    }
  })
  scene.step(1 / 60, 0)
  scene.input.keyDown('Space')
  scene.input.keyUp('Space') // ~460ms before touchdown — outside the buffer
  for (let i = 1; i < 120; i++) scene.step(1 / 60, i / 60)
  expect(jumped).toBe(false)
  expect(ball.position[1]).toBeCloseTo(0.45, 1)
})

test('coyote time keeps grounded true briefly after leaving the ground', () => {
  const scene = new YuraScene({ gravity: -20 })
  scene.add('plane', { size: 10 })
  const ball = scene.add('sphere', { radius: 0.5, position: [0, 0.5, 0], body: 'dynamic' })
  for (let i = 0; i < 120; i++) scene.step(1 / 60, i / 60)
  expect(ball.grounded).toBe(true)
  ball.position[1] = 3 // leaves the ground (falling, not jumping)
  scene.step(1 / 60, 2)
  expect(ball.groundedNow).toBe(false)
  expect(ball.grounded).toBe(true) // inside the ~100ms grace window
  for (let i = 1; i <= 12; i++) scene.step(1 / 60, 2 + i / 60)
  expect(ball.grounded).toBe(false) // grace expired
})

test('coyote grace never applies while moving upward (no double jump)', () => {
  const scene = new YuraScene({ gravity: -20 })
  scene.add('plane', { size: 10 })
  const ball = scene.add('sphere', { radius: 0.5, position: [0, 0.5, 0], body: 'dynamic' })
  for (let i = 0; i < 60; i++) scene.step(1 / 60, i / 60)
  ball.velocity[1] = 8 // jump impulse
  scene.step(1 / 60, 1)
  expect(ball.groundedNow).toBe(false)
  expect(ball.grounded).toBe(false)
})

// --- Cylinder collider ------------------------------------------------------

test('cylinders collide at their visual radius with a radial XZ push-out', () => {
  const scene = new YuraScene({})
  const pillar = scene.add('cylinder', { size: [1.1, 2.6, 1.1], position: [0, 1.3, 0], solid: true })
  expect(pillar.radius).toBeCloseTo(0.55, 5) // s3[0]/2, not max(w/2, h/2)
  const ball = scene.add('sphere', { radius: 0.45, position: [0.8, 0.45, 0], body: 'dynamic' })
  ball.velocity[0] = -2
  scene.step(1 / 60, 0)
  const dxz = Math.hypot(ball.position[0], ball.position[2])
  expect(dxz).toBeGreaterThanOrEqual(0.99) // pushed out to r_cyl + r_ball
  expect(ball.position[1]).toBeCloseTo(0.45, 5) // push is purely horizontal
  expect(ball.velocity[0]).toBeGreaterThan(0) // inward velocity reflected
})

test('cylinder collision is inactive outside its height band', () => {
  const scene = new YuraScene({})
  scene.add('cylinder', { size: [1.1, 2.6, 1.1], position: [0, 1.3, 0], solid: true })
  const ball = scene.add('sphere', { radius: 0.45, position: [0.2, 3.2, 0], body: 'dynamic' })
  let hits = 0
  ball.onCollide(() => hits++)
  scene.step(1 / 60, 0)
  expect(hits).toBe(0)
  expect(ball.position[0]).toBeCloseTo(0.2, 5) // no radial shove above the top
})

// --- Sleep threshold --------------------------------------------------------

test('a settled ball rests at exactly ground + radius with zero vy', () => {
  const scene = new YuraScene({ gravity: -20 })
  scene.add('plane', { size: 10 })
  const ball = scene.add('sphere', { radius: 0.5, position: [0, 2, 0], body: 'dynamic' })
  for (let i = 0; i < 300; i++) scene.step(1 / 60, i / 60)
  expect(ball.velocity[1]).toBe(0)
  expect(ball.position[1]).toBe(0.5)
  const before = ball.position[1]
  scene.step(1 / 60, 5.01)
  expect(ball.position[1]).toBe(before) // no per-frame sink/pop micro-jitter
  expect(ball.grounded).toBe(true)
})
