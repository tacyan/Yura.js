#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, sep } from 'node:path'
import { createHash } from 'node:crypto'
import type { BunPlugin } from 'bun'

const root = resolve(import.meta.dir, '..')
const out = join(root, 'dist')
const comparisonOut = join(out, 'comparison')
const args = process.argv.slice(2)
const baseIndex = args.indexOf('--base')
const base = baseIndex < 0 ? 'v0.3.1' : args[baseIndex + 1]
if (!base || base.startsWith('-')) throw new Error('--base requires a Git revision')
function git(...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd: root })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout
}
const commit = git('rev-parse', '--verify', `${base}^{commit}`).toString().trim()
const snapshot = mkdtempSync(join(tmpdir(), 'yura-compare-'))
const entries: Record<string, string> = {
  yura: 'packages/yura/src/index.ts',
  '@yura/core': 'packages/core/src/index.ts',
  '@yura/renderer-webgl': 'packages/renderer-webgl/src/index.ts',
  '@yura/renderer-webgpu': 'packages/renderer-webgpu/src/index.ts',
}
function revisionPlugin(sourceRoot: string): BunPlugin {
  return { name: 'isolated-yura-revision', setup(build) {
    build.onResolve({ filter: /^(yura|@yura\/[^/]+)$/ }, ({ path }) => {
      if (!entries[path]) throw new Error(`Unexpected workspace import: ${path}`)
      return { path: join(sourceRoot, entries[path]) }
    })
  } }
}
const shell = (bundle: string) => `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>余白に、生命を。</title><style>html,body{margin:0;width:100%;height:100%;background:#071325;color:#eff5ff;font-family:'Yu Mincho','Hiragino Mincho ProN',serif}#stage{position:absolute;inset:0;overflow:hidden}#error{position:absolute;inset:auto 20px 20px;font:12px/1.8 sans-serif}</style><body><div id="stage" aria-label="余白に、生命を。ひかりが、ほどける。また、生まれる。"></div><p id="error" role="status"></p><script type="module" src="./${bundle}"></script></body></html>`
async function build(entry: string, destination: string, sourceRoot?: string) {
  const result = await Bun.build({ entrypoints: [entry], outdir: destination, target: 'browser', minify: true, sourcemap: 'none', plugins: sourceRoot ? [revisionPlugin(sourceRoot)] : [] })
  if (!result.success) throw new AggregateError(result.logs, `Build failed: ${entry}`)
  return result
}

try {
  // Materialise only tracked source blobs, without touching the user's checkout.
  const files = git('ls-tree', '-r', '--name-only', '-z', commit, '--', 'packages').toString().split('\0').filter((path) => path.includes('/src/'))
  for (const path of files) {
    const destination = join(snapshot, path)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, git('show', `${commit}:${path}`))
  }
  mkdirSync(comparisonOut, { recursive: true })
  await build(join(root, 'examples/comparison/index.html'), comparisonOut)
  const preview = join(root, 'examples/comparison/preview.ts')
  const reports: Record<string, unknown> = {}
  for (const [side, sourceRoot] of [['before', snapshot], ['after', root]] as const) {
    const destination = join(comparisonOut, side)
    await build(preview, destination, sourceRoot)
    writeFileSync(join(comparisonOut, `${side}.html`), shell(`${side}/preview.js`))
    // Verify every brief against each actual revision, before offering the sample.
    const auditEntry = join(snapshot, 'audit.ts')
    writeFileSync(auditEntry, `export { direction } from ${JSON.stringify(join(root, 'examples/comparison/direction.ts'))}; export { planStage, framePoses } from 'yura';`)
    const audit = await Bun.build({ entrypoints: [auditEntry], outdir: join(snapshot, `audit-${side}`), target: 'bun', plugins: [revisionPlugin(sourceRoot)] })
    if (!audit.success) throw new AggregateError(audit.logs, 'Comparison audit build failed')
    const { direction, planStage, framePoses } = await import(audit.outputs[0].path)
    reports[side] = Object.fromEntries(['water', 'light', 'kinetic'].map((key) => {
      const result = direction(key)
      const plan = planStage(result.lines, result.options)
      if (plan.lines.some((line: { start: number }, i: number) => line.start !== i * 4)) throw new Error(`${side}/${key}: timeline mismatch`)
      for (let frame = 0; frame <= 120; frame++) {
        for (const line of plan.lines) {
          for (const pose of framePoses(line, frame / 10, 120) ?? []) {
            for (const value of Object.values(pose).flat()) {
              if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${side}/${key}: non-finite glyph pose`)
            }
          }
        }
      }
      return [key, { selected: result.selected, counts: result.counts }]
    }))
  }
  const sourceFiles = ['preview.ts', 'direction.ts', 'briefs.ts']
  const hash = createHash('sha256')
  for (const file of sourceFiles) hash.update(await Bun.file(join(root, 'examples/comparison', file)).text())
  const version = JSON.parse(git('show', `${commit}:packages/yura/package.json`).toString()).version
  writeFileSync(join(comparisonOut, 'provenance.json'), JSON.stringify({ baselineCommit: commit, baselineVersion: version, entryHash: hash.digest('hex'), reports }, null, 2))
  await build(join(root, 'examples/atelier/index.html'), join(out, 'atelier'))
  console.log(`比較ビルド完了: v${version} (${commit.slice(0, 8)}) / 現在の作業コード`)
  console.log(JSON.stringify(reports, null, 2))
} finally {
  rmSync(snapshot, { recursive: true, force: true })
}

if (!args.includes('--build-only')) {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const url = new URL(request.url)
    const path = decodeURIComponent(url.pathname === '/' ? '/comparison/index.html' : url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname)
    const filePath = resolve(out, `.${path}`)
    if (!filePath.startsWith(`${out}${sep}`)) return new Response('Forbidden', { status: 403 })
    const file = Bun.file(filePath)
    return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 })
  } })
  console.log(`比較サンプル: http://127.0.0.1:${server.port}/comparison/`)
  console.log(`光のアトリエ: http://127.0.0.1:${server.port}/atelier/`)
}
