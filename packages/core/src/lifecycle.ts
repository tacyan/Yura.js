export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Calls back with `false` when the tab is hidden OR the element scrolls
 * offscreen, `true` when both are visible again. Returns a cleanup function.
 */
export function watchVisibility(el: Element, cb: (visible: boolean) => void): () => void {
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

  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    io?.disconnect()
  }
}
