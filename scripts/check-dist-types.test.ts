import { describe, expect, test } from 'bun:test'
import { sep } from 'node:path'
import {
  SMOKE_IMPORTS,
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
    expect(SMOKE_IMPORTS['.']).toEqual(['yura', 'looks', 'shapes', 'eases', 'gameAudio'])
    expect(SMOKE_IMPORTS['./three']).toEqual(['yuraLayer'])
  })

  test('imports the named surface and re-exports it so nothing is elided', () => {
    const src = consumerSource('yurayura', SMOKE_IMPORTS['.'])
    expect(src).toContain("import { yura, looks, shapes, eases, gameAudio } from 'yurayura'")
    expect(src).toContain('export const smoke = { yura, looks, shapes, eases, gameAudio }')
    const three = consumerSource('yurayura/three', SMOKE_IMPORTS['./three'])
    expect(three).toContain("import { yuraLayer } from 'yurayura/three'")
    expect(three).toContain('export const smoke = { yuraLayer }')
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
