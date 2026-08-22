/**
 * README drift guard — machine-checks that every ```ts / ```js fence in the
 * repo-root README still matches the real `yura` package, the same way
 * apps/playground/test/recipes.test.ts guards the playground recipes.
 *
 * Per snippet it asserts:
 *   1. the code transpiles with Bun.Transpiler (syntax errors = drift);
 *   2. every `import … from 'yura'` / `'yurayura'` (subpaths like
 *      'yura/three' included) names only bindings the real package entry
 *      actually exports;
 *   3. import-free fragments that lean on bare library vocabulary
 *      (`lyrics(app, …)`, `shapes.helix(…)`, `gameAudio()`) only use names
 *      that exist in the export table — unless an earlier snippet declared
 *      them (`app`, `scene`, `player` continue earlier examples) or they are
 *      ECMAScript/web builtins.
 *
 * Nothing is hardcoded to today's API: export tables are read from the
 * package sources through the package.json "exports" map, and the published
 * npm alias is read from scripts/build-npm.sh (the script that stamps it).
 */
import { test, expect, describe } from 'bun:test'

const transpiler = new Bun.Transpiler({ loader: 'ts' })

// ---------------------------------------------------------------------------
// Locate everything relative to THIS file — never via cwd or absolute paths.
// ---------------------------------------------------------------------------
const readmeUrl = new URL('../../../README.md', import.meta.url)
const pkgDirUrl = new URL('../', import.meta.url)
const readme = await Bun.file(readmeUrl.pathname).text()
const pkgJson = JSON.parse(await Bun.file(new URL('package.json', pkgDirUrl).pathname).text()) as {
  name: string
  module?: string
  exports?: Record<string, string | Record<string, string>>
}

// The published npm name is stamped into dist-npm by scripts/build-npm.sh —
// read it from there so a rename is picked up automatically. If the script
// ever disappears, the README is simply only allowed the workspace name.
const buildScript = Bun.file(new URL('../../../scripts/build-npm.sh', import.meta.url).pathname)
const npmAlias = (await buildScript.exists())
  ? /"name":\s*"([^"]+)"/.exec(await buildScript.text())?.[1]
  : undefined
const packageNames = new Set([pkgJson.name, ...(npmAlias ? [npmAlias] : [])])

// ---------------------------------------------------------------------------
// 1. Extract ```ts / ```js fences from the README.
// ---------------------------------------------------------------------------
interface Snippet {
  lang: string
  /** 1-based README line of the opening fence, for readable test names. */
  line: number
  code: string
}

const CODE_LANGS = new Set(['ts', 'tsx', 'js', 'jsx', 'typescript', 'javascript'])

function extractCodeFences(markdown: string): Snippet[] {
  const out: Snippet[] = []
  const lines = markdown.split('\n')
  let fence: { indent: string; lang: string; line: number; body: string[] } | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (fence === null) {
      const open = /^(\s*)```([A-Za-z0-9_-]*)\s*$/.exec(line)
      if (open) fence = { indent: open[1]!, lang: open[2]!.toLowerCase(), line: i + 1, body: [] }
      continue
    }
    if (/^\s*```\s*$/.test(line)) {
      if (CODE_LANGS.has(fence.lang)) {
        out.push({ lang: fence.lang, line: fence.line, code: fence.body.join('\n') })
      }
      fence = null
      continue
    }
    // Fences inside list items indent their body to the fence's own indent
    // (e.g. the gameAudio loop example) — strip exactly that prefix.
    fence.body.push(line.startsWith(fence.indent) ? line.slice(fence.indent.length) : line)
  }
  return out
}

const snippets = extractCodeFences(readme)

// ---------------------------------------------------------------------------
// 2. Lenient transpile.
//
// Strategy (deliberately forgiving, because README fences may be fragments
// that lean on surrounding prose): try the snippet verbatim first; if the
// parser rejects it, retry with the code wrapped in an async function body,
// which legalises fragment-only constructs (a bare `return`, `break`, an
// `await` mid-example, …). Only when BOTH parses fail do we surface the
// original error — so a genuine syntax error still fails the test.
// ---------------------------------------------------------------------------
function transpileLeniently(code: string): { ok: boolean; error?: unknown } {
  try {
    transpiler.transformSync(code)
    return { ok: true }
  } catch (raw) {
    try {
      transpiler.transformSync(`async function __readmeFragment__() {\n${code}\n}`)
      return { ok: true }
    } catch {
      return { ok: false, error: raw }
    }
  }
}

describe('README snippets transpile cleanly', () => {
  for (const snippet of snippets) {
    test(`README:${snippet.line} (${snippet.lang}) has no syntax errors`, () => {
      const result = transpileLeniently(snippet.code)
      if (!result.ok) throw result.error // surfaces Bun's own parse diagnostics
      expect(result.ok).toBe(true)
    })
  }
})

// ---------------------------------------------------------------------------
// 3. Export tables, read from the real package sources via package.json.
// ---------------------------------------------------------------------------
interface ExportTable {
  values: Set<string>
  types: Set<string>
}

/** Value + type exports of one package entry source file. The transpiler's
 *  scan() reports value exports only (it erases `export type`), so type-only
 *  exports are collected from the `export type` clauses by regex. */
async function exportTableOf(sourcePath: string): Promise<ExportTable> {
  const source = await Bun.file(sourcePath).text()
  const values = new Set(transpiler.scan(source).exports)
  const types = new Set<string>()
  for (const clause of source.matchAll(/export\s+type\s*\{([^}]*)\}/g)) {
    for (const entry of clause[1]!.split(',')) {
      // `orig as alias` re-exports expose the alias.
      const name = entry.trim().split(/\s+as\s+/).pop()?.trim()
      if (name) types.add(name)
    }
  }
  for (const decl of source.matchAll(/export\s+(?:declare\s+)?(?:type|interface)\s+([A-Za-z_$][\w$]*)/g)) {
    types.add(decl[1]!)
  }
  return { values, types }
}

// package.json "exports" → subpath → entry table. This package uses plain
// string targets; a conditional-exports object would take import/default.
const entrySources = new Map<string, string>()
if (pkgJson.exports) {
  for (const [subpath, entry] of Object.entries(pkgJson.exports)) {
    const target = typeof entry === 'string' ? entry : (entry.import ?? entry.default)
    if (target) entrySources.set(subpath, target)
  }
} else if (pkgJson.module) {
  entrySources.set('.', pkgJson.module)
}
const entryTables = new Map<string, ExportTable>()
for (const [subpath, rel] of entrySources) {
  entryTables.set(subpath, await exportTableOf(new URL(rel, pkgDirUrl).pathname))
}
const rootValues = entryTables.get('.')?.values ?? new Set<string>()

/** '.' or './sub' when the specifier targets this package under any of its
 *  names (workspace or npm alias), else null (relative/foreign imports are
 *  out of scope for this guard). */
function packageSubpath(specifier: string): string | null {
  for (const name of packageNames) {
    if (specifier === name) return '.'
    if (specifier.startsWith(name + '/')) return './' + specifier.slice(name.length + 1)
  }
  return null
}

// ---------------------------------------------------------------------------
// Import parsing (same approach as recipes.test.ts, extended with subpaths,
// `type` markers, and local-binding collection for the fragment check).
// ---------------------------------------------------------------------------
interface ImportDemand {
  specifier: string
  /** Named value bindings the package must export (original names). */
  values: string[]
  /** Type-only bindings (`import type {…}` or inline `type X`). */
  types: string[]
  needsDefault: boolean
  /** Every local name the import declares — context for later fragments. */
  locals: string[]
}

function parseImports(code: string): ImportDemand[] {
  const demands: ImportDemand[] = []
  const importRe = /import\s+([^'";]+?)\s+from\s*(['"])([^'"]+)\2/g
  for (const match of code.matchAll(importRe)) {
    let clause = match[1]!.trim()
    const demand: ImportDemand = {
      specifier: match[3]!,
      values: [],
      types: [],
      needsDefault: false,
      locals: [],
    }
    const wholeClauseTypeOnly = /^type\s/.test(clause)
    if (wholeClauseTypeOnly) clause = clause.replace(/^type\s+/, '')
    const braced = clause.match(/\{([\s\S]*?)\}/)
    if (braced) {
      for (const part of braced[1]!.split(',')) {
        let entry = part.trim()
        if (!entry) continue
        let typeOnly = wholeClauseTypeOnly
        if (/^type\s/.test(entry)) {
          typeOnly = true
          entry = entry.replace(/^type\s+/, '')
        }
        // `orig as local` — the package must export `orig`.
        const [orig, local] = entry.split(/\s+as\s+/).map((s) => s.trim())
        if (!orig) continue
        ;(typeOnly ? demand.types : demand.values).push(orig)
        demand.locals.push(local ?? orig)
      }
    }
    for (const part of clause.replace(/\{[\s\S]*?\}/, '').split(',')) {
      const p = part.trim()
      if (!p) continue
      if (p.startsWith('*')) {
        // namespace import: any module satisfies it
        const local = p.split(/\s+as\s+/)[1]?.trim()
        if (local) demand.locals.push(local)
        continue
      }
      demand.needsDefault = !wholeClauseTypeOnly
      demand.locals.push(p)
    }
    demands.push(demand)
  }
  return demands
}

const importsBySnippet = snippets.map((snippet) => parseImports(snippet.code))

describe('README imports name only real yura exports', () => {
  snippets.forEach((snippet, index) => {
    const demands = importsBySnippet[index]!.filter((d) => packageSubpath(d.specifier) !== null)
    if (demands.length === 0) return
    test(`README:${snippet.line} imports resolve against the package`, () => {
      const problems: string[] = []
      for (const demand of demands) {
        const subpath = packageSubpath(demand.specifier)!
        const table = entryTables.get(subpath)
        if (!table) {
          problems.push(`'${demand.specifier}' is not a package entry (no "${subpath}" in package.json exports)`)
          continue
        }
        for (const name of demand.values.filter((n) => !table.values.has(n))) {
          problems.push(`'${demand.specifier}' does not export value '${name}'`)
        }
        // A type binding may resolve to either a type or a value export
        // (classes are both), hence the union.
        for (const name of demand.types.filter((n) => !table.types.has(n) && !table.values.has(n))) {
          problems.push(`'${demand.specifier}' does not export type '${name}'`)
        }
        if (demand.needsDefault && !table.values.has('default')) {
          problems.push(`'${demand.specifier}' has no default export`)
        }
      }
      expect(problems).toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------
// 4. Bare library vocabulary in import-free fragments.
// ---------------------------------------------------------------------------

/** Replace string literals and comments with spaces so identifier regexes do
 *  not fire inside them. Lenient simplifications, each erring toward NOT
 *  failing the test: template literals are stripped whole (including `${…}`
 *  interiors), and regex literals are not modeled — the README currently
 *  contains neither. */
function stripStringsAndComments(code: string): string {
  let out = ''
  let i = 0
  while (i < code.length) {
    const ch = code[i]!
    const next = code[i + 1]
    if (ch === '/' && next === '/') {
      const nl = code.indexOf('\n', i)
      const stop = nl === -1 ? code.length : nl
      out += ' '.repeat(stop - i)
      i = stop
      continue
    }
    if (ch === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2)
      const stop = end === -1 ? code.length : end + 2
      out += code.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1
      while (j < code.length && code[j] !== ch) j += code[j] === '\\' ? 2 : 1
      const stop = Math.min(j + 1, code.length)
      out += code.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
      continue
    }
    out += ch
    i++
  }
  return out
}

const JS_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'return', 'function', 'class', 'extends', 'super', 'this', 'new', 'delete', 'typeof',
  'instanceof', 'in', 'of', 'void', 'yield', 'await', 'async', 'const', 'let', 'var',
  'import', 'export', 'from', 'as', 'try', 'catch', 'finally', 'throw', 'with',
  'get', 'set', 'static', 'true', 'false', 'null', 'undefined', 'type', 'interface',
  'satisfies', 'keyof',
])

/** ECMAScript + ubiquitous web-platform globals a README fragment may use
 *  freely. A fixed, documented list — deliberately NOT probed from
 *  globalThis, so the verdict never depends on the runtime the test happens
 *  to execute in. */
const AMBIENT_GLOBALS = new Set([
  'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'Date', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'Promise', 'Proxy',
  'Reflect', 'Intl', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'AggregateError',
  'NaN', 'Infinity', 'globalThis', 'console', 'window', 'document', 'navigator',
  'performance', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout',
  'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'structuredClone',
  'fetch', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'AbortController',
  'Event', 'CustomEvent', 'crypto', 'localStorage', 'sessionStorage',
])

/** Identifiers a snippet declares itself: const/let/var/function/class names,
 *  destructuring patterns, arrow-function parameters, catch bindings. An
 *  over-approximation (object keys inside patterns count too) — safe, because
 *  "declared" only ever excuses a name from the check. */
function declaredIdentifiers(strippedCode: string): Set<string> {
  const declared = new Set<string>()
  for (const m of strippedCode.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
    declared.add(m[1]!)
  }
  for (const m of strippedCode.matchAll(/\b(?:const|let|var)\s*(\{[^}]*\}|\[[^\]]*\])/g)) {
    for (const id of m[1]!.matchAll(/[A-Za-z_$][\w$]*/g)) declared.add(id[0])
  }
  for (const m of strippedCode.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const part of m[1]!.split(',')) {
      const id = /[A-Za-z_$][\w$]*/.exec(part)
      if (id) declared.add(id[0])
    }
  }
  for (const m of strippedCode.matchAll(/(?<![\w$).\]])([A-Za-z_$][\w$]*)\s*=>/g)) declared.add(m[1]!)
  for (const m of strippedCode.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) declared.add(m[1]!)
  return declared
}

/** Identifiers used as `name(…)` or `name.…` heads — the positions in which
 *  README fragments lean on library vocabulary (`lyrics(app, …)`,
 *  `shapes.helix(…)`). Names merely mentioned as data are not checked. */
function vocabularyHeads(strippedCode: string): Set<string> {
  const used = new Set<string>()
  for (const m of strippedCode.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*[(.]/g)) {
    if (!JS_KEYWORDS.has(m[1]!)) used.add(m[1]!)
  }
  return used
}

// Context accumulated across snippets in document order: later fragments
// legitimately continue earlier examples (`app` from the lyrics example,
// `scene`/`player` from the game), so anything an earlier snippet declared —
// including its import bindings — is ambient for the ones after it.
const contextBeforeSnippet: Set<string>[] = []
{
  const context = new Set<string>()
  snippets.forEach((snippet, index) => {
    contextBeforeSnippet.push(new Set(context))
    for (const id of declaredIdentifiers(stripStringsAndComments(snippet.code))) context.add(id)
    for (const demand of importsBySnippet[index]!) for (const local of demand.locals) context.add(local)
  })
}

describe('bare library vocabulary in import-free fragments exists', () => {
  snippets.forEach((snippet, index) => {
    // Snippets WITH imports are covered by the import check above, and their
    // remaining free identifiers (`renderer`, `camera`, …) are explicitly
    // "your code" per the prose — only import-free fragments are vocabulary.
    if (importsBySnippet[index]!.length > 0) return
    test(`README:${snippet.line} fragment uses only real vocabulary`, () => {
      const stripped = stripStringsAndComments(snippet.code)
      const declared = declaredIdentifiers(stripped)
      const context = contextBeforeSnippet[index]!
      const unresolved = [...vocabularyHeads(stripped)].filter(
        (name) =>
          !declared.has(name) &&
          !context.has(name) &&
          !AMBIENT_GLOBALS.has(name) &&
          !rootValues.has(name),
      )
      // Anything left is package vocabulary that no longer exists (rename or
      // removal drift) or a typo — either way the README went stale.
      expect(unresolved).toEqual([])
    })
  })
})

// ---------------------------------------------------------------------------
// Guards against silent rot of the guard itself (mirrors recipes.test.ts).
// ---------------------------------------------------------------------------
describe('the README guard itself still bites', () => {
  test('the README contains ts/js fences', () => {
    expect(snippets.length).toBeGreaterThan(0)
  })
  test('the package export table is non-empty', () => {
    expect(rootValues.size).toBeGreaterThan(0)
  })
  test('the import parser sees yura imports in the README', () => {
    const demanded = importsBySnippet.flat().filter((d) => packageSubpath(d.specifier) !== null)
    expect(demanded.length).toBeGreaterThan(0)
  })
  test('at least one import-free fragment is vocabulary-checked', () => {
    expect(importsBySnippet.some((demands) => demands.length === 0)).toBe(true)
  })
})
