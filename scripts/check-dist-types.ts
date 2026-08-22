#!/usr/bin/env bun
/**
 * Consumer smoke test for the published `yurayura` type definitions.
 *
 * Usage: bun scripts/check-dist-types.ts [distNpmDir]   # default: dist-npm
 *
 * After build-npm.sh assembles dist-npm/, this script synthesizes minimal
 * consumer projects in an OS temp directory and runs `tsc --noEmit`:
 *
 *   import { yura, looks, shapes, eases, gameAudio } from 'yurayura'
 *   import { yuraLayer } from 'yurayura/three'
 *
 * Each exported subpath is checked as a SEPARATE tsc program: ambient types
 * pulled in by one entry's reference directives (e.g. index.d.ts referencing
 * @webgpu/types) must not mask their absence on another entry — exactly how
 * a consumer importing only `yurayura/three` once broke.
 *
 * The consumer's tsconfig maps each specifier through `paths` to the exact
 * file named by the `types` condition of the corresponding `exports` entry
 * in dist-npm/package.json — so the mapping is derived from the real
 * manifest, never hardcoded, and no node_modules copy is needed. With
 * `skipLibCheck: false` the whole shipped .d.ts tree is type-checked, which
 * catches breakage like a missing `@webgpu/types` reference on a subpath
 * entry (the historical `yurayura/three` failure mode).
 *
 * The `/// <reference types="@webgpu/types" />` directives inside the
 * shipped d.ts resolve via tsc's secondary lookup from the containing file,
 * i.e. through this repo's node_modules — the same topology a real consumer
 * has after `npm install yurayura`.
 *
 * Exit code: 0 when the consumer type-checks; tsc's non-zero code otherwise.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** One entry of a package.json `exports` map. */
export type ExportsEntry = string | { [condition: string]: ExportsEntry }

/** The `types` target of one exports entry (falls back to import/default). */
export function typesTarget(entry: ExportsEntry): string | undefined {
  if (typeof entry === 'string') return entry
  for (const condition of ['types', 'import', 'default']) {
    const nested = entry[condition]
    if (nested !== undefined) return typesTarget(nested)
  }
  return undefined
}

/**
 * Build a tsconfig `paths` map from a package.json, so every subpath the
 * package exports resolves to the shipped declaration file for that subpath.
 * Values are absolute paths into `distNpmDir`.
 */
export function pathsFromExports(
  pkg: { name: string; exports?: Record<string, ExportsEntry> },
  distNpmDir: string,
): Record<string, string[]> {
  if (!pkg.exports) throw new Error(`${pkg.name}: package.json has no "exports" map`)
  const paths: Record<string, string[]> = {}
  for (const [subpath, entry] of Object.entries(pkg.exports)) {
    if (!subpath.startsWith('.') || subpath.includes('*')) continue
    const target = typesTarget(entry)
    if (!target) throw new Error(`${pkg.name}: exports["${subpath}"] has no types/default target`)
    const specifier = subpath === '.' ? pkg.name : pkg.name + subpath.slice(1)
    paths[specifier] = [resolve(distNpmDir, target)]
  }
  return paths
}

/** Named values each exported subpath must provide to consumers. Subpaths
 *  not listed here are smoke-tested with a namespace import. */
export const SMOKE_IMPORTS: Record<string, string[]> = {
  '.': [
    'yura',
    'YuraApp',
    'YuraScene',
    'looks',
    'shapes',
    'eases',
    'gameAudio',
    'formatStats',
    'FrameRing',
    'noteToFreq',
    'layoutColumns',
    'CODES',
    'MAX_ATTRACTORS',
    'DEFAULT_ATTRACTOR_RADIUS',
  ],
  './three': ['yuraLayer'],
}

/** Extra consumer statements per subpath that USE the shipped types the way
 *  an app would — game types, the eases table, morphTo/morphNow, gravityWell,
 *  audio and layout helpers. `%SPEC%` is replaced with the import specifier.
 *  This only has to type-check (noEmit); it never runs. */
export const SMOKE_USAGE: Record<string, string[]> = {
  '.': [
    `import type { GameSetup, EaseName, EaseFn, MorphNowOptions, YuraStats, ColumnPlacement } from '%SPEC%'`,
    `const setup: GameSetup = (scene) => {`,
    `  const release = scene.gravityWell([0, 1.5, 0], 12, DEFAULT_ATTRACTOR_RADIUS)`,
    `  release()`,
    `}`,
    `const easeName: EaseName = 'linear'`,
    `const easeFn: EaseFn = eases[easeName]`,
    `const eased: number = easeFn(0.5)`,
    `const morphOpts: MorphNowOptions = {}`,
    `export function smokeMorphTo(app: YuraApp): YuraApp {`,
    `  return app.morphTo([shapes.galaxy(), 'YURA'])`,
    `}`,
    `export function smokeMorphNow(app: YuraApp): Promise<YuraApp> {`,
    `  return app.morphNow(shapes.helix(), morphOpts)`,
    `}`,
    `const stats: YuraStats = {`,
    `  backend: 'webgpu',`,
    `  fps: 60,`,
    `  frameMs: 16.7,`,
    `  particles: 1_000_000,`,
    `  requestedParticles: 1_000_000,`,
    `  resolutionScale: 1,`,
    `  qualityLevel: 3,`,
    `}`,
    `const statsLine: string = formatStats(stats)`,
    `const ring = new FrameRing(8)`,
    `ring.push(16.7)`,
    `const freq: number = noteToFreq('A4')`,
    `const columns: ColumnPlacement[] = layoutColumns([2, 2], 1, 0.5, 'center', 10)`,
    `const wellCap: number = MAX_ATTRACTORS`,
    `const noWebGPU: string = CODES.NO_WEBGPU`,
    `export const smokeUsage = { setup, eased, statsLine, ring, freq, columns, wellCap, noWebGPU }`,
  ],
}

/** Source of one synthetic consumer module. Imports the subpath's surface
 *  and re-exports the values so nothing can be elided as unused; optional
 *  usage lines exercise the shipped types as real consumer code. */
export function consumerSource(specifier: string, names?: string[], usage?: string[]): string {
  const lines = names?.length
    ? [
        `import { ${names.join(', ')} } from '${specifier}'`,
        '',
        `export const smoke = { ${names.join(', ')} }`,
      ]
    : [`import * as ns from '${specifier}'`, '', 'export const smoke = ns']
  if (usage?.length) {
    lines.push('', ...usage.map((line) => line.replaceAll('%SPEC%', specifier)))
  }
  return `${lines.join('\n')}\n`
}

/** tsconfig for the synthetic consumer (strict, full lib check, no ambient
 *  types beyond what the shipped d.ts pulls in via reference directives). */
export function consumerTsconfig(paths: Record<string, string[]>): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        types: [],
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        paths,
      },
      files: ['main.ts'],
    },
    null,
    2,
  )
}

/** Locate the TypeScript compiler installed in this repo (no network). */
function tscCommand(tsconfigPath: string): string[] {
  try {
    const tscJs = Bun.resolveSync('typescript/lib/tsc.js', repoRoot)
    return [process.execPath, tscJs, '-p', tsconfigPath, '--pretty', 'false']
  } catch {
    return [process.execPath, 'x', 'tsc', '-p', tsconfigPath, '--pretty', 'false']
  }
}

/** Synthesize the consumer in a temp dir, type-check it, clean up. */
export function checkDistTypes(distNpmDir: string): number {
  const pkgJsonPath = join(distNpmDir, 'package.json')
  if (!existsSync(pkgJsonPath)) {
    console.error(`check-dist-types: ${pkgJsonPath} not found — run \`bun run build:npm\` first`)
    return 1
  }
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
    name: string
    exports?: Record<string, ExportsEntry>
  }
  const paths = pathsFromExports(pkg, distNpmDir)
  for (const [specifier, [target]] of Object.entries(paths)) {
    if (!existsSync(target!)) {
      console.error(`check-dist-types: '${specifier}' types file missing: ${target}`)
      return 1
    }
  }

  const tmp = mkdtempSync(join(tmpdir(), 'yura-check-dist-types-'))
  try {
    let failed = 0
    for (const [index, specifier] of Object.keys(paths).entries()) {
      const subpath = specifier === pkg.name ? '.' : `.${specifier.slice(pkg.name.length)}`
      const dir = join(tmp, `consumer-${index}`)
      mkdirSync(dir)
      writeFileSync(
        join(dir, 'main.ts'),
        consumerSource(specifier, SMOKE_IMPORTS[subpath], SMOKE_USAGE[subpath]),
      )
      const tsconfigPath = join(dir, 'tsconfig.json')
      writeFileSync(tsconfigPath, consumerTsconfig(paths))

      const proc = Bun.spawnSync(tscCommand(tsconfigPath), {
        cwd: repoRoot,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const out = `${proc.stdout.toString()}${proc.stderr.toString()}`.trim()
      if (proc.exitCode !== 0) {
        failed++
        console.error(`check-dist-types: '${specifier}' FAILED consumer type-check:`)
        if (out) console.error(out)
      } else {
        console.log(`check-dist-types: OK — '${specifier}' type-checks for consumers`)
      }
    }
    return failed === 0 ? 0 : 1
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const distNpmDir = resolve(repoRoot, process.argv[2] ?? 'dist-npm')
  process.exit(checkDistTypes(distNpmDir))
}
