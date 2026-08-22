const DOCS_BASE = 'https://yura.dev/errors'

/**
 * Every user-facing failure carries a stable YURA-xxx code, a human fix hint,
 * and a docs URL. Raw GPU/stack traces stay in dev mode only.
 */
export class YuraError extends Error {
  readonly code: string
  readonly hint: string | undefined

  constructor(code: string, message: string, hint?: string) {
    super(`${code}: ${message}${hint ? `\n\nFix:\n  ${hint}` : ''}\n\nLearn more: ${DOCS_BASE}/${code}`)
    this.name = 'YuraError'
    this.code = code
    this.hint = hint
  }
}

export const CODES = {
  NO_WEBGPU: 'YURA-001',
  ADAPTER_FAILED: 'YURA-002',
  TARGET_NOT_FOUND: 'YURA-003',
  UNKNOWN_PRESET: 'YURA-010',
  UNKNOWN_LOOK: 'YURA-011',
  INVALID_COLOR: 'YURA-012',
  UNKNOWN_SHAPE: 'YURA-013',
  GROUND_REPLACED: 'YURA-014',
  UNKNOWN_EASE: 'YURA-015',
  ASSET_LOAD_FAILED: 'YURA-020',
  DEVICE_LOST: 'YURA-050',
} as const

export function warnCode(code: string, message: string): void {
  console.info(`[Yura] ${code}: ${message}\nLearn more: ${DOCS_BASE}/${code}`)
}
