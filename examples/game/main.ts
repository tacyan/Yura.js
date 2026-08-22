/**
 * ORB RUSH — the README mini-game, verbatim. Roll with WASD/arrows/drag,
 * jump with Space/tap, collect all 10 orbs. Needs WebGPU.
 */
import { yura, materials } from 'yura'
import { isWin, orbLabel, orbRing } from './score'

const app = yura('#game')
const scene = app.scene({ gravity: -22, bounds: 12 })

scene.add('plane', { size: 24, material: 'checker' })
const player = scene.add('sphere', { radius: 0.45, material: 'chrome', body: 'dynamic', shadow: true })
for (const position of orbRing()) {
  scene.add('sphere', { radius: 0.26, material: materials.neon('#22d3ee'), tag: 'orb', position })
}

const hud = scene.text(orbLabel(0), { anchor: 'top' })
scene.camera.follow(player, { distance: 8, height: 3.6 })
player.trail()                                  // comet trail, one line

scene.onUpdate((dt, input) => {
  player.velocity[0] += input.x * 26 * dt
  player.velocity[2] -= input.y * 26 * dt
  if (input.jump && player.grounded) player.velocity[1] = 8.5
})

let score = 0
player.onCollide((other) => {
  if (other.tag === 'orb' && other.alive) {
    other.remove()
    scene.burst(other.position)                 // particle pop, one line
    hud.set(orbLabel(++score))
    if (isWin(score)) scene.celebrate()         // confetti finale, one line
  }
})

app.run()
