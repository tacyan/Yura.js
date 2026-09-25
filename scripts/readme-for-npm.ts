#!/usr/bin/env bun
/**
 * Make the README work on npmjs.com (and any other place it is rendered away
 * from the repository), where relative links resolve to nothing.
 *
 * Usage: bun scripts/readme-for-npm.ts <in> <out> <repoUrl> <ref>
 *   e.g. bun scripts/readme-for-npm.ts README.md dist-npm/README.md \
 *          https://github.com/tacyan/Yura.js v0.3.0
 *
 * - Images `![alt](path)` → raw file URLs, so GIFs and screenshots display.
 * - Links `[text](path)` → the file's page on GitHub.
 * - Both are pinned to <ref> (the release tag), so a published version keeps
 *   showing the media and docs it shipped with even after main moves on.
 * - Absolute URLs, in-page anchors (#...) and mailto: are left untouched.
 * - Import specifiers are rewritten from the workspace name to the published
 *   one (`from 'yura'` → `from 'yurayura'`, subpaths included).
 */
import { readFileSync, writeFileSync } from 'node:fs'

export interface NpmReadmeOptions {
  /** https://github.com/<owner>/<repo> (a trailing .git or slash is tolerated). */
  repoUrl: string
  /** Git ref the links are pinned to — normally the release tag. */
  ref: string
  /** Workspace package name → published name. */
  rename?: { from: string; to: string }
}

const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i

/** The repository's base URL without `.git` or a trailing slash. (Pure.) */
export function repoBase(url: string): string {
  return url.replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/+$/, '')
}

/** Rewrites one README for publishing. (Pure.) */
export function readmeForNpm(markdown: string, opts: NpmReadmeOptions): string {
  const base = repoBase(opts.repoUrl)
  const raw = base.replace('https://github.com/', 'https://raw.githubusercontent.com/')
  const fix = (target: string, image: boolean): string => {
    if (ABSOLUTE.test(target)) return target
    const clean = target.replace(/^\.\//, '')
    return image ? `${raw}/${opts.ref}/${clean}` : `${base}/blob/${opts.ref}/${clean}`
  }
  let out = markdown.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (_m, bang: string, text: string, target: string, title = '') =>
    `${bang}[${text}](${fix(target, bang === '!')}${title})`,
  )
  // HTML <img src="..."> in the README (tables, badges written as HTML).
  out = out.replace(/(<img\b[^>]*\bsrc=")([^"]+)(")/g, (_m, pre: string, src: string, post: string) => `${pre}${fix(src, true)}${post}`)
  if (opts.rename) {
    const { from, to } = opts.rename
    const spec = new RegExp(`(from\\s+['"])${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}((?:/[\\w-]+)?['"])`, 'g')
    out = out.replace(spec, `$1${to}$2`)
  }
  return out
}

if (import.meta.main) {
  const [input, output, repoUrl, ref] = process.argv.slice(2)
  if (!input || !output || !repoUrl || !ref) {
    console.error('usage: bun scripts/readme-for-npm.ts <in> <out> <repoUrl> <ref>')
    process.exit(2)
  }
  const md = readFileSync(input, 'utf8')
  writeFileSync(output, readmeForNpm(md, { repoUrl, ref, rename: { from: 'yura', to: 'yurayura' } }))
}
