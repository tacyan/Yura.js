import { yura } from 'yura'
import helmetUrl from './DamagedHelmet.glb'

const app = yura('#hero').model(helmetUrl).look('studio').interactive()

app.run()
;(window as unknown as { __yura: unknown }).__yura = app

const hud = document.getElementById('hud')!
app.onStats((s) => { hud.textContent = `${s.backend} · ${s.fps} fps (${s.frameMs} ms) · glTF PBR + IBL · res ×${s.resolutionScale} · Q${s.qualityLevel}` })
