export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Calls back with `false` when the tab is hidden OR the element scrolls
 * offscreen, `true` when both are visible again. Returns a cleanup function.
 *
 * The current state is emitted synchronously on subscription, so a tab that
 * starts out hidden is reported immediately (without IntersectionObserver
 * nothing else would fire until the first visibilitychange). In non-DOM
 * environments (no `document`) this is a no-op and returns a no-op disposer.
 */
export function watchVisibility(el: Element, cb: (visible: boolean) => void): () => void {
  if (typeof document === 'undefined') return () => {}

  let tabVisible = document.visibilityState !== 'hidden'
  let inViewport = true

  const emit = () => cb(tabVisible && inViewport)

  const onVisibility = () => {
    tabVisible = document.visibilityState !== 'hidden'
    emit()
  }
  document.addEventListener('visibilitychange', onVisibility)

  let io: IntersectionObserver | undefined
  if (typeof IntersectionObserver === 'function') {
    io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        inViewport = entry.isIntersecting
      }
      emit()
    })
    io.observe(el)
  }

  // Initial synchronous emit so subscribers learn the starting state.
  emit()

  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    io?.disconnect()
  }
}
