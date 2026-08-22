import { test, expect } from 'bun:test'
import {
  reducedMotionPolicy,
  drainCleanups,
  resetSceneHandles,
  FixedStepAccumulator,
  SCENE_FIXED_DT,
  SCENE_MAX_STEPS,
  clampCanvasSize,
  FALLBACK_MAX_TEXTURE_DIM,
  watchDprChanges,
  type DprMediaQuery,
} from '../src/app'
import { YuraScene, type SceneObject } from '../src/scene'

// These tests cover the pure/headless halves of the app-level fixes:
//  - the reduced-motion policy (a frozen game loop was the bug),
//  - cleanup draining on device-loss recovery (listener accumulation),
//  - scene mesh-handle reset on device-loss recovery (blank canvas).
// The DOM/GPU halves (overlay rendering, actual re-registration on a fresh
// GPUDevice) can only be verified in a browser.

// ---- reducedMotionPolicy ----

test('reduced motion never stops the scene game loop, only idle sway', () => {
  const p = reducedMotionPolicy('scene', true)
  expect(p.runLoop).toBe(true)
  expect(p.idleSway).toBe(false)
})

test('reduced motion settles decorative modes to a static frame', () => {
  expect(reducedMotionPolicy('particles', true)).toEqual({ runLoop: false, idleSway: false })
  expect(reducedMotionPolicy('model', true)).toEqual({ runLoop: false, idleSway: false })
})

test('without reduced motion every mode runs with idle sway', () => {
  for (const mode of ['particles', 'model', 'scene'] as const) {
    expect(reducedMotionPolicy(mode, false)).toEqual({ runLoop: true, idleSway: true })
  }
})

// ---- drainCleanups ----

test('drainCleanups runs every cleanup exactly once and returns an empty list', () => {
  const calls: number[] = []
  const list = [() => calls.push(1), () => calls.push(2), () => calls.push(3)]
  const next = drainCleanups(list)
  expect(calls).toEqual([1, 2, 3])
  expect(next).toEqual([])
  expect(list).toEqual([]) // input is emptied, not just copied
})

test('a throwing cleanup does not block the rest', () => {
  const calls: string[] = []
  const next = drainCleanups([
    () => calls.push('a'),
    () => {
      throw new Error('broken teardown')
    },
    () => calls.push('c'),
  ])
  expect(calls).toEqual(['a', 'c'])
  expect(next).toEqual([])
})

test('draining is idempotent: a second drain (or re-entrant drain) fires nothing twice', () => {
  let count = 0
  const list: Array<() => void> = []
  // Re-entrant case: a cleanup that drains the same list mid-flight.
  list.push(() => {
    count++
    drainCleanups(list)
  })
  list.push(() => count++)
  drainCleanups(list)
  expect(count).toBe(2) // each cleanup ran exactly once
  drainCleanups(list) // second drain of the now-empty list
  expect(count).toBe(2)
})

// ---- resetSceneHandles ----

function fakeHandle(removed: { n: number }): NonNullable<SceneObject['handle']> {
  return {
    remove: () => {
      removed.n++
    },
  } as unknown as NonNullable<SceneObject['handle']>
}

test('resetSceneHandles nulls handle and shadowHandle on every live object', () => {
  const scene = new YuraScene({})
  const removed = { n: 0 }
  const a = scene.add('sphere', { radius: 0.5, position: [0, 0, 0] })
  const b = scene.add('box', { size: 1, position: [2, 0, 0], tag: 'crate' })
  a.handle = fakeHandle(removed)
  a.shadowHandle = fakeHandle(removed)
  b.handle = fakeHandle(removed)

  resetSceneHandles(scene)

  expect(a.handle).toBeNull()
  expect(a.shadowHandle).toBeNull()
  expect(b.handle).toBeNull()
  expect(b.shadowHandle).toBeNull()
  // Handles into a lost device are dead — reset must NOT call remove() on them.
  expect(removed.n).toBe(0)
})

test('resetSceneHandles tolerates a missing scene', () => {
  expect(() => resetSceneHandles(null)).not.toThrow()
})

// --- fixed-timestep accumulator (scene physics, LOW #18) ---

test('steady 60fps yields exactly one tick per frame with no drift', () => {
  const acc = new FixedStepAccumulator()
  for (let i = 0; i < 600; i++) {
    expect(acc.advance(1 / 60)).toBe(1)
  }
  expect(acc.remainder).toBeLessThan(SCENE_FIXED_DT)
})

test('sub-30fps frames run multiple fixed ticks instead of slow motion', () => {
  const acc = new FixedStepAccumulator()
  // 20fps: each rendered frame owes exactly three 1/60s sim ticks.
  expect(acc.advance(3 / 60)).toBe(3)
  expect(acc.advance(3 / 60)).toBe(3)
  expect(acc.remainder).toBeLessThan(1e-6)
})

test('fractional remainders carry across frames (144fps-style small dts)', () => {
  const acc = new FixedStepAccumulator()
  expect(acc.advance(1 / 120)).toBe(0)
  expect(acc.remainder).toBeCloseTo(1 / 120, 9)
  expect(acc.advance(1 / 120)).toBe(1)
  expect(acc.remainder).toBeLessThan(1e-6)
  // Sim time consumed equals real time fed in: 2 * (1/120) = 1 * (1/60).
})

test('a dt spike is clamped, capped at SCENE_MAX_STEPS, and the excess is dropped', () => {
  const acc = new FixedStepAccumulator()
  // A 2s stall (tab switch) first clamps to 0.25s = 15 owed ticks, then the
  // step cap keeps only 5 and discards the rest — no catch-up spiral.
  expect(acc.advance(2)).toBe(SCENE_MAX_STEPS)
  expect(acc.remainder).toBe(0)
  // Next normal frame is back to a single tick.
  expect(acc.advance(1 / 60)).toBe(1)
})

test('exactly at the step cap the fractional remainder is kept, past it dropped', () => {
  const at = new FixedStepAccumulator()
  expect(at.advance(5.5 / 60)).toBe(5) // 5 ticks == cap, not past it
  expect(at.remainder).toBeCloseTo(0.5 / 60, 9)
  const past = new FixedStepAccumulator()
  expect(past.advance(6.5 / 60)).toBe(5) // 6 owed > cap: run 5, drop the rest
  expect(past.remainder).toBe(0)
})

test('negative dt is ignored and custom step parameters are honoured', () => {
  const acc = new FixedStepAccumulator(0.1, 2, 0.5)
  expect(acc.advance(-1)).toBe(0) // backwards rAF timestamp: no ticks
  expect(acc.remainder).toBe(0)
  expect(acc.advance(0.35)).toBe(2) // 3 owed at 0.1s/step > cap 2: drop rest
  expect(acc.remainder).toBe(0)
  expect(acc.advance(0.15)).toBe(1)
  expect(acc.remainder).toBeCloseTo(0.05, 9)
  acc.reset()
  expect(acc.remainder).toBe(0)
})

// --- canvas size clamping to the device texture limit (LOW #19) ---

test('clampCanvasSize passes sizes within the device limit through unchanged', () => {
  expect(clampCanvasSize(1920, 1080, 8192)).toEqual({ width: 1920, height: 1080 })
  expect(clampCanvasSize(0, 0, 8192)).toEqual({ width: 0, height: 0 })
})

test('clampCanvasSize scales oversized canvases down preserving aspect ratio', () => {
  expect(clampCanvasSize(16384, 8192, 8192)).toEqual({ width: 8192, height: 4096 })
  const r = clampCanvasSize(10000, 5000, 4096)
  expect(r.width).toBe(4096)
  expect(r.height).toBeCloseTo(2048, 6)
  // Both axes over the limit: the longest edge lands exactly on it.
  const both = clampCanvasSize(20000, 12000, 8192)
  expect(Math.max(both.width, both.height)).toBe(8192)
  expect(both.width / both.height).toBeCloseTo(20000 / 12000, 6)
  // Default fallback limit applies when no device is available to ask.
  expect(clampCanvasSize(FALLBACK_MAX_TEXTURE_DIM + 1, 1).width).toBe(FALLBACK_MAX_TEXTURE_DIM)
})

// --- DPR change watcher re-registration bookkeeping ---

interface FakeMql extends DprMediaQuery {
  query: string
  listeners: Array<() => void>
  fire(): void
}

function fakeMediaEnv(initialDpr: number) {
  const created: FakeMql[] = []
  const env = {
    dpr: initialDpr,
    created,
    matchMedia(query: string): DprMediaQuery {
      const mql: FakeMql = {
        query,
        listeners: [],
        addEventListener(_type, listener) {
          mql.listeners.push(listener)
        },
        removeEventListener(_type, listener) {
          mql.listeners = mql.listeners.filter((l) => l !== listener)
        },
        fire() {
          for (const l of [...mql.listeners]) l()
        },
      }
      created.push(mql)
      return mql
    },
  }
  return env
}

test('watchDprChanges registers against the current dpr and re-registers on change', () => {
  const env = fakeMediaEnv(2)
  let changes = 0
  watchDprChanges((q) => env.matchMedia(q), () => env.dpr, () => changes++)

  expect(env.created).toHaveLength(1)
  expect(env.created[0].query).toBe('(resolution: 2dppx)')
  expect(env.created[0].listeners).toHaveLength(1)

  // Drag to a 1.5x monitor: the (resolution: 2dppx) query stops matching.
  env.dpr = 1.5
  env.created[0].fire()

  expect(changes).toBe(1)
  expect(env.created[0].listeners).toHaveLength(0) // stale listener removed
  expect(env.created).toHaveLength(2) // fresh registration...
  expect(env.created[1].query).toBe('(resolution: 1.5dppx)') // ...at the NEW dpr
  expect(env.created[1].listeners).toHaveLength(1)
})

test('disposing the dpr watcher removes the live listener and stops re-registration', () => {
  const env = fakeMediaEnv(1)
  let changes = 0
  const stop = watchDprChanges((q) => env.matchMedia(q), () => env.dpr, () => changes++)

  env.dpr = 2
  env.created[0].fire()
  expect(changes).toBe(1)
  expect(env.created).toHaveLength(2)

  stop()
  expect(env.created[1].listeners).toHaveLength(0)
  // A straggler event after dispose must neither fire onChange nor re-register.
  env.created[1].fire()
  expect(changes).toBe(1)
  expect(env.created).toHaveLength(2)
})

test('after a reset, attach() would re-realize: realize() only skips non-null handles', () => {
  // Mirrors scene.realize()'s guard (`if (!renderer || obj.handle) return`):
  // a nulled handle is exactly what makes re-registration happen. Verified
  // here structurally; the real re-registration needs a GPU device.
  const scene = new YuraScene({})
  const obj = scene.add('sphere', { radius: 1 })
  obj.handle = fakeHandle({ n: 0 })
  resetSceneHandles(scene)
  expect(obj.handle).toBeNull() // realize()'s skip-condition is cleared
})

import { clickAimDelta } from '../src/app'

test('clickAimDelta: center click does not move the camera', () => {
  expect(clickAimDelta(500, 300, 1000, 600)).toEqual({ yaw: 0, pitch: 0 })
})

test('clickAimDelta: right/bottom clicks swing toward the point (drag-direction signs)', () => {
  const right = clickAimDelta(1000, 300, 1000, 600)
  expect(right.yaw).toBeCloseTo(-0.7, 5) // right edge → yaw decreases, capped
  expect(right.pitch).toBeCloseTo(0, 5)
  const bottom = clickAimDelta(500, 600, 1000, 600)
  expect(bottom.pitch).toBeCloseTo(-0.45, 5) // bottom edge → pitch decreases, capped
})

test('clickAimDelta: out-of-bounds coords clamp and zero-size is safe', () => {
  const far = clickAimDelta(5000, -200, 1000, 600)
  expect(far.yaw).toBeCloseTo(-0.7, 5)
  expect(far.pitch).toBeCloseTo(0.45, 5)
  expect(clickAimDelta(10, 10, 0, 0)).toEqual({ yaw: 0, pitch: 0 })
})

// ---- HUD sugar: formatStats / FrameRing / StatsTicker / onStats ----

import {
  formatStats,
  FrameRing,
  FRAME_RING_CAPACITY,
  StatsTicker,
  YuraApp,
  type YuraStats,
} from '../src/app'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** YuraApp never touches the DOM until run()/mountCanvas — a bare object works headless. */
function headlessApp(): YuraApp {
  return new YuraApp({} as unknown as HTMLElement)
}

// -- formatStats --

test('formatStats renders the one-line HUD string the demos assembled by hand', () => {
  const s: YuraStats = {
    backend: 'webgpu',
    fps: 60,
    frameMs: 16.7,
    particles: 500_000,
    requestedParticles: 1_000_000,
    resolutionScale: 0.75,
    qualityLevel: 2,
  }
  // Byte-for-byte the string examples/hello/main.ts used to build inline.
  expect(formatStats(s)).toBe('webgpu · 60 fps (16.7 ms) · 500k / 1000k particles · res ×0.75 · Q2')
})

test('formatStats rounds particle counts to whole k (poster backend, zero particles)', () => {
  const s: YuraStats = {
    backend: 'poster',
    fps: 0,
    frameMs: 0,
    particles: 0,
    requestedParticles: 1_500,
    resolutionScale: 1,
    qualityLevel: 0,
  }
  expect(formatStats(s)).toBe('poster · 0 fps (0 ms) · 0k / 2k particles · res ×1 · Q0')
})

// -- FrameRing --

test('FrameRing keeps pushed values in order while below capacity', () => {
  const ring = new FrameRing(4)
  expect(ring.size).toBe(0)
  expect(ring.last()).toEqual([])
  ring.push(16)
  ring.push(17)
  ring.push(18)
  expect(ring.size).toBe(3)
  expect(ring.last()).toEqual([16, 17, 18]) // oldest → newest
})

test('FrameRing evicts the oldest values once capacity is exceeded', () => {
  const ring = new FrameRing(3)
  for (const v of [1, 2, 3, 4, 5]) ring.push(v)
  expect(ring.size).toBe(3) // capped
  expect(ring.last()).toEqual([3, 4, 5]) // 1 and 2 evicted, order preserved
  ring.push(6)
  expect(ring.last()).toEqual([4, 5, 6])
})

test('FrameRing.last(n) returns only the newest n, and clamps silly n', () => {
  const ring = new FrameRing(5)
  for (const v of [10, 20, 30, 40, 50]) ring.push(v)
  expect(ring.last(2)).toEqual([40, 50])
  expect(ring.last(99)).toEqual([10, 20, 30, 40, 50]) // n > size → everything
  expect(ring.last(0)).toEqual([])
  expect(ring.last(-3)).toEqual([])
})

test('FrameRing rejects a non-positive or fractional capacity', () => {
  expect(() => new FrameRing(0)).toThrow(RangeError)
  expect(() => new FrameRing(-1)).toThrow(RangeError)
  expect(() => new FrameRing(2.5)).toThrow(RangeError)
})

// -- StatsTicker --

test('StatsTicker.start fires periodically; its stop handle halts it and is idempotent', async () => {
  const ticker = new StatsTicker()
  let n = 0
  const stop = ticker.start(() => n++, 10)
  await sleep(80)
  expect(n).toBeGreaterThanOrEqual(2)
  stop()
  const frozen = n
  await sleep(50)
  expect(n).toBe(frozen) // no ticks after stop
  stop() // second stop is a no-op, not a crash
  ticker.stopAll() // and stopAll after stop is safe too
})

test('StatsTicker.stopAll halts every started timer (the dispose hook)', async () => {
  const ticker = new StatsTicker()
  let a = 0
  let b = 0
  ticker.start(() => a++, 10)
  const stopB = ticker.start(() => b++, 10)
  await sleep(50)
  ticker.stopAll()
  const [fa, fb] = [a, b]
  await sleep(50)
  expect(a).toBe(fa)
  expect(b).toBe(fb)
  stopB() // handle outlives stopAll harmlessly
})

// -- YuraApp.onStats / frames --

test('onStats delivers stats plus the formatStats text, and dispose() stops it', async () => {
  const app = headlessApp()
  const seen: Array<{ stats: YuraStats; text: string }> = []
  app.onStats((stats, text) => seen.push({ stats, text }), 10)
  await sleep(80)
  expect(seen.length).toBeGreaterThanOrEqual(2)
  const first = seen[0]
  expect(first.text).toBe(formatStats(first.stats))
  expect(first.stats.backend).toBe('poster') // never run(): still the poster backend
  expect(first.stats.requestedParticles).toBeGreaterThan(0)

  app.dispose()
  const frozen = seen.length
  await sleep(50)
  expect(seen.length).toBe(frozen) // dispose stopped the interval
})

test('the onStats stop handle halts only that subscription', async () => {
  const app = headlessApp()
  let a = 0
  let b = 0
  const stopA = app.onStats(() => a++, 10)
  app.onStats(() => b++, 10)
  await sleep(50)
  stopA()
  const [fa, fb] = [a, b]
  await sleep(50)
  expect(a).toBe(fa) // stopped one is frozen...
  expect(b).toBeGreaterThan(fb) // ...the sibling keeps ticking
  app.dispose()
})

test('onStats on a disposed app is a no-op that still hands back a callable stop', async () => {
  const app = headlessApp()
  app.dispose()
  let calls = 0
  const stop = app.onStats(() => calls++, 5)
  await sleep(40)
  expect(calls).toBe(0)
  stop() // must not throw
})

test('frames() is empty before any tick and its default window fits the ring', () => {
  const app = headlessApp()
  expect(app.frames()).toEqual([])
  expect(app.frames(88)).toEqual([]) // the showcase sparkline width
  expect(FRAME_RING_CAPACITY).toBeGreaterThanOrEqual(120) // default n always fits
  app.dispose()
})

// ── Morph choreography: eases registry + .motion timing + morphNow options ──

import { eases, type EaseFn } from '../src/app'
import type { ShapeSpec } from '../src/shapes'

/** Typed window into YuraApp's private morph machinery for white-box checks. */
interface MorphInternals {
  renderer: {
    morphT: number
    morphBoost: number
    morphSpread: number
    writeTargetA(d: Float32Array): void
    writeTargetB(d: Float32Array): void
  } | null
  shapeData: Float32Array[]
  morph: { pos: 0 | 1; phase: 'hold' | 'move'; timer: number; nextShape: number }
  morphPinned: boolean
  holdSeconds: number
  morphSeconds: number
  morphEase: EaseFn
  activeMorphSeconds: number
  activeMorphEase: EaseFn
  motionParams: Record<string, unknown>
  updateMorph(dt: number): void
}

const internals = (app: YuraApp) => app as unknown as MorphInternals

function fakeRenderer() {
  const writes: string[] = []
  return {
    morphT: 0,
    morphBoost: 0,
    morphSpread: 0,
    writes,
    dispose() {},
    writeTargetA(_d: Float32Array) {
      writes.push('A')
    },
    writeTargetB(_d: Float32Array) {
      writes.push('B')
    },
  }
}

const probeShape = (): ShapeSpec => ({
  kind: 'probe',
  generate: (n: number) => new Float32Array(n * 4),
})

test('eases: every registered curve starts at 0 and ends at 1', () => {
  const names = Object.keys(eases).sort()
  expect(names).toEqual(['back', 'cubic', 'expo', 'linear', 'smooth'])
  for (const [, fn] of Object.entries(eases)) {
    expect(fn(0)).toBeCloseTo(0, 9)
    expect(fn(1)).toBeCloseTo(1, 9)
  }
})

test('eases.cubic is byte-identical to the legacy easeInOutCubic curve', () => {
  expect(eases.cubic(0.25)).toBeCloseTo(0.0625, 12) // 4t³
  expect(eases.cubic(0.5)).toBeCloseTo(0.5, 12)
  expect(eases.cubic(0.75)).toBeCloseTo(0.9375, 12) // 1 - (-2t+2)³/2
})

test('eases: cubic/expo/smooth/linear are monotone in [0,1]; back overshoots but stays bounded', () => {
  const monotone: Array<keyof typeof eases> = ['cubic', 'expo', 'smooth', 'linear']
  for (const name of monotone) {
    const fn = eases[name]
    let prev = fn(0)
    for (let i = 1; i <= 100; i++) {
      const v = fn(i / 100)
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9)
      expect(v).toBeGreaterThanOrEqual(-1e-9)
      expect(v).toBeLessThanOrEqual(1 + 1e-9)
      prev = v
    }
  }
  let peak = 0
  for (let i = 0; i <= 100; i++) {
    const v = eases.back(i / 100)
    expect(v).toBeGreaterThanOrEqual(-1e-9) // ease-out back never undershoots
    expect(v).toBeLessThanOrEqual(1.2) // bounded overshoot (~1.099 max)
    peak = Math.max(peak, v)
  }
  expect(peak).toBeGreaterThan(1) // it genuinely overshoots — that's the point
})

test('morph timing defaults reproduce the legacy constants exactly', () => {
  const app = headlessApp()
  const i = internals(app)
  expect(i.holdSeconds).toBe(3.2)
  expect(i.morphSeconds).toBe(2.6)
  expect(i.morphEase).toBe(eases.cubic)
  expect(i.activeMorphSeconds).toBe(2.6)
  expect(i.activeMorphEase).toBe(eases.cubic)
  app.dispose()
})

test('motion({ hold, morph, ease }) retunes timing without leaking into physics params', () => {
  const app = headlessApp()
  const i = internals(app)
  expect(app.motion({ hold: 1.5, morph: 0.5, ease: 'expo' })).toBe(app)
  expect(i.holdSeconds).toBe(1.5)
  expect(i.morphSeconds).toBe(0.5)
  expect(i.morphEase).toBe(eases.expo)
  expect('hold' in i.motionParams).toBe(false)
  expect('morph' in i.motionParams).toBe(false)
  expect('ease' in i.motionParams).toBe(false)

  // physics-only calls leave timing untouched (and still merge as before)
  app.motion({ damping: 9 })
  expect(i.motionParams.damping).toBe(9)
  expect(i.holdSeconds).toBe(1.5)
  expect(i.morphEase).toBe(eases.expo)

  // custom function eases are stored as-is
  const f: EaseFn = (t) => t * t
  app.motion({ ease: f })
  expect(i.morphEase).toBe(f)
  app.dispose()
})

test('motion rejects an unknown ease name with a YuraError', () => {
  const app = headlessApp()
  expect(() => app.motion({ ease: 'zigzag' as never })).toThrow(/Unknown ease "zigzag"/)
  app.dispose()
})

test('the automatic cycle honours motion({ hold, morph, ease })', () => {
  const app = headlessApp()
  const i = internals(app)
  const r = fakeRenderer()
  i.renderer = r
  i.shapeData = [new Float32Array(8), new Float32Array(8)]
  app.motion({ hold: 1, morph: 2, ease: 'linear' })

  i.updateMorph(0.5) // 0.5 < hold(1): still holding
  expect(i.morph.phase).toBe('hold')
  i.updateMorph(0.6) // 1.1 ≥ hold(1): transition begins
  expect(i.morph.phase).toBe('move')
  i.updateMorph(0.5) // k = 0.5/2 = 0.25 → linear e = 0.25 (cubic would be 0.0625)
  expect(r.morphT).toBeCloseTo(0.25, 9)
  i.updateMorph(1.5) // k = 1: arrival preloads the next shape and re-holds
  expect(i.morph.phase).toBe('hold')
  expect(i.morph.pos).toBe(1)
  expect(r.writes).toContain('A')
  app.dispose()
})

test('with no motion() timing call the cycle still holds 3.2s and morphs 2.6s on the cubic curve', () => {
  const app = headlessApp()
  const i = internals(app)
  const r = fakeRenderer()
  i.renderer = r
  i.shapeData = [new Float32Array(8), new Float32Array(8)]

  i.updateMorph(3.1) // < 3.2: still holding
  expect(i.morph.phase).toBe('hold')
  i.updateMorph(0.2) // 3.3 ≥ 3.2: moving
  expect(i.morph.phase).toBe('move')
  i.updateMorph(0.65) // k = 0.65/2.6 = 0.25 → cubic e = 4·0.25³ = 0.0625
  expect(r.morphT).toBeCloseTo(0.0625, 9)
  app.dispose()
})

test('morphNow({ duration, ease }) applies to that transition only', async () => {
  const app = headlessApp().particles(8)
  const i = internals(app)
  const r = fakeRenderer()
  i.renderer = r

  await app.morphNow(probeShape(), { duration: 1, ease: 'linear' })
  expect(i.morphPinned).toBe(true)
  expect(i.morph.phase).toBe('move')
  expect(i.activeMorphSeconds).toBe(1)
  expect(i.activeMorphEase).toBe(eases.linear)
  // the app-level choreography is untouched
  expect(i.morphSeconds).toBe(2.6)
  expect(i.morphEase).toBe(eases.cubic)

  i.updateMorph(0.25) // k = 0.25/1 → linear e = 0.25
  expect(r.morphT).toBeCloseTo(0.25, 9)

  // a follow-up morphNow without options falls back to the app defaults
  await app.morphNow(probeShape())
  expect(i.activeMorphSeconds).toBe(2.6)
  expect(i.activeMorphEase).toBe(eases.cubic)
  app.dispose()
})

test('morphNow before run() still degrades to .shape() with options dropped', async () => {
  const app = headlessApp().particles(8)
  const i = internals(app)
  await app.morphNow(probeShape(), { duration: 9, ease: 'back' })
  expect(i.renderer).toBeNull()
  expect(i.activeMorphSeconds).toBe(2.6) // untouched — no renderer, no transition
  expect(i.activeMorphEase).toBe(eases.cubic)
  app.dispose()
})

// ---------------------------------------------------------------------------
// game() sugar + scene() double-call detach
// ---------------------------------------------------------------------------

import { SCENE_REPLACED_CODE } from '../src/app'
import type { GameSetup } from '../src/app'

/** Swap run() for a headless fake that only records the call order. */
function fakeRun(app: YuraApp, order: string[]): { runs: number } {
  const state = { runs: 0 }
  ;(app as unknown as { run: () => Promise<YuraApp> }).run = async () => {
    state.runs++
    order.push('run')
    return app
  }
  return state
}

/** Capture warnCode output (it logs via console.info) around fn. */
function captureInfo(fn: () => void): string[] {
  const seen: string[] = []
  const orig = console.info
  console.info = (...args: unknown[]) => {
    seen.push(args.map(String).join(' '))
  }
  try {
    fn()
  } finally {
    console.info = orig
  }
  return seen
}

const appCleanups = (app: YuraApp) => (app as unknown as { cleanups: Array<() => void> }).cleanups

test('game(opts, setup) builds the scene with the options, runs setup, then run(), and resolves with the scene', async () => {
  const app = headlessApp()
  const order: string[] = []
  const runState = fakeRun(app, order)

  const seen: YuraScene[] = []
  const scene = await app.game({ gravity: -12, bounds: 30 }, (s) => {
    seen.push(s)
    order.push('setup')
  })

  expect(scene).toBeInstanceOf(YuraScene)
  expect(seen.length).toBe(1)
  expect(seen[0]).toBe(scene)
  expect(scene.gravity).toBe(-12)
  expect(scene.bounds).toBe(30)
  expect(runState.runs).toBe(1)
  expect(order).toEqual(['setup', 'run']) // setup fully done before the loop starts
  app.dispose()
})

test('game(setup) with opts omitted awaits an async setup before starting run()', async () => {
  const app = headlessApp()
  const order: string[] = []
  fakeRun(app, order)

  const scene = await app.game(async (s) => {
    await sleep(10)
    s.add('sphere', { radius: 0.5, position: [0, 0, 0] })
    order.push('setup')
  })

  expect(order).toEqual(['setup', 'run'])
  let objects = 0
  scene.each(null, () => objects++)
  expect(objects).toBe(1) // the sphere added by the (already finished) setup
  expect(scene.gravity).toBe(0) // SceneOptions defaults
  app.dispose()
})

test('game() with no setup still creates a scene and starts run()', async () => {
  const app = headlessApp()
  const order: string[] = []
  const runState = fakeRun(app, order)
  const setup: GameSetup | undefined = undefined
  const scene = await app.game(setup)
  expect(scene).toBeInstanceOf(YuraScene)
  expect(runState.runs).toBe(1)
  app.dispose()
})

test('a second scene() call detaches the old scene: cleanups drain, handles reset, YURA-016 warned', () => {
  const app = headlessApp()

  const first = captureInfo(() => app.scene()) // first call: silent
  expect(first).toEqual([])
  const oldScene = (app as unknown as { sceneObj: YuraScene }).sceneObj
  const removed = { n: 0 }
  const obj = oldScene.add('sphere', { radius: 0.5, position: [0, 0, 0] })
  obj.handle = fakeHandle(removed)
  obj.shadowHandle = fakeHandle(removed)

  const drained: string[] = []
  appCleanups(app).push(() => drained.push('old-listener'))

  const replacements: YuraScene[] = []
  const infos = captureInfo(() => {
    replacements.push(app.scene({ gravity: -9 }))
  })

  const second = replacements[0]
  expect(second).not.toBe(oldScene)
  expect(second.gravity).toBe(-9)
  expect(drained).toEqual(['old-listener']) // old scene's cleanups ran…
  expect(appCleanups(app)).toEqual([]) // …and the list is empty again
  expect(obj.handle).toBeNull() // stale GPU handles reset, not double-freed
  expect(obj.shadowHandle).toBeNull()
  expect(removed.n).toBe(0)
  expect(infos.length).toBe(1)
  expect(infos[0]).toContain(SCENE_REPLACED_CODE)
  expect(infos[0]).toContain('scene() called again')
  app.dispose()
})

test('the first scene() call keeps its original silent behavior (no warn, no drain)', () => {
  const app = headlessApp()
  appCleanups(app).push(() => {
    throw new Error('must not be drained by a first scene() call')
  })
  const infos = captureInfo(() => app.scene())
  expect(infos).toEqual([])
  expect(appCleanups(app).length).toBe(1)
  appCleanups(app).length = 0 // discard the sentinel so dispose stays quiet
  app.dispose()
})
