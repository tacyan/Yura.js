import { test, expect, describe } from 'bun:test'
import { motions, kineticMoods, identityPose, composePose, type MotionGlyph } from '../src/motions'
import { poseToStyle, planKinetic } from '../src/kinetic'
import { LIGHT_ENTER, LIGHT_HOLD, LIGHT_EXIT } from '../src/motions-light'
import { WATER_ENTER, WATER_HOLD, WATER_EXIT } from '../src/motions-water'
import { KINETIC_ENTER, KINETIC_HOLD, KINETIC_EXIT, KINETIC_LAYOUT } from '../src/motions-kinetic'
import { ring, drift, bump, smooth } from '../src/motion-kit'
import {
  OCEAN_WAVES,
  OCEAN_MAX_HEIGHT,
  oceanHeight,
  oceanGLSL,
  hexToRgb,
  bubbleLayout,
  bubbleAt,
  BUBBLE_SPAN,
  shaftLayout,
  curtainLayout,
  CAUSTIC_GLSL,
} from '../src/stage-world-light'
import { cameraAt, CAMERA_FOV, CAMERA_DISTANCE } from '../src/stage-motion'

const glyph = (i: number, n: number, seed = 7): MotionGlyph => ({ i, n, seed, char: '光', rank: n <= 1 ? 0 : i / (n - 1) })

describe('light channels on the pose', () => {
  test('brightness multiplies and hue adds; both serialise into the filter chain', () => {
    const p = composePose(composePose(identityPose(), { bright: 2, hue: 30 }), { bright: 1.5, hue: -10, blur: 0.1 })
    expect(p.bright).toBe(3)
    expect(p.hue).toBe(20)
    expect(poseToStyle(p).filter).toBe('blur(0.1em) brightness(3) hue-rotate(20deg)')
    expect(poseToStyle(identityPose()).filter).toBe('none')
  })

  test('non-finite or negative light collapses safely; hand-built poses without the fields still render', () => {
    expect(poseToStyle({ ...identityPose(), bright: NaN, hue: Infinity }).filter).toBe('none')
    expect(poseToStyle({ ...identityPose(), bright: -2 }).filter).toBe('brightness(0)')
    const legacy = { ...identityPose() } as Record<string, unknown>
    delete legacy.bright
    delete legacy.hue
    expect(poseToStyle(legacy as never).filter).toBe('none')
  })
})

describe('recipe packs', () => {
  const core = (phase: keyof typeof motions, pack: object) => Object.keys(pack).filter((k) => !(k in motions[phase]) || motions[phase][k as never] !== (pack as Record<string, unknown>)[k])

  test('every pack recipe is registered as itself (no pack silently overrides the core or another pack)', () => {
    const packs: [keyof typeof motions, object][] = [
      ['enter', LIGHT_ENTER],
      ['enter', WATER_ENTER],
      ['enter', KINETIC_ENTER],
      ['hold', LIGHT_HOLD],
      ['hold', WATER_HOLD],
      ['hold', KINETIC_HOLD],
      ['exit', LIGHT_EXIT],
      ['exit', WATER_EXIT],
      ['exit', KINETIC_EXIT],
      ['layout', KINETIC_LAYOUT],
    ]
    for (const [phase, pack] of packs) expect({ phase, clashes: core(phase, pack) }).toEqual({ phase, clashes: [] })
    const total = packs.reduce((n, [, p]) => n + Object.keys(p).length, 0)
    const all = Object.values(motions).reduce((n, r) => n + Object.keys(r).length, 0)
    expect(all).toBeGreaterThanOrEqual(total + 76) // the 76 core recipes stay
  })

  test('the vocabulary is at least three times the original size', () => {
    expect(Object.keys(motions.enter).length).toBeGreaterThanOrEqual(90)
    expect(Object.keys(motions.hold).length).toBeGreaterThanOrEqual(50)
    expect(Object.keys(motions.exit).length).toBeGreaterThanOrEqual(65)
    expect(Object.keys(motions.layout).length).toBeGreaterThanOrEqual(25)
  })

  test('light recipes actually carry light: every light entrance brightens or glows on the way in', () => {
    for (const [name, r] of Object.entries(LIGHT_ENTER)) {
      let lit = false
      for (let k = 1; k < 20 && !lit; k++) {
        const p = composePose(identityPose(), r.pose(k / 20, glyph(1, 3)))
        lit = p.bright > 1.05 || p.glow > 0.02 || Math.abs(p.hue) > 1 || p.split > 0.01
      }
      expect({ name, lit }).toEqual({ name, lit: true })
    }
  })

  test('every new mood can plan a whole song and stays inside its palette', () => {
    const song = ['君の声が', '夜を照らす', '光の中で', 'もう一度', '水面に', '揺れる']
    for (const mood of ['luminous', 'aqua', 'spectrum', 'kinetic', 'cinematic', 'dream', 'eerie', 'mapping'] as const) {
      const m = kineticMoods[mood]
      for (let seed = 1; seed <= 6; seed++) {
        for (const line of planKinetic(song, { mood, seed })) {
          expect((m.enter as readonly string[]).includes(line.enter)).toBe(true)
          expect((m.exit as readonly string[]).includes(line.exit)).toBe(true)
        }
      }
    }
  })
})

describe('motion kit', () => {
  test('ring settles to exactly zero at both ends; bump and smooth stay in 0..1', () => {
    for (const c of [0.5, 1, 2.5]) {
      expect(ring(0, c)).toBe(0)
      expect(ring(1, c)).toBe(0)
      expect(ring(NaN, c)).toBe(0)
    }
    for (let k = 0; k <= 40; k++) {
      const v = k / 40
      expect(bump(v)).toBeGreaterThanOrEqual(0)
      expect(bump(v)).toBeLessThanOrEqual(1)
      expect(smooth(0.2, 0.8, v)).toBeGreaterThanOrEqual(0)
      expect(smooth(0.2, 0.8, v)).toBeLessThanOrEqual(1)
      expect(Math.abs(drift(v * 100, 3, 1))).toBeLessThanOrEqual(1)
    }
  })
})

describe('ocean', () => {
  test('height stays within the sum of amplitudes and is a pure function of (x, z, t)', () => {
    for (let k = 0; k < 500; k++) {
      const h = oceanHeight(k * 1.7 - 400, k * 0.9 - 200, k * 0.13)
      expect(Math.abs(h)).toBeLessThanOrEqual(OCEAN_MAX_HEIGHT + 1e-12)
    }
    expect(oceanHeight(3, 4, 5)).toBe(oceanHeight(3, 4, 5))
    expect(oceanHeight(NaN, 0, 0)).toBe(0)
    expect(oceanHeight(0, 0, Infinity)).toBe(0)
  })

  test('the vertex shader is generated from the same wave table (GLSL and TS cannot drift)', () => {
    const glsl = oceanGLSL()
    expect(glsl.match(/h \+= /g)).toHaveLength(OCEAN_WAVES.length)
    for (const w of OCEAN_WAVES) expect(glsl).toContain(`h += ${Number.isInteger(w.amp) ? `${w.amp}.0` : w.amp} * sin(ph);`)
    // Every float literal is a GLSL float (a bare integer would not compile in GLSL ES 1.0 arithmetic with floats).
    for (const lit of glsl.match(/[^\w.]\d+(?![\w.])/g) ?? []) expect(lit).toBe('never a bare integer literal')
  })

  test('caustic GLSL uses only constant loop bounds (GLSL ES 1.0)', () => {
    expect(CAUSTIC_GLSL).toContain('for (int y = -1; y <= 1; y++)')
    expect(/for \(int \w+ = [^;]+; \w+ <[=]? [a-zA-Z_]/.test(CAUSTIC_GLSL)).toBe(false)
  })
})

describe('layouts for bubbles, shafts and curtains', () => {
  test('bubbles rise and wrap inside their span; the reading column stays clear', () => {
    const bubbles = bubbleLayout(5)
    for (const b of bubbles) {
      if (b.z > -8) expect(Math.abs(b.x)).toBeGreaterThanOrEqual(7)
      for (const t of [0, 3.3, 100, NaN]) {
        const p = bubbleAt(b, t)
        expect(p.y).toBeGreaterThanOrEqual(-9)
        expect(p.y).toBeLessThanOrEqual(-9 + BUBBLE_SPAN)
        expect(Number.isFinite(p.x)).toBe(true)
      }
    }
    expect(bubbleLayout(5)).toEqual(bubbleLayout(5))
  })

  test('shafts fan symmetrically; curtains recede into depth', () => {
    const s = shaftLayout(1)
    expect(s[0].spin).toBeLessThan(0)
    expect(s[s.length - 1].spin).toBeGreaterThan(0)
    const c = curtainLayout(1)
    for (let i = 1; i < c.length; i++) expect(c[i].z).toBeLessThan(c[i - 1].z)
  })

  test('hex colours parse to sRGB floats; junk is black', () => {
    expect(hexToRgb('#ff8000')).toEqual([1, 128 / 255, 0])
    expect(hexToRgb('#fff')).toEqual([1, 1, 1])
    expect(hexToRgb('var(--x)')).toEqual([0, 0, 0])
  })
})

describe('new camera moves', () => {
  test('vertigo keeps the lyric plane framed: tan(fov/2)·distance is constant', () => {
    const rest = Math.tan(((CAMERA_FOV / 2) * Math.PI) / 180) * CAMERA_DISTANCE
    for (const u of [0, 0.25, 0.5, 0.9, 1]) {
      const c = cameraAt('vertigo', u, u * 4)
      expect(Math.tan(((c.fov / 2) * Math.PI) / 180) * c.z).toBeCloseTo(rest, 9)
    }
    expect(cameraAt('vertigo', 0, 0).z).not.toBeCloseTo(cameraAt('vertigo', 1, 4).z, 3)
  })

  test('surface-break rises from below to the text; ascend looks up', () => {
    expect(cameraAt('surface-break', 0, 0).y).toBeLessThan(-4)
    expect(cameraAt('surface-break', 1, 3).y).toBeCloseTo(0, 9)
    expect(cameraAt('ascend', 1, 3).ty).toBeGreaterThan(3)
  })
})
