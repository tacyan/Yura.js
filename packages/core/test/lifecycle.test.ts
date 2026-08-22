import { test, expect, spyOn } from 'bun:test'
import { prefersReducedMotion, watchVisibility } from '../src/lifecycle'
import { acquireWebGPU } from '../src/capabilities'

// Tests swap DOM globals (document / IntersectionObserver / matchMedia / navigator)
// in and out, so the global object is handled untyped here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type Listener = (ev?: unknown) => void

function makeFakeDocument(initial: 'visible' | 'hidden' = 'visible') {
  const listeners = new Map<string, Listener[]>()
  const doc = {
    visibilityState: initial as 'visible' | 'hidden',
    addCalls: 0,
    removeCalls: 0,
    addEventListener(type: string, fn: Listener) {
      doc.addCalls++
      const arr = listeners.get(type) ?? []
      arr.push(fn)
      listeners.set(type, arr)
    },
    removeEventListener(type: string, fn: Listener) {
      doc.removeCalls++
      const arr = listeners.get(type) ?? []
      const i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
    },
    fire(type: string) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn()
    },
    listenerCount(type: string) {
      return (listeners.get(type) ?? []).length
    },
  }
  return doc
}

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  cb: (entries: Array<{ isIntersecting: boolean }>) => void
  observed: unknown[] = []
  disconnectCalls = 0
  constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
    this.cb = cb
    FakeIntersectionObserver.instances.push(this)
  }
  observe(el: unknown) {
    this.observed.push(el)
  }
  disconnect() {
    this.disconnectCalls++
  }
}

/** Installs fake document/IntersectionObserver globals; returns a restore fn. */
function installDomFakes(doc: ReturnType<typeof makeFakeDocument> | undefined, withIO: boolean) {
  const hadDocument = 'document' in g
  const prevDocument = g.document
  const hadIO = 'IntersectionObserver' in g
  const prevIO = g.IntersectionObserver
  FakeIntersectionObserver.instances = []
  if (doc) g.document = doc
  if (withIO) g.IntersectionObserver = FakeIntersectionObserver
  else delete g.IntersectionObserver
  return () => {
    if (hadDocument) g.document = prevDocument
    else delete g.document
    if (hadIO) g.IntersectionObserver = prevIO
    else delete g.IntersectionObserver
  }
}

// ---------------------------------------------------------------------------
// prefersReducedMotion
// ---------------------------------------------------------------------------

test('prefersReducedMotion is false when matchMedia is undefined', () => {
  expect(typeof matchMedia).toBe('undefined')
  expect(prefersReducedMotion()).toBe(false)
})

test('prefersReducedMotion reflects matchMedia matches', () => {
  const hadMM = 'matchMedia' in g
  const prevMM = g.matchMedia
  const queries: string[] = []
  try {
    let matches = true
    g.matchMedia = (query: string) => {
      queries.push(query)
      return { matches }
    }
    expect(prefersReducedMotion()).toBe(true)
    matches = false
    expect(prefersReducedMotion()).toBe(false)
    expect(queries).toEqual([
      '(prefers-reduced-motion: reduce)',
      '(prefers-reduced-motion: reduce)',
    ])
  } finally {
    if (hadMM) g.matchMedia = prevMM
    else delete g.matchMedia
  }
})

// ---------------------------------------------------------------------------
// watchVisibility
// ---------------------------------------------------------------------------

test('watchVisibility emits on tab visibility and viewport changes', () => {
  const doc = makeFakeDocument('visible')
  const restore = installDomFakes(doc, true)
  try {
    const el = {} as Element
    const calls: boolean[] = []
    const dispose = watchVisibility(el, (v) => calls.push(v))
    try {
      // the initial state is emitted synchronously; observer is registered on the element
      expect(calls).toEqual([true])
      expect(doc.addCalls).toBe(1)
      expect(doc.listenerCount('visibilitychange')).toBe(1)
      const io = FakeIntersectionObserver.instances[0]
      expect(io).toBeDefined()
      expect(io.observed).toEqual([el])

      // tab hidden -> false, visible again -> true
      doc.visibilityState = 'hidden'
      doc.fire('visibilitychange')
      doc.visibilityState = 'visible'
      doc.fire('visibilitychange')
      expect(calls).toEqual([true, false, true])

      // leaves viewport -> false, re-enters -> true
      io.cb([{ isIntersecting: false }])
      io.cb([{ isIntersecting: true }])
      expect(calls).toEqual([true, false, true, false, true])

      // hidden tab wins even while the element is in the viewport
      doc.visibilityState = 'hidden'
      doc.fire('visibilitychange')
      io.cb([{ isIntersecting: true }])
      expect(calls).toEqual([true, false, true, false, true, false, false])
    } finally {
      dispose()
    }
  } finally {
    restore()
  }
})

test('watchVisibility disposer removes every listener and disconnects the observer', () => {
  const doc = makeFakeDocument('visible')
  const restore = installDomFakes(doc, true)
  try {
    const calls: boolean[] = []
    const dispose = watchVisibility({} as Element, (v) => calls.push(v))
    dispose()

    expect(doc.removeCalls).toBe(doc.addCalls)
    expect(doc.listenerCount('visibilitychange')).toBe(0)
    const io = FakeIntersectionObserver.instances[0]
    expect(io.disconnectCalls).toBe(1)

    // firing after dispose reaches no listener (only the initial emit remains)
    doc.visibilityState = 'hidden'
    doc.fire('visibilitychange')
    expect(calls).toEqual([true])

    // disposing twice stays balanced overall (each remove matched a listener list no-op)
    dispose()
    expect(doc.listenerCount('visibilitychange')).toBe(0)
    expect(io.disconnectCalls).toBe(2)
  } finally {
    restore()
  }
})

test('watchVisibility works without IntersectionObserver (visibility only)', () => {
  const doc = makeFakeDocument('hidden')
  const restore = installDomFakes(doc, false)
  try {
    const calls: boolean[] = []
    const dispose = watchVisibility({} as Element, (v) => calls.push(v))
    try {
      expect(FakeIntersectionObserver.instances).toEqual([])
      // hidden-at-start is reported immediately, not only on the first event
      expect(calls).toEqual([false])
      doc.visibilityState = 'visible'
      doc.fire('visibilitychange')
      expect(calls).toEqual([false, true])
    } finally {
      dispose()
    }
    expect(doc.removeCalls).toBe(doc.addCalls)
    expect(doc.listenerCount('visibilitychange')).toBe(0)
  } finally {
    restore()
  }
})

test('watchVisibility emits the initial hidden state synchronously with IntersectionObserver present', () => {
  const doc = makeFakeDocument('hidden')
  const restore = installDomFakes(doc, true)
  try {
    const calls: boolean[] = []
    const dispose = watchVisibility({} as Element, (v) => calls.push(v))
    try {
      expect(calls).toEqual([false])
    } finally {
      dispose()
    }
  } finally {
    restore()
  }
})

test('watchVisibility is a no-op in non-DOM environments (no document)', () => {
  const restore = installDomFakes(undefined, false)
  try {
    expect(typeof document).toBe('undefined')
    const calls: boolean[] = []
    const dispose = watchVisibility({} as Element, (v) => calls.push(v))
    expect(calls).toEqual([])
    expect(FakeIntersectionObserver.instances).toEqual([])
    expect(() => dispose()).not.toThrow()
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------------------
// acquireWebGPU
// ---------------------------------------------------------------------------

/** Swaps globalThis.navigator; returns a restore fn. */
function swapNavigator(value: unknown) {
  const prev = g.navigator
  g.navigator = value as Navigator
  return () => {
    g.navigator = prev
  }
}

test('acquireWebGPU returns null and warns YURA-001 when navigator.gpu is missing', async () => {
  // Inject a gpu-less navigator: the runtime's own navigator may or may not
  // expose gpu (bun >= 1.4 does), so the test must never depend on it.
  const restore = swapNavigator({})
  const info = spyOn(console, 'info').mockImplementation(() => {})
  try {
    expect(await acquireWebGPU()).toBeNull()
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0][0]).toContain('YURA-001')
  } finally {
    info.mockRestore()
    restore()
  }
})

test('acquireWebGPU returns null and warns YURA-001 when navigator is undefined', async () => {
  const restore = swapNavigator(undefined)
  const info = spyOn(console, 'info').mockImplementation(() => {})
  try {
    expect(await acquireWebGPU()).toBeNull()
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0][0]).toContain('YURA-001')
  } finally {
    info.mockRestore()
    restore()
  }
})

test('acquireWebGPU returns null and warns YURA-002 when no adapter is found', async () => {
  const requests: unknown[] = []
  const restore = swapNavigator({
    gpu: {
      requestAdapter: async (opts: unknown) => {
        requests.push(opts)
        return null
      },
    },
  })
  const info = spyOn(console, 'info').mockImplementation(() => {})
  try {
    expect(await acquireWebGPU()).toBeNull()
    expect(requests).toEqual([{ powerPreference: 'high-performance' }])
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0][0]).toContain('YURA-002')
  } finally {
    info.mockRestore()
    restore()
  }
})

test('acquireWebGPU returns null and warns YURA-002 when requestDevice throws', async () => {
  const restore = swapNavigator({
    gpu: {
      requestAdapter: async () => ({
        requestDevice: async () => {
          throw new Error('device lost')
        },
      }),
    },
  })
  const info = spyOn(console, 'info').mockImplementation(() => {})
  try {
    expect(await acquireWebGPU()).toBeNull()
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0][0]).toContain('YURA-002')
    expect(info.mock.calls[0][0]).toContain('device lost')
  } finally {
    info.mockRestore()
    restore()
  }
})

test('acquireWebGPU resolves adapter and device on success', async () => {
  const device = { label: 'fake-device' }
  const adapter = { requestDevice: async () => device }
  const restore = swapNavigator({
    gpu: { requestAdapter: async () => adapter },
  })
  const info = spyOn(console, 'info').mockImplementation(() => {})
  try {
    const handles = await acquireWebGPU()
    expect(handles).not.toBeNull()
    expect(handles!.adapter).toBe(adapter as unknown as GPUAdapter)
    expect(handles!.device).toBe(device as unknown as GPUDevice)
    expect(info).not.toHaveBeenCalled()
  } finally {
    info.mockRestore()
    restore()
  }
})
