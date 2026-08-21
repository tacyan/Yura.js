// ORB RUSH — a complete game in ~45 lines. No 3D assets, no engine boilerplate.
import { yura, materials } from 'yura'

const app = yura('#game')
const scene = app.scene({ gravity: -22, bounds: 12 })

scene.add('plane', { size: 24, material: 'checker' })
scene.add('knot', { radius: 1.1, material: 'gold', position: [0, 1.6, 0], spin: [0, 0.7, 0.25], shadow: true })

const ball = scene.add('sphere', {
  radius: 0.45, material: 'chrome', position: [0, 3, 7], body: 'dynamic', shadow: true,
})

const ORBS = 10
for (let i = 0; i < ORBS; i++) {
  const a = (i / ORBS) * Math.PI * 2
  scene.add('sphere', {
    radius: 0.26, material: materials.neon('#22d3ee'), tag: 'orb', shadow: true,
    position: [Math.cos(a) * 8, 1, Math.sin(a) * 8],
  })
}
for (const [x, z] of [[-5, -5], [5, -5], [-5, 5], [5, 5]]) {
  scene.add('cylinder', { size: [1.1, 2.6, 1.1], material: 'obsidian', position: [x, 1.3, z], solid: true, shadow: true })
}

let score = 0
const hud = scene.text(`ORBS 0 / ${ORBS}`, { anchor: 'top' })
scene.camera.follow(ball, { distance: 8, height: 3.6 })

scene.onUpdate((dt, input, time) => {
  ball.velocity[0] += input.x * 26 * dt
  ball.velocity[2] -= input.y * 26 * dt
  if (input.jump && ball.grounded) ball.velocity[1] = 8.5
  scene.each('orb', (orb, i) => {
    orb.position[1] = 1 + Math.sin(time * 2.4 + i * 1.3) * 0.25
  })
})

ball.onCollide((other) => {
  if (other.tag === 'orb' && other.alive) {
    other.remove()
    hud.set(++score >= ORBS ? 'ALL ORBS COLLECTED — YOU WIN' : `ORBS ${score} / ${ORBS}`)
  }
})

app.run()
;(window as unknown as { __yura: unknown }).__yura = app
