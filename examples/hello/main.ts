import { yura } from 'yura'

const app = yura('#hero').preset('neon-galaxy').interactive()

app.run()
;(window as unknown as { __yura: unknown }).__yura = app

// Dev HUD — frame budget visibility (spec §10 性能), one line of sugar.
const hud = document.getElementById('hud')!
app.onStats((_, text) => { hud.textContent = text })
