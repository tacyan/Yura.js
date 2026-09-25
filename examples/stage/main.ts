import * as THREE from 'three'
import { defineLyricStage, stageThemes } from 'yura'
import type { StageThemeName } from 'yura'

// One call registers <yura-lyric-stage>; every tag on the page comes alive.
// Handing over THREE turns each stage's backdrop into a real 3D world.
defineLyricStage({ three: THREE })

const hero = document.querySelector('#hero') as HTMLElement
const select = document.querySelector('#theme') as HTMLSelectElement
const name = document.querySelector('#name') as HTMLElement
const names = Object.keys(stageThemes) as StageThemeName[]

for (const key of names) select.add(new Option(`${stageThemes[key].ja}`, key))
const show = (): void => {
  const key = (hero.getAttribute('theme') ?? 'noir') as StageThemeName
  select.value = key
  name.textContent = `seed ${hero.getAttribute('seed') ?? 1}`
}
select.onchange = () => {
  hero.setAttribute('theme', select.value)
  show()
}

// Omakase: a new theme and a new seed — a whole new video from the same lyrics.
const shuffle = (): void => {
  const current = hero.getAttribute('theme')
  const pool = names.filter((n) => n !== current)
  hero.setAttribute('seed', String(1 + Math.floor(Math.random() * 1e6)))
  hero.setAttribute('theme', pool[Math.floor(Math.random() * pool.length)])
  show()
}
;(document.querySelector('#shuffle') as HTMLButtonElement).onclick = shuffle
addEventListener('keydown', (e: KeyboardEvent) => {
  if ((e.key === 'r' || e.key === 'R') && !(e.target instanceof HTMLInputElement)) shuffle()
})
show()
