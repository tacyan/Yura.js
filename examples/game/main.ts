/**
 * ORB RUSH — the README mini-game, verbatim. Roll with WASD/arrows/drag,
 * jump with Space/tap, collect all 10 orbs. Needs WebGPU.
 */
import { yura, materials, gameAudio, type LoopHandle } from 'yura'
import { isWin, orbLabel, orbRing } from './score'

const audio = gameAudio()
const riff = ['C3', 'C4', 'G3', 'C4', 'A2', 'A3', 'E3', 'A3', 'F2', 'F3', 'C3', 'F3', 'G2', 'G3', 'D3', 'G3']
let bgm: LoopHandle | null = null
const startBgm = () => { bgm ??= audio.loop(riff, { bpm: 300, wave: 'square', gain: 0.18 }) }
window.addEventListener('pointerdown', startBgm, { once: true })
window.addEventListener('keydown', startBgm, { once: true })

yura('#game').game({ gravity: -22, bounds: 12 }, (scene) => {
  scene.add('plane', { size: 24, material: 'checker' })
  const player = scene.add('sphere', { radius: 0.45, material: 'chrome', body: 'dynamic', shadow: true })
  for (const position of orbRing()) {
    scene.add('sphere', { radius: 0.26, material: materials.neon('#22d3ee'), tag: 'orb', position })
  }

  const hud = scene.text(orbLabel(0), { anchor: 'top' })
  scene.camera.follow(player, { distance: 8, height: 3.6 })
  player.trail()                                // comet trail, one line

  scene.onUpdate((dt, input) => {
    player.velocity[0] += input.x * 26 * dt
    player.velocity[2] -= input.y * 26 * dt
    if (input.jump && player.grounded) player.velocity[1] = 8.5
  })

  let score = 0
  player.onCollide((other) => {
    if (other.tag === 'orb' && other.alive) {
      other.remove()
      scene.burst(other.position)               // particle pop, one line
      hud.set(orbLabel(++score))
      if (isWin(score)) { bgm?.stop(); audio.win(); scene.celebrate() }  // fanfare + confetti
    }
  })
})
