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
