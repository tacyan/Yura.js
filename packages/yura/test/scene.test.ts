import { test, expect } from 'bun:test'
import { YuraScene } from '../src/scene'
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
