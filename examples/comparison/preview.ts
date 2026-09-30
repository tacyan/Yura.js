import * as THREE from 'three'
import { lyricStage } from 'yura'
import { briefs, type BriefName } from './briefs'
import { direction } from './direction'

// This exact file is compiled twice. Only package resolution changes.
let stage: ReturnType<typeof lyricStage> | undefined
let lastTime = 0
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

function mount(key: BriefName) {
  stage?.stop()
  const { selected, lines, options, counts } = direction(key)
  stage = lyricStage('#stage', lines, {
    ...options, three: THREE, reducedMotion: reduced,
    a11y: 'hidden', parallax: true, maxPixelRatio: 1.5,
    // Both old and new versions support explicit render(t). The parent is the only clock.
    scheduler: { request: () => 0, cancel: () => {} },
  })
  stage.render(lastTime)
  const info = { selected, has3D: stage.has3D, counts }
  parent.postMessage({ type: 'yura-info', key, ...info }, location.origin)
}
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== parent) return
  const message = event.data
  if (message?.type === 'render' && Number.isFinite(message.time)) {
    lastTime = Math.max(0, Math.min(12, message.time))
    stage?.render(lastTime)
  }
  if (message?.type === 'brief' && Object.hasOwn(briefs, message.key)) mount(message.key)
})
window.addEventListener('pagehide', (event) => { if (!event.persisted) stage?.stop() })
try { mount('water') } catch (error) {
  document.querySelector('#error')!.textContent = `作品を読み込めませんでした: ${String(error)}`
  parent.postMessage({ type: 'yura-error', message: String(error) }, location.origin)
}
