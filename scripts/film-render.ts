#!/usr/bin/env bun
/**
 * Renders a yuraFilm script to MP4, frame-exact, with its synthesised soundtrack.
 *
 *   bun run film <script.json> [--out name.mp4] [--fps 30] [--from 0] [--to 12.5] [--no-audio] [--jpeg-quality 95]
 *
 * How: the film page (examples/film) is served by Bun, opened in headless
 * Chrome over the DevTools protocol (Bun's own WebSocket — no puppeteer), and
 * every frame is drawn at an exact time with `__yuraFilm.render(t)` and
 * captured. Frames stream into ffmpeg together with the WAV the page
 * synthesises. Nothing is recorded in real time, so a slow machine renders
 * the same film as a fast one — just more slowly.
 *
 * Portability: Chrome is found through CHROME_PATH, then the standard install
 * locations of each OS, then the PATH; ffmpeg through FFMPEG_PATH, then the PATH.
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir, platform } from 'node:os'
import { join, resolve, basename, extname } from 'node:path'
import { planFilm, type FilmScript } from '../packages/yura/src/film'
import { filmOptions } from './film-options'

// ------------------------------------------------------------------ args

const argv = process.argv.slice(2)
const initialOptions = filmOptions(argv, { fps: 30, duration: Number.MAX_VALUE })
const scriptArg = initialOptions.script
// `bun run` changes into the repo; paths the user typed are relative to where they typed them.
const userCwd = process.env.INIT_CWD ?? process.cwd()
// Bun's HTML bundle resolves its chunk URLs against the process cwd: serve from the repo root,
// whatever directory the command was typed in.
process.chdir(resolve(import.meta.dir, '..'))
const { default: page } = await import('../examples/film/index.html')
const scriptPath = resolve(userCwd, scriptArg)
const script = JSON.parse(readFileSync(scriptPath, 'utf8')) as FilmScript
const plan = planFilm(script) // validates names early, with the list of real ones
const { fps, from, to, audio, quality, out: outputPath } = filmOptions(argv, plan)
const out = resolve(userCwd, outputPath ?? `${basename(scriptPath, extname(scriptPath))}.mp4`)

// ------------------------------------------------------------------ tools

function which(cmd: string): string | null {
  const r = Bun.spawnSync(platform() === 'win32' ? ['where', cmd] : ['which', cmd])
  const p = r.stdout.toString().split(/\r?\n/)[0]?.trim()
  return r.exitCode === 0 && p ? p : null
}

function findChrome(): string {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  const pf = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean) as string[]
  // Standard install locations per OS (not machine-specific: every install of Chrome lands here).
  const candidates =
    platform() === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : platform() === 'win32'
        ? pf.map((p) => join(p, 'Google/Chrome/Application/chrome.exe'))
        : []
  for (const c of candidates) if (existsSync(c)) return c
  for (const cmd of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']) {
    const p = which(cmd)
    if (p) return p
  }
  throw new Error('Chrome / Chromium was not found. Install it, or set CHROME_PATH to its executable.')
}

function findFfmpeg(): string {
  if (process.env.FFMPEG_PATH && existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH
  const p = which('ffmpeg')
  if (!p) throw new Error('ffmpeg was not found. Install it (https://ffmpeg.org/download.html), or set FFMPEG_PATH.')
  return p
}

// ------------------------------------------------------------------ CDP

class Cdp {
  private id = 0
  private pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>()
  /** Protocol events (page errors and console output are collected for failure reports). */
  onEvent?: (method: string, params: unknown) => void
  private constructor(private ws: WebSocket) {
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data)) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } }
      if (m.id === undefined) {
        if (m.method) this.onEvent?.(m.method, m.params)
        return
      }
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      if (m.error) p.fail(new Error(m.error.message))
      else p.ok(m.result)
    })
  }
  static open(url: string): Promise<Cdp> {
    return new Promise((ok, fail) => {
      const ws = new WebSocket(url)
      ws.addEventListener('open', () => ok(new Cdp(ws)))
      ws.addEventListener('error', () => fail(new Error(`Could not connect to Chrome at ${url}`)))
    })
  }
  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    return new Promise((ok, fail) => this.pending.set(id, { ok: ok as (v: unknown) => void, fail }))
  }
  close(): void {
    this.ws.close()
  }
}

async function launchChrome(exe: string, profile: string): Promise<{ proc: ReturnType<typeof Bun.spawn>; ws: string }> {
  const proc = Bun.spawn(
    [exe, '--headless=new', '--remote-debugging-port=0', '--remote-allow-origins=*', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', '--force-color-profile=srgb', 'about:blank'],
    { stdout: 'ignore', stderr: 'pipe' },
  )
  const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let buf = ''
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value)
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf)
    if (m) {
      reader.releaseLock()
      return { proc, ws: m[1] }
    }
  }
  proc.kill()
  throw new Error(`Chrome did not start:\n${buf.slice(-800)}`)
}

// ------------------------------------------------------------------ render

const RESULT_TIMEOUT_MS = Number(process.env.YURA_FILM_TIMEOUT_MS) || 60_000

async function main(): Promise<void> {
  const chromeExe = findChrome()
  const ffmpegExe = findFfmpeg()
  const tmp = mkdtempSync(join(tmpdir(), 'yura-film-'))
  const server = Bun.serve({ port: 0, development: false, routes: { '/': page, '/__script.json': Response.json(script) } })
  let chrome: ReturnType<typeof Bun.spawn> | undefined
  let connection: Cdp | undefined
  let encoder: ReturnType<typeof Bun.spawn> | undefined
  const cleanup = (): void => {
    try {
      connection?.close()
    } catch {}
    encoder?.kill()
    chrome?.kill()
    server.stop(true)
    rmSync(tmp, { recursive: true, force: true })
  }
  try {
    const launched = await launchChrome(chromeExe, join(tmp, 'profile'))
    chrome = launched.proc
    const cdp = await Cdp.open(launched.ws)
    connection = cdp
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true })
    const s = (method: string, params: Record<string, unknown> = {}) => cdp.send<Record<string, unknown>>(method, params, sessionId)
    // Keep the page's own errors: when a script is wrong, the page says why.
    const pageLog: string[] = []
    cdp.onEvent = (method, params) => {
      const p = params as { exceptionDetails?: { exception?: { description?: string }; text?: string }; type?: string; args?: { value?: unknown; description?: string }[] }
      if (method === 'Runtime.exceptionThrown') pageLog.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'exception')
      if (method === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'warning')) pageLog.push((p.args ?? []).map((a) => String(a.value ?? a.description ?? '')).join(' '))
    }
    await s('Runtime.enable')
    await s('Page.enable')
    await s('Emulation.setDeviceMetricsOverride', { width: plan.width, height: plan.height, deviceScaleFactor: 1, mobile: false })
    await s('Page.navigate', { url: `http://localhost:${server.port}/?export=1&script=/__script.json` })
    const evaluate = async (expression: string): Promise<unknown> => {
      const r = (await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })) as { result?: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
      return r.result?.value
    }
    const started = Date.now()
    while (!(await evaluate('window.__yuraFilm?.ready === true').catch(() => false))) {
      if (Date.now() - started > RESULT_TIMEOUT_MS) {
        const state = await evaluate('[document.readyState, "fonts " + document.fonts.status, "film " + !!document.querySelector("[data-yura-film]"), ...performance.getEntriesByType("resource").map((e) => e.name.slice(-40) + " " + e.responseStatus)].join(", ")').catch((e) => String(e))
        throw new Error(`The film page did not become ready (${state}).${pageLog.length ? `\n  page said:\n    ${pageLog.slice(-5).join('\n    ')}` : ''}`)
      }
      await Bun.sleep(200)
    }

    let wavPath: string | null = null
    if (audio) {
      const b64 = (await evaluate('window.__yuraFilm.wav()')) as string | null
      if (b64) {
        wavPath = join(tmp, 'soundtrack.wav')
        writeFileSync(wavPath, Buffer.from(b64, 'base64'))
      } else console.warn('  (no Web Audio in this Chrome — rendering without sound)')
    }

    const frames = Math.max(1, Math.round((to - from) * fps))
    const args = [ffmpegExe, '-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(fps), '-i', '-']
    if (wavPath) args.push('-ss', String(from), '-i', wavPath, '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-shortest')
    args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out)
    const ff = Bun.spawn(args, { stdin: 'pipe', stdout: 'inherit', stderr: 'inherit' })
    encoder = ff
    const t0 = Date.now()
    for (let i = 0; i < frames; i++) {
      const t = from + i / fps
      await evaluate(`window.__yuraFilm.render(${t})`)
      const shot = (await s('Page.captureScreenshot', { format: 'jpeg', quality, captureBeyondViewport: false, optimizeForSpeed: true })) as { data: string }
      ff.stdin.write(Buffer.from(shot.data, 'base64'))
      if (i % fps === 0 || i === frames - 1) {
        const pct = Math.round(((i + 1) / frames) * 100)
        process.stdout.write(`\r  rendering ${String(pct).padStart(3)}%  frame ${i + 1}/${frames}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`)
      }
    }
    ff.stdin.end()
    const code = await ff.exited
    encoder = undefined
    process.stdout.write('\n')
    if (code !== 0) throw new Error(`ffmpeg exited with ${code}`)
    const mb = (statSync(out).size / 1e6).toFixed(1)
    console.log(`  ✓ ${out}  (${plan.width}×${plan.height}, ${fps} fps, ${(to - from).toFixed(1)} s, ${mb} MB${wavPath ? ', with sound' : ''})`)
  } finally {
    cleanup()
  }
}

console.log(`yura film · ${basename(scriptPath)} · ${plan.scenes.length} scenes · ${plan.duration.toFixed(1)} s · look "${plan.lookName}" · ${plan.aspect}`)
main().catch((e) => {
  console.error(`\n  ✗ ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
