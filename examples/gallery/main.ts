import * as THREE from 'three'
import {
  yuraSite,
  stageThemes,
  stageWorlds,
  cameraMoves,
  stageTransitions,
  stageDecor,
  kineticCatalog,
  kineticMoods,
  motions,
  glyphRank,
  glyphProgress,
  identityPose,
  composePose,
  poseToStyle,
  blockReveals,
  blockRevealAt,
} from 'yura'
import type { StageThemeName, TransitionRecipe, HoldRecipe, LayoutRecipe, MotionEntry, BlockRevealName } from 'yura'

// Everything on this page is generated from the library's own registries,
// so the gallery can never fall behind what the library actually does.

const site = yuraSite({ theme: 'noir', three: THREE })
const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T
const el = <T extends HTMLElement = HTMLElement>(tag: string, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): T => {
  const e = Object.assign(document.createElement(tag), props) as T
  e.append(...kids)
  return e
}
const stages = () => Array.from(document.querySelectorAll('yura-lyric-stage'))

// ------------------------------------------------------------------ ① stage lab
const lab = $('#lab')
const panel = $('#panel')
const desc = el('p', { className: 'desc' })
const select = (label: string, attr: string, table: Record<string, { ja: string; desc: string }>, withAuto = true) => {
  const s = el<HTMLSelectElement>('select')
  if (withAuto) s.add(new Option('テーマにおまかせ', ''))
  for (const [k, v] of Object.entries(table)) s.add(new Option(`${v.ja}（${k}）`, k))
  s.onchange = () => {
    if (s.value) lab.setAttribute(attr, s.value)
    else lab.removeAttribute(attr)
    desc.textContent = s.value ? table[s.value].desc : ''
  }
  s.onfocus = () => (desc.textContent = s.value ? table[s.value].desc : `${label}: ${Object.keys(table).length} 種類`)
  panel.append(el('label', {}, `${label} · ${Object.keys(table).length}`, s))
  return s
}
const themeSel = select('テーマ', 'theme', stageThemes, false)
select('3Dの世界', 'world', stageWorlds)
select('カメラ', 'camera', cameraMoves)
select('つなぎ', 'transition', stageTransitions)
const moodTable = Object.fromEntries(Object.entries(kineticMoods).map(([k, v]) => [k, { ja: v.ja, desc: v.desc }]))
select('文字の雰囲気', 'mood', { ...moodTable, mix: { ja: 'ミックス', desc: '全部の雰囲気から行ごとに選ぶ。' } })
panel.append(desc)

// Decor chips (multi-select).
const chosen = new Set<string>(stageThemes.noir.decor)
const chips = el('div', { className: 'chips' })
for (const [k, v] of Object.entries(stageDecor)) {
  const b = el('button', { textContent: v.ja, title: v.desc })
  b.setAttribute('aria-pressed', String(chosen.has(k)))
  b.onclick = () => {
    chosen.has(k) ? chosen.delete(k) : chosen.add(k)
    b.setAttribute('aria-pressed', String(chosen.has(k)))
    lab.setAttribute('decor', chosen.size ? [...chosen].join(' ') : 'none')
    desc.textContent = v.desc
  }
  chips.append(b)
}
panel.append(el('label', {}, `装飾 · ${Object.keys(stageDecor).length}`, chips))
const reroll = el('button', { className: 'yura-btn', textContent: 'シードを振り直す ↻' })
reroll.onclick = () => lab.setAttribute('seed', String(1 + Math.floor(Math.random() * 1e6)))
panel.append(reroll)

// ------------------------------------------------------------------ ② themes
const setTheme = (name: StageThemeName) => {
  site.setTheme(name)
  for (const s of stages()) s.setAttribute('theme', name)
  themeSel.value = name
  for (const b of Array.from(document.querySelectorAll('.theme'))) b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.name === name))
}
$('#theme-count').textContent = `· ${Object.keys(stageThemes).length}`
for (const [name, t] of Object.entries(stageThemes) as [StageThemeName, (typeof stageThemes)[StageThemeName]][]) {
  const sw = el('div', { className: 'sw' })
  for (const s of t.schemes) sw.append(el('span', { textContent: '字', style: `background:${s.bg};color:${s.fg};font-family:${t.fonts.lyric === 'serif' ? t.fonts.serif : t.fonts.display}` }))
  const b = el('button', { className: 'theme' }, sw, el('div', { className: 'tx' }, el('b', { textContent: t.ja }), el('code', { textContent: name }), el('small', { textContent: `${t.desc}（世界: ${stageWorlds[t.world].ja}）` })))
  b.dataset.name = name
  b.setAttribute('aria-pressed', String(name === 'noir'))
  b.onclick = () => setTheme(name)
  $('#theme-list').append(b)
}
themeSel.onchange = () => setTheme(themeSel.value as StageThemeName)

// ------------------------------------------------------------------ ③ text motions (live loops)
const catalog = kineticCatalog()
$('#motion-count').textContent = `· ${catalog.length}`
const SAMPLE = '夜明けの色'
const CYCLE = 2.8
interface Card { entry: MotionEntry; spans: HTMLElement[]; box: HTMLElement; visible: boolean }
const cards: Card[] = []
const grid = $('#motion-grid')
const io = new IntersectionObserver((es) => es.forEach((e) => { const c = cards.find((x) => x.box === e.target); if (c) c.visible = e.isIntersecting }))
const phases = [['enter', '登場'], ['hold', '保持'], ['exit', '退場'], ['layout', '配置']] as const
let phase: MotionEntry['phase'] = 'enter'
const render = () => {
  grid.textContent = ''
  cards.length = 0
  for (const entry of catalog.filter((e) => e.phase === phase)) {
    const demo = el('div', { className: 'demo' })
    const line = el('span')
    const spans = Array.from(SAMPLE).map((ch) => el('span', { textContent: ch }))
    line.append(...spans)
    demo.append(line)
    if (phase === 'layout') {
      const box = (motions.layout[entry.name as keyof typeof motions.layout] as LayoutRecipe).box
      if (box.writingMode) line.style.writingMode = box.writingMode
      if (box.transform) line.style.transform = box.transform
      demo.style.justifyItems = box.justifyContent === 'flex-start' ? 'start' : box.justifyContent === 'flex-end' ? 'end' : 'center'
      demo.style.fontSize = `${34 * Math.min(1.6, (motions.layout[entry.name as keyof typeof motions.layout] as LayoutRecipe).fontScale ?? 1)}px`
    }
    const card = el('div', { className: 'm' }, demo, el('div', { className: 'name' }, el('b', { textContent: entry.ja }), el('code', { textContent: entry.name }), el('small', { textContent: entry.desc })))
    grid.append(card)
    cards.push({ entry, spans, box: card, visible: false })
    io.observe(card)
  }
  for (const b of Array.from($('#phase-tabs').children)) b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.phase === phase))
}
for (const [p, ja] of phases) {
  const b = el('button', { textContent: `${ja} ${catalog.filter((e) => e.phase === p).length}` })
  b.dataset.phase = p
  b.onclick = () => { phase = p; render() }
  $('#phase-tabs').append(b)
}
render()
for (const [k, m] of Object.entries(kineticMoods)) {
  $('#mood-list').append(el('div', { className: 'mood' }, el('b', { textContent: `雰囲気: ${m.ja}` }), el('code', { textContent: k }), el('small', { textContent: `${m.desc} 登場: ${m.enter.join(' / ')}` })))
}

const n = SAMPLE.length
const loop = (now: number) => {
  const t = now / 1000
  for (const c of cards) {
    if (!c.visible) continue
    const u = (t % CYCLE) / CYCLE
    c.spans.forEach((span, i) => {
      const g = { i, n, seed: 7, char: SAMPLE[i], rank: i / (n - 1) }
      const pose = identityPose()
      if (c.entry.phase === 'enter' || c.entry.phase === 'exit') {
        const r = motions[c.entry.phase][c.entry.name as never] as TransitionRecipe
        const rank = glyphRank(r.order ?? 'ltr', i, n, 7)
        // enter: arrive over 60% of the cycle then rest; exit: rest, then leave.
        const p = c.entry.phase === 'enter' ? Math.min(1, u / 0.6) : Math.max(0, (u - 0.3) / 0.6)
        composePose(pose, r.pose(glyphProgress(p, rank, r.stagger ?? 0.5), { ...g, rank }))
        if (r.origin) span.style.transformOrigin = r.origin
      } else if (c.entry.phase === 'hold') {
        const r = motions.hold[c.entry.name as never] as HoldRecipe
        composePose(pose, r.pose(t, g, 0.5))
        if (r.origin) span.style.transformOrigin = r.origin
      } else {
        const r = motions.layout[c.entry.name as never] as LayoutRecipe
        if (r.offset) composePose(pose, r.offset(g))
      }
      const s = poseToStyle(pose)
      span.textContent = pose.char ?? SAMPLE[i]
      span.style.transform = s.transform
      span.style.opacity = s.opacity
      span.style.filter = s.filter
      span.style.clipPath = s.clipPath
      span.style.textShadow = s.textShadow === 'none' ? '' : s.textShadow
    })
  }
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)

// ------------------------------------------------------------------ ④ block reveals (replayable)
for (const [name, r] of Object.entries(blockReveals) as [BlockRevealName, { ja: string; desc: string }][]) {
  const inner = el('div', { textContent: r.ja.slice(0, 1) })
  const curtain = el('div', { className: 'curtain' })
  const box = el('div', { className: 'box' }, inner, curtain)
  const play = () => {
    const t0 = performance.now()
    const step = () => {
      const p = (performance.now() - t0) / 1300
      const f = blockRevealAt(name, p)
      inner.style.opacity = f.opacity
      inner.style.transform = f.transform
      inner.style.clipPath = f.clipPath
      curtain.style.transform = f.curtain.transform
      curtain.style.opacity = f.curtain.opacity
      if (p < 1) requestAnimationFrame(step)
    }
    step()
  }
  const btn = el('button', { className: 'yura-link', textContent: 'もう一度 ↻' })
  btn.style.cssText = 'font:inherit;font-size:12px;border:0;background:none;color:inherit;cursor:pointer'
  btn.onclick = play
  const card = el('div', { className: 'rv' }, box, el('div', {}, el('b', { textContent: r.ja }), el('code', { textContent: `data-yura-reveal="${name}"` }), el('small', { textContent: r.desc })), btn)
  $('#reveal-grid').append(card)
  new IntersectionObserver((es, o) => es.forEach((e) => { if (e.isIntersecting) { play(); o.disconnect() } })).observe(box)
}

// ------------------------------------------------------------------ ⑥ demo links
const demos = [
  ['完成サイト（新曲特設ページ）', 'オープニング、見出しの登場、カーテン、マーキー、数え上げ、スクロール再生の歌詞、配色の切り替え。属性だけで組んだ1ページ。', 'bun run dev:site'],
  ['歌詞ステージ（全画面＋縦長カード）', '3D の世界で歌詞が一行ずつ。テーマを R キーでおまかせ切り替え。', 'bun run dev:stage'],
  ['文字の表現カタログ', '76 の文字表現を一つずつ再生して説明を読める。雰囲気でまとめて再生も。', 'bun run dev:kinetic'],
  ['パーティクルの歌詞', '最初からある、100万粒子で文字を組み上げる歌詞演出（WebGPU）。', 'bun run dev:lyrics'],
]
for (const [title, text, cmd] of demos) $('#demo-links').append(el('a', { href: '#demos' }, el('b', { textContent: title }), el('p', { textContent: text }), el('code', { textContent: cmd })))
site.refresh()
