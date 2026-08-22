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
