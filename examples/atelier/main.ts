import { yura, cinematic, kineticLyrics } from 'yura'
import { sculpture } from './sculptures'

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
const art = document.querySelector<HTMLElement>('.art')!
const status = document.querySelector<HTMLElement>('#status')!
const pause = document.querySelector<HTMLButtonElement>('#pause')!
const pauseIcon = document.querySelector<HTMLElement>('#pause-icon')!
const name = document.querySelector<HTMLElement>('#art-name')!
const note = document.querySelector<HTMLElement>('.art-caption-note')!
const buttons = [...document.querySelectorAll<HTMLButtonElement>('[data-shape]')]
const works = {
  orbit: { title: '環 — Orbit', note: '光でできた、終わりのないかたち。', colors: ['#b6ddff', '#547dd6'] },
  bloom: { title: '花 — Bloom', note: 'ひらく、その瞬間を閉じ込めて。', colors: ['#f9d9e8', '#b097f1'] },
  wave: { title: '波 — Wave', note: '静けさの中に、ゆらぎがある。', colors: ['#bcf0e6', '#518dc6'] },
} as const
type Work = keyof typeof works
let current: Work = 'orbit'
let ready = false
let paused = reducedMotion.matches
let inView = true
let disposed = false

// One canvas, one simulation; the quality governor adjusts to the actual device.
const app = yura('#sculpture', { quality: 'auto' })
  .particles(180_000)
  .shape(sculpture(current))
  .gradient(...works[current].colors)
  .look(cinematic({ background: [0, 0, 0], bloomStrength: 0.5, particleSize: 0.018, intensity: 0.36, grain: 0.012, vignette: 0.2, nebula: 0, stars: 0, trail: 0.15, dofStrength: 0.12 }))
  .motion({ attraction: 4.5, damping: 3, noiseStrength: 0.18, turbulence: 0.15, swirl: 0.035 })
  .interactive({ gravity: 8 })

function syncPlayback() {
  if (!ready || disposed) return
  if (paused || !inView) app.pause()
  else app.resume()
  pause.setAttribute('aria-pressed', String(paused))
  pause.setAttribute('aria-label', paused ? 'アニメーションを再生' : 'アニメーションを一時停止')
  pauseIcon.textContent = paused ? '▷' : 'Ⅱ'
  status.textContent = paused ? '静けさを楽しむ' : '作品の上でポインターを動かしてみてください'
}

// Scroll off the exhibition and GPU work stops. The reader's pause choice is preserved.
const observer = new IntersectionObserver(([entry]) => {
  inView = entry.isIntersecting
  syncPlayback()
})
observer.observe(document.querySelector('#experience')!)

async function select(work: Work) {
  if (!ready || disposed || work === current) return
  current = work
  for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.shape === work))
  name.textContent = works[work].title
  note.textContent = works[work].note
  app.gradient(works[work].colors[0], works[work].colors[1])
  // A paused sculpture still updates immediately; no automatic motion is forced.
  try {
    await app.morphNow(sculpture(work), { duration: paused ? 0 : 2.8, ease: 'cubic' })
    if (disposed) return
    if (paused) {
      app.resume()
      requestAnimationFrame(() => syncPlayback())
    }
  } catch (error) {
    status.textContent = 'かたちを切り替えられませんでした。ページを再読み込みしてください。'
    console.error(error)
  }
}
for (const button of buttons) {
  button.disabled = true
  button.addEventListener('click', () => { void select(button.dataset.shape as Work) })
}
pause.addEventListener('click', () => { paused = !paused; syncPlayback() })
const onMotionChange = () => { paused = reducedMotion.matches; syncPlayback() }
reducedMotion.addEventListener('change', onMotionChange)

// A single, frame-exact entrance. No permanent text animation loop is needed.
const heading = document.querySelector<HTMLElement>('#hero-title')!
let title: ReturnType<typeof kineticLyrics> | undefined
let titleFrame = 0
if (!reducedMotion.matches) {
  title = kineticLyrics(heading, [{ text: '余白に、\n生命を。', at: 0, enter: 'rise', hold: 'still', layout: 'left' }], {
    size: '1em', enterDuration: 1.4, loop: false,
    color: '#eff5ff',
    scheduler: { request: () => 0, cancel: () => {} },
  })
  heading.classList.add('title-animated')
  const start = performance.now()
  const reveal = (now: number) => {
    if (disposed) return
    title!.render((now - start) / 1000)
    if (now - start < 1700) titleFrame = requestAnimationFrame(reveal)
    else { title!.stop(); title = undefined; heading.classList.remove('title-animated') }
  }
  titleFrame = requestAnimationFrame(reveal)
}

try {
  await app.run()
  if (!disposed && app.stats.backend !== 'poster') {
    ready = true
    art.dataset.live = 'true'
    for (const button of buttons) button.disabled = false
    pause.disabled = false
    syncPlayback()
  } else if (!disposed) {
    document.querySelector('#sculpture')!.setAttribute('hidden', '')
    status.textContent = 'この環境では静止画で展示しています'
  }
} catch (error) {
  status.textContent = '静止画で展示しています。動かすにはページを再読み込みしてください。'
  console.error(error)
}

function dispose() {
  disposed = true
  cancelAnimationFrame(titleFrame)
  title?.stop()
  heading.classList.remove('title-animated')
  observer.disconnect()
  reducedMotion.removeEventListener('change', onMotionChange)
  app.dispose()
}
// A back-forward-cache restore keeps the same live instance.
window.addEventListener('pagehide', (event) => { if (!event.persisted) dispose() })
if (import.meta.hot) import.meta.hot.dispose(dispose)
