import { test, expect } from 'bun:test'
import { readmeForNpm, repoBase } from './readme-for-npm'

const opts = { repoUrl: 'git+https://github.com/o/r.git', ref: 'v1.2.3', rename: { from: 'yura', to: 'yurayura' } }

test('relative images become raw URLs pinned to the tag', () => {
  expect(readmeForNpm('![a](docs/x.gif)', opts)).toBe('![a](https://raw.githubusercontent.com/o/r/v1.2.3/docs/x.gif)')
  expect(readmeForNpm('| ![a](./docs/y.jpg) |', opts)).toBe('| ![a](https://raw.githubusercontent.com/o/r/v1.2.3/docs/y.jpg) |')
  expect(readmeForNpm('<img src="docs/z.png" alt="">', opts)).toBe('<img src="https://raw.githubusercontent.com/o/r/v1.2.3/docs/z.png" alt="">')
})

test('relative links become GitHub pages pinned to the tag; titles survive', () => {
  expect(readmeForNpm('[guide](docs/SITE.md)', opts)).toBe('[guide](https://github.com/o/r/blob/v1.2.3/docs/SITE.md)')
  expect(readmeForNpm('[e](docs/ERRORS.md#yura-019 "codes")', opts)).toBe('[e](https://github.com/o/r/blob/v1.2.3/docs/ERRORS.md#yura-019 "codes")')
})

test('absolute URLs, anchors and mailto are untouched', () => {
  const md = '[a](https://x.y/z) [b](#install) [c](mailto:a@b.c) [![CI](https://s/badge.svg)](https://gh/ci)'
  expect(readmeForNpm(md, opts)).toBe(md)
})

test('import specifiers move to the published name, subpaths included, nothing else', () => {
  const md = "import { yura } from 'yura'\nimport { yuraLayer } from \"yura/three\"\nconst s = 'yura'\nfrom 'yuraish'"
  expect(readmeForNpm(md, opts)).toBe("import { yura } from 'yurayura'\nimport { yuraLayer } from \"yurayura/three\"\nconst s = 'yura'\nfrom 'yuraish'")
})

test('repo URLs are normalised', () => {
  expect(repoBase('git+https://github.com/o/r.git')).toBe('https://github.com/o/r')
  expect(repoBase('https://github.com/o/r/')).toBe('https://github.com/o/r')
})

test('the real README has no relative link left after the rewrite', async () => {
  const md = await Bun.file(new URL('../README.md', import.meta.url).pathname).text()
  const out = readmeForNpm(md, opts)
  const relative = [...out.matchAll(/!?\[[^\]]*\]\(([^)\s]+)/g)].map((m) => m[1]).filter((u) => !/^(https?:|#|mailto:)/.test(u))
  expect(relative).toEqual([])
  expect(out).not.toMatch(/from ['"]yura['"/]/)
})

/**
 * READMEs already on npm (0.1.0, 0.2.0) link these images with relative
 * paths, which npm resolves against the repository's default branch — not a
 * tag. Deleting any of them breaks those published pages for good (it
 * happened once, when the README media was replaced). From 0.3.0 on, links
 * are pinned to the release tag, so only this legacy list needs guarding.
 */
const LEGACY_PUBLISHED_ASSETS = [
  // 0.1.0 / 0.2.0 (relative links → default branch)
  'docs/screenshots/showcase-galaxy-1m.jpg',
  'docs/screenshots/three-interop.jpg',
  'docs/screenshots/lyric-motion.jpg',
  'docs/screenshots/showcase-hello-morph.jpg',
  'docs/screenshots/showcase-shockwave-hud.jpg',
  'docs/screenshots/showcase-webgl2-vortex.jpg',
  'docs/screenshots/bench-results.jpg',
  // 0.3.0 media — pinned to the v0.3.0 tag on npm, but the repository README
  // on GitHub shows them from the default branch, so they must stay too.
  'docs/screenshots/hero-sakura.gif',
  'docs/screenshots/stage-synthwave.gif',
  'docs/screenshots/stage-noir.gif',
  'docs/screenshots/stage-cosmos.jpg',
  'docs/screenshots/stage-tunnel.jpg',
  'docs/screenshots/stage-shards.jpg',
  'docs/screenshots/stage-orbit.jpg',
  'docs/screenshots/site-story.jpg',
  'docs/screenshots/site-tracks.jpg',
  'docs/screenshots/gallery-themes.jpg',
  'docs/screenshots/gallery-motions.jpg',
]

test('assets linked by already-published READMEs are never deleted', async () => {
  for (const path of LEGACY_PUBLISHED_ASSETS) {
    expect({ path, exists: await Bun.file(new URL(`../${path}`, import.meta.url).pathname).exists() }).toEqual({ path, exists: true })
  }
})

test('every image the README shows exists in the repository (GIFs included)', async () => {
  const md = await Bun.file(new URL('../README.md', import.meta.url).pathname).text()
  const local = [...md.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g), ...md.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(u))
  expect(local.length).toBeGreaterThan(0)
  for (const path of local) {
    expect({ path, exists: await Bun.file(new URL(`../${path.replace(/^\.\//, '')}`, import.meta.url).pathname).exists() }).toEqual({ path, exists: true })
  }
})
