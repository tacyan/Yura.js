/**
 * Regression tests for the playground RECIPES (code strings).
 *
 * Recipes are shipped as raw source strings, so a syntax error introduced
 * while editing one would previously only surface at runtime in the browser.
 * These tests transpile every recipe at test time and cross-check every
 * `import ... from 'yura'` binding against the real exports of
 * packages/yura/src/index.ts (derived dynamically — nothing hardcoded),
 * so a renamed/removed API immediately flags the stale recipe.
 *
 * Deliberately NOT covered here (already asserted via the served HTML in
 * server.test.ts): recipe count and the presence of specific labels.
 */
import { test, expect, describe } from 'bun:test'
import { RECIPES } from '../server'

const transpiler = new Bun.Transpiler({ loader: 'ts' })

/** Local bindings a recipe pulls from the bare 'yura' specifier, mapped to
 * the export name each one requires ('default' for a default import;
 * namespace imports need no particular export and are skipped). */
function requiredYuraExports(code: string): string[] {
  const required: string[] = []
  const importRe = /import\s+([^'"]+?)\s+from\s*(['"])yura\2/g
  for (const match of code.matchAll(importRe)) {
    const clause = match[1]
    const braced = clause.match(/\{([\s\S]*?)\}/)
    if (braced) {
      for (const part of braced[1].split(',')) {
        // `orig as local` — the package must export `orig`.
        const name = part.trim().split(/\s+as\s+/)[0]?.trim()
        if (name) required.push(name)
      }
    }
    for (const part of clause.replace(/\{[\s\S]*?\}/, '').split(',')) {
      const p = part.trim()
      if (!p) continue
      if (p.startsWith('*')) continue // namespace import: any module satisfies it
      required.push('default') // default import needs a default export
    }
  }
  return required
}

describe('playground recipes transpile cleanly', () => {
  for (const recipe of RECIPES) {
    test(`recipe "${recipe.label}" has no syntax errors`, () => {
      // transformSync throws an AggregateError of parse errors on bad input.
      expect(() => transpiler.transformSync(recipe.code)).not.toThrow()
    })
  }
})

const indexPath = new URL('../../../packages/yura/src/index.ts', import.meta.url).pathname
const indexSource = await Bun.file(indexPath).text()
// Actual value exports, read from the package entry itself — never hardcoded.
const yuraExports = new Set(transpiler.scan(indexSource).exports)

describe('recipe imports exist in the real yura package', () => {
  test('the yura index parses and exports something', () => {
    expect(yuraExports.size).toBeGreaterThan(0)
  })

  test('the import parser sees the recipe imports (guards against silent regex rot)', () => {
    expect(RECIPES.flatMap((r) => requiredYuraExports(r.code)).length).toBeGreaterThan(0)
  })

  for (const recipe of RECIPES) {
    test(`recipe "${recipe.label}" imports only existing yura exports`, () => {
      const missing = requiredYuraExports(recipe.code).filter((name) => !yuraExports.has(name))
      expect(missing).toEqual([])
    })
  }
})
