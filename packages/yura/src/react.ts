/**
 * React adapter — the `yura/react` (npm: `yurayura/react`) subpath.
 *
 * React itself is intentionally NOT a dependency of this package. The single
 * `import … from 'react'` below is a bare specifier the CONSUMER's bundler
 * resolves against the React copy already in their app (declared as an
 * optional peer dependency, `react >= 17`, in the published manifest).
 * Inside this repo the specifier type-checks against the minimal ambient
 * shim in `react-shim.d.ts`, which is never shipped: every public signature
 * here is structural (no React type references), so the emitted `react.d.ts`
 * can never collide with the consumer's own `@types/react`.
 *
 * @example
 * ```ts
 * import { createElement } from 'react'
 * import { useYura } from 'yurayura/react'
 *
 * function Hero() {
 *   const { ref } = useYura((app) => { app.look('cyberpunk') })
 *   return createElement('div', { ref, style: { height: '60vh' } })
 * }
 * ```
 */
import { useEffect, useRef, useState } from 'react'
import { yura } from './app'
import type { YuraApp, YuraOptions } from './app'

/**
 * Mutable ref container, structurally compatible with the `ref` prop of any
 * React DOM element across @types/react 17–19 (`{ current: E | null }`).
 */
export interface YuraRefObject<E> {
  current: E | null
}

/**
 * Optional mount callback for {@link useYura}: receives the {@link YuraApp}
 * after it is created but BEFORE `run()` starts, so chained configuration
 * (`app.look(…)`, `app.morphTo(…)`, …) applies to the first frame. It may
 * return a cleanup function, which runs on unmount before `app.dispose()`.
 */
export type YuraSetup = (app: YuraApp) => void | (() => void)

/** What {@link useYura} returns. */
export interface UseYuraResult<E extends HTMLElement = HTMLDivElement> {
  /** Attach to the container element: `createElement('div', { ref })`. */
  ref: YuraRefObject<E>
  /** `null` until the mount effect has run, the live {@link YuraApp} after. */
  app: YuraApp | null
}

/**
 * Mount a Yura app on a React-managed element and tie its lifecycle to the
 * component: on mount `yura(el, opts)` → `setup(app)` → `app.run()`; on
 * unmount the setup's returned cleanup (if any), then `app.dispose()`.
 *
 * `setup` and `opts` are captured when the effect first runs — the scene is
 * created once per mounted element (StrictMode's double-invoked effect simply
 * disposes the first app and creates a fresh one). If the ref was never
 * attached to an element, the hook does nothing and `app` stays `null`.
 */
export function useYura<E extends HTMLElement = HTMLDivElement>(
  setup?: YuraSetup,
  opts?: YuraOptions,
): UseYuraResult<E> {
  const ref = useRef<E | null>(null)
  const [app, setApp] = useState<YuraApp | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let unmounted = false
    const instance = yura(el, opts)
    const cleanup = setup?.(instance)
    instance.run().catch((err: unknown) => {
      // A rejection AFTER unmount is expected teardown noise (dispose() races
      // GPU init, e.g. under StrictMode's mount/unmount/mount) — stay silent.
      if (!unmounted) console.error('[yura] run() failed:', err)
    })
    setApp(instance)
    return () => {
      unmounted = true
      try {
        if (typeof cleanup === 'function') cleanup()
      } finally {
        instance.dispose()
      }
    }
    // Intentionally mount-once: setup/opts are captured by the first run.
  }, [])
  return { ref, app }
}
