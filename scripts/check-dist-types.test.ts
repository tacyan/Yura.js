import { describe, expect, test } from 'bun:test'
import { sep } from 'node:path'
import {
  SMOKE_IMPORTS,
  SMOKE_USAGE,
  consumerSource,
  consumerTsconfig,
  pathsFromExports,
  typesTarget,
} from './check-dist-types'

describe('typesTarget', () => {
  test('string entry is its own target', () => {
    expect(typesTarget('./dist/index.js')).toBe('./dist/index.js')
  })

  test('prefers the types condition and recurses into nested conditions', () => {
    expect(typesTarget({ types: './t.d.ts', default: './i.js' })).toBe('./t.d.ts')
    expect(typesTarget({ import: { types: './t.d.ts' }, default: './i.js' })).toBe('./t.d.ts')
  })

  test('falls back to default, undefined when nothing matches', () => {
    expect(typesTarget({ default: './i.js' })).toBe('./i.js')
    expect(typesTarget({ require: './i.cjs' })).toBeUndefined()
  })
})

describe('pathsFromExports', () => {
  const pkg = {
    name: 'yurayura',
    exports: {
      '.': { types: './types/yura/src/index.d.ts', default: './dist/index.js' },
      './three': { types: './dist/three.d.ts', default: './dist/three.js' },
    },
  }

  test('maps every exported subpath to its types file under distNpmDir', () => {
    const paths = pathsFromExports(pkg, `${sep}repo${sep}dist-npm`)
    expect(Object.keys(paths).sort()).toEqual(['yurayura', 'yurayura/three'])
    expect(paths['yurayura']![0]!.split(sep)).toEqual(
      ['', 'repo', 'dist-npm', 'types', 'yura', 'src', 'index.d.ts'].filter((s, i) => i === 0 || s !== ''),
    )
    expect(paths['yurayura/three']![0]!.endsWith(`${sep}dist-npm${sep}dist${sep}three.d.ts`)).toBe(true)
  })

  test('skips wildcard subpaths, throws without exports or types target', () => {
    const withWildcard = { name: 'p', exports: { './*': './dist/*.js', '.': './i.d.ts' } }
    expect(Object.keys(pathsFromExports(withWildcard, sep))).toEqual(['p'])
    expect(() => pathsFromExports({ name: 'p' }, sep)).toThrow('no "exports"')
    expect(() => pathsFromExports({ name: 'p', exports: { '.': { require: './i.cjs' } } }, sep)).toThrow(
      'no types/default target',
    )
  })
})

describe('synthetic consumer', () => {
  test('covers the root and /three surfaces required of the published package', () => {
    const root = SMOKE_IMPORTS['.']!
    // The original surface plus the night APIs must all be smoke-imported.
    for (const name of [
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
    ]) {
      expect(root).toContain(name)
    }
    expect(new Set(root).size).toBe(root.length)
    expect(SMOKE_IMPORTS['./three']).toEqual(['yuraLayer'])
  })

  test('every root smoke import and usage name is a real export of the source entry', async () => {
    const indexPath = new URL('../packages/yura/src/index.ts', import.meta.url).pathname
    const source = await Bun.file(indexPath).text()
    const scanned = new Set(new Bun.Transpiler({ loader: 'ts' }).scan(source).exports)
    const typeExports = new Set<string>()
    for (const clause of source.matchAll(/export\s+type\s*\{([^}]*)\}/g)) {
      for (const entry of clause[1]!.split(',')) {
        const name = entry.trim().split(/\s+as\s+/).pop()?.trim()
        if (name) typeExports.add(name)
      }
    }
    expect(SMOKE_IMPORTS['.']!.filter((n) => !scanned.has(n))).toEqual([])
    // Types consumed by the usage block must be exported types of the entry.
    const usageTypeImport = SMOKE_USAGE['.']!.find((l) => l.startsWith('import type'))!
    const usedTypes = usageTypeImport
      .slice(usageTypeImport.indexOf('{') + 1, usageTypeImport.indexOf('}'))
      .split(',')
      .map((n) => n.trim())
    expect(usedTypes.length).toBeGreaterThan(0)
    expect(usedTypes.filter((n) => !typeExports.has(n))).toEqual([])
  })

  test('usage block consumes the night APIs as real consumer code', () => {
    const usage = SMOKE_USAGE['.']!.join('\n')
    expect(usage).toContain('GameSetup')
    expect(usage).toContain('gravityWell(')
    expect(usage).toContain('morphTo(')
    expect(usage).toContain('morphNow(')
    expect(usage).toContain('eases[')
    expect(usage).toContain('noteToFreq(')
    expect(usage).toContain('formatStats(')
    expect(usage).toContain('layoutColumns(')
  })

  test('imports the named surface and re-exports it so nothing is elided', () => {
    const rootNames = SMOKE_IMPORTS['.']!
    const src = consumerSource('yurayura', rootNames)
    expect(src).toContain(`import { ${rootNames.join(', ')} } from 'yurayura'`)
    expect(src).toContain(`export const smoke = { ${rootNames.join(', ')} }`)
    const three = consumerSource('yurayura/three', SMOKE_IMPORTS['./three'])
    expect(three).toContain("import { yuraLayer } from 'yurayura/three'")
    expect(three).toContain('export const smoke = { yuraLayer }')
  })

  test('usage lines are appended with %SPEC% resolved to the specifier', () => {
    const src = consumerSource('yurayura', SMOKE_IMPORTS['.'], SMOKE_USAGE['.'])
    expect(src).toContain("import type { GameSetup, EaseName, EaseFn, MorphNowOptions, YuraStats, ColumnPlacement } from 'yurayura'")
    expect(src).not.toContain('%SPEC%')
    expect(src).toContain('export const smokeUsage')
  })

  test('unknown subpaths fall back to a namespace import', () => {
    const src = consumerSource('yurayura/future')
    expect(src).toContain("import * as ns from 'yurayura/future'")
    expect(src).toContain('export const smoke = ns')
  })

  test('tsconfig is strict, checks shipped d.ts fully, and carries the paths map', () => {
    const cfg = JSON.parse(consumerTsconfig({ yurayura: ['/x/index.d.ts'] }))
    expect(cfg.compilerOptions.skipLibCheck).toBe(false)
    expect(cfg.compilerOptions.strict).toBe(true)
    expect(cfg.compilerOptions.noEmit).toBe(true)
    expect(cfg.compilerOptions.types).toEqual([])
    expect(cfg.compilerOptions.paths).toEqual({ yurayura: ['/x/index.d.ts'] })
    expect(cfg.files).toEqual(['main.ts'])
  })
})
