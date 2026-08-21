import { test, expect } from 'bun:test'
import { meshes } from '../src/meshes'

for (const name of ['sphere', 'box', 'plane', 'disc', 'torus', 'cylinder', 'torusKnot'] as const) {
  test(`${name} mesh is well-formed`, () => {
    const g = meshes[name]()
    const vertCount = g.positions.length / 3
    expect(vertCount).toBeGreaterThan(2)
    expect(g.normals.length).toBe(vertCount * 3)
    expect(g.uvs.length).toBe(vertCount * 2)
    expect(g.indices.length % 3).toBe(0)
    for (let i = 0; i < g.indices.length; i++) {
      expect(g.indices[i]).toBeLessThan(vertCount)
    }
    for (let i = 0; i < g.positions.length; i++) {
      expect(Number.isFinite(g.positions[i])).toBe(true)
    }
  })
}

test('sphere normals are unit length', () => {
  const g = meshes.sphere(2)
  for (let i = 0; i < 60; i += 3) {
    const l = Math.hypot(g.normals[i], g.normals[i + 1], g.normals[i + 2])
    expect(Math.abs(l - 1)).toBeLessThan(1e-4)
  }
})
