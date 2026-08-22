/**
 * Yura.js Playground — a Hono + Bun server for live-editing and sharing
 * Yura sketches. Bun-native end to end: bun:sqlite for snippet storage,
 * Bun.build to bundle the `yura` package for the browser at startup, and
 * Bun.serve via the default export. Zero frontend build step.
 *
 *   bun run play          # from the repo root
 *   PORT=5000 bun run apps/playground/server.ts
 *
 * YURA_BUNDLE_FILE=<path> serves a pre-built bundle instead of building
 * from source (used when the source tree is unavailable).
 */
import { Hono } from 'hono'
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
// The whole Yura universe on ONE server: Bun bundles these pages (TS,
// assets and all) and serves them as routes alongside the playground.
import showcasePage from '../showcase/index.html'
import benchPage from '../benchmarks/index.html'
import lyricsPage from '../../examples/lyrics/index.html'
import helloPage from '../../examples/hello/index.html'
import modelPage from '../../examples/model/index.html'

const MAX_CODE_BYTES = 32 * 1024

const DEFAULT_CODE = `import { yura, shapes } from 'yura'

// Two lines: a cursor-reactive galaxy of half a million particles.
const app = yura('#stage')
await app.run()

// The swarm obeys at runtime — change the word, press Run:
setTimeout(() => app.morphNow('HELLO'), 3000)
setTimeout(() => app.morphNow(shapes.vortex()), 7500)
`

/** Curated example sketches — the playground's docs-by-example. */
const RECIPES: Array<{ label: string; code: string }> = [
  { label: 'galaxy', code: DEFAULT_CODE },
  {
    label: 'word morph',
    code: `import { yura } from 'yura'

// morphTo cycles the words forever; motion() sets the beat, and the
// 'back' ease overshoots each arrival for a snappy design-reel feel.
yura('#stage')
  .preset('cyberpunk')
  .particles(350_000)
  .morphTo(['YURA', 'MAKE', 'THE WEB', 'MOVE'])
  .motion({ hold: 1.4, morph: 1.8, ease: 'back' })
  .run()
`,
  },
  {
    label: 'lyric motion',
    code: `import { yura, lyrics } from 'yura'

const app = yura('#stage').preset('aurora').particles(400_000)
await app.run()

// Kinetic typography: bare strings auto-time themselves \`every\` seconds;
// sweep 0.8 condenses each line glyph by glyph before the next dissolve.
lyrics(app, [
  { text: 'ゆらめく光', at: 0 },
  '波のように踊る',
  { text: 'YURA', direction: 'center' },
], { every: 3.4, sweep: 0.8, loop: true })
`,
  },
  {
    label: 'aurora',
    code: `import { yura } from 'yura'

// One line — pointer reactivity is on by default, and turbulence blends in
// divergence-free curl noise so the sheets ripple like a living fluid.
yura('#stage').preset('aurora').motion({ turbulence: 0.8 }).run()
`,
  },
  {
    label: 'custom look',
    code: `import { yura, shapes, looks } from 'yura'

// sakura ships the whole pipeline curated — screen blend + reinhard tone
// curve — and still accepts raw overrides, down to any knob you like.
yura('#stage')
  .particles(400_000)
  .gradient('#f9a8d4', '#fde68a')
  .look(looks.sakura({ trail: 0.45 }))
  .shape(shapes.flow())
  .motion({ turbulence: 0.5, swirl: 0.08 })
  .run()
`,
  },
  {
    label: 'shape tour',
    code: `import { yura, shapes } from 'yura'

// Now with the box / cone / helix generators; expo easing rushes each morph.
yura('#stage')
  .preset('cinematic')
  .particles(600_000)
  .morphTo([shapes.sphere(), shapes.helix(), shapes.cone(), shapes.box(), shapes.vortex(), shapes.ring(), shapes.galaxy()])
  .motion({ hold: 1.8, morph: 1.4, ease: 'expo' })
  .run()
`,
  },
  {
    label: 'mini game',
    code: `import { yura } from 'yura'

// PRISM RUSH — gather 8 pearls around the iridescent knot. WASD/drag rolls,
// Space/tap jumps, R restarts. game() = scene + setup + run in one call. (Needs WebGPU.)
yura('#stage').game({ gravity: -22, bounds: 11 }, (scene) => {
  scene.add('plane', { size: 22, material: 'obsidian' })
  scene.add('knot', { radius: 1.3, material: 'iridescent', position: [0, 1.8, 0], spin: [0, 0.5, 0.2], solid: true, shadow: true })
  const ball = scene.add('sphere', { radius: 0.45, material: 'iridescent', position: [0, 3, 6], body: 'dynamic', shadow: true })
  ball.trail({ color: '#c4b5fd' })
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    scene.add('sphere', { radius: 0.26, hitRadius: 0.7, material: 'pearl', tag: 'pearl', shadow: true, position: [Math.cos(a) * 7, 1, Math.sin(a) * 7] })
  }

  let score = 0
  const hud = scene.text('PEARLS 0 / 8', { anchor: 'top' })
  scene.camera.follow(ball, { distance: 8, height: 3.6 })

  scene.onUpdate((dt, input) => {
    ball.velocity[0] += input.x * 26 * dt
    ball.velocity[2] -= input.y * 26 * dt
    if (input.jump && ball.grounded) ball.velocity[1] = 8.5
    if (input.pressed('KeyR')) { scene.reset(); score = 0; hud.set('PEARLS 0 / 8') }
  })
  ball.onCollide((p) => {
    if (p.tag !== 'pearl' || !p.alive) return
    p.remove()
    // Pickup spark: a pink-to-cyan fountain aimed straight up.
    scene.burst(p.position, { color: '#f0abfc', colorEnd: '#22d3ee', direction: [0, 1, 0], spread: 0.7 })
    hud.set(++score < 8 ? 'PEARLS ' + score + ' / 8' : 'ALL PEARLS — press R')
    if (score === 8) scene.celebrate()
  })
})
`,
  },
  {
    label: 'particle fx',
    code: `import { yura } from 'yura'

// FX kit — arrows/WASD nudge, Space hops, B bursts, F fountains, C celebrates. (Needs WebGPU.)
yura('#stage').game({ gravity: -18, bounds: 8 }, (scene) => {
  scene.add('plane', { size: 18, material: 'checker' })
  const ball = scene.add('sphere', { radius: 0.5, material: 'chrome', position: [0, 2, 0], body: 'dynamic', shadow: true })
  ball.trail({ color: '#67e8f9' })

  scene.onUpdate((dt, input) => {
    ball.velocity[0] += input.x * 20 * dt
    ball.velocity[2] -= input.y * 20 * dt
    if (input.jump && ball.grounded) ball.velocity[1] = 7
    // burst() sugar: colorEnd fades each spark, drag slows it late in life,
    // direction + spread + shape turn a point burst into a disc fountain.
    if (input.pressed('KeyB')) scene.burst(ball.position, { color: '#f472b6', colorEnd: '#facc15', drag: 2 })
    if (input.pressed('KeyF')) scene.burst(ball.position, { direction: [0, 1, 0], spread: 0.25, speed: 10, shape: 'disc', color: '#67e8f9', colorEnd: '#c4b5fd' })
    if (input.pressed('KeyC')) scene.celebrate()
  })
})
`,
  },
  {
    label: 'three.js',
    code: `// three.js interop — needs network access for the esm.sh CDN.
import * as THREE from 'https://esm.sh/three@0.168.0'
import { yuraLayer } from 'yura'

const stage = document.getElementById('stage')
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(stage.clientWidth, stage.clientHeight)
stage.appendChild(renderer.domElement)
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(60, stage.clientWidth / stage.clientHeight, 0.1, 100)
camera.position.set(0, 1.6, 9)
camera.lookAt(0, 1, 0)

const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(1.2, 0.36, 200, 32), new THREE.MeshNormalMaterial())
knot.position.y = 1
scene.add(knot)

// The 3-line integration: create the layer, attach it, sync each frame.
const fx = await yuraLayer(renderer, camera, { preset: 'neon-galaxy', particles: 200_000, radius: 3.4 })
fx.attach(knot)
renderer.setAnimationLoop((t) => {
  knot.rotation.y = t / 1500
  renderer.render(scene, camera)
  fx.sync()
})
`,
  },
]

export interface PlaygroundOptions {
  /** SQLite path; ':memory:' for tests. */
  dbPath?: string
}

interface SnippetRow {
  id: string
  code: string
}

function randomId(): string {
  let id = ''
  while (id.length < 8) id += Math.random().toString(36).slice(2)
  return id.slice(0, 8)
}

/** Bundle the yura package for the browser once, on first request. */
let yuraBundle: string | null = null
async function buildYuraBundle(): Promise<string> {
  if (yuraBundle) return yuraBundle
  const prebuilt = process.env.YURA_BUNDLE_FILE
  if (prebuilt) {
    yuraBundle = await Bun.file(prebuilt).text()
    return yuraBundle
  }
  const entry = new URL('../../packages/yura/src/index.ts', import.meta.url).pathname
  const result = await Bun.build({ entrypoints: [entry], target: 'browser', minify: true })
  if (!result.success) {
    throw new Error(`yura bundle failed: ${result.logs.map((l) => l.message).join('; ')}`)
  }
  yuraBundle = await result.outputs[0].text()
  return yuraBundle
}

export function createApp(options: PlaygroundOptions = {}): Hono {
  const dbPath =
    options.dbPath ?? new URL('./.data/playground.sqlite', import.meta.url).pathname
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.run(
    'CREATE TABLE IF NOT EXISTS snippets (id TEXT PRIMARY KEY, code TEXT NOT NULL, created INTEGER NOT NULL)',
  )
  const insert = db.prepare('INSERT INTO snippets (id, code, created) VALUES (?, ?, ?)')
  const select = db.prepare('SELECT id, code FROM snippets WHERE id = ?')

  const app = new Hono()

  app.get('/', (c) => c.html(page(null)))

  app.get('/s/:id', (c) => {
    const row = select.get(c.req.param('id')) as SnippetRow | null
    if (!row) return c.html(page(null), 404)
    return c.html(page(row.id))
  })

  app.get('/api/snippet/:id', (c) => {
    const row = select.get(c.req.param('id')) as SnippetRow | null
    if (!row) return c.json({ error: 'not found' }, 404)
    return c.json({ id: row.id, code: row.code })
  })

  app.post('/api/share', async (c) => {
    let body: { code?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid json' }, 400)
    }
    const code = body.code
    if (typeof code !== 'string' || code.trim().length === 0) {
      return c.json({ error: 'code required' }, 400)
    }
    if (new TextEncoder().encode(code).length > MAX_CODE_BYTES) {
      return c.json({ error: `code exceeds ${MAX_CODE_BYTES} bytes` }, 413)
    }
    const id = randomId()
    insert.run(id, code, Date.now())
    return c.json({ id, url: `/s/${id}` })
  })

  // Browser ESM bundle of the yura package. CORS open so the sandboxed
  // (opaque-origin) preview iframe can import it.
  app.get('/yura.js', async (c) => {
    const js = await buildYuraBundle()
    return c.body(js, 200, {
      'content-type': 'text/javascript; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-cache',
    })
  })

  return app
}

/** The playground page. `snippetId` preloads a shared sketch. */
function page(snippetId: string | null): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>YURA Playground</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --bg: #05060e; --panel: #0b0e1d; --line: rgba(148,163,184,0.16);
    --text: #e2e8f0; --muted: #8494ad; --cyan: #67e8f9; --violet: #c4b5fd;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  html, body { height: 100%; background: var(--bg); color: var(--text); overflow: hidden; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; display: flex; flex-direction: column; }
  header {
    display: flex; align-items: center; gap: 16px; padding: 12px 20px;
    border-bottom: 1px solid var(--line); background: var(--panel);
  }
  .word {
    font-size: 1.05rem; font-weight: 900; letter-spacing: 0.3em;
    background: linear-gradient(90deg, var(--cyan), var(--violet));
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .word small { font-weight: 400; letter-spacing: 0.12em; color: var(--muted);
    -webkit-text-fill-color: var(--muted); margin-left: 10px; font-size: 0.7rem; }
  .spacer { flex: 1; }
  button {
    padding: 7px 18px; border-radius: 8px; cursor: pointer; font-size: 0.85rem;
    border: 1px solid var(--line); background: transparent; color: var(--text);
    font-weight: 600; transition: border-color .2s, color .2s;
  }
  button:hover { border-color: rgba(148,163,184,0.45); }
  button.primary {
    border: 0; color: #04050c;
    background: linear-gradient(90deg, var(--cyan), var(--violet));
  }
  .pages { display: flex; gap: 14px; margin-left: 18px; }
  .pages a { color: var(--muted); text-decoration: none; font-family: var(--mono);
    font-size: 0.72rem; letter-spacing: 0.12em; text-transform: uppercase; transition: color .2s; }
  .pages a:hover { color: var(--cyan); }
  kbd { font-family: var(--mono); font-size: 0.7rem; color: var(--muted);
    border: 1px solid var(--line); border-radius: 4px; padding: 1px 5px; margin-left: 7px; }
  button.primary kbd { color: rgba(4,5,12,0.75); border-color: rgba(4,5,12,0.3); }
  main { flex: 1; display: grid; grid-template-columns: minmax(320px, 34%) 1fr; min-height: 0; }
  .editor { display: flex; flex-direction: column; border-right: 1px solid var(--line); min-width: 0; }
  .recipes {
    display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 14px;
    border-bottom: 1px solid var(--line); background: rgba(11,14,29,0.6);
  }
  .recipes span { font-family: var(--mono); font-size: 0.62rem; letter-spacing: 0.14em;
    text-transform: uppercase; color: var(--muted); align-self: center; margin-right: 4px; }
  .recipes button {
    padding: 4px 12px; border-radius: 999px; font-size: 0.72rem; font-weight: 500;
    font-family: var(--mono); color: var(--muted);
  }
  .recipes button:hover { color: var(--cyan); border-color: rgba(103,232,249,0.4); }
  textarea {
    flex: 1; resize: none; border: 0; outline: none; padding: 18px 20px;
    background: var(--bg); color: var(--text); font-family: var(--mono);
    font-size: 13.5px; line-height: 1.75; tab-size: 2; white-space: pre;
    caret-color: var(--cyan);
  }
  textarea::selection { background: rgba(103,232,249,0.22); }
  .preview { position: relative; background: #000; }
  iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
  #toast {
    position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%) translateY(8px);
    padding: 9px 20px; border-radius: 999px; background: var(--panel);
    border: 1px solid var(--line); font-size: 0.82rem; color: var(--text);
    opacity: 0; transition: opacity .3s, transform .3s; pointer-events: none;
  }
  #toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  @media (max-width: 760px) { main { grid-template-columns: 1fr; grid-template-rows: 40% 1fr; }
    .editor { border-right: 0; border-bottom: 1px solid var(--line); } }
</style>
</head>
<body>
<header>
  <div class="word">YURA<small>PLAYGROUND</small></div>
  <nav class="pages">
    <a href="/showcase">showcase</a>
    <a href="/lyrics">lyrics</a>
    <a href="/bench">bench</a>
    <a href="/hello">hello</a>
    <a href="/model">model</a>
  </nav>
  <div class="spacer"></div>
  <button id="run" class="primary">Run<kbd>⌘⏎</kbd></button>
  <button id="share">Share</button>
</header>
<main>
  <div class="editor">
    <div class="recipes" id="recipes"><span>examples</span></div>
    <textarea id="code" spellcheck="false" autocomplete="off"></textarea>
  </div>
  <div class="preview"><!-- Preview runs same-origin: fine for localhost.
       For public deployment, serve previews from a separate origin instead
       of re-enabling sandbox (sandboxed srcdoc script execution proved
       unreliable across Chrome states). --><iframe id="frame" title="preview"></iframe></div>
</main>
<div id="toast"></div>
<script>
const SNIPPET_ID = ${JSON.stringify(snippetId)};
const DEFAULT_CODE = ${JSON.stringify(DEFAULT_CODE)};
const RECIPES = ${JSON.stringify(RECIPES)};
const codeEl = document.getElementById('code');
const frame = document.getElementById('frame');
const toastEl = document.getElementById('toast');
let toastTimer = 0;

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

/** Full-width / invisible characters are the usual cause of an opaque
 *  "Invalid or unexpected token" (typing with an IME on). Locate them so the
 *  error overlay can point at the exact spot. U+3000 is legal JS whitespace
 *  and full-width letters are legal in strings, so this only reports when a
 *  SyntaxError actually occurred. */
function sketchHints(src) {
  const matcher = () =>
    /[\\u00A0\\u200B-\\u200F\\u2018-\\u201F\\u2212\\u3001-\\u303F\\uFE64-\\uFE66\\uFEFF\\uFF01-\\uFF5E\\uFFE0-\\uFFE6]/g;
  const found = [];
  const lines = src.split('\\n');
  for (let ln = 0; ln < lines.length && found.length < 5; ln++) {
    const g = matcher();
    let m;
    while ((m = g.exec(lines[ln])) && found.length < 5) {
      const cp = m[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
      found.push('line ' + (ln + 1) + ':' + (m.index + 1) + '  "' + m[0] + '" (U+' + cp + ')');
    }
  }
  if (found.length === 0) return '';
  return '\\nfull-width / invisible characters found — likely cause, replace with half-width:\\n  ' +
    found.join('\\n  ');
}

function run() {
  const src = codeEl.value;
  const code = src.replace(/<\\/script/gi, '<\\\\/script');
  const hints = sketchHints(src);
  const origin = location.origin;
  frame.srcdoc = [
    '<!doctype html><html><head><meta charset="utf-8"><style>',
    'html,body{height:100%;margin:0;background:#04050c;overflow:hidden}#stage{position:fixed;inset:0}',
    '#fps{position:fixed;top:10px;right:12px;z-index:9;font:600 11.5px ui-monospace,Menlo,monospace;',
    'color:#8494ad;text-shadow:0 0 8px rgba(0,0,0,0.9);pointer-events:none}',
    '#err{display:none;position:fixed;left:12px;right:12px;bottom:12px;z-index:99;padding:12px 16px;',
    'border-radius:10px;background:rgba(26,7,14,0.94);border:1px solid rgba(251,113,133,0.4);',
    'border-left:3px solid #fb7185;color:#fecdd3;font:12.5px/1.65 ui-monospace,Menlo,monospace;white-space:pre-wrap}',
    '#err b{color:#fb7185;display:block;margin-bottom:3px;font-size:10.5px;letter-spacing:0.14em;text-transform:uppercase}',
    '</style>',
    '<script>(function(){var HINTS=' + JSON.stringify(hints) + ';',
    'function show(m,line){var d=document.getElementById("err");if(!d)return;',
    'd.style.display="block";d.innerHTML="<b>sketch error</b>";',
    'var t=m;if(line>0)t+="  [sketch line "+line+"]";',
    'if(/SyntaxError/i.test(m)&&HINTS)t+=HINTS;',
    'd.appendChild(document.createTextNode(t))}',
    'window.addEventListener("error",function(e){',
    'show(e.message||"Script error",/srcdoc/.test(e.filename||"")?e.lineno:0)});',
    'window.addEventListener("unhandledrejection",function(e){var r=e.reason;',
    'show(r&&r.message?r.message:String(r),0)})})()<\\/script>',
    '<script type="importmap">' + JSON.stringify({ imports: { yura: origin + '/yura.js' } }) + '<\\/script>',
    '</head><body><div id="stage"></div><div id="fps"></div><div id="err"></div>',
    '<script>(function(){var l=performance.now(),e=60,el=document.getElementById("fps");',
    'function t(n){e=e*0.92+(1000/Math.max(n-l,0.1))*0.08;l=n;requestAnimationFrame(t)}',
    'requestAnimationFrame(t);setInterval(function(){el.textContent=Math.round(e)+" fps"},500)})()<\\/script>',
    '<script type="module">' + code + '<\\/script>',
    '</body></html>',
  ].join('');
}

const recipesEl = document.getElementById('recipes');
for (const r of RECIPES) {
  const b = document.createElement('button');
  b.textContent = r.label;
  b.dataset.recipe = r.label;
  b.addEventListener('click', () => { codeEl.value = r.code; run(); });
  recipesEl.appendChild(b);
}

async function share() {
  const res = await fetch('/api/share', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: codeEl.value }),
  });
  if (!res.ok) { toast('Share failed (' + res.status + ')'); return; }
  const { url } = await res.json();
  const full = location.origin + url;
  history.replaceState(null, '', url);
  try { await navigator.clipboard.writeText(full); toast('Link copied — ' + full); }
  catch { toast('Shared — ' + full); }
}

document.getElementById('run').addEventListener('click', run);
document.getElementById('share').addEventListener('click', share);
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); run(); }
});
codeEl.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = codeEl.selectionStart, t = codeEl.selectionEnd;
    codeEl.setRangeText('  ', s, t, 'end');
  }
});

(async () => {
  if (SNIPPET_ID) {
    const res = await fetch('/api/snippet/' + SNIPPET_ID);
    if (res.ok) { codeEl.value = (await res.json()).code; run(); return; }
  }
  codeEl.value = DEFAULT_CODE;
  run();
})();
</script>
</body>
</html>`
}

const isMain = import.meta.main
const port = Number(process.env.PORT ?? 4175)
const app = isMain ? createApp() : null

if (app) {
  console.log(`YURA Playground → http://localhost:${port}/`)
}

export default app
  ? {
      port,
      routes: {
        '/showcase': showcasePage,
        '/lyrics': lyricsPage,
        '/bench': benchPage,
        '/hello': helloPage,
        '/model': modelPage,
      },
      fetch: app.fetch,
    }
  : undefined
