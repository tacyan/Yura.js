import { test, expect } from 'bun:test'
import { reducedMotionPolicy, drainCleanups, resetSceneHandles } from '../src/app'
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
