import { test, expect } from 'bun:test'
import { createApp } from '../server'

const app = createApp({ dbPath: ':memory:' })

test('GET / serves the playground page', async () => {
  const res = await app.request('/')
  expect(res.status).toBe(200)
  const html = await res.text()
  expect(html).toContain('YURA')
  expect(html).toContain('id="code"')
  // Preview runs same-origin (see the inline comment in server.ts); the error
  // overlay must diagnose full-width/invisible characters behind SyntaxErrors.
  expect(html).toContain('<iframe id="frame"')
  expect(html).toContain('sketchHints')
  expect(html).toContain('sketch error')
  // Recipe chips (docs-by-example) ship with the page.
  expect(html).toContain('word morph')
  expect(html).toContain('shape tour')
  // Scene-kit + interop recipes (adoption demos for the new capabilities).
  expect(html).toContain('mini game')
  expect(html).toContain('particle fx')
  expect(html).toContain('three.js')
  expect(html).toContain('yuraLayer')
  expect(html).toContain('esm.sh/three')
})

test('share -> fetch snippet -> load shared page round-trips', async () => {
  const code = "import { yura } from 'yura'\nyura('#stage').run()"
  const shareRes = await app.request('/api/share', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  expect(shareRes.status).toBe(200)
  const { id, url } = (await shareRes.json()) as { id: string; url: string }
  expect(id).toMatch(/^[a-z0-9]{8}$/)
  expect(url).toBe(`/s/${id}`)

  const snippetRes = await app.request(`/api/snippet/${id}`)
  expect(snippetRes.status).toBe(200)
  const snippet = (await snippetRes.json()) as { code: string }
  expect(snippet.code).toBe(code)

  const pageRes = await app.request(url)
  expect(pageRes.status).toBe(200)
  expect(await pageRes.text()).toContain(JSON.stringify(id))
})

test('share rejects missing, empty, and invalid payloads', async () => {
  const bad = await app.request('/api/share', { method: 'POST', body: 'not json' })
  expect(bad.status).toBe(400)
  const empty = await app.request('/api/share', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: '   ' }),
  })
  expect(empty.status).toBe(400)
})

test('share rejects oversized code with 413', async () => {
  const res = await app.request('/api/share', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'x'.repeat(33 * 1024) }),
  })
  expect(res.status).toBe(413)
})

test('unknown snippet returns 404 on api and page', async () => {
  expect((await app.request('/api/snippet/zzzzzzzz')).status).toBe(404)
  expect((await app.request('/s/zzzzzzzz')).status).toBe(404)
})

test('GET /yura.js serves a browser bundle with CORS', async () => {
  const res = await app.request('/yura.js')
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toContain('javascript')
  expect(res.headers.get('access-control-allow-origin')).toBe('*')
  const js = await res.text()
  expect(js.length).toBeGreaterThan(10_000)
  // The public API must survive bundling + minification. `yuraLayer` (and the
  // scene kit) back the mini game / particle fx / three.js interop recipes.
  expect(js).toContain('neon-galaxy')
  expect(js).toContain('yuraLayer')
})
