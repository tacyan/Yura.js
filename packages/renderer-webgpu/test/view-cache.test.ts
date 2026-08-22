import { test, expect } from 'bun:test'
import { ViewCache, getZeroScratch, type ViewSource } from '../src/view-cache'

/** Fake GPUTexture that records how many views it has created. */
class FakeTexture implements ViewSource<{ id: number; owner: FakeTexture }> {
  createViewCalls = 0
  createView() {
    this.createViewCalls++
    return { id: this.createViewCalls, owner: this }
  }
}

test('same generation: view is created once and the same instance is reused', () => {
  const cache = new ViewCache<{ id: number; owner: FakeTexture }>()
  const tex = new FakeTexture()

  const v1 = cache.getView(tex)
  const v2 = cache.getView(tex)
  const v3 = cache.getView(tex)

  expect(tex.createViewCalls).toBe(1)
  expect(v2).toBe(v1)
  expect(v3).toBe(v1)
})

test('invalidate advances the generation: next get re-creates the view', () => {
  const cache = new ViewCache<{ id: number; owner: FakeTexture }>()
  const tex = new FakeTexture()

  const before = cache.getView(tex)
  expect(tex.createViewCalls).toBe(1)

  cache.invalidate()

  const after = cache.getView(tex)
  expect(tex.createViewCalls).toBe(2)
  expect(after).not.toBe(before)

  // And the re-created view is cached again within the new generation.
  expect(cache.getView(tex)).toBe(after)
  expect(tex.createViewCalls).toBe(2)
})

test('different textures get independent entries', () => {
  const cache = new ViewCache<{ id: number; owner: FakeTexture }>()
  const texA = new FakeTexture()
  const texB = new FakeTexture()

  const viewA = cache.getView(texA)
  const viewB = cache.getView(texB)

  expect(viewA).not.toBe(viewB)
  expect(viewA.owner).toBe(texA)
  expect(viewB.owner).toBe(texB)
  expect(texA.createViewCalls).toBe(1)
  expect(texB.createViewCalls).toBe(1)

  // Repeat gets stay per-texture, no cross-talk.
  expect(cache.getView(texA)).toBe(viewA)
  expect(cache.getView(texB)).toBe(viewB)
  expect(texA.createViewCalls).toBe(1)
  expect(texB.createViewCalls).toBe(1)
})

test('getZeroScratch returns the same instance for repeat lengths and grows only when needed', () => {
  const a = getZeroScratch(64)
  const b = getZeroScratch(64)
  expect(b).toBe(a)

  // Smaller request reuses the existing (larger) scratch.
  const c = getZeroScratch(16)
  expect(c).toBe(a)
  expect(c.length).toBeGreaterThanOrEqual(16)

  // Larger request grows the scratch; subsequent equal request reuses it.
  const d = getZeroScratch(a.length + 1)
  expect(d).not.toBe(a)
  expect(d.length).toBeGreaterThanOrEqual(a.length + 1)
  expect(getZeroScratch(a.length + 1)).toBe(d)
})

test('getZeroScratch is all zeroes at every size', () => {
  for (const len of [1, 7, 64, 1024]) {
    const s = getZeroScratch(len)
    expect(s.length).toBeGreaterThanOrEqual(len)
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== 0) throw new Error(`non-zero at index ${i}: ${s[i]}`)
    }
  }
})
