import * as THREE from 'three'
import { defineLyricStage, stageThemes, projectionMapping, projectionSync, projectorTiles } from 'yura'
import type { StageThemeName } from 'yura'

// A projection-mapping studio for a lyric stage.
//
//   control window (this page, no query)   the leader: owns the timeline, shows
//                                          the toolbar, can open output windows
//   output window (?output=i&of=n)         a follower: full-screen black output
//                                          for projector i of n, showing only
//                                          its slice of the picture with soft
//                                          edges where it overlaps a neighbour
//
// Drag each output window onto its projector's display, press F for full
// screen and C to calibrate: drag the numbered corners onto the wall (or
// 1–4 / Tab and the arrow keys), T for the test pattern. Each output keeps
// its own calibration in this browser; E downloads it as JSON.

const params = new URLSearchParams(location.search)
const outputIndex = params.has('output') ? Math.max(0, Number(params.get('output')) || 0) : -1
const outputCount = Math.max(1, Number(params.get('of')) || 1)
const isOutput = outputIndex >= 0
const OVERLAP = 0.15

// Every window shares the leader's clock, so all projectors play the same frame.
const sync = projectionSync({ role: isOutput ? 'follower' : 'leader', channel: 'yura-projection-demo' })
defineLyricStage({ three: THREE, clock: () => sync.clock() })

const show = document.querySelector('#show') as HTMLElement
const theme = params.get('theme')
if (theme && theme in stageThemes) show.setAttribute('theme', theme)

const tile = projectorTiles(outputCount, OVERLAP)[Math.min(outputIndex, outputCount - 1)] ?? projectorTiles(1)[0]
const mapping = projectionMapping(show, {
  fullscreen: true,
  storageKey: `yura-projection-demo:${isOutput ? `${outputIndex}/${outputCount}` : 'control'}`,
  ...(isOutput
    ? { viewport: { x: tile.x, y: 0, width: tile.width, height: 1 }, blend: { left: tile.blendLeft, right: tile.blendRight }, blackLevel: outputCount > 1 ? 0.02 : 0 }
    : {}),
})
if (isOutput) document.body.classList.add('output')

// ---- toolbar (control window)
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T
const themeSelect = $<HTMLSelectElement>('#theme')
for (const key of Object.keys(stageThemes) as StageThemeName[]) themeSelect.add(new Option(stageThemes[key].ja, key))
themeSelect.value = show.getAttribute('theme') ?? 'lagoon'
themeSelect.onchange = () => show.setAttribute('theme', themeSelect.value)

let calibrating = false
let pattern = false
const calBtn = $<HTMLButtonElement>('#calibrate')
const patBtn = $<HTMLButtonElement>('#pattern')
const setPattern = (on: boolean): void => {
  pattern = on
  mapping.pattern(on)
  patBtn.setAttribute('aria-pressed', String(on))
}
const setCalibrate = (on: boolean): void => {
  calibrating = on
  mapping.calibrate(on) // calibration shows the pattern by default…
  calBtn.setAttribute('aria-pressed', String(on))
  setPattern(on) // …and the button state follows it
}
calBtn.onclick = () => setCalibrate(!calibrating)
patBtn.onclick = () => setPattern(!pattern)
$<HTMLButtonElement>('#fullscreen').onclick = () => void mapping.requestFullscreen()
$<HTMLButtonElement>('#open').onclick = () => {
  const n = Number($<HTMLSelectElement>('#tiles').value) || 1
  for (let i = 0; i < n; i++) {
    const url = `${location.pathname}?output=${i}&of=${n}&theme=${encodeURIComponent(show.getAttribute('theme') ?? '')}`
    window.open(url, `yura-output-${i}`, 'popup,width=960,height=540')
  }
}
$<HTMLButtonElement>('#export').onclick = () => {
  const blob = new Blob([JSON.stringify(mapping.config(), null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `yura-projection${isOutput ? `-${outputIndex + 1}of${outputCount}` : ''}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}

// Keys work in output windows too (they have no toolbar).
addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'c' || e.key === 'C') setCalibrate(!calibrating)
  else if (e.key === 'f' || e.key === 'F') void mapping.requestFullscreen()
})

// The toolbar fades out after a few idle seconds so it never ends up on the wall.
const IDLE_MS = 2500
let idle = 0
const wake = (): void => {
  document.body.classList.remove('idle')
  clearTimeout(idle)
  idle = window.setTimeout(() => document.body.classList.add('idle'), IDLE_MS)
}
addEventListener('pointermove', wake)
wake()
