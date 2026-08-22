#!/usr/bin/env bun
/**
 * Rewrite the .d.ts tree emitted for the npm build so dist-npm/types is
 * self-contained and the rewrite is portable (pure Bun/TS — replaces the
 * BSD-`sed -i ''` pipeline that only worked on macOS).
 *
 * Usage: bun scripts/rewrite-dts.ts <typesDir>   # e.g. dist-npm/types
 *
 * What it does to every *.d.ts under <typesDir>:
 *   - `@yura/*` workspace specifiers -> relative paths into the copied tree
 *     (computed per file, so nesting depth doesn't matter)
 *   - `Float32Array<ArrayBuffer>` etc. -> plain `Float32Array`; the generic
 *     TypedArray form needs TS >= 5.7 in consumers, while the plain form
 *     types identically for practical use and works on older compilers
 *   - `/// <reference types="@webgpu/types" />` prepended (idempotently) to
 *     every entry module of the published package (yura/src/*.d.ts), not
 *     just index.d.ts — so a consumer importing only `yurayura/three` still
 *     gets the GPU* ambient types and tsc doesn't fall over on GPUDevice.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

export const WEBGPU_REFERENCE = '/// <reference types="@webgpu/types" />'

export interface RewriteOptions {
  /** Bare specifier -> replacement path, applied wherever the specifier appears quoted. */
  aliases?: Record<string, string>
  /** Prepend the @webgpu/types reference line (idempotent). */
  insertReference?: boolean
}

const TYPED_ARRAYS = ['Float32Array', 'Uint32Array', 'Uint8Array']

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Pure rewrite of one declaration file's content. */
export function rewriteDts(content: string, opts: RewriteOptions = {}): string {
  let out = content
  for (const [from, to] of Object.entries(opts.aliases ?? {})) {
    out = out.replace(
      new RegExp(`(['"])${escapeRegExp(from)}\\1`, 'g'),
      (_m, q: string) => `${q}${to}${q}`,
    )
  }
  for (const name of TYPED_ARRAYS) {
    out = out.replace(new RegExp(`\\b${name}<[A-Za-z]*>`, 'g'), name)
  }
  if (opts.insertReference && !out.includes(WEBGPU_REFERENCE)) {
    out = `${WEBGPU_REFERENCE}\n${out}`
  }
  return out
}

/** Workspace package -> entry module location inside the copied types tree. */
const WORKSPACE_ENTRIES: Record<string, string> = {
  '@yura/core': 'core/src/index',
  '@yura/renderer-webgpu': 'renderer-webgpu/src/index',
  '@yura/renderer-webgl': 'renderer-webgl/src/index',
}

/** Entry modules of the published package: every top-level yura/src/*.d.ts
 *  (index, three, and any future subpath export) gets the WebGPU reference. */
const PACKAGE_ENTRY_RE = /^yura\/src\/[^/]+\.d\.ts$/

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (p.endsWith('.d.ts')) yield p
  }
}

const toPosix = (p: string) => p.split(sep).join('/')

/** Rewrite every .d.ts under typesDir in place; returns the changed files. */
export function rewriteDtsTree(typesDir: string): string[] {
  const changed: string[] = []
  for (const file of walk(typesDir)) {
    const aliases: Record<string, string> = {}
    for (const [pkg, entry] of Object.entries(WORKSPACE_ENTRIES)) {
      let rel = toPosix(relative(dirname(file), join(typesDir, entry)))
      if (!rel.startsWith('.')) rel = `./${rel}`
      aliases[pkg] = rel
    }
    const insertReference = PACKAGE_ENTRY_RE.test(toPosix(relative(typesDir, file)))
    const before = readFileSync(file, 'utf8')
    const after = rewriteDts(before, { aliases, insertReference })
    if (after !== before) {
      writeFileSync(file, after)
      changed.push(file)
    }
  }
  return changed
}

if (import.meta.main) {
  const dir = process.argv[2]
  if (!dir) {
    console.error('usage: bun scripts/rewrite-dts.ts <typesDir>')
    process.exit(1)
  }
  const changed = rewriteDtsTree(dir)
  console.log(`rewrite-dts: rewrote ${changed.length} file(s) under ${dir}`)
}
