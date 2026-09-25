import * as THREE from 'three'
import { yuraSite, stageThemes } from 'yura'
import type { StageThemeName } from 'yura'

// The whole site's motion is this one call: every data-yura-* attribute in
// index.html comes alive, both <yura-lyric-stage> tags get a Three.js world,
// and the page shares one colour / type system with them.
const site = yuraSite({ theme: 'noir', three: THREE, opening: { title: 'YOAKE — 夜明けの色', once: false } })

// Demo-only: switch the whole site (page + stages) between themes.
const box = document.querySelector('#themes') as HTMLElement
const stages = Array.from(document.querySelectorAll('yura-lyric-stage'))
for (const name of Object.keys(stageThemes) as StageThemeName[]) {
  const b = document.createElement('button')
  b.textContent = stageThemes[name].ja
  b.setAttribute('aria-pressed', String(name === 'noir'))
  b.onclick = () => {
    site.setTheme(name)
    for (const s of stages) s.setAttribute('theme', name)
    for (const other of Array.from(box.children)) other.setAttribute('aria-pressed', String(other === b))
  }
  box.appendChild(b)
}
