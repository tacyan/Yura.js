// ORB RUSH — a complete game in <60 lines. No 3D assets, no engine boilerplate.
import { yura, materials } from 'yura'

const app = yura('#game')
const scene = app.scene({ gravity: -22, bounds: 12 })

scene.add('plane', { size: 24, material: 'checker' })
scene.add('knot', { radius: 1.1, material: 'gold', position: [0, 1.6, 0], spin: [0, 0.7, 0.25], solid: true, shadow: true })

const ball = scene.add('sphere', {
  radius: 0.45, material: 'chrome', position: [0, 3, 7], body: 'dynamic', shadow: true,
})
ball.trail({ color: '#7dd3fc' })

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

const pad = (n: number) => String(Math.floor(n)).padStart(2, '0')
const fmt = (t: number) => `${pad(t / 60)}:${pad(t % 60)}.${Math.floor((t % 1) * 10)}`
let score = 0, elapsed = 0, done = false, best = 0
try { best = Number(localStorage.getItem('orb-rush-best')) || 0 } catch { /* private mode */ }
const hud = scene.text(`ORBS 0 / ${ORBS}`, { anchor: 'top' })
const clock = scene.text('00:00.0', { anchor: 'top-right' })
scene.camera.follow(ball, { distance: 8, height: 3.6 })

scene.onUpdate((dt, input, time) => {
  ball.velocity[0] += input.x * 26 * dt
  ball.velocity[2] -= input.y * 26 * dt
  if (input.jump && ball.grounded) ball.velocity[1] = 8.5
  if (!done) clock.set(`${fmt((elapsed += dt))}${best ? `  BEST ${fmt(best)}` : ''}`)
  if (input.pressed('KeyR')) { scene.reset(); score = elapsed = 0; done = false; hud.set(`ORBS 0 / ${ORBS}`) }
  scene.each('orb', (orb, i) => {
    orb.position[1] = 1 + Math.sin(time * 2.4 + i * 1.3) * 0.25
  })
})

ball.onCollide((other) => {
  if (other.tag !== 'orb' || !other.alive) return
  other.remove()
  scene.burst(other.position, { color: '#22d3ee' })
  if (++score < ORBS) return hud.set(`ORBS ${score} / ${ORBS}`)
  done = true
  scene.celebrate()
  const record = !best || elapsed < best
  if (record) { best = elapsed; try { localStorage.setItem('orb-rush-best', String(best)) } catch { /* ignore */ } }
  hud.set(`YOU WIN — ${fmt(elapsed)}${record ? ' ★ NEW BEST' : ''}  ·  R to restart`)
})

app.run()
;(window as unknown as { __yura: unknown }).__yura = app
