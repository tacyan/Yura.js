import { CODES, warnCode } from './errors'

export type Backend = 'webgpu' | 'webgl2' | 'poster'

export interface GPUHandles {
  adapter: GPUAdapter
  device: GPUDevice
}

/**
 * Single place for GPU capability detection (spec §10 保守性).
 * Returns null instead of throwing — callers fall back, never white-screen.
 */
export async function acquireWebGPU(): Promise<GPUHandles | null> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) {
    warnCode(CODES.NO_WEBGPU, 'WebGPU is not available in this browser. Falling back to a static poster.')
    return null
  }
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) {
      warnCode(CODES.ADAPTER_FAILED, 'No suitable GPU adapter found. Falling back to a static poster.')
      return null
    }
    const device = await adapter.requestDevice()
    return { adapter, device }
  } catch (err) {
    warnCode(CODES.ADAPTER_FAILED, `GPU device request failed (${(err as Error).message}). Falling back to a static poster.`)
    return null
  }
}
