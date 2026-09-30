import { yuraFilm, renderFilmAudio, encodeWav, filmLooks } from 'yura'
import type { FilmScript, FilmRun, FilmLookName, FilmAspect } from 'yura'
import demo from './scripts/demo.json'

// A film player that doubles as the export target of scripts/film-render.ts.
//
//   ?script=<url>   load a script (JSON) instead of the demo
//   ?export=1       no toolbar, no autoplay: the renderer drives window.__yuraFilm
//
// window.__yuraFilm is the bridge: render(t) draws one exact frame, wav()
// returns the synthesised soundtrack as base64 WAV.

const params = new URLSearchParams(location.search)
const exporting = params.has('export')
if (exporting) document.body.classList.add('export')

async function loadScript(): Promise<FilmScript> {
  const injected = (window as { __YURA_FILM_SCRIPT__?: FilmScript }).__YURA_FILM_SCRIPT__
  if (injected) return injected
  const url = params.get('script')
  if (url) return (await (await fetch(url)).json()) as FilmScript
  return demo as FilmScript
}

let script = await loadScript()
const host = document.querySelector('#film') as HTMLElement
let film: FilmRun = yuraFilm(host, script, { autoplay: !exporting })

const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
const toBase64 = (bytes: Uint8Array): string => {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(s)
}
await document.fonts.ready
;(window as unknown as { __yuraFilm: unknown }).__yuraFilm = {
  ready: true,
  duration: film.plan.duration,
  fps: film.plan.fps,
  width: film.plan.width,
  height: film.plan.height,
  async render(t: number) {
    film.render(t)
    await frame()
  },
  async wav() {
    const buf = await renderFilmAudio(film.plan)
    return buf ? toBase64(encodeWav(buf)) : null
  },
}

// ---- preview toolbar
const rebuild = (patch: Partial<FilmScript>): void => {
  script = { ...script, ...patch }
  film.stop()
  film = yuraFilm(host, script)
}
const lookSel = document.querySelector('#look') as HTMLSelectElement
for (const k of Object.keys(filmLooks) as FilmLookName[]) lookSel.add(new Option(filmLooks[k].ja, k))
lookSel.value = script.look ?? 'saas'
lookSel.onchange = () => rebuild({ look: lookSel.value as FilmLookName })
const aspectSel = document.querySelector('#aspect') as HTMLSelectElement
aspectSel.value = script.aspect ?? '16:9'
aspectSel.onchange = () => rebuild({ aspect: aspectSel.value as FilmAspect })

// Sound needs a user gesture: render the soundtrack once, then play picture and sound on one clock.
;(document.querySelector('#play') as HTMLButtonElement).onclick = async () => {
  const ctx = new AudioContext()
  const buf = await renderFilmAudio(film.plan)
  const start = ctx.currentTime + 0.1
  if (buf) {
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)
    src.start(start)
  }
  film.stop()
  film = yuraFilm(host, script, { loop: false, clock: () => Math.max(0, ctx.currentTime - start) })
}

let idle = 0
addEventListener('pointermove', () => {
  document.body.classList.remove('idle')
  clearTimeout(idle)
  idle = window.setTimeout(() => document.body.classList.add('idle'), 2500)
})
