import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WEBGPU_REFERENCE, rewriteDts, rewriteDtsTree } from './rewrite-dts'

const CORE_ALIAS = { '@yura/core': '../../core/src/index' }

describe('rewriteDts: workspace alias rewrite', () => {
  test('@yura/core -> relative path (single quotes)', () => {
    expect(rewriteDts("import { Vec3 } from '@yura/core';\n", { aliases: CORE_ALIAS }))
      .toBe("import { Vec3 } from '../../core/src/index';\n")
  })

  test('double quotes and import() type positions are rewritten too', () => {
    const src = 'export declare const a: import("@yura/core").Vec3;\n'
    expect(rewriteDts(src, { aliases: CORE_ALIAS }))
      .toBe('export declare const a: import("../../core/src/index").Vec3;\n')
  })

  test('all three workspace packages', () => {
    const out = rewriteDts(
      "export * from '@yura/renderer-webgpu';\nexport * from '@yura/renderer-webgl';\n",
      {
        aliases: {
          '@yura/renderer-webgpu': '../../renderer-webgpu/src/index',
          '@yura/renderer-webgl': '../../renderer-webgl/src/index',
        },
      },
    )
    expect(out).toBe(
      "export * from '../../renderer-webgpu/src/index';\nexport * from '../../renderer-webgl/src/index';\n",
    )
  })

  test('unrelated specifiers are untouched', () => {
    const src = "import * as THREE from 'three';\n"
    expect(rewriteDts(src, { aliases: CORE_ALIAS })).toBe(src)
  })
})

describe('rewriteDts: TypedArray generic stripping', () => {
  test('Float32Array<ArrayBuffer> -> Float32Array', () => {
    expect(rewriteDts('declare const p: Float32Array<ArrayBuffer>;\n'))
      .toBe('declare const p: Float32Array;\n')
  })

  test('Uint32Array / Uint8Array with any identifier argument', () => {
    expect(rewriteDts('a: Uint32Array<ArrayBufferLike>, b: Uint8Array<ArrayBuffer>'))
      .toBe('a: Uint32Array, b: Uint8Array')
  })

  test('plain Float32Array and other identifiers stay as-is', () => {
    const src = 'a: Float32Array; b: MyFloat32Array<ArrayBuffer>;\n'
    expect(rewriteDts(src)).toBe(src)
  })
})

describe('rewriteDts: @webgpu/types reference insertion', () => {
  test('prepends the reference line when asked', () => {
    const out = rewriteDts('export declare const d: GPUDevice;\n', { insertReference: true })
    expect(out.startsWith(`${WEBGPU_REFERENCE}\n`)).toBe(true)
  })

  test('is idempotent', () => {
    const once = rewriteDts('export {};\n', { insertReference: true })
    const twice = rewriteDts(once, { insertReference: true })
    expect(twice).toBe(once)
    expect(twice.split(WEBGPU_REFERENCE).length - 1).toBe(1)
  })

  test('not inserted when option is off', () => {
    expect(rewriteDts('export {};\n')).toBe('export {};\n')
  })
})

describe('rewriteDtsTree: directory walk', () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'rewrite-dts-'))
    mkdirSync(join(root, 'yura/src'), { recursive: true })
    mkdirSync(join(root, 'core/src'), { recursive: true })
    mkdirSync(join(root, 'renderer-webgpu/src'), { recursive: true })
    writeFileSync(join(root, 'yura/src/index.d.ts'), "export * from '@yura/core';\n")
    writeFileSync(join(root, 'yura/src/three.d.ts'), "import type { Swarm } from '@yura/core';\nexport declare function yuraLayer(s: Swarm): void;\n")
    writeFileSync(join(root, 'core/src/index.d.ts'), 'export declare const pos: Float32Array<ArrayBuffer>;\n')
    writeFileSync(join(root, 'renderer-webgpu/src/index.d.ts'), "import { Swarm } from '@yura/core';\nexport declare const d: GPUDevice;\n")
    return root
  }

  test('three.d.ts (and every yura/src entry) gets the WebGPU reference', () => {
    const root = setup()
    rewriteDtsTree(root)
    const three = readFileSync(join(root, 'yura/src/three.d.ts'), 'utf8')
    const index = readFileSync(join(root, 'yura/src/index.d.ts'), 'utf8')
    expect(three.startsWith(`${WEBGPU_REFERENCE}\n`)).toBe(true)
    expect(index.startsWith(`${WEBGPU_REFERENCE}\n`)).toBe(true)
  })

  test('non-entry files get aliases/generics rewritten but no reference', () => {
    const root = setup()
    rewriteDtsTree(root)
    const webgpu = readFileSync(join(root, 'renderer-webgpu/src/index.d.ts'), 'utf8')
    const core = readFileSync(join(root, 'core/src/index.d.ts'), 'utf8')
    expect(webgpu).toContain("from '../../core/src/index'")
    expect(webgpu).not.toContain(WEBGPU_REFERENCE)
    expect(core).toBe('export declare const pos: Float32Array;\n')
  })

  test('relative paths are computed per file (yura/src -> core/src)', () => {
    const root = setup()
    rewriteDtsTree(root)
    const index = readFileSync(join(root, 'yura/src/index.d.ts'), 'utf8')
    expect(index).toContain("export * from '../../core/src/index';")
  })

  test('running the tree rewrite twice is a no-op', () => {
    const root = setup()
    rewriteDtsTree(root)
    const first = readFileSync(join(root, 'yura/src/three.d.ts'), 'utf8')
    const changed = rewriteDtsTree(root)
    expect(changed).toEqual([])
    expect(readFileSync(join(root, 'yura/src/three.d.ts'), 'utf8')).toBe(first)
  })
})
