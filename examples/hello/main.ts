import { yura } from 'yura'

const app = yura('#hero').preset('neon-galaxy').interactive()

app.run()
;(window as unknown as { __yura: unknown }).__yura = app

// Dev HUD — frame budget visibility (spec §10 性能).
const hud = document.getElementById('hud')!
setInterval(() => {
  const s = app.stats
  hud.textContent =
    `${s.backend} · ${s.fps} fps (${s.frameMs} ms) · ` +
    `${(s.particles / 1000).toFixed(0)}k / ${(s.requestedParticles / 1000).toFixed(0)}k particles · ` +
    `res ×${s.resolutionScale} · Q${s.qualityLevel}`
}, 500)
