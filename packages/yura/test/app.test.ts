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

import { resolvePreset } from '../src/presets'

test('physics keys set via motion() survive a later preset() — order no longer matters', () => {
  const app = headlessApp()
  const i = internals(app)
  app.motion({ turbulence: 0.8, damping: 9 }).preset('aurora')

  const aurora: Record<string, unknown> = { ...resolvePreset('aurora').motion }
  expect(i.motionParams.turbulence).toBe(0.8)
  expect(i.motionParams.damping).toBe(9)
  // Everything the user did NOT touch still comes from the new preset.
  for (const [k, v] of Object.entries(aurora)) {
    if (k === 'turbulence' || k === 'damping') continue
    expect(i.motionParams[k]).toBe(v)
  }
  app.dispose()
})

test('preset switching without motion() still replaces motion params wholesale', () => {
  const app = headlessApp()
  const i = internals(app)
  app.preset('aurora')
  expect(i.motionParams).toEqual({ ...resolvePreset('aurora').motion })
  app.preset('cinematic')
  expect(i.motionParams).toEqual({ ...resolvePreset('cinematic').motion })
  app.dispose()
})

test('user motion keys persist across repeated preset swaps, later motion() still wins', () => {
  const app = headlessApp()
  const i = internals(app)
  app.preset('aurora').motion({ damping: 9 }).preset('cinematic')
  expect(i.motionParams.damping).toBe(9)
  expect(i.motionParams.noiseStrength).toBe(resolvePreset('cinematic').motion.noiseStrength)

  app.motion({ damping: 4 })
  expect(i.motionParams.damping).toBe(4)
  app.preset('cyberpunk')
  expect(i.motionParams.damping).toBe(4)
  app.dispose()
})

// ── Explicit .look() vs .preset() — the userMotion pattern applied to looks ──

import { looks } from '../src/looks'

/** Typed window into YuraApp's private look state for white-box checks. */
const lookInternals = (app: YuraApp) =>
  app as unknown as {
    lookParams: ReturnType<typeof looks.cinematic>
    userLook: ReturnType<typeof looks.cinematic> | null
  }

test('an explicit look() survives a later preset() — order no longer matters', () => {
  const app = headlessApp()
  const li = lookInternals(app)
  app.look(looks.sakura()).preset('aurora')
  // The pinned look wins over the preset's look…
  expect(li.lookParams).toEqual(looks.sakura())
  // …while every other preset channel still applies as usual.
  expect(internals(app).motionParams).toEqual({ ...resolvePreset('aurora').motion })
  app.dispose()
})

test('preset switching without look() still replaces the look wholesale', () => {
  const app = headlessApp()
  const li = lookInternals(app)
  app.preset('aurora')
  expect(li.lookParams).toEqual(resolvePreset('aurora').look)
  app.preset('cinematic')
  expect(li.lookParams).toEqual(resolvePreset('cinematic').look)
  expect(li.userLook).toBeNull()
  app.dispose()
})

test('user look persists across repeated preset swaps, later look() still wins', () => {
  const app = headlessApp()
  const li = lookInternals(app)
  app.preset('aurora').look('sakura').preset('cinematic')
  expect(li.lookParams).toEqual(looks.sakura())
  app.preset('cyberpunk')
  expect(li.lookParams).toEqual(looks.sakura())

  // A later look() re-pins: the newest explicit look is the one that sticks.
  app.look('aurora')
  expect(li.lookParams).toEqual(looks.aurora())
  app.preset('cinematic')
  expect(li.lookParams).toEqual(looks.aurora())
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

// ---------------------------------------------------------------------------
// Headless DOM/GPU fakes: everything below drives the private render plumbing
// (mountCanvas / run / tick / pointer bindings / poster fallbacks) without a
// browser, in the same spirit as fakeRenderer()/fakeRun() above.
// ---------------------------------------------------------------------------

import { textDampTarget, FALLBACK_MAX_TEXTURE_DIM as FALLBACK_DIM } from '../src/app'
import { hexToLinear, DEFAULT_LEVELS } from '@yura/core'
import { WebGPUParticleRenderer, WebGPUModelRenderer } from '@yura/renderer-webgpu'

/** Temporarily install globals (document, rAF, …), restoring even absent keys. */
async function withGlobals<T>(
  overrides: Record<string, unknown>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const saved = new Map<string, PropertyDescriptor | undefined>()
  const g = globalThis as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  try {
    return await fn()
  } finally {
    for (const [key, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, key, desc)
      else delete g[key]
    }
  }
}

/** Silence warnCode (console.info) noise from expected fallbacks. */
async function quietInfo<T>(fn: () => Promise<T>): Promise<T> {
  const orig = console.info
  console.info = () => {}
  try {
    return await fn()
  } finally {
    console.info = orig
  }
}

interface FakeEl {
  tag: string
  style: { cssText: string; position: string }
  attrs: Record<string, string>
  children: FakeEl[]
  parentEl: FakeEl | null
  textContent: string
  rect: { left: number; top: number; width: number; height: number }
  setAttribute(k: string, v: string): void
  appendChild(c: FakeEl): FakeEl
  append(...cs: FakeEl[]): void
  remove(): void
  addEventListener(t: string, fn: (e: never) => void): void
  removeEventListener(t: string, fn: (e: never) => void): void
  dispatch(t: string, e?: unknown): void
  listenerCount(t?: string): number
  getBoundingClientRect(): { left: number; top: number; width: number; height: number }
}

function makeEl(tag = 'div'): FakeEl {
  const listeners = new Map<string, Array<(e: unknown) => void>>()
  const el: FakeEl = {
    tag,
    style: { cssText: '', position: '' },
    attrs: {},
    children: [],
    parentEl: null,
    textContent: '',
    rect: { left: 0, top: 0, width: 200, height: 100 },
    setAttribute(k, v) {
      el.attrs[k] = v
    },
    appendChild(c) {
      el.children.push(c)
      c.parentEl = el
      return c
    },
    append(...cs) {
      for (const c of cs) el.appendChild(c)
    },
    remove() {
      if (el.parentEl) el.parentEl.children = el.parentEl.children.filter((c) => c !== el)
      el.parentEl = null
    },
    addEventListener(t, fn) {
      const list = listeners.get(t) ?? []
      list.push(fn as (e: unknown) => void)
      listeners.set(t, list)
    },
    removeEventListener(t, fn) {
      listeners.set(t, (listeners.get(t) ?? []).filter((l) => l !== (fn as (e: unknown) => void)))
    },
    dispatch(t, e = {}) {
      for (const fn of [...(listeners.get(t) ?? [])]) fn(e)
    },
    listenerCount(t) {
      if (t !== undefined) return (listeners.get(t) ?? []).length
      let n = 0
      for (const list of listeners.values()) n += list.length
      return n
    },
    getBoundingClientRect() {
      return el.rect
    },
  }
  return el
}

function fakeCtx2d() {
  const calls = {
    gradients: 0,
    stops: [] as string[],
    rects: 0,
    arcs: 0,
    fills: 0,
    fillColors: new Set<unknown>(),
  }
  const ctx = {
    calls,
    fillStyle: '' as unknown,
    globalAlpha: 1,
    createRadialGradient() {
      calls.gradients++
      return {
        addColorStop(_o: number, c: string) {
          calls.stops.push(c)
        },
      }
    },
    fillRect() {
      calls.rects++
      calls.fillColors.add(ctx.fillStyle)
    },
    beginPath() {},
    arc() {
      calls.arcs++
    },
    fill() {
      calls.fills++
      calls.fillColors.add(ctx.fillStyle)
    },
  }
  return ctx
}

interface FakeCanvasEl extends FakeEl {
  clientWidth: number
  clientHeight: number
  width: number
  height: number
  ctx2d: ReturnType<typeof fakeCtx2d> | null
  getContext(kind: string): unknown
}

function makeCanvas(opts: { ctx2d?: boolean; w?: number; h?: number } = {}): FakeCanvasEl {
  const base = makeEl('canvas')
  const ctx = opts.ctx2d ? fakeCtx2d() : null
  const canvas: FakeCanvasEl = Object.assign(base, {
    clientWidth: opts.w ?? 320,
    clientHeight: opts.h ?? 240,
    width: 0,
    height: 0,
    ctx2d: ctx,
    getContext(kind: string): unknown {
      return kind === '2d' ? canvas.ctx2d : null
    },
  })
  return canvas
}

function makeDocument(opts: { ctx2d?: boolean } = {}) {
  const listeners = new Map<string, Array<() => void>>()
  const doc = {
    visibilityState: 'visible' as string,
    created: [] as FakeEl[],
    addEventListener(t: string, fn: () => void) {
      const list = listeners.get(t) ?? []
      list.push(fn)
      listeners.set(t, list)
    },
    removeEventListener(t: string, fn: () => void) {
      listeners.set(t, (listeners.get(t) ?? []).filter((l) => l !== fn))
    },
    dispatch(t: string) {
      for (const fn of [...(listeners.get(t) ?? [])]) fn()
    },
    createElement(tag: string): FakeEl {
      const el = tag === 'canvas' ? makeCanvas({ ctx2d: opts.ctx2d }) : makeEl(tag)
      doc.created.push(el)
      return el
    },
  }
  return doc
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  observed: unknown[] = []
  disconnected = false
  constructor(public cb: () => void) {
    FakeResizeObserver.instances.push(this)
  }
  observe(el: unknown) {
    this.observed.push(el)
  }
  disconnect() {
    this.disconnected = true
  }
  trigger() {
    this.cb()
  }
}

function rafKit() {
  const kit = {
    scheduled: [] as FrameRequestCallback[],
    canceled: [] as number[],
    next: 1,
    raf(cb: FrameRequestCallback): number {
      kit.scheduled.push(cb)
      return kit.next++
    },
    caf(id: number): void {
      kit.canceled.push(id)
    },
  }
  return kit
}

function domKit(opts: { reduce?: boolean; ctx2d?: boolean } = {}) {
  FakeResizeObserver.instances.length = 0
  const raf = rafKit()
  const doc = makeDocument({ ctx2d: opts.ctx2d })
  return {
    raf,
    doc,
    globals: {
      document: doc,
      getComputedStyle: (el: { style: { position: string } }) => ({
        position: el.style.position || 'static',
      }),
      requestAnimationFrame: raf.raf,
      cancelAnimationFrame: raf.caf,
      devicePixelRatio: 2,
      ResizeObserver: FakeResizeObserver,
      matchMedia: (q: string) => ({
        matches: q.includes('prefers-reduced-motion') ? !!opts.reduce : false,
        addEventListener() {},
        removeEventListener() {},
      }),
    } as Record<string, unknown>,
  }
}

function fakeParticleRenderer() {
  const r = {
    onDeviceLost: null as (() => void) | null,
    morphT: 0,
    morphBoost: 0,
    morphSpread: 0,
    textDamp: 1,
    pointerWorld: [0, 0, 0] as [number, number, number],
    pointerStrength: 0,
    parallax: [0, 0] as [number, number],
    world: [1, 2, 3] as [number, number, number] | null,
    writesA: [] as Float32Array[],
    writesB: [] as Float32Array[],
    positions: [] as Float32Array[],
    frames: [] as Array<[number, number, number]>,
    resizes: [] as Array<[number, number]>,
    disposed: 0,
    writeTargetA(d: Float32Array) {
      r.writesA.push(d)
    },
    writeTargetB(d: Float32Array) {
      r.writesB.push(d)
    },
    writePositions(d: Float32Array) {
      r.positions.push(d)
    },
    pointerToWorld(_x: number, _y: number) {
      return r.world
    },
    frame(dt: number, t: number, count: number) {
      r.frames.push([dt, t, count])
    },
    resize(w: number, h: number) {
      r.resizes.push([w, h])
    },
    dispose() {
      r.disposed++
    },
  }
  return r
}

function fakeModelRenderer() {
  const r = {
    colorA: [0, 0, 0] as unknown,
    colorB: [0, 0, 0] as unknown,
    onDeviceLost: null as (() => void) | null,
    autoRotate: 1,
    shadowArea: undefined as number | undefined,
    yaw: 0.4,
    pitch: 0.2,
    resizes: [] as Array<[number, number]>,
    frames: [] as Array<[number, number]>,
    loaded: [] as string[],
    aimed: [] as Array<[number, number]>,
    rotated: [] as Array<[number, number]>,
    panned: [] as Array<[number, number]>,
    zoomed: [] as number[],
    resets: 0,
    disposed: 0,
    resize(w: number, h: number) {
      r.resizes.push([w, h])
    },
    frame(dt: number, t: number) {
      r.frames.push([dt, t])
    },
    async loadModel(url: string) {
      r.loaded.push(url)
    },
    aimTo(y: number, p: number) {
      r.aimed.push([y, p])
    },
    rotateBy(y: number, p: number) {
      r.rotated.push([y, p])
    },
    panBy(x: number, y: number) {
      r.panned.push([x, y])
    },
    zoomBy(f: number) {
      r.zoomed.push(f)
    },
    resetView() {
      r.resets++
    },
    dispose() {
      r.disposed++
    },
  }
  return r
}

function fakeGpuNavigator(limits?: { maxTextureDimension2D?: number }) {
  return {
    gpu: {
      requestAdapter: async () => ({
        requestDevice: async () => ({ limits }),
      }),
    },
  }
}

interface FullInternals {
  container: FakeEl
  canvas: FakeCanvasEl | null
  renderer: ReturnType<typeof fakeParticleRenderer> | null
  modelRenderer: ReturnType<typeof fakeModelRenderer> | null
  sceneObj: YuraScene | null
  colorA: string
  colorB: string
  modelUrl: string | null
  pointerEnabled: boolean
  shapeSeq: ShapeSpec[]
  shapeData: Float32Array[]
  targetKinds: [string, string]
  morph: { pos: 0 | 1; phase: 'hold' | 'move'; timer: number; nextShape: number }
  morphPinned: boolean
  textDamp: number
  running: boolean
  visible: boolean
  disposed: boolean
  recovering: boolean
  rafId: number
  lastTime: number
  simTime: number
  sceneSimTime: number
  fpsEma: number
  burst: number
  pointerNdc: [number, number] | null
  particleCount: number
  maxTextureDim: number
  governor: { level: number; enabled: boolean; setLevel(n: number): void; current(): { res: number; frac: number } }
  cleanups: Array<() => void>
  tick(now: number): void
  morphDestKind(): string
  activeCount(): number
  applyResolution(): void
  observeResize(): void
  bindPointer(): void
  bindModelPointer(): void
  generateRemainingShapes(): Promise<void>
  recoverFromDeviceLost(): Promise<void>
  mountCanvas(): void
}

const full = (app: YuraApp) => app as unknown as FullInternals
const appOn = (el: FakeEl, options?: ConstructorParameters<typeof YuraApp>[1]) =>
  new YuraApp(el as unknown as HTMLElement, options)

// ---- fluent configuration ----

test('model/gradient/interactive/reactToPointer chain and store their state', () => {
  const app = headlessApp()
  const i = full(app)
  expect(app.model('assets/x.glb')).toBe(app)
  expect(i.modelUrl).toBe('assets/x.glb')
  expect(app.gradient('#101010', '#efefef')).toBe(app)
  expect(i.colorA).toBe('#101010')
  expect(i.colorB).toBe('#efefef')
  expect(app.interactive(false)).toBe(app)
  expect(i.pointerEnabled).toBe(false)
  expect(app.reactToPointer()).toBe(app)
  expect(i.pointerEnabled).toBe(true)
  app.dispose()
})

test('morphTo replaces the preset cycle, keeps a pinned shape() first, and turns strings into text', () => {
  const a = probeShape()
  const b = probeShape()

  const fresh = headlessApp()
  fresh.morphTo([a, b])
  expect(full(fresh).shapeSeq).toEqual([a, b])
  fresh.dispose()

  const strings = headlessApp()
  strings.morphTo(['こんにちは'])
  expect(full(strings).shapeSeq).toHaveLength(1)
  expect(full(strings).shapeSeq[0].kind).toBe('text')
  strings.dispose()

  const pinned = headlessApp()
  const firstShape = probeShape()
  pinned.shape(firstShape).morphTo([a, b])
  expect(full(pinned).shapeSeq[0]).toBe(firstShape)
  expect(full(pinned).shapeSeq.slice(1)).toEqual([a, b])
  pinned.morphTo([])
  expect(full(pinned).shapeSeq).toEqual([firstShape])
  pinned.dispose()

  const untouched = headlessApp()
  const before = full(untouched).shapeSeq
  untouched.morphTo([])
  expect(full(untouched).shapeSeq).toBe(before)
  untouched.dispose()
})

test('lyrics() sugar hands back a controllable run', () => {
  const app = headlessApp()
  const run = app.lyrics([{ text: 'hello', at: 0 }])
  expect(typeof run.stop).toBe('function')
  expect(typeof run.seek).toBe('function')
  run.stop()
  app.dispose()
})

// ---- small internals ----

test('morphDestKind: at rest the front buffer, mid-move the destination buffer', () => {
  const app = headlessApp()
  const i = full(app)
  i.targetKinds = ['frontKind', 'backKind']
  i.morph.phase = 'hold'
  i.morph.pos = 0
  expect(i.morphDestKind()).toBe('frontKind')
  i.morph.pos = 1
  expect(i.morphDestKind()).toBe('backKind')
  i.morph.phase = 'move'
  i.morph.pos = 0
  expect(i.morphDestKind()).toBe('backKind')
  i.morph.pos = 1
  expect(i.morphDestKind()).toBe('frontKind')
  app.dispose()
})

test('activeCount scales the request by the governor frac and never reaches zero', () => {
  const app = headlessApp().particles(1000)
  const i = full(app)
  expect(i.activeCount()).toBe(Math.max(1, Math.floor(1000 * DEFAULT_LEVELS[0].frac)))
  const last = DEFAULT_LEVELS.length - 1
  i.governor.setLevel(last)
  expect(i.activeCount()).toBe(Math.max(1, Math.floor(1000 * DEFAULT_LEVELS[last].frac)))
  app.particles(1)
  expect(i.activeCount()).toBe(1)
  app.dispose()
})

test('mountCanvas mounts one absolute a11y-hidden canvas and forces relative positioning', async () => {
  const el = makeEl()
  const app = appOn(el)
  const i = full(app)
  const kit = domKit()
  await withGlobals(kit.globals, () => {
    i.mountCanvas()
    const canvas = i.canvas!
    expect(el.style.position).toBe('relative')
    expect(el.children).toContain(canvas)
    expect(canvas.attrs['aria-hidden']).toBe('true')
    expect(canvas.attrs.role).toBe('presentation')
    expect(canvas.style.cssText).toContain('position:absolute')
    i.mountCanvas() // idempotent
    expect(el.children).toHaveLength(1)
  })
  app.dispose()

  const positioned = makeEl()
  positioned.style.position = 'sticky'
  const app2 = appOn(positioned)
  await withGlobals(kit.globals, () => {
    full(app2).mountCanvas()
    expect(positioned.style.position).toBe('sticky')
  })
  app2.dispose()
})

test('applyResolution sizes from CSS size × dpr (capped at 2) × governor scale, clamped to the device limit', async () => {
  const app = headlessApp()
  const i = full(app)
  const r = fakeParticleRenderer()
  i.renderer = r
  i.canvas = makeCanvas({ w: 800, h: 600 })
  const scale = i.governor.current().res

  await withGlobals({ devicePixelRatio: 3 }, () => i.applyResolution())
  expect(r.resizes.pop()).toEqual([800 * 2 * scale, 600 * 2 * scale]) // dpr capped at 2

  await withGlobals({ devicePixelRatio: 1.5 }, () => i.applyResolution())
  expect(r.resizes.pop()).toEqual([800 * 1.5 * scale, 600 * 1.5 * scale])

  i.maxTextureDim = 512
  const clamped = clampCanvasSize(800 * 2 * scale, 600 * 2 * scale, 512)
  await withGlobals({ devicePixelRatio: 2 }, () => i.applyResolution())
  expect(r.resizes.pop()).toEqual([clamped.width, clamped.height])

  // model renderer takes precedence over the particle renderer
  const mr = fakeModelRenderer()
  i.modelRenderer = mr
  await withGlobals({ devicePixelRatio: 2 }, () => i.applyResolution())
  expect(mr.resizes).toHaveLength(1)
  expect(r.resizes).toHaveLength(0)

  // no canvas → no-op
  i.canvas = null
  await withGlobals({ devicePixelRatio: 2 }, () => i.applyResolution())
  expect(mr.resizes).toHaveLength(1)
  i.renderer = null
  i.modelRenderer = null
  app.dispose()
})

test('observeResize re-applies resolution now, on container resize, and on monitor-DPI change', async () => {
  const el = makeEl()
  const app = appOn(el)
  const i = full(app)
  const r = fakeParticleRenderer()
  i.renderer = r
  i.canvas = makeCanvas({ w: 100, h: 50 })
  FakeResizeObserver.instances.length = 0
  const env = fakeMediaEnv(2)
  await withGlobals(
    { ResizeObserver: FakeResizeObserver, matchMedia: env.matchMedia, devicePixelRatio: 2 },
    () => {
      i.observeResize()
      expect(FakeResizeObserver.instances).toHaveLength(1)
      const ro = FakeResizeObserver.instances[0]
      expect(ro.observed).toContain(i.container)
      expect(r.resizes).toHaveLength(1) // applied immediately
      ro.trigger()
      expect(r.resizes).toHaveLength(2)
      env.created[0].fire() // dpr changed
      expect(r.resizes).toHaveLength(3)
      drainCleanups(i.cleanups)
      expect(ro.disconnected).toBe(true)
      expect(env.created.at(-1)!.listeners).toHaveLength(0)
    },
  )
  i.renderer = null
  i.canvas = null
  app.dispose()
})

test('observeResize works without matchMedia (no dpr watcher registered)', async () => {
  const el = makeEl()
  const app = appOn(el)
  const i = full(app)
  const r = fakeParticleRenderer()
  i.renderer = r
  i.canvas = makeCanvas({ w: 100, h: 50 })
  FakeResizeObserver.instances.length = 0
  await withGlobals(
    { ResizeObserver: FakeResizeObserver, matchMedia: undefined, devicePixelRatio: 1 },
    () => {
      i.observeResize()
      expect(FakeResizeObserver.instances).toHaveLength(1)
      expect(r.resizes).toHaveLength(1)
      drainCleanups(i.cleanups)
    },
  )
  i.renderer = null
  i.canvas = null
  app.dispose()
})

// ---- pointer bindings ----

test('bindPointer maps pointer position to NDC, click starts a burst, leave clears', () => {
  const el = makeEl()
  const app = appOn(el)
  const i = full(app)
  i.bindPointer()
  el.dispatch('pointermove', { clientX: 150, clientY: 25 })
  expect(i.pointerNdc![0]).toBeCloseTo(0.5, 9) // (150/200)*2-1
  expect(i.pointerNdc![1]).toBeCloseTo(0.5, 9) // -((25/100)*2-1)
  expect(i.burst).toBe(0)
  el.dispatch('pointerdown', { clientX: 100, clientY: 50 })
  expect(i.burst).toBe(1)
  expect(i.pointerNdc![0]).toBeCloseTo(0, 9)
  expect(i.pointerNdc![1]).toBeCloseTo(0, 9)
  el.dispatch('pointerleave', {})
  expect(i.pointerNdc).toBeNull()
  drainCleanups(i.cleanups)
  expect(el.listenerCount()).toBe(0)
  el.dispatch('pointermove', { clientX: 10, clientY: 10 })
  expect(i.pointerNdc).toBeNull()
  app.dispose()
})

test('bindPointer and bindModelPointer are no-ops when interactivity is off', () => {
  const el = makeEl()
  const app = appOn(el).interactive(false)
  const i = full(app)
  i.bindPointer()
  i.bindModelPointer()
  expect(el.listenerCount()).toBe(0)
  expect(i.cleanups).toHaveLength(0)
  app.dispose()
})

test('bindModelPointer: drag rotates, shift/right drag pans, wheel zooms, dblclick resets', () => {
  const el = makeEl()
  const app = appOn(el)
  const i = full(app)
  const mr = fakeModelRenderer()
  i.modelRenderer = mr
  i.bindModelPointer()

  // left drag rotates by pixel delta × 0.006
  el.dispatch('pointerdown', { button: 0, shiftKey: false, clientX: 10, clientY: 10, pointerId: 1 })
  el.dispatch('pointermove', { clientX: 30, clientY: 20 })
  let [ry, rp] = mr.rotated.at(-1)!
  expect(ry).toBeCloseTo(20 * 0.006, 9)
  expect(rp).toBeCloseTo(10 * 0.006, 9)
  el.dispatch('pointermove', { clientX: 40, clientY: 5 })
  ;[ry, rp] = mr.rotated.at(-1)!
  expect(ry).toBeCloseTo(10 * 0.006, 9)
  expect(rp).toBeCloseTo(-15 * 0.006, 9)
  el.dispatch('pointerup', { clientX: 40, clientY: 5 }) // long drag: not a click
  expect(mr.aimed).toHaveLength(0)

  // shift-drag pans (x inverted)
  el.dispatch('pointerdown', { button: 0, shiftKey: true, clientX: 0, clientY: 0 })
  el.dispatch('pointermove', { clientX: 5, clientY: 7 })
  expect(mr.panned.at(-1)).toEqual([-5, 7])
  el.dispatch('pointerup', { clientX: 5, clientY: 7 })

  // right-button drag pans too
  el.dispatch('pointerdown', { button: 2, shiftKey: false, clientX: 0, clientY: 0 })
  el.dispatch('pointermove', { clientX: -3, clientY: 2 })
  expect(mr.panned.at(-1)).toEqual([3, 2])
  el.dispatch('pointerleave', {})
  const movesBefore = mr.rotated.length + mr.panned.length
  el.dispatch('pointermove', { clientX: 99, clientY: 99 }) // released: no-op
  expect(mr.rotated.length + mr.panned.length).toBe(movesBefore)

  const prevented = { n: 0 }
  el.dispatch('wheel', { deltaY: 100, preventDefault: () => prevented.n++ })
  expect(mr.zoomed.at(-1)).toBeCloseTo(1.1, 9)
  expect(prevented.n).toBe(1)
  el.dispatch('dblclick', {})
  expect(mr.resets).toBe(1)
  el.dispatch('contextmenu', { preventDefault: () => prevented.n++ })
  expect(prevented.n).toBe(2)

  drainCleanups(i.cleanups)
  expect(el.listenerCount()).toBe(0)
  i.modelRenderer = null
  app.dispose()
})

test('bindModelPointer: a quick still press is a click that aims the camera', () => {
  const el = makeEl()
  const app = appOn(el)
  const i = full(app)
  const mr = fakeModelRenderer()
  i.modelRenderer = mr
  i.bindModelPointer()
  el.dispatch('pointerdown', { button: 0, shiftKey: false, clientX: 150, clientY: 25, pointerId: 1 })
  el.dispatch('pointerup', { clientX: 152, clientY: 26 }) // ~2px within 250ms
  expect(mr.aimed).toHaveLength(1)
  const d = clickAimDelta(152, 26, el.rect.width, el.rect.height)
  const [yaw, pitch] = mr.aimed[0]
  expect(yaw).toBeCloseTo(mr.yaw + d.yaw, 9)
  expect(pitch).toBeCloseTo(mr.pitch + d.pitch, 9)
  drainCleanups(i.cleanups)
  i.modelRenderer = null
  app.dispose()
})

// ---- background shape generation ----

test('generateRemainingShapes fills shapeData and preloads only the second shape into targetB', async () => {
  const app = headlessApp().particles(4)
  const i = full(app)
  const r = fakeParticleRenderer()
  i.renderer = r
  const gen = (fill: number): ShapeSpec => ({
    kind: `probe-${fill}`,
    generate: (n: number) => new Float32Array(n * 4).fill(fill),
  })
  const [s0, s1, s2] = [gen(0), gen(1), gen(2)]
  i.shapeSeq = [s0, s1, s2]
  i.shapeData = [s0.generate(4) as Float32Array]
  i.targetKinds = [s0.kind, s0.kind]
  await i.generateRemainingShapes()
  expect(i.shapeData).toHaveLength(3)
  expect(i.shapeData[1][0]).toBe(1)
  expect(i.shapeData[2][0]).toBe(2)
  expect(r.writesB).toHaveLength(1)
  expect(r.writesB[0][0]).toBe(1)
  expect(i.targetKinds[1]).toBe(s1.kind)
  i.renderer = null
  app.dispose()
})

test('generateRemainingShapes stops quietly once the app is disposed', async () => {
  const app = headlessApp().particles(4)
  const i = full(app)
  const s: ShapeSpec = { kind: 'late', generate: (n: number) => new Float32Array(n * 4) }
  i.shapeSeq = [s, s]
  i.shapeData = []
  app.dispose()
  await i.generateRemainingShapes()
  expect(i.shapeData).toHaveLength(0)
})

// ---- the frame loop ----

test('tick advances the simulation, feeds the frame ring, clamps dt, and reschedules', async () => {
  const app = headlessApp().particles(8)
  const i = full(app)
  const r = fakeParticleRenderer()
  i.renderer = r
  i.running = true
  i.visible = true
  i.lastTime = 1000
  const raf = rafKit()
  await withGlobals({ requestAnimationFrame: raf.raf, cancelAnimationFrame: raf.caf }, () => {
    i.tick(1016)
    expect(r.frames).toHaveLength(1)
    const [dt, t, count] = r.frames[0]
    expect(dt).toBeCloseTo(0.016, 9)
    expect(t).toBeCloseTo(0.016, 9)
    expect(count).toBe(i.activeCount())
    expect(app.frames()).toHaveLength(1)
    expect(app.frames()[0]).toBeCloseTo(16, 6)
    expect(raf.scheduled).toHaveLength(1)

    i.tick(3000) // huge gap → clamped to MAX_DT
    expect(r.frames[1][0]).toBeCloseTo(1 / 30, 9)

    i.lastTime = 99_999 // rAF timestamp behind lastTime → dt 0, never negative
    i.tick(5000)
    expect(r.frames[2][0]).toBe(0)
    app.dispose()
  })
})

test('tick drives pointer forces: hover repels, click detonates, leave releases', async () => {
  const app = headlessApp().particles(8)
  const i = full(app)
  const r = fakeParticleRenderer()
  i.renderer = r
  i.running = true
  i.visible = true
  i.lastTime = 0
  const raf = rafKit()
  await withGlobals({ requestAnimationFrame: raf.raf, cancelAnimationFrame: raf.caf }, () => {
    i.pointerNdc = [0.5, -0.25]
    i.tick(16)
    expect(r.pointerWorld).toEqual([1, 2, 3])
    expect(r.pointerStrength).toBeCloseTo(60, 6)
    expect(r.parallax[0]).toBeCloseTo(0.5 * 0.08, 9)
    expect(r.parallax[1]).toBeCloseTo(-0.25 * 0.08, 9)

    i.burst = 1
    i.tick(32)
    expect(r.pointerStrength).toBeCloseTo(60 + 2400, 6)
    expect(i.burst).toBeCloseTo(Math.exp(-0.016 * 5), 9)

    r.world = null // pointer off the swarm plane: strength untouched
    const prev = r.pointerStrength
    i.tick(48)
    expect(r.pointerStrength).toBe(prev)

    i.pointerNdc = null
    i.tick(64)
    expect(r.pointerStrength).toBe(0)
    app.dispose()
  })
})

test('tick is inert while paused, hidden, disposed, or renderer-less', async () => {
  const raf = rafKit()
  await withGlobals({ requestAnimationFrame: raf.raf, cancelAnimationFrame: raf.caf }, () => {
    const app = headlessApp()
    const i = full(app)
    const r = fakeParticleRenderer()
    i.renderer = r
    i.visible = true
    i.lastTime = 0

    i.running = false
    i.tick(16)
    expect(r.frames).toHaveLength(0)

    i.running = true
    i.visible = false
    i.tick(16)
    expect(r.frames).toHaveLength(0)

    i.visible = true
    i.renderer = null
    i.tick(16)
    expect(raf.scheduled).toHaveLength(0)

    i.renderer = r
    i.disposed = true
    i.tick(16)
    expect(r.frames).toHaveLength(0)
    expect(raf.scheduled).toHaveLength(0)
  })
})

test('tick steps a scene on the fixed physics grid and clamps the render dt', async () => {
  const el = makeEl()
  const app = appOn(el)
  const i = full(app)
  app.scene({ keyboard: false })
  const mr = fakeModelRenderer()
  i.modelRenderer = mr
  i.running = true
  i.visible = true
  i.lastTime = 0
  const raf = rafKit()
  await withGlobals({ requestAnimationFrame: raf.raf, cancelAnimationFrame: raf.caf }, () => {
    i.tick(50) // 50ms → three 1/60 physics ticks
    expect(i.sceneSimTime).toBeCloseTo(3 * SCENE_FIXED_DT, 9)
    expect(mr.frames).toHaveLength(1)
    expect(mr.frames[0][0]).toBeCloseTo(1 / 30, 9) // render dt clamped to MAX_DT
    expect(raf.scheduled).toHaveLength(1)
    app.dispose()
  })
})

test('sustained slow frames drop a quality level mid-loop and re-apply resolution', async () => {
  const app = headlessApp().particles(8)
  const i = full(app)
  const r = fakeParticleRenderer()
  i.renderer = r
  i.canvas = makeCanvas({ w: 640, h: 480 })
  i.running = true
  i.visible = true
  i.lastTime = 0
  const raf = rafKit()
  await withGlobals(
    { requestAnimationFrame: raf.raf, cancelAnimationFrame: raf.caf, devicePixelRatio: 1 },
    () => {
      let now = 0
      for (let f = 0; f < 60 && r.resizes.length === 0; f++) {
        now += 40 // 25fps: far over the frame budget
        i.tick(now)
      }
      expect(i.governor.level).toBeGreaterThan(0)
      expect(r.resizes.length).toBeGreaterThan(0)
      app.dispose()
    },
  )
})

test('resume restarts the loop exactly once; pause cancels the pending frame', async () => {
  const app = headlessApp()
  const i = full(app)
  const raf = rafKit()
  await withGlobals({ requestAnimationFrame: raf.raf, cancelAnimationFrame: raf.caf }, () => {
    expect(i.running).toBe(false)
    app.resume()
    expect(i.running).toBe(true)
    expect(raf.scheduled).toHaveLength(1)
    const id = i.rafId
    expect(id).toBeGreaterThan(0)
    app.resume() // already running → no second schedule
    expect(raf.scheduled).toHaveLength(1)
    app.pause()
    expect(i.running).toBe(false)
    expect(raf.canceled).toEqual([id])
    expect(i.rafId).toBe(0)
    app.pause() // nothing pending → no extra cancel
    expect(raf.canceled).toHaveLength(1)
    app.dispose()
    app.resume() // disposed → no-op
    expect(raf.scheduled).toHaveLength(1)
  })
})

test('dispose removes the mounted canvas and tears down both renderers exactly once', () => {
  const el = makeEl()
  const app = appOn(el)
  const i = full(app)
  const canvas = makeCanvas()
  el.appendChild(canvas)
  i.canvas = canvas
  const r = fakeParticleRenderer()
  const mr = fakeModelRenderer()
  i.renderer = r
  i.modelRenderer = mr
  app.dispose()
  expect(r.disposed).toBe(1)
  expect(mr.disposed).toBe(1)
  expect(i.canvas).toBeNull()
  expect(el.children).not.toContain(canvas)
  app.dispose() // idempotent
  expect(r.disposed).toBe(1)
  expect(mr.disposed).toBe(1)
})

// ---- device-loss recovery ----

test('device loss recovery drains listeners, resets scene handles, then re-runs once', async () => {
  const app = headlessApp()
  const i = full(app)
  const order: string[] = []
  const scene = app.scene({ keyboard: false })
  const obj = scene.add('sphere', { radius: 1 })
  obj.handle = fakeHandle({ n: 0 })
  i.renderer = fakeParticleRenderer()
  i.modelRenderer = fakeModelRenderer()
  i.cleanups.push(() => order.push('cleanup'))
  ;(app as unknown as { run: () => Promise<YuraApp> }).run = async () => {
    order.push('run')
    return app
  }
  await i.recoverFromDeviceLost()
  expect(order).toEqual(['cleanup', 'run'])
  expect(obj.handle).toBeNull()
  expect(i.renderer).toBeNull()
  expect(i.modelRenderer).toBeNull()
  expect(i.recovering).toBe(false)
  app.dispose()
})

test('recovery is re-entrancy safe and a failed re-run falls back to the poster', async () => {
  const app = headlessApp()
  const i = full(app)
  let runs = 0
  ;(app as unknown as { run: () => Promise<YuraApp> }).run = async () => {
    runs++
    throw new Error('device lost again')
  }
  await i.recoverFromDeviceLost()
  expect(runs).toBe(1)
  expect(app.stats.backend).toBe('poster')
  expect(i.recovering).toBe(false)

  i.recovering = true // already recovering → guard
  await i.recoverFromDeviceLost()
  expect(runs).toBe(1)
  i.recovering = false

  app.dispose() // disposed → guard
  await i.recoverFromDeviceLost()
  expect(runs).toBe(1)
})

// ---- run(): poster fallbacks (no GPU anywhere) ----

test('run() with no usable backend paints the 2D poster instead of a white screen', async () => {
  const el = makeEl()
  const app = appOn(el, { backend: 'webgl2' }).gradient('#111111', '#222222')
  const i = full(app)
  const kit = domKit({ ctx2d: true })
  await withGlobals(kit.globals, () =>
    quietInfo(async () => {
      await app.run()
      expect(app.stats.backend).toBe('poster')
      const canvas = i.canvas!
      const ctx = canvas.ctx2d!
      expect(canvas.width).toBe(Math.max(1, canvas.clientWidth * 2))
      expect(canvas.height).toBe(Math.max(1, canvas.clientHeight * 2))
      expect(ctx.calls.gradients).toBe(1)
      expect(ctx.calls.stops).toHaveLength(2)
      expect(ctx.calls.rects).toBe(1)
      expect(ctx.calls.arcs).toBe(900)
      expect(ctx.calls.fills).toBe(900)
      expect(ctx.calls.fillColors.has('#111111')).toBe(true)
      expect(ctx.calls.fillColors.has('#222222')).toBe(true)
      expect(ctx.globalAlpha).toBe(1)

      const ro = FakeResizeObserver.instances.at(-1)!
      ro.trigger() // container resized → redraw
      expect(ctx.calls.arcs).toBe(1800)
      app.dispose()
      expect(ro.disconnected).toBe(true)
    }),
  )
})

test('run() with a scene but no WebGPU renders the in-DOM unsupported notice', async () => {
  const el = makeEl()
  const app = appOn(el, { backend: 'webgl2' }).gradient('#123456', '#abcdef')
  app.scene({ keyboard: false })
  const kit = domKit()
  await withGlobals(kit.globals, () => quietInfo(() => app.run()))
  expect(app.stats.backend).toBe('poster')
  const overlay = el.children.at(-1)!
  expect(overlay.attrs.role).toBe('status')
  expect(overlay.children).toHaveLength(3)
  const [badge, title, hint] = overlay.children
  expect(badge.style.cssText).toContain('#123456')
  expect(badge.style.cssText).toContain('#abcdef')
  expect(title.textContent).toContain('WebGPU')
  expect(hint.textContent.length).toBeGreaterThan(0)
  app.dispose()
  expect(el.children).not.toContain(overlay)
})

test('run() with a model but no WebGPU falls back to the static poster', async () => {
  const el = makeEl()
  const app = appOn(el, { backend: 'webgl2' }).model('robot.glb')
  const i = full(app)
  const kit = domKit({ ctx2d: true })
  await withGlobals(kit.globals, () => quietInfo(() => app.run()))
  expect(app.stats.backend).toBe('poster')
  expect(i.canvas!.ctx2d!.calls.arcs).toBe(900)
  expect(i.running).toBe(false)
  app.dispose()
})

test('run() quality modes: low pins the floor level, high disables the governor, heavy auto boots one notch down', async () => {
  const kit = domKit()
  await withGlobals(kit.globals, () =>
    quietInfo(async () => {
      const low = appOn(makeEl(), { backend: 'webgl2', quality: 'low' })
      await low.run()
      expect(low.stats.qualityLevel).toBe(4)
      low.dispose()

      const high = appOn(makeEl(), { backend: 'webgl2', quality: 'high' })
      await high.run()
      expect(full(high).governor.enabled).toBe(false)
      expect(high.stats.qualityLevel).toBe(0)
      high.dispose()

      const heavy = appOn(makeEl(), { backend: 'webgl2' }).particles(300_000)
      await heavy.run()
      expect(heavy.stats.qualityLevel).toBe(2)
      heavy.dispose()

      const light = appOn(makeEl(), { backend: 'webgl2' }).particles(299_999)
      await light.run()
      expect(light.stats.qualityLevel).toBe(0)
      light.dispose()
    }),
  )
})

test('run() on a disposed app never touches the DOM', async () => {
  const app = headlessApp()
  app.dispose()
  expect(await app.run()).toBe(app) // would throw without the guard: no document exists here
  expect(full(app).canvas).toBeNull()
})

// ---- run(): WebGPU paths via patched renderer statics ----

type StaticPatch = { restore(): void }
function patchStatic(klass: object, name: string, impl: unknown): StaticPatch {
  const target = klass as Record<string, unknown>
  const orig = target[name]
  target[name] = impl
  return {
    restore() {
      target[name] = orig
    },
  }
}

test('run() acquires WebGPU, spawns the swarm on the first shape, and starts the loop', async () => {
  const el = makeEl()
  const app = appOn(el).particles(16)
  const spec: ShapeSpec = {
    kind: 'probe',
    generate: (n: number) => Float32Array.from({ length: n * 4 }, (_, k) => (k % 4 === 3 ? 7 : k)),
  }
  app.shape(spec)
  const i = full(app)
  const kit = domKit()
  const pr = fakeParticleRenderer()
  const created: Array<{ count: number; colorA: unknown; colorB: unknown }> = []
  const patch = patchStatic(WebGPUParticleRenderer, 'create', async (_c: unknown, _d: unknown, opts: never) => {
    created.push(opts)
    return pr
  })
  try {
    await withGlobals(
      { ...kit.globals, navigator: fakeGpuNavigator({ maxTextureDimension2D: 4096 }) },
      () =>
        quietInfo(async () => {
          await app.run()
    expect(app.stats.backend).toBe('webgpu')
    expect(i.maxTextureDim).toBe(4096)
    expect(created).toHaveLength(1)
    expect(created[0].count).toBe(16)
    expect(created[0].colorA).toEqual(hexToLinear(i.colorA))
    expect(created[0].colorB).toEqual(hexToLinear(i.colorB))

    expect(pr.writesA).toHaveLength(1)
    expect(pr.writesB).toHaveLength(1)
    const first = pr.writesA[0]
    expect(first).toHaveLength(16 * 4)
    const seeded = pr.positions[0]
    expect(seeded).toHaveLength(first.length)
    for (let k = 0; k < first.length; k += 4) {
      expect(Math.abs(seeded[k] - first[k])).toBeLessThanOrEqual(1.4 + 1e-6)
      expect(Math.abs(seeded[k + 1] - first[k + 1])).toBeLessThanOrEqual(1.4 + 1e-6)
      expect(Math.abs(seeded[k + 2] - first[k + 2])).toBeLessThanOrEqual(1.4 + 1e-6)
      expect(seeded[k + 3]).toBe(first[k + 3]) // w untouched
    }
    expect(i.targetKinds).toEqual(['probe', 'probe'])
    expect(pr.textDamp).toBe(textDampTarget(false, 16))
    expect(typeof pr.onDeviceLost).toBe('function')
    expect(i.running).toBe(true)
    expect(kit.raf.scheduled).toHaveLength(1)

    // stalled loop + tab becomes visible again → the visibility watcher restarts it
    i.rafId = 0
    kit.doc.dispatch('visibilitychange')
    expect(kit.raf.scheduled).toHaveLength(2)
    app.dispose()
    expect(pr.disposed).toBe(1)
    pr.onDeviceLost?.() // wired to recovery, which is a no-op after dispose
    expect(i.recovering).toBe(false)
        }),
    )
  } finally {
    patch.restore()
  }
})

test('run() under prefers-reduced-motion settles the swarm into one static frame', async () => {
  const el = makeEl()
  const app = appOn(el).particles(8)
  app.shape(probeShape())
  const i = full(app)
  const kit = domKit({ reduce: true })
  const pr = fakeParticleRenderer()
  const patch = patchStatic(WebGPUParticleRenderer, 'create', async () => pr)
  try {
    await withGlobals({ ...kit.globals, navigator: fakeGpuNavigator() }, () =>
      quietInfo(() => app.run()),
    )
    expect(i.maxTextureDim).toBe(FALLBACK_DIM) // fake device exposes no limits
    expect(pr.frames).toHaveLength(240)
    expect(pr.frames[0][0]).toBeCloseTo(1 / 60, 9)
    expect(i.simTime).toBeCloseTo(240 / 60, 6)
    expect(pr.resizes.length).toBeGreaterThan(0)
    expect(i.running).toBe(false)
    expect(kit.raf.scheduled).toHaveLength(0)
    app.dispose()
  } finally {
    patch.restore()
  }
})

test('run() with a scene mounts the model renderer with the studio look by default', async () => {
  const el = makeEl()
  const app = appOn(el)
  app.scene({ keyboard: false })
  const i = full(app)
  const kit = domKit()
  const mr = fakeModelRenderer()
  const createdLooks: unknown[] = []
  const patch = patchStatic(WebGPUModelRenderer, 'create', async (_c: unknown, _d: unknown, look: unknown) => {
    createdLooks.push(look)
    return mr
  })
  try {
    await withGlobals({ ...kit.globals, navigator: fakeGpuNavigator() }, () =>
      quietInfo(async () => {
        await app.run()
        expect(app.stats.backend).toBe('webgpu')
        expect(createdLooks[0]).toEqual(looks.studio())
        expect(mr.colorA).toEqual(hexToLinear(i.colorA))
        expect(mr.colorB).toEqual(hexToLinear(i.colorB))
        expect(typeof mr.shadowArea).toBe('number')
        expect(typeof mr.onDeviceLost).toBe('function')
        expect(mr.autoRotate).not.toBe(0) // idle sway allowed
        expect(i.running).toBe(true)
        expect(kit.raf.scheduled).toHaveLength(1)
        app.dispose()
        mr.onDeviceLost?.() // wired to recovery, which is a no-op after dispose
        expect(i.recovering).toBe(false)
      }),
    )
  } finally {
    patch.restore()
  }
})

test('run() with a scene keeps an explicit look and reduced motion only stops the idle sway', async () => {
  const el = makeEl()
  const app = appOn(el).look('sakura')
  app.scene({ keyboard: false })
  const kit = domKit({ reduce: true })
  const mr = fakeModelRenderer()
  const createdLooks: unknown[] = []
  const patch = patchStatic(WebGPUModelRenderer, 'create', async (_c: unknown, _d: unknown, look: unknown) => {
    createdLooks.push(look)
    return mr
  })
  try {
    await withGlobals({ ...kit.globals, navigator: fakeGpuNavigator() }, () =>
      quietInfo(async () => {
        await app.run()
        expect(createdLooks[0]).toEqual(looks.sakura())
        expect(mr.autoRotate).toBe(0) // sway toned down…
        expect(full(app).running).toBe(true) // …but the game loop still runs
        expect(kit.raf.scheduled).toHaveLength(1)
        app.dispose()
      }),
    )
  } finally {
    patch.restore()
  }
})

test('run() with a model resolves the URL against the page and starts the viewer', async () => {
  const el = makeEl()
  const app = appOn(el).model('assets/robot.glb')
  const i = full(app)
  const kit = domKit()
  const mr = fakeModelRenderer()
  const patch = patchStatic(WebGPUModelRenderer, 'create', async () => mr)
  const pageHref = 'http://localhost:7777/deep/page.html'
  try {
    await withGlobals(
      { ...kit.globals, navigator: fakeGpuNavigator(), location: { href: pageHref } },
      () =>
        quietInfo(async () => {
          await app.run()
          expect(app.stats.backend).toBe('webgpu')
          expect(mr.loaded).toEqual([new URL('assets/robot.glb', pageHref).href])
          expect(i.running).toBe(true)
          expect(kit.raf.scheduled).toHaveLength(1)
          app.dispose()
          mr.onDeviceLost?.() // wired to recovery, which is a no-op after dispose
          expect(i.recovering).toBe(false)
        }),
    )
  } finally {
    patch.restore()
  }
})

test('run() with a model under reduced motion presents a single settled frame', async () => {
  const el = makeEl()
  const app = appOn(el).model('robot.glb')
  const i = full(app)
  const kit = domKit({ reduce: true })
  const mr = fakeModelRenderer()
  const patch = patchStatic(WebGPUModelRenderer, 'create', async () => mr)
  try {
    await withGlobals(
      { ...kit.globals, navigator: fakeGpuNavigator(), location: { href: 'http://localhost/' } },
      () => quietInfo(() => app.run()),
    )
    expect(mr.autoRotate).toBe(0)
    expect(mr.frames).toEqual([[1 / 60, 0]])
    expect(mr.resizes.length).toBeGreaterThan(0)
    expect(i.running).toBe(false)
    expect(kit.raf.scheduled).toHaveLength(0)
    app.dispose()
  } finally {
    patch.restore()
  }
})

import { yura } from '../src/app'

test('the yura() factory constructs a YuraApp bound to the target element', () => {
  const el = makeEl()
  const app = yura(el as unknown as HTMLElement)
  expect(app).toBeInstanceOf(YuraApp)
  expect(full(app).container).toBe(el)
  app.dispose()
})
