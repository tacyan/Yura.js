/**
 * Lifecycle tests for the `yura/react` adapter (`useYura`).
 *
 * React is not installed in this workspace (by design — it is an optional
 * peer of the published package), so the bare `'react'` import inside
 * `src/react.ts` is satisfied with `mock.module`: a minimal fake hook
 * runtime (useRef/useState/useEffect) plus a tiny renderer harness that
 * mirrors React's ordering — render → refs attached → effects flushed —
 * and supports re-render and unmount. YuraApp's `run`/`dispose` are spied
 * on the real prototype, so the hook drives the real `yura()` factory.
 */
import { afterAll, afterEach, describe, expect, mock, spyOn, test } from 'bun:test'

// ---------------------------------------------------------------------------
// Fake React
// ---------------------------------------------------------------------------

type Cleanup = (() => void) | void

interface EffectSlot {
  fn: () => Cleanup
  deps: readonly unknown[] | undefined
  prevDeps: readonly unknown[] | undefined
  cleanup: Cleanup
  mounted: boolean
}

interface Instance {
  cells: unknown[]
  cursor: number
  effects: EffectSlot[]
  pending: Array<{ fn: () => Cleanup; deps: readonly unknown[] | undefined }>
}

let current: Instance | null = null

function instance(): Instance {
  if (!current) throw new Error('hook called outside a component render')
  return current
}

function useRef<T>(initialValue: T): { current: T } {
  const inst = instance()
  const i = inst.cursor++
  if (inst.cells.length <= i) inst.cells.push({ current: initialValue })
  return inst.cells[i] as { current: T }
}

function useState<S>(initialState: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void] {
  const inst = instance()
  const i = inst.cursor++
  if (inst.cells.length <= i) {
    const cell = {
      value: typeof initialState === 'function' ? (initialState as () => S)() : initialState,
      set(next: S | ((prev: S) => S)) {
        cell.value = typeof next === 'function' ? (next as (prev: S) => S)(cell.value) : next
      },
    }
    inst.cells.push(cell)
  }
  const cell = inst.cells[i] as { value: S; set: (next: S | ((prev: S) => S)) => void }
  return [cell.value, cell.set]
}

function useEffect(fn: () => Cleanup, deps?: readonly unknown[]): void {
  instance().pending.push({ fn, deps })
}

function depsChanged(
  prev: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined,
): boolean {
  if (prev === undefined || next === undefined) return true
  if (prev.length !== next.length) return true
  return prev.some((value, i) => !Object.is(value, next[i]))
}

/** Mount a component. Like React, effects do NOT run inside render(): the
 *  caller attaches refs first, then calls flushEffects() (or rerender(),
 *  which renders and flushes). unmount() runs effect cleanups in reverse. */
function render<T>(component: () => T) {
  const inst: Instance = { cells: [], cursor: 0, effects: [], pending: [] }
  let result!: T
  const doRender = () => {
    inst.cursor = 0
    inst.pending = []
    current = inst
    try {
      result = component()
    } finally {
      current = null
    }
  }
  const flushEffects = () => {
    inst.pending.forEach((p, i) => {
      let slot = inst.effects[i]
      if (!slot) {
        slot = { fn: p.fn, deps: p.deps, prevDeps: undefined, cleanup: undefined, mounted: false }
        inst.effects.push(slot)
      } else {
        slot.fn = p.fn
        slot.deps = p.deps
      }
      if (!slot.mounted || depsChanged(slot.prevDeps, slot.deps)) {
        if (typeof slot.cleanup === 'function') slot.cleanup()
        slot.cleanup = slot.fn()
        slot.prevDeps = slot.deps
        slot.mounted = true
      }
    })
  }
  doRender()
  return {
    get result() {
      return result
    },
    flushEffects,
    rerender() {
      doRender()
      flushEffects()
    },
    unmount() {
      for (const slot of [...inst.effects].reverse()) {
        if (typeof slot.cleanup === 'function') slot.cleanup()
        slot.cleanup = undefined
        slot.mounted = false
      }
    },
  }
}

// The fake must be registered BEFORE the module under test resolves 'react'.
mock.module('react', () => ({ useRef, useState, useEffect }))

const { useYura } = await import('../src/react')
const { YuraApp } = await import('../src/app')

// ---------------------------------------------------------------------------
// Spies on the real YuraApp prototype — the hook calls the real yura().
// ---------------------------------------------------------------------------

const order: string[] = []
const runSpy = spyOn(YuraApp.prototype, 'run').mockImplementation(function (this: unknown) {
  order.push('run')
  return Promise.resolve(this)
} as (typeof YuraApp.prototype)['run'])
const disposeSpy = spyOn(YuraApp.prototype, 'dispose').mockImplementation(function () {
  order.push('dispose')
})

afterEach(() => {
  runSpy.mockClear()
  disposeSpy.mockClear()
  order.length = 0
})

afterAll(() => {
  runSpy.mockRestore()
  disposeSpy.mockRestore()
})

const fakeElement = () => ({ nodeType: 1, tagName: 'DIV' }) as unknown as HTMLDivElement

const flushMicrotasks = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

// ---------------------------------------------------------------------------

describe('useYura', () => {
  test('returns a null ref and a null app before effects run', () => {
    const h = render(() => useYura())
    expect(h.result.ref.current).toBeNull()
    expect(h.result.app).toBeNull()
    expect(runSpy).not.toHaveBeenCalled()
    h.unmount()
    expect(disposeSpy).not.toHaveBeenCalled()
  })

  test('does nothing when the ref was never attached to an element', () => {
    const h = render(() => useYura())
    h.flushEffects()
    h.rerender()
    expect(h.result.app).toBeNull()
    expect(runSpy).not.toHaveBeenCalled()
    h.unmount()
    expect(disposeSpy).not.toHaveBeenCalled()
  })

  test('mount order is yura(el) → setup(app) → run(), app exposed on the next render', () => {
    const seen: unknown[] = []
    const h = render(() =>
      useYura((app) => {
        order.push('setup')
        seen.push(app)
      }),
    )
    h.result.ref.current = fakeElement()
    h.flushEffects()

    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeInstanceOf(YuraApp)
    expect(order).toEqual(['setup', 'run']) // setup configures the app BEFORE run()
    expect(runSpy).toHaveBeenCalledTimes(1)

    // State set inside the effect becomes visible on the following render.
    expect(h.result.app).toBeNull()
    h.rerender()
    expect(h.result.app).toBe(seen[0] as InstanceType<typeof YuraApp>)

    // Mount-once semantics: a re-render must not create or run a second app.
    h.rerender()
    expect(runSpy).toHaveBeenCalledTimes(1)
    expect(disposeSpy).not.toHaveBeenCalled()
    h.unmount()
  })

  test('unmount runs the setup cleanup BEFORE dispose(), exactly once', () => {
    const h = render(() =>
      useYura(() => () => {
        order.push('cleanup')
      }),
    )
    h.result.ref.current = fakeElement()
    h.flushEffects()
    h.unmount()
    expect(order).toEqual(['run', 'cleanup', 'dispose'])
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  test('with no setup at all, mount runs and unmount still disposes', () => {
    const h = render(() => useYura(undefined, { quality: 'high', backend: 'webgl2' }))
    h.result.ref.current = fakeElement()
    h.flushEffects()
    expect(runSpy).toHaveBeenCalledTimes(1)
    h.unmount()
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  test('a throwing setup cleanup still lets dispose() run', () => {
    const h = render(() =>
      useYura(() => () => {
        throw new Error('consumer cleanup bug')
      }),
    )
    h.result.ref.current = fakeElement()
    h.flushEffects()
    expect(() => h.unmount()).toThrow('consumer cleanup bug')
    expect(disposeSpy).toHaveBeenCalledTimes(1) // finally-block guarantee
  })

  test('a run() rejection while mounted is reported, never thrown', async () => {
    runSpy.mockImplementationOnce(() => Promise.reject(new Error('no gpu')))
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const h = render(() => useYura())
      h.result.ref.current = fakeElement()
      h.flushEffects()
      await flushMicrotasks()
      expect(errSpy).toHaveBeenCalledTimes(1)
      h.unmount()
      expect(disposeSpy).toHaveBeenCalledTimes(1)
    } finally {
      errSpy.mockRestore()
    }
  })

  test('a run() rejection AFTER unmount stays silent (StrictMode teardown race)', async () => {
    let rejectRun!: (err: Error) => void
    runSpy.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRun = reject
        }) as ReturnType<(typeof YuraApp.prototype)['run']>,
    )
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const h = render(() => useYura())
      h.result.ref.current = fakeElement()
      h.flushEffects()
      h.unmount()
      rejectRun(new Error('device lost during teardown'))
      await flushMicrotasks()
      expect(errSpy).not.toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
    }
  })

  test('remount (StrictMode-style) creates a fresh app and disposes the old one', () => {
    const apps: unknown[] = []
    const component = () =>
      useYura((app) => {
        apps.push(app)
      })

    const first = render(component)
    first.result.ref.current = fakeElement()
    first.flushEffects()
    first.unmount()
    expect(disposeSpy).toHaveBeenCalledTimes(1)

    const second = render(component)
    second.result.ref.current = fakeElement()
    second.flushEffects()

    expect(apps).toHaveLength(2)
    expect(apps[1]).not.toBe(apps[0])
    expect(runSpy).toHaveBeenCalledTimes(2)
    second.unmount()
    expect(disposeSpy).toHaveBeenCalledTimes(2)
  })
})
