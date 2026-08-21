/**
 * Yura.js Playground — a Hono + Bun server for live-editing and sharing
 * Yura sketches. Bun-native end to end: bun:sqlite for snippet storage,
 * Bun.build to bundle the `yura` package for the browser at startup, and
 * Bun.serve via the default export. Zero frontend build step.
 *
 *   bun run play          # from the repo root
 *   PORT=5000 bun run apps/playground/server.ts
 */
import { Hono } from 'hono'
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const MAX_CODE_BYTES = 32 * 1024

const DEFAULT_CODE = `import { yura, shapes } from 'yura'

const app = yura('#stage')
  .preset('neon-galaxy')
  .particles(500_000)
  .interactive()

await app.run()

// Try: app.morphNow('HELLO')  ·  app.morphNow(shapes.vortex())
`

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
  kbd { font-family: var(--mono); font-size: 0.7rem; color: var(--muted);
    border: 1px solid var(--line); border-radius: 4px; padding: 1px 5px; margin-left: 7px; }
  main { flex: 1; display: grid; grid-template-columns: minmax(320px, 34%) 1fr; min-height: 0; }
  .editor { display: flex; flex-direction: column; border-right: 1px solid var(--line); min-width: 0; }
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
  <div class="spacer"></div>
  <button id="run" class="primary">Run<kbd>⌘⏎</kbd></button>
  <button id="share">Share</button>
</header>
<main>
  <div class="editor"><textarea id="code" spellcheck="false" autocomplete="off"></textarea></div>
  <div class="preview"><iframe id="frame" sandbox="allow-scripts" title="preview"></iframe></div>
</main>
<div id="toast"></div>
<script>
const SNIPPET_ID = ${JSON.stringify(snippetId)};
const DEFAULT_CODE = ${JSON.stringify(DEFAULT_CODE)};
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

function run() {
  const code = codeEl.value.replace(/<\\/script/gi, '<\\\\/script');
  const origin = location.origin;
  frame.srcdoc = [
    '<!doctype html><html><head><meta charset="utf-8"><style>',
    'html,body{height:100%;margin:0;background:#04050c;overflow:hidden}#stage{position:fixed;inset:0}',
    '</style>',
    '<script type="importmap">' + JSON.stringify({ imports: { yura: origin + '/yura.js' } }) + '<\\/script>',
    '</head><body><div id="stage"></div>',
    '<script type="module">' + code + '<\\/script>',
    '</body></html>',
  ].join('');
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

export default app ? { port, fetch: app.fetch } : undefined
