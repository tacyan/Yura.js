import { briefs, DURATION, type BriefName } from './briefs'

type Info = { key: BriefName; selected: Record<string, string>; has3D: boolean; counts: Record<string, number> }
const frames = { before: document.querySelector<HTMLIFrameElement>('#before')!, after: document.querySelector<HTMLIFrameElement>('#after')! }
const infos: Partial<Record<keyof typeof frames, Info>> = {}
const prompt = document.querySelector('#prompt')!
const play = document.querySelector<HTMLButtonElement>('#play')!
const slider = document.querySelector<HTMLInputElement>('#time')!
const output = document.querySelector('output')!
const status = document.querySelector('#load-status')!
let key: BriefName = 'water'
let time = 0
let playing = !matchMedia('(prefers-reduced-motion: reduce)').matches
let previous = performance.now()
let visible = true
let handle = 0
prompt.textContent = briefs[key].prompt

const send = (message: object) => { for (const frame of Object.values(frames)) frame.contentWindow?.postMessage(message, location.origin) }
function render() {
  slider.value = String(time)
  output.textContent = `${time.toFixed(2)}秒`
  send({ type: 'render', time })
}
function syncPlay() { play.textContent = playing ? '一時停止' : '再生'; play.setAttribute('aria-pressed', String(playing)) }
function updateInfo() {
  for (const side of ['before', 'after'] as const) {
    const info = infos[side]
    if (info) document.querySelector(`#${side}-recipes`)!.textContent = `背景 ${info.selected.world} ／ 文字 ${info.selected.enter}・${info.selected.hold}・${info.selected.exit} ／ 転換 ${info.selected.transition} ／ ${info.has3D ? '3D描画' : 'CSS背景（GPU未使用）'}`
  }
  if (!infos.before || !infos.after) return
  status.textContent = infos.before.has3D && infos.after.has3D ? '両方の作品を同じ時刻で表示しています。作品の上でポインターを動かすと視点が変わります。' : 'GPUを使えない作品はCSS背景です。3D表現の比較にはWebGL対応のブラウザが必要です。'
  const rows = { themes: 'テーマ', worlds: '3Dワールド', motions: '文字モーション・レイアウト', transitions: '場面転換' }
  const tbody = document.querySelector('#counts')!
  tbody.replaceChildren()
  for (const [field, label] of Object.entries(rows)) {
    const row = document.createElement('tr')
    for (const value of [label, infos.before.counts[field], infos.after.counts[field]]) {
      const cell = document.createElement('td'); cell.textContent = String(value); row.appendChild(cell)
    }
    tbody.appendChild(row)
  }
}
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin) return
  const side = (Object.keys(frames) as (keyof typeof frames)[]).find((side) => frames[side].contentWindow === event.source)
  if (!side) return
  if (event.data?.type === 'yura-error') { playing = false; syncPlay(); status.textContent = `${side === 'before' ? '変更前' : '変更後'}を読み込めませんでした: ${event.data.message}`; return }
  if (event.data?.type !== 'yura-info') return
  if (event.data.key !== key) { frames[side].contentWindow?.postMessage({ type: 'brief', key }, location.origin); return }
  infos[side] = event.data
  updateInfo()
  render()
})
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-brief]')) {
  button.addEventListener('click', () => {
    key = button.dataset.brief as BriefName; time = 0
    delete infos.before; delete infos.after
    for (const other of document.querySelectorAll('[data-brief]')) other.setAttribute('aria-pressed', String(other === button))
    prompt.textContent = briefs[key].prompt
    status.textContent = '両方の作品を切り替えています。'
    send({ type: 'brief', key }); render()
  })
}
play.addEventListener('click', () => { playing = !playing; previous = performance.now(); syncPlay() })
document.querySelector('#restart')!.addEventListener('click', () => { time = 0; render() })
slider.addEventListener('input', () => { playing = false; time = Number(slider.value); syncPlay(); render() })
const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting })
observer.observe(document.querySelector('.comparison')!)
function tick(now: number) {
  const delta = Math.min(0.1, (now - previous) / 1000)
  previous = now
  if (playing && visible && infos.before && infos.after) { time = (time + delta) % DURATION; render() }
  handle = requestAnimationFrame(tick)
}
syncPlay(); handle = requestAnimationFrame(tick)
void fetch('./provenance.json').then((response) => { if (!response.ok) throw new Error('比較条件を取得できません'); return response.json() }).then((data) => {
  document.querySelector('#before-revision')!.textContent = `${data.baselineVersion} / ${data.baselineCommit.slice(0, 8)}`
  document.querySelector('#provenance')!.textContent = `変更前: ${data.baselineCommit}。比較エントリSHA-256: ${data.entryHash}。変更後: ビルド時の作業ツリー。`
}).catch((error) => { document.querySelector('#provenance')!.textContent = String(error) })
window.addEventListener('pagehide', (event) => { if (!event.persisted) { cancelAnimationFrame(handle); observer.disconnect() } })
