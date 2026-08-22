import { test, expect, spyOn } from 'bun:test'
import { YuraError, CODES } from '@yura/core'
import {
  YuraScene,
  SHAPE_NAMES,
  type ShapeName,
  type AddOptions,
  SceneInput,
  rollDelta,
  cameraFollowGoal,
  stickAxes,
  isTap,
  combineAxes,
  padDeadZone,
  readGamepads,
  clampToBounds,
  occludedEyeDistance,
  easeOcclusion,
  segmentPointDistance,
  segmentAxisDistanceXZ,
  sweptSphereTOI,
  sweptCylinderTOI,
} from '../src/scene'
import { resolveMaterial, materials } from '../src/materials'
import { FX_FLOATS } from '../src/fx'
import { MAX_ATTRACTORS } from '@yura/renderer-webgpu'

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

// --- HUD text metadata across detach/re-attach (device recovery) ---

interface FakeEl {
  style: { cssText: string }
  textContent: string
  removed: boolean
  remove(): void
}

/** Minimal DOM stand-in so mount/unmount cycles run headless. */
function installFakeDocument(): { made: FakeEl[]; uninstall: () => void } {
  const made: FakeEl[] = []
  const doc = {
    createElement: (): FakeEl => {
      const el: FakeEl = {
        style: { cssText: '' },
        textContent: '',
        removed: false,
        remove() {
          this.removed = true
        },
      }
      made.push(el)
      return el
    },
    body: { appendChild: () => {} },
  }
  // Save/restore the previous global instead of assuming no ambient document
  // exists (runtime versions differ in which globals they ship).
  const g = globalThis as { document?: unknown }
  const hadDoc = 'document' in g
  const prevDoc = g.document
  g.document = doc
  return {
    made,
    uninstall: () => {
      if (hadDoc) g.document = prevDoc
      else delete g.document
    },
  }
}

test('HUD text metadata survives detach/re-attach with its current content', () => {
  const scene = new YuraScene({})
  const hud = scene.text('ORBS 0 / 10', { anchor: 'top' }) // headless: metadata only, no DOM yet
  hud.set('ORBS 3 / 10')
  const { made, uninstall } = installFakeDocument()
  try {
    scene.mountTexts() // simulated re-attach after device recovery
    expect(made.length).toBe(1)
    expect(made[0].textContent).toBe('ORBS 3 / 10') // latest content, not the initial
    expect(made[0].style.cssText).toContain('left:50%') // anchor preserved
    hud.set('ORBS 4 / 10') // handle identity survives recovery
    expect(made[0].textContent).toBe('ORBS 4 / 10')
    scene.unmountTexts() // a second device loss
    expect(made[0].removed).toBe(true)
    scene.mountTexts()
    expect(made.length).toBe(2)
    expect(made[1].textContent).toBe('ORBS 4 / 10')
  } finally {
    uninstall()
  }
})

test('a removed HUD text stays gone; set() while detached lands on re-attach', () => {
  const scene = new YuraScene({})
  const gone = scene.text('A')
  const kept = scene.text('B', { anchor: 'top-right' })
  gone.remove()
  const { made, uninstall } = installFakeDocument()
  try {
    scene.mountTexts()
    expect(made.length).toBe(1) // removed handle does not resurrect
    expect(made[0].textContent).toBe('B')
    scene.unmountTexts()
    kept.set('B2') // updated while no element exists
    scene.mountTexts()
    expect(made[1].textContent).toBe('B2')
  } finally {
    uninstall()
  }
})

// --- Camera occlusion pull-in math ---

test('occludedEyeDistance: clear ray returns the full look→eye distance', () => {
  const look = [0, 1, 0]
  const eye = [0, 1, 10]
  expect(occludedEyeDistance(look, eye, [])).toBeCloseTo(10, 6)
  expect(occludedEyeDistance(look, eye, [{ position: [5, 1, 5], radius: 1 }])).toBeCloseTo(10, 6)
})

test('occludedEyeDistance: a blocking sphere pulls the eye to first hit minus margin', () => {
  const look = [0, 1, 0]
  const eye = [0, 1, 10]
  const wall = { position: [0, 1, 5], radius: 1 }
  // 24 samples along 10 units; probe 0.25 → first hit at z = 3.75, minus margin 0.4.
  expect(occludedEyeDistance(look, eye, [wall])).toBeCloseTo(3.35, 6)
  const noMargin = occludedEyeDistance(look, eye, [wall], 0.25, 0)
  expect(noMargin - occludedEyeDistance(look, eye, [wall], 0.25, 0.4)).toBeCloseTo(0.4, 6)
  expect(occludedEyeDistance(look, eye, [wall])).toBeLessThan(10)
})

test('occludedEyeDistance: cylinder blocks only inside its height band', () => {
  const pillar = { position: [0, 1.3, 4], radius: 0.55, halfHeight: 1.3, collider: 'cylinder' as const }
  const low = occludedEyeDistance([0, 1, 0], [0, 1, 8], [pillar])
  expect(low).toBeLessThan(4) // through the pillar → pulled in front of it
  expect(low).toBeGreaterThan(2)
  const high = occludedEyeDistance([0, 4, 0], [0, 4, 8], [pillar])
  expect(high).toBeCloseTo(8, 6) // over the top → untouched
})

test('easeOcclusion approaches without popping; pull-in is faster than release', () => {
  const dt = 1 / 60
  const first = easeOcclusion(0, 2, dt)
  expect(first).toBeGreaterThan(0)
  expect(first).toBeLessThan(2) // eased, not snapped
  let v = 0
  for (let i = 0; i < 200; i++) v = easeOcclusion(v, 2, dt)
  expect(v).toBeCloseTo(2, 2) // converges to the target
  const inStep = easeOcclusion(0, 1, dt) - 0
  const outStep = 1 - easeOcclusion(1, 0, dt)
  expect(inStep).toBeGreaterThan(outStep) // hide fast, reveal gently
  expect(easeOcclusion(1.99, 2, 10)).toBeLessThanOrEqual(2) // never overshoots
})

// --- onLand landing events ---

test('onLand fires exactly once per landing with the impact intensity', () => {
  const scene = new YuraScene({ gravity: -20 })
  scene.add('plane', { size: 10 })
  const ball = scene.add('sphere', { radius: 0.5, position: [0, 0.62, 0], body: 'dynamic' })
  const fired: number[] = []
  expect(ball.onLand((i) => fired.push(i))).toBe(ball) // chainable
  for (let i = 0; i < 240; i++) scene.step(1 / 60, i / 60)
  expect(fired.length).toBe(1) // one landing, one event — settling never re-fires
  expect(fired[0]).toBeGreaterThan(1.5) // downward speed of the fall
  expect(fired[0]).toBeLessThan(3.5)
  expect(ball.grounded).toBe(true)
})

test('onLand does not fire while rolling on the ground, re-fires after a jump', () => {
  const scene = new YuraScene({ gravity: -20 })
  scene.add('plane', { size: 20 })
  const ball = scene.add('sphere', { radius: 0.5, position: [0, 0.62, 0], body: 'dynamic' })
  let fires = 0
  let last = 0
  ball.onLand((i) => {
    fires++
    last = i
  })
  for (let i = 0; i < 120; i++) scene.step(1 / 60, i / 60)
  expect(fires).toBe(1)
  scene.onUpdate(() => {
    ball.velocity[0] = 4 // constant roll across the floor
  })
  for (let i = 120; i < 300; i++) scene.step(1 / 60, i / 60)
  expect(fires).toBe(1) // rolling on ground is not a landing
  ball.velocity[1] = 6 // jump
  for (let i = 300; i < 480; i++) scene.step(1 / 60, i / 60)
  expect(fires).toBeGreaterThanOrEqual(2) // landing after the jump fires again
  expect(last).toBeGreaterThan(1) // with a real impact speed
  expect(ball.grounded).toBe(true)
})

// --- Swept-sphere CCD: fast bodies must not tunnel through colliders --------

test('segmentPointDistance measures mid-segment and clamps to endpoints', () => {
  const mid = segmentPointDistance([0, 0, 0], [10, 0, 0], [5, 3, 0])
  expect(mid.distance).toBeCloseTo(3, 6)
  expect(mid.t).toBeCloseTo(0.5, 6)
  const before = segmentPointDistance([0, 0, 0], [10, 0, 0], [-4, 3, 0])
  expect(before.distance).toBeCloseTo(5, 6) // clamped to the A endpoint
  expect(before.t).toBe(0)
  const degenerate = segmentPointDistance([2, 1, 2], [2, 1, 2], [2, 5, 2])
  expect(degenerate.distance).toBeCloseTo(4, 6) // zero-length segment = point
})

test('segmentAxisDistanceXZ measures radial XZ distance, ignoring Y', () => {
  const level = segmentAxisDistanceXZ([0, 100, 0], [10, -50, 0], [5, 0, 4])
  expect(level.distance).toBeCloseTo(4, 6) // wild Y values never matter
  expect(level.t).toBeCloseTo(0.5, 6)
  const past = segmentAxisDistanceXZ([0, 0, 0], [0, 0, 10], [3, 99, 14])
  expect(past.distance).toBeCloseTo(5, 6) // clamped to the B endpoint: hypot(3, 4)
  expect(past.t).toBe(1)
})

test('sweptSphereTOI reports the first-touch time; clean misses stay -1', () => {
  // Center at x=5, radius 1: a segment 0→10 first touches at x=4 → t=0.4.
  expect(sweptSphereTOI([0, 0, 0], [10, 0, 0], [5, 0, 0], 1)).toBeCloseTo(0.4, 6)
  expect(sweptSphereTOI([0, 0, 0], [10, 0, 0], [5, 3, 0], 1)).toBe(-1) // passes 3 above
  expect(sweptSphereTOI([5, 0.5, 0], [6, 0.5, 0], [5, 0, 0], 1)).toBe(0) // starts inside
  expect(sweptSphereTOI([7, 0, 0], [10, 0, 0], [5, 0, 0], 1)).toBe(-1) // moving away
})

test('sweptCylinderTOI honors the height band and cap entry', () => {
  // Axis at x=5, radius 1, band 2: a level pass at y=0 touches at t=0.4.
  expect(sweptCylinderTOI([0, 0, 0], [10, 0, 0], [5, 0, 0], 1, 2)).toBeCloseTo(0.4, 6)
  // The same pass 5 units up crosses radially but never enters the band.
  expect(sweptCylinderTOI([0, 5, 0], [10, 5, 0], [5, 0, 0], 1, 2)).toBe(-1)
  // A straight fall onto the cap enters the band at y=+2 → t=0.6.
  expect(sweptCylinderTOI([5, 8, 0], [5, -2, 0], [5, 0, 0], 1, 2)).toBeCloseTo(0.6, 6)
})

test('CCD: a fast body crossing an orb between ticks still fires onCollide', () => {
  const scene = new YuraScene({ gravity: 0 })
  const player = scene.add('sphere', { radius: 0.2, position: [0, 0, 0], body: 'dynamic' })
  const orb = scene.add('sphere', { radius: 0.26, position: [1.5, 0, 0], tag: 'orb' })
  let hits = 0
  player.onCollide((o) => {
    if (o.tag === 'orb') hits++
  })
  player.velocity[0] = 60 // 1 unit per 1/60 tick — far beyond the 0.46 contact range
  const rr = 0.2 + 0.26
  let discreteWouldHit = false
  for (let i = 0; i < 4; i++) {
    scene.step(1 / 60, i / 60)
    const d = Math.hypot(player.position[0] - orb.position[0], player.position[1], player.position[2])
    if (d <= rr) discreteWouldHit = true
  }
  expect(discreteWouldHit).toBe(false) // every end-of-tick position is outside contact range...
  expect(hits).toBe(1) // ...yet the sweep caught the crossing, exactly once
  expect(player.position[0]).toBeCloseTo(4, 5) // a pickup never deflects the body
})

test('CCD: a fast body stops at a solid it would have tunneled through', () => {
  const scene = new YuraScene({ gravity: 0 })
  const wall = scene.add('sphere', { radius: 1, position: [3.5, 0, 0], solid: true })
  const ball = scene.add('sphere', { radius: 0.5, position: [0, 0, 0], body: 'dynamic' })
  ball.velocity[0] = 360 // 6 units per tick: the naive end position (x=6) is past the wall
  scene.step(1 / 60, 0)
  expect(ball.position[0]).toBeCloseTo(2, 5) // time-of-impact contact: 3.5 - (1 + 0.5)
  expect(ball.velocity[0]).toBeLessThan(0) // the usual solid response bounced it back
  expect(wall.position[0]).toBe(3.5) // static solid never moves
})

test('CCD: a fast body stops at a solid pillar (cylinder XZ sweep)', () => {
  const scene = new YuraScene({ gravity: 0 })
  scene.add('cylinder', { size: [2, 4, 2], position: [3.5, 0, 0], solid: true })
  const ball = scene.add('sphere', { radius: 0.5, position: [0, 0, 0], body: 'dynamic' })
  ball.velocity[0] = 360
  scene.step(1 / 60, 0)
  expect(ball.position[0]).toBeCloseTo(2, 5) // radial contact: 3.5 - (1 + 0.5)
  expect(ball.velocity[0]).toBeLessThan(0)
})

test('slow motion keeps the exact discrete collision outcome (fast path)', () => {
  // Per-tick travel (0.05) is far below 0.5×minRadius (0.25): the sweep is
  // skipped and first contact lands on the tick the discrete math predicts.
  const scene = new YuraScene({ gravity: 0 })
  const player = scene.add('sphere', { radius: 0.5, position: [0, 0, 0], body: 'dynamic' })
  scene.add('sphere', { radius: 0.5, position: [1.99, 0, 0], tag: 'orb' })
  let tick = 0
  const hitTicks: number[] = []
  player.onCollide(() => hitTicks.push(tick))
  player.velocity[0] = 3
  for (tick = 1; tick <= 25; tick++) scene.step(1 / 60, tick / 60)
  // Discrete prediction: first tick where 1.99 - 0.05k <= 1.0 → k = 20.
  expect(hitTicks[0]).toBe(20)
  expect(player.position[0]).toBeCloseTo(1.25, 5) // non-solid contact never displaces
})

test('hitRadius widens pair collisions without touching visuals or ground rest', () => {
  const scene = new YuraScene({ gravity: 0 })
  const player = scene.add('sphere', { radius: 0.45, position: [0, 0, 0], body: 'dynamic' })
  // Visual orb radius 0.26 but a generous 0.6 hit area: contact at 0.45+0.6=1.05.
  const orb = scene.add('sphere', { radius: 0.26, hitRadius: 0.6, position: [2, 0, 0], tag: 'orb' })
  const hits: number[] = []
  player.onCollide(() => hits.push(player.position[0]))
  player.velocity[0] = 3
  for (let t = 1; t <= 30; t++) scene.step(1 / 60, t / 60)
  expect(hits.length).toBeGreaterThan(0)
  // First contact must land once the gap is <= 1.05 (generous), well before
  // the visual-radius distance of 0.71.
  expect(hits[0]).toBeGreaterThanOrEqual(2 - 1.05 - 0.06)
  expect(hits[0]).toBeLessThan(2 - 0.71)
  expect(orb.radius).toBeCloseTo(0.26, 5) // visual radius untouched
})

test('hitRadius defaults to radius — behavior identical when unset', () => {
  const scene = new YuraScene({ gravity: 0 })
  const a = scene.add('sphere', { radius: 0.5, position: [0, 0, 0], body: 'dynamic' })
  const b = scene.add('sphere', { radius: 0.3, position: [5, 0, 0] })
  expect(a.hitRadius).toBe(0.5)
  expect(b.hitRadius).toBe(0.3)
})

// --- Edge cases: unknown shape names, duplicate ground planes ---------------

test('an unknown shape name throws YURA-013 listing the available shapes', () => {
  const scene = new YuraScene({})
  let err: unknown = null
  try {
    scene.add('cube' as ShapeName) // what a plain-JS caller can pass
  } catch (e) {
    err = e
  }
  expect(err).toBeInstanceOf(YuraError)
  const yerr = err as YuraError
  expect(yerr.code).toBe('YURA-013')
  expect(yerr.message).toContain('cube')
  expect(yerr.message).toContain(SHAPE_NAMES.join(', ')) // full available list
  expect(yerr.hint).toContain("scene.add('sphere'") // fix example
})

test("a second add('plane') warns with YURA-014 but still moves the ground", () => {
  const scene = new YuraScene({ gravity: -20 })
  const info = spyOn(console, 'info').mockImplementation(() => {})
  try {
    scene.add('plane', { size: 10 })
    expect(info).not.toHaveBeenCalled() // first plane is silent
    scene.add('plane', { size: 10, position: [0, 2, 0] })
    expect(info).toHaveBeenCalledTimes(1)
    expect(String(info.mock.calls[0][0])).toContain('YURA-014')
  } finally {
    info.mockRestore()
  }
  // Behavior unchanged: the newest plane owns the ground height.
  const ball = scene.add('sphere', { radius: 0.5, position: [0, 6, 0], body: 'dynamic' })
  for (let i = 0; i < 600; i++) scene.step(1 / 60, i / 60)
  expect(ball.position[1]).toBeCloseTo(2.5, 1)
})

// --- Mesh-asset shape vocabulary --------------------------------------------
// The renderer's mesh assets (torusMesh/torusKnotMesh/cylinderMesh/discMesh)
// are exposed through scene.add as torus/knot/cylinder/disc. Each case pins
// the option style and the collision-radius approximation buildShape assigns.

const MESH_ASSET_SHAPES: ShapeName[] = ['torus', 'knot', 'cylinder', 'disc']

const MESH_ASSET_CASES: Array<{ shape: ShapeName; opts?: AddOptions; radius: number; note: string }> = [
  { shape: 'torus', radius: 1.2, note: 'default ring radius 1 → bound r*1.2' },
  { shape: 'torus', opts: { radius: 2 }, radius: 2.4, note: 'radius option scales the bound' },
  { shape: 'knot', radius: 1.3, note: 'default radius 1 → bound r*1.3' },
  { shape: 'knot', opts: { radius: 2 }, radius: 2.6, note: 'radius option scales the bound' },
  { shape: 'disc', radius: 1, note: 'default radius 1 → collision radius = visual radius' },
  { shape: 'disc', opts: { radius: 2 }, radius: 2, note: 'radius option is the collision radius' },
  { shape: 'cylinder', opts: { size: [1.1, 2.6, 1.1] }, radius: 0.55, note: 'size → radial radius s3[0]/2' },
]

for (const { shape, opts, radius, note } of MESH_ASSET_CASES) {
  test(`add('${shape}'${opts ? ', ' + JSON.stringify(opts) : ''}) builds geometry with radius ${radius} (${note})`, () => {
    const scene = new YuraScene({})
    const obj = scene.add(shape, opts)
    // Real geometry came back from the renderer's mesh asset.
    expect(obj.geo.positions.length).toBeGreaterThan(0)
    expect(obj.geo.indices.length).toBeGreaterThan(0)
    expect(obj.geo.normals.length).toBe(obj.geo.positions.length)
    // Collision radius follows the documented approximation…
    expect(obj.radius).toBeCloseTo(radius, 5)
    // …and hitRadius defaults to it, like every other shape.
    expect(obj.hitRadius).toBeCloseTo(radius, 5)
  })
}

test('cylinder keeps its band collider; the other mesh-asset shapes stay spheres', () => {
  const scene = new YuraScene({})
  const pillar = scene.add('cylinder', { size: [1.1, 2.6, 1.1] })
  expect(pillar.collider).toBe('cylinder')
  expect(pillar.halfHeight).toBeCloseTo(1.3, 5) // s3[1]/2
  for (const shape of ['torus', 'knot', 'disc'] as ShapeName[]) {
    const obj = scene.add(shape)
    expect(obj.collider).toBe('sphere')
    expect(obj.halfHeight).toBeCloseTo(obj.radius, 5) // sphere colliders: band = radius
  }
})

test('every mesh-asset shape is listed in SHAPE_NAMES and the YURA-013 error', () => {
  for (const shape of MESH_ASSET_SHAPES) expect(SHAPE_NAMES).toContain(shape)
  const scene = new YuraScene({})
  let err: unknown = null
  try {
    scene.add('pyramid' as ShapeName)
  } catch (e) {
    err = e
  }
  expect(err).toBeInstanceOf(YuraError)
  const message = (err as YuraError).message
  // SHAPE_NAMES is the single source of truth, so each name flows into the list.
  for (const shape of MESH_ASSET_SHAPES) expect(message).toContain(shape)
})

test('obj.trail passes colorEnd, width, and fade through to the FX emitter', () => {
  const run = (opts: Record<string, unknown>): { out: Float32Array; n: number } => {
    const scene = new YuraScene({})
    const obj = scene.add('sphere', { radius: 0.5, position: [0, 3, 0] })
    obj.trail({ rate: 60, life: 10, color: '#ff0000', intensity: 1, ...opts })
    for (let i = 0; i < 60; i++) scene.step(1 / 60, i / 60)
    const out = new Float32Array(scene.fx.capacity * FX_FLOATS)
    const n = scene.fx.writeInstances(out)
    expect(n).toBeGreaterThan(0)
    return { out, n }
  }

  // Defaults: pure-red sparks, small sprites, linear fade barely bitten after 1s.
  const base = run({})
  for (let i = 0; i < base.n; i++) {
    const o = i * FX_FLOATS
    expect(base.out[o + 6]).toBe(0) // no blue without colorEnd
    expect(base.out[o + 3]).toBeLessThan(0.15) // size 0.11 x <= 1.3 jitter
    expect(base.out[o + 7]).toBeGreaterThan(0.7) // (1 - 1/7)^2 lower bound
  }

  const custom = run({ colorEnd: '#0000ff', width: 5, fade: 8 })
  let minAlpha = 1
  for (let i = 0; i < custom.n; i++) {
    const o = i * FX_FLOATS
    expect(custom.out[o + 6]).toBeGreaterThan(0) // colorEnd blends blue in with age
    expect(custom.out[o + 3]).toBeGreaterThan(0.2) // width 5: 0.55 x 5 x 0.11 x 0.7
    minAlpha = Math.min(minAlpha, custom.out[o + 7])
  }
  expect(minAlpha).toBeLessThan(0.5) // fade 8 collapses the oldest sparks
})

// --- edge-triggered key queries -------------------------------------------

test('pressed() is true only on the frame the key goes down', () => {
  const input = new SceneInput()
  expect(input.pressed('KeyE')).toBe(false)
  input.keyDown('KeyE')
  expect(input.pressed('KeyE')).toBe(true)
  input.endFrame(1 / 60) // frame boundary: the edge is consumed
  expect(input.pressed('KeyE')).toBe(false)
  expect(input.key('KeyE')).toBe(true) // …but the key is still held
  input.keyUp('KeyE')
  expect(input.pressed('KeyE')).toBe(false)
})

// --- DOM binding (headless fakes: window / document / element) ------------

type Handler = (ev: unknown) => void
type HandlerMap = Map<string, Handler[]>

function listenerPair(m: HandlerMap): {
  addEventListener: (t: string, f: Handler) => void
  removeEventListener: (t: string, f: Handler) => void
} {
  return {
    addEventListener: (t, f) => m.set(t, [...(m.get(t) ?? []), f]),
    removeEventListener: (t, f) =>
      m.set(
        t,
        (m.get(t) ?? []).filter((x) => x !== f),
      ),
  }
}

const dispatch = (m: HandlerMap, type: string, ev: unknown): void => {
  for (const f of m.get(type) ?? []) f(ev)
}

test('bind() wires keyboard/blur/visibility to window+document and dispose() unwires', () => {
  const g = globalThis as Record<string, unknown>
  const prevWin = g.window
  const prevDoc = g.document
  const win: HandlerMap = new Map()
  const doc: HandlerMap = new Map()
  const visibility = { state: 'visible' }
  g.window = listenerPair(win)
  g.document = {
    ...listenerPair(doc),
    get visibilityState() {
      return visibility.state
    },
  }
  const input = new SceneInput()
  let prevented = 0
  const key = (code: string): unknown => ({
    code,
    repeat: false,
    preventDefault: () => {
      prevented++
    },
  })
  try {
    input.bind()
    expect(win.get('keydown')).toHaveLength(1)
    expect(win.get('keyup')).toHaveLength(1)
    expect(win.get('blur')).toHaveLength(1)
    expect(doc.get('visibilitychange')).toHaveLength(1)

    // Navigation keys are prevented (no page scroll) and land in the key set.
    dispatch(win, 'keydown', key('ArrowLeft'))
    expect(prevented).toBe(1)
    expect(input.key('ArrowLeft')).toBe(true)
    expect(input.x).toBe(combineAxes(-1, 0, 0))
    // Other keys pass through unprevented.
    dispatch(win, 'keydown', key('KeyQ'))
    expect(prevented).toBe(1)
    expect(input.key('KeyQ')).toBe(true)
    dispatch(win, 'keyup', { code: 'ArrowLeft' })
    expect(input.key('ArrowLeft')).toBe(false)

    // blur drops everything held (the keyups will never arrive).
    dispatch(win, 'blur', {})
    expect(input.key('KeyQ')).toBe(false)

    // visibilitychange clears only when the tab actually hides.
    dispatch(win, 'keydown', key('KeyD'))
    dispatch(doc, 'visibilitychange', {})
    expect(input.key('KeyD')).toBe(true) // still visible
    visibility.state = 'hidden'
    dispatch(doc, 'visibilitychange', {})
    expect(input.key('KeyD')).toBe(false)

    input.dispose()
    expect(win.get('keydown')).toHaveLength(0)
    expect(win.get('keyup')).toHaveLength(0)
    expect(win.get('blur')).toHaveLength(0)
    expect(doc.get('visibilitychange')).toHaveLength(0)
  } finally {
    if (prevWin === undefined) delete g.window
    else g.window = prevWin
    if (prevDoc === undefined) delete g.document
    else g.document = prevDoc
  }
})

test('bindPointer(): drag drives the stick, cancel drops it without a jump, dispose restores', () => {
  const handlers: HandlerMap = new Map()
  const captured: number[] = []
  let capThrow = false
  const el = {
    style: { touchAction: 'pan-y' },
    ...listenerPair(handlers),
    setPointerCapture: (id: number) => {
      if (capThrow) throw new Error('capture unavailable')
      captured.push(id)
    },
  }
  const input = new SceneInput()
  input.bindPointer(el as unknown as Parameters<SceneInput['bindPointer']>[0])
  expect(el.style.touchAction).toBe('none')

  let prevented = 0
  const pd = (id: number, x: number, y: number, type = 'touch'): unknown => ({
    pointerId: id,
    clientX: x,
    clientY: y,
    pointerType: type,
    preventDefault: () => {
      prevented++
    },
  })

  // Touch drag: prevented, captured, and mapped onto the stick axes.
  dispatch(handlers, 'pointerdown', pd(1, 100, 100))
  expect(prevented).toBe(1)
  expect(captured).toEqual([1])
  dispatch(handlers, 'pointermove', { pointerId: 1, clientX: 160, clientY: 100 })
  expect(input.x).toBe(combineAxes(0, stickAxes(60, 0).x, 0))
  expect(isTap(0, 60)).toBe(false) // precondition: a 60px drag is not a tap
  dispatch(handlers, 'pointerup', { pointerId: 1 })
  expect(input.x).toBe(0)
  expect(input.jump).toBe(false) // drag release is not a jump

  // Mouse pointers keep default behavior (no preventDefault).
  dispatch(handlers, 'pointerdown', pd(2, 0, 0, 'mouse'))
  expect(prevented).toBe(1)
  // A cancel for a foreign pointer id is ignored…
  dispatch(handlers, 'pointercancel', { pointerId: 99 })
  dispatch(handlers, 'pointermove', { pointerId: 2, clientX: 50, clientY: 0 })
  expect(input.x).toBe(combineAxes(0, stickAxes(50, 0).x, 0)) // stick alive
  // …while cancelling the stick pointer drops it with NO tap-jump.
  expect(isTap(0, 0)).toBe(true) // a zero-length press WOULD be a tap on pointerup
  dispatch(handlers, 'pointercancel', { pointerId: 2 })
  expect(input.x).toBe(0)
  expect(input.jump).toBe(false)

  // setPointerCapture throwing is survivable — the drag still works.
  capThrow = true
  dispatch(handlers, 'pointerdown', pd(3, 10, 10))
  dispatch(handlers, 'pointermove', { pointerId: 3, clientX: 70, clientY: 10 })
  expect(input.x).toBe(combineAxes(0, stickAxes(60, 0).x, 0))
  dispatch(handlers, 'pointercancel', { pointerId: 3 })

  input.dispose()
  expect(el.style.touchAction).toBe('pan-y')
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    expect(handlers.get(t)).toHaveLength(0)
  }
})

// --- attach(): realize + shadow discs + follow/orbit camera ---------------

interface MeshRec {
  material: Record<string, unknown>
  worlds: unknown[]
}

function fakeSceneRenderer(): {
  r: { shadowArea: number; cameraPose: unknown; setFX: (a: unknown, n: number) => void; addMesh: (g: unknown, m: Record<string, unknown>, o?: unknown) => { setWorld: (w: unknown) => void; remove: () => void } }
  meshes: MeshRec[]
} {
  const meshes: MeshRec[] = []
  const r = {
    shadowArea: 0,
    cameraPose: undefined as unknown,
    addMesh(_geo: unknown, material: Record<string, unknown>, _opts?: unknown) {
      const rec: MeshRec = { material, worlds: [] }
      meshes.push(rec)
      return {
        setWorld(w: unknown) {
          rec.worlds.push(w)
        },
        remove() {},
      }
    },
    setFX(_a: unknown, _n: number) {},
  }
  return { r, meshes }
}

test('attach() realizes queued objects (shadow disc included) and follow/orbit steer the camera', () => {
  const scene = new YuraScene({ keyboard: false, bounds: 5, gravity: -10 })
  const ball = scene.add('sphere', { radius: 0.5, position: [0, 2, 0], body: 'dynamic', shadow: true })
  scene.add('box', { position: [3, 0, 0] })
  const { r, meshes } = fakeSceneRenderer()
  const g = globalThis as Record<string, unknown>
  const prevGCS = g.getComputedStyle
  g.getComputedStyle = () => ({ position: 'static' })
  const container = { style: { position: '' } }
  try {
    const detach = scene.attach(
      r as unknown as Parameters<YuraScene['attach']>[0],
      container as unknown as Parameters<YuraScene['attach']>[1],
    )
    expect(container.style.position).toBe('relative')
    expect(r.shadowArea).toBe(scene.bounds * 1.25 + 2)
    // ball mesh + its shadow disc + box mesh, in realize order.
    expect(meshes.length).toBe(3)
    expect(meshes[0].material).toEqual(resolveMaterial(undefined) as unknown as Record<string, unknown>) // default look
    expect(meshes[1].material.unlit).toBe(true) // shadow disc is unlit…
    expect(meshes[1].material.fade).toBe(true) // …and distance-faded
    expect((meshes[1].material.color as number[])[3]).toBeLessThan(1) // translucent

    // A step syncs every realized handle's world matrix (shadow too).
    scene.step(1 / 60, 0)
    expect(meshes[0].worlds.length).toBeGreaterThan(0)
    expect(meshes[1].worlds.length).toBeGreaterThan(0)
    expect(meshes[2].worlds.length).toBeGreaterThan(0)

    // Follow camera: stepping produces a concrete eye/target pose.
    scene.camera.follow(ball, { distance: 6, height: 2 })
    scene.step(1 / 60, 1 / 60)
    const pose = r.cameraPose as { eye: number[]; target: number[] }
    expect(pose).toBeTruthy()
    expect(pose.eye).toHaveLength(3)
    expect(pose.target).toHaveLength(3)
    for (const v of [...pose.eye, ...pose.target]) expect(Number.isFinite(v)).toBe(true)

    // Orbit hands the camera back to the renderer.
    scene.camera.orbit()
    expect(r.cameraPose).toBeNull()
    detach()
  } finally {
    if (prevGCS === undefined) delete g.getComputedStyle
    else g.getComputedStyle = prevGCS
  }
})

// --- material fallback -----------------------------------------------------

test('resolveMaterial falls back to pearl for unknown non-hex names', () => {
  const fallback = resolveMaterial('definitely-not-a-preset')
  expect(fallback).toBe(resolveMaterial(undefined)) // same shared pearl preset
  expect(fallback).toEqual(materials.pearl)
  // …unlike a KNOWN preset name, which is defensively copied.
  expect(resolveMaterial('pearl')).not.toBe(materials.pearl)
  expect(resolveMaterial('pearl')).toEqual(materials.pearl)
  // Hex strings become plastic in that color; explicit objects pass through.
  expect(resolveMaterial('#ff8800')).toEqual(materials.plastic('#ff8800'))
  const custom = materials.metal('#4cc9f0')
  expect(resolveMaterial(custom)).toBe(custom)
})

// --- gravityWell: black-hole zones for scene particles ----------------------
// scene.gravityWell feeds FxPool.attractors with the GPU sims' shared
// AttractorParams vocabulary; each call returns a release function, wells
// accumulate, and calls past MAX_ATTRACTORS warn (YURA-017) and queue.

test('gravityWell pulls scene particles toward the well; the release function removes it', () => {
  const scene = new YuraScene({})
  scene.fx.spawn(3, 0, 0, 0, 0, 0, 60, 0.1, 1, 1, 1, 0, 0)
  const release = scene.gravityWell([0, 0, 0], 10)
  expect(scene.fx.attractors).toHaveLength(1)
  for (let i = 0; i < 30; i++) scene.step(1 / 60, i / 60)
  const out = new Float32Array(FX_FLOATS)
  expect(scene.fx.writeInstances(out)).toBe(1)
  expect(out[0]).toBeLessThan(3) // pulled toward the origin well
  release()
  expect(scene.fx.attractors).toHaveLength(0)
})

test('a negative-strength gravityWell repels scene particles', () => {
  const scene = new YuraScene({})
  scene.fx.spawn(3, 0, 0, 0, 0, 0, 60, 0.1, 1, 1, 1, 0, 0)
  scene.gravityWell([0, 0, 0], -10)
  for (let i = 0; i < 30; i++) scene.step(1 / 60, i / 60)
  const out = new Float32Array(FX_FLOATS)
  expect(scene.fx.writeInstances(out)).toBe(1)
  expect(out[0]).toBeGreaterThan(3) // pushed away from the origin well
})

test('gravityWell accumulates per call, warns past MAX_ATTRACTORS, and releasing frees the slot', () => {
  const scene = new YuraScene({})
  const info = spyOn(console, 'info').mockImplementation(() => {})
  try {
    const releases = Array.from({ length: MAX_ATTRACTORS }, (_, i) =>
      scene.gravityWell([i, 0, 0], 1),
    )
    expect(scene.fx.attractors).toHaveLength(MAX_ATTRACTORS)
    expect(info).not.toHaveBeenCalled() // within budget: silent
    expect('radius' in scene.fx.attractors[0]).toBe(false) // omitted -> sims' default applies

    const releaseExtra = scene.gravityWell([9, 9, 9], 2, 0.5)
    expect(info).toHaveBeenCalledTimes(1)
    expect(String(info.mock.calls[0][0])).toContain(CODES.GRAVITY_WELL_CLAMPED)
    // The extra well is queued (the pool clamps to the first MAX_ATTRACTORS)…
    expect(scene.fx.attractors).toHaveLength(MAX_ATTRACTORS + 1)
    expect(scene.fx.attractors[MAX_ATTRACTORS]).toEqual({
      position: [9, 9, 9],
      strength: 2,
      radius: 0.5,
    })
    // …and releasing an active well promotes it into the acting set.
    releases[0]()
    expect(scene.fx.attractors).toHaveLength(MAX_ATTRACTORS)
    expect(scene.fx.attractors[MAX_ATTRACTORS - 1].position).toEqual([9, 9, 9])
    releaseExtra()
    expect(scene.fx.attractors).toHaveLength(MAX_ATTRACTORS - 1)
    releaseExtra() // release is idempotent
    expect(scene.fx.attractors).toHaveLength(MAX_ATTRACTORS - 1)
  } finally {
    info.mockRestore()
  }
})
