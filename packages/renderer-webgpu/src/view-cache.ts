/**
 * Per-texture view cache for offscreen render targets.
 *
 * `GPUTexture.createView()` allocates a fresh view object every call, so the
 * post chain (fade → scene → bright → blur → streak → composite) was creating
 * six garbage views per frame. Offscreen textures only change on resize, so
 * their views can live as long as the texture does: the cache hands back the
 * same view until `invalidate()` advances the generation (called whenever the
 * textures are destroyed and re-created).
 *
 * The swapchain texture (`context.getCurrentTexture()`) is a new texture every
 * frame and must NOT go through this cache.
 */

/** Structural subset of GPUTexture the cache needs; lets tests use fakes. */
export interface ViewSource<V> {
  createView(): V
}

interface Entry<V> {
  view: V
  generation: number
}

export class ViewCache<V = GPUTextureView> {
  private generation = 0
  private readonly entries = new Map<ViewSource<V>, Entry<V>>()

  /**
   * Return the cached view for `texture`, creating it only on the first
   * request per texture per generation.
   */
  getView(texture: ViewSource<V>): V {
    const entry = this.entries.get(texture)
    if (entry && entry.generation === this.generation) return entry.view
    const view = texture.createView()
    this.entries.set(texture, { view, generation: this.generation })
    return view
  }

  /**
   * Drop every cached view and advance the generation. Call whenever the
   * backing textures are destroyed/re-created (resize, dispose): stale views
   * of a destroyed texture must never be handed out again.
   */
  invalidate(): void {
    this.generation++
    this.entries.clear()
  }
}

/**
 * Module-level zero-filled scratch shared by callers that need "a run of
 * zeroes" to upload (e.g. clearing velocities in `writePositions`). Grows only
 * when a larger length is requested; otherwise the same instance is returned.
 *
 * INVARIANT: callers must never write into the returned array — it is always
 * all zeroes. Pass an explicit element count to `queue.writeBuffer` since the
 * scratch may be longer than requested.
 */
let zeroScratch = new Float32Array(0) as Float32Array<ArrayBuffer>

export function getZeroScratch(length: number): Float32Array<ArrayBuffer> {
  if (zeroScratch.length < length) {
    zeroScratch = new Float32Array(length)
  }
  return zeroScratch
}
