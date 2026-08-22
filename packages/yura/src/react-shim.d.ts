/**
 * Minimal ambient typing for the OPTIONAL `react` peer used by `react.ts`,
 * so this repo type-checks without React installed (the workspace adds no
 * react dependency by design — consumers bring their own React).
 *
 * NEVER SHIPPED: tsc's declaration emit does not copy input .d.ts files to
 * the outDir, so `dist-npm/types` cannot contain this module. Published
 * consumers resolve `react` against their own React typings, and the shipped
 * `react.d.ts` is purely structural (it references no React types at all),
 * so this shim can never collide with a real `@types/react`.
 *
 * Keep the signatures here to the strict minimum `react.ts` needs.
 */
declare module 'react' {
  export function useRef<T>(initialValue: T): { current: T }
  export function useState<S>(
    initialState: S | (() => S),
  ): [S, (next: S | ((prev: S) => S)) => void]
  export function useEffect(
    effect: () => void | (() => void),
    deps?: readonly unknown[],
  ): void
}
