import { test, expect } from 'bun:test'
import {
  YuraScene,
  SceneInput,
  rollDelta,
  cameraFollowGoal,
  stickAxes,
  isTap,
  combineAxes,
  padDeadZone,
  readGamepads,
  clampToBounds,
} from '../src/scene'
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

// --- Rolling spheres --------------------------------------------------------

test('rollDelta: axis is horizontal, perpendicular to travel; angle = dist / r', () => {
  const d = rollDelta(3, 0, 0.5, 1 / 60) // moving +x
  expect(d.axis[0]).toBe(0)
  expect(d.axis[1]).toBe(0)
  expect(d.axis[2]).toBe(-1) // up x v for +x travel
  expect(d.angle).toBeCloseTo((3 / 0.5) * (1 / 60), 6)
  expect(Math.hypot(...d.axis)).toBeCloseTo(1, 6) // unit axis
})

test('rollDelta: no rotation at rest or with a degenerate radius', () => {
  expect(rollDelta(0, 0, 0.5, 1 / 60).angle).toBe(0)
  expect(rollDelta(2, 1, 0, 1 / 60).angle).toBe(0)
})

test('a moving dynamic sphere accumulates roll orientation; a box does not', () => {
  const scene = new YuraScene({ gravity: -20 })
  scene.add('plane', { size: 20 })
  const ball = scene.add('sphere', { radius: 0.5, position: [0, 0.5, 0], body: 'dynamic' })
  const box = scene.add('box', { size: 1, position: [5, 0.7, 5], body: 'dynamic' })
  ball.velocity[0] = 4
  box.velocity[0] = 4
  for (let i = 0; i < 30; i++) scene.step(1 / 60, i / 60)
  const q = ball.rollQuat
  expect(q).not.toBeNull()
  expect(Math.hypot(q![0], q![1], q![2], q![3])).toBeCloseTo(1, 5) // stays normalized
  expect(Math.abs(q![2])).toBeGreaterThan(0.01) // rotated about z for +x travel
  expect(box.rollQuat).toBeNull() // only spheres roll
})

// --- Camera follow math -----------------------------------------------------

test('cameraFollowGoal at rest: eye sits behind and above, look at the target', () => {
  const g = cameraFollowGoal([1, 2, 3], [0, 0, 0], { distance: 8, height: 3.6 })
  expect(g.eye).toEqual([1, 5.6, 11])
  expect(g.look).toEqual([1, 2.5, 3])
})

test('cameraFollowGoal widens with speed and looks ahead, both capped', () => {
  const base = { distance: 8, height: 3.6 }
  const slow = cameraFollowGoal([0, 1, 0], [4, 0, 0], base)
  expect(slow.eye[2]).toBeGreaterThan(8) // a little wider than the base distance
  expect(slow.eye[1]).toBeGreaterThan(4.6) // and a little higher
  expect(slow.look[0]).toBeCloseTo(4 * 0.22, 6) // look-ahead in travel direction
  const fast = cameraFollowGoal([0, 1, 0], [40, 0, -40], base)
  expect(fast.eye[2]).toBeCloseTo(8 * 1.3, 6) // widening capped at +30%
  expect(fast.look[0]).toBe(1.6) // look-ahead capped
  expect(fast.look[2]).toBe(-1.6)
})

test('cameraFollowGoal landing dip lowers the eye and eases the look down', () => {
  const base = cameraFollowGoal([0, 1, 0], [0, 0, 0], { distance: 8, height: 3.6 })
  const dipped = cameraFollowGoal([0, 1, 0], [0, 0, 0], { distance: 8, height: 3.6 }, 0.4)
  expect(dipped.eye[1]).toBeCloseTo(base.eye[1] - 0.4, 6)
  expect(dipped.look[1]).toBeCloseTo(base.look[1] - 0.2, 6)
})

test('a hard landing records its impact speed for the camera dip', () => {
  const scene = new YuraScene({ gravity: -20 })
  scene.add('plane', { size: 10 })
  const ball = scene.add('sphere', { radius: 0.5, position: [0, 4, 0], body: 'dynamic' })
  for (let i = 0; i < 45; i++) scene.step(1 / 60, i / 60)
  expect(ball.impact).toBeGreaterThan(5) // fell ~3.5 units: v = sqrt(2*g*h) ≈ 11.8
})

// --- scene.reset() ----------------------------------------------------------

test('reset revives removed objects and restores spawn state', () => {
  const scene = new YuraScene({ gravity: -20, bounds: 10 })
  scene.add('plane', { size: 20 })
  const ball = scene.add('sphere', { radius: 0.5, position: [0, 3, 7], body: 'dynamic' })
  const orb = scene.add('sphere', { radius: 0.3, position: [2, 1, 0], tag: 'orb' })
  const total = scene.objectCount
  ball.velocity[0] = 9
  for (let i = 0; i < 90; i++) scene.step(1 / 60, i / 60)
  orb.remove()
  expect(scene.count('orb')).toBe(0)
  scene.reset()
  expect(scene.objectCount).toBe(total)
  expect(scene.count('orb')).toBe(1)
  expect(orb.alive).toBe(true)
  expect(ball.position).toEqual([0, 3, 7])
  expect(ball.velocity).toEqual([0, 0, 0])
  expect(ball.rollQuat).toBeNull()
})

test('reset clears particles and the sim still settles cleanly afterwards', () => {
  const scene = new YuraScene({ gravity: -20 })
  scene.add('plane', { size: 20 })
  const ball = scene.add('sphere', { radius: 0.5, position: [0, 2, 0], body: 'dynamic' })
  scene.burst([0, 1, 0], { count: 40 })
  scene.step(1 / 60, 0)
  expect(scene.fx.alive).toBeGreaterThan(0)
  scene.reset()
  expect(scene.fx.alive).toBe(0)
  for (let i = 1; i < 240; i++) scene.step(1 / 60, i / 60)
  expect(ball.position[1]).toBeCloseTo(0.5, 1) // physics keeps working post-reset
})

// --- universal input: virtual stick, tap-to-jump, gamepad, source combination ---

test('stickAxes: dead zone, linear ramp to full at the radius, clamp beyond', () => {
  expect(stickAxes(4, 0)).toEqual({ x: 0, y: 0 }) // inside the 8px dead zone
  expect(stickAxes(64, 0).x).toBeCloseTo(1, 6) // full deflection at the radius
  expect(stickAxes(36, 0).x).toBeCloseTo(0.5, 6) // halfway between dead zone and radius
  expect(stickAxes(500, 0).x).toBeCloseTo(1, 6) // clamped past the radius
  expect(stickAxes(0, -64).y).toBeCloseTo(1, 6) // drag up (screen -dy) = forward
  expect(stickAxes(0, 64).y).toBeCloseTo(-1, 6) // drag down = backward
})

test('isTap: quick + small = tap; long or travelled presses are drags', () => {
  expect(isTap(0.1, 4)).toBe(true)
  expect(isTap(0.25, 4)).toBe(false) // held too long
  expect(isTap(0.1, 30)).toBe(false) // moved too far
  expect(isTap(0.2, 0)).toBe(false) // boundary is exclusive
})

test('combineAxes: the largest-magnitude source wins per axis', () => {
  expect(combineAxes()).toBe(0)
  expect(combineAxes(0.3, -0.8, 0.5)).toBe(-0.8)
  expect(combineAxes(1, -0.4)).toBe(1)
})

test('padDeadZone: below 0.15 reads zero, above rescales smoothly to 1', () => {
  expect(padDeadZone(0.1)).toBe(0)
  expect(padDeadZone(0.15)).toBe(0)
  expect(padDeadZone(0.575)).toBeCloseTo(0.5, 6)
  expect(padDeadZone(1)).toBeCloseTo(1, 6)
  expect(padDeadZone(-1)).toBeCloseTo(-1, 6)
})

test('a touch drag drives input.x/y and releasing returns the stick to zero', () => {
  const input = new SceneInput()
  input.pointerDown(1, 100, 100)
  input.pointerMove(1, 164, 100) // 64px right = full deflection
  expect(input.x).toBeCloseTo(1, 6)
  expect(input.y).toBeCloseTo(0, 6)
  input.pointerMove(1, 100, 36) // 64px up = forward
  expect(input.y).toBeCloseTo(1, 6)
  input.pointerUp(1)
  expect(input.x).toBe(0)
  expect(input.y).toBe(0)
  expect(input.jump).toBe(false) // it travelled — a drag, not a tap
})

test('a quick small tap feeds the shared jump buffer', () => {
  const input = new SceneInput()
  input.pointerDown(1, 50, 50)
  input.pointerMove(1, 54, 50) // 4px wiggle stays a tap
  for (let i = 0; i < 3; i++) input.endFrame(1 / 60) // released after 50ms
  input.pointerUp(1)
  expect(input.jump).toBe(true)
  expect(input.jump).toBe(false) // consumed like a Space tap
})

test('second-finger tap jumps while the first finger keeps steering', () => {
  const input = new SceneInput()
  input.pointerDown(1, 100, 100)
  input.pointerMove(1, 164, 100)
  for (let i = 0; i < 3; i++) input.endFrame(1 / 60)
  input.pointerDown(2, 300, 200) // second finger = jump edge
  expect(input.x).toBeCloseTo(1, 6) // stick untouched
  expect(input.jump).toBe(true)
  input.pointerUp(2)
  input.pointerUp(1) // long drag ends without another jump
  expect(input.jump).toBe(false)
})

test('keyboard, touch, and gamepad combine — largest magnitude wins per axis', () => {
  const input = new SceneInput()
  input.keyDown('KeyD')
  input.pointerDown(1, 0, 0)
  input.pointerMove(1, -36, 0) // stick says -0.5
  expect(input.x).toBe(1) // keyboard is stronger
  input.keyUp('KeyD')
  expect(input.x).toBeCloseTo(-0.5, 6) // now the stick wins
  input.applyPad({ x: 0.9, y: 0, jump: false })
  expect(input.x).toBeCloseTo(0.9, 6) // pad out-deflects the stick
  input.pointerMove(1, -64, 0)
  expect(input.x).toBeCloseTo(-1, 6) // full stick beats the pad
})

test('gamepad A edge feeds the shared jump buffer and re-arms per press', () => {
  const input = new SceneInput()
  input.applyPad({ x: 0, y: 0, jump: true }) // press edge
  input.applyPad({ x: 0, y: 0, jump: false }) // released before the frame read
  expect(input.jump).toBe(true) // the edge was buffered
  expect(input.jump).toBe(false) // consumed
  input.applyPad({ x: 0, y: 0, jump: true })
  expect(input.jump).toBe(true) // next press re-arms
})

test('readGamepads: dead-zones the left stick, folds pads, reads A/cross', () => {
  expect(readGamepads(null)).toEqual({ x: 0, y: 0, jump: false })
  expect(readGamepads([null, { axes: [0.1, -0.1], buttons: [{ pressed: false }] }])).toEqual({
    x: 0,
    y: 0,
    jump: false,
  })
  const r = readGamepads([{ axes: [0.575, -1], buttons: [{ pressed: true }] }])
  expect(r.x).toBeCloseTo(0.5, 6)
  expect(r.y).toBeCloseTo(1, 6) // stick up (-1) = forward
  expect(r.jump).toBe(true)
  expect(readGamepads([{ axes: [1, 0], buttons: [{ pressed: true }], connected: false }]).x).toBe(0)
})

test('clampToBounds zeroes outward velocity at the wall, keeps inward', () => {
  expect(clampToBounds(3, 2, 4.5)).toEqual({ position: 3, velocity: 2 }) // inside: untouched
  expect(clampToBounds(4.7, 3, 4.5)).toEqual({ position: 4.5, velocity: 0 }) // outward: zeroed
  expect(clampToBounds(4.7, -2, 4.5)).toEqual({ position: 4.5, velocity: -2 }) // inward survives
  expect(clampToBounds(-4.7, -3, 4.5)).toEqual({ position: -4.5, velocity: 0 }) // far wall too
})

test('holding a direction into the arena wall pins the ball without jitter', () => {
  const scene = new YuraScene({ gravity: -20, bounds: 5 })
  scene.add('plane', { size: 12 })
  const ball = scene.add('sphere', { radius: 0.5, position: [3, 0.5, 0], body: 'dynamic' })
  scene.onUpdate((dt) => {
    ball.velocity[0] += 40 * dt // held right, straight into the wall
  })
  for (let i = 0; i < 120; i++) scene.step(1 / 60, i / 60)
  for (let i = 120; i < 180; i++) {
    scene.step(1 / 60, i / 60)
    expect(ball.position[0]).toBe(4.5) // glued to the wall, not vibrating off it
  }
})
