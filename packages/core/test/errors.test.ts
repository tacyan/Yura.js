import { test, expect, spyOn } from 'bun:test'
import { YuraError, CODES, warnCode } from '../src/errors'

// Published docs base — part of the user-facing contract pinned by these tests.
// If this changes, every error message and docs link changes with it.
const DOCS_BASE = 'https://yura.dev/errors'

const CODE_PREFIX = 'YURA-'
const codeNumber = (code: string): number => Number(code.slice(CODE_PREFIX.length))

// ---------------------------------------------------------------------------
// YuraError: message/code/hint formatting contract
// ---------------------------------------------------------------------------

test('YuraError with a hint formats code, message, Fix block, and docs link', () => {
  const err = new YuraError(CODES.NO_WEBGPU, 'WebGPU is not available', 'Use a recent Chromium-based browser')
  expect(err.message).toBe(
    'YURA-001: WebGPU is not available' +
      '\n\nFix:\n  Use a recent Chromium-based browser' +
      `\n\nLearn more: ${DOCS_BASE}/YURA-001`,
  )
  expect(err.code).toBe(CODES.NO_WEBGPU)
  expect(err.hint).toBe('Use a recent Chromium-based browser')
})

test('YuraError without a hint omits the Fix block but keeps the docs link', () => {
  const err = new YuraError(CODES.ADAPTER_FAILED, 'No suitable GPU adapter')
  expect(err.message).toBe(`YURA-002: No suitable GPU adapter\n\nLearn more: ${DOCS_BASE}/YURA-002`)
  expect(err.message).not.toContain('Fix:')
  expect(err.hint).toBeUndefined()
})

test('YuraError message always starts with "<code>: " and ends with the docs URL for that code', () => {
  for (const code of Object.values(CODES)) {
    const err = new YuraError(code, 'boom')
    expect(err.message.startsWith(`${code}: `)).toBe(true)
    expect(err.message.endsWith(`Learn more: ${DOCS_BASE}/${code}`)).toBe(true)
  }
})

test('YuraError is a proper Error subclass', () => {
  const err = new YuraError(CODES.TARGET_NOT_FOUND, 'selector matched nothing')
  expect(err).toBeInstanceOf(YuraError)
  expect(err).toBeInstanceOf(Error)
  expect(err.name).toBe('YuraError')
})

test('YuraError hint is indented verbatim under Fix: (first line only, two spaces)', () => {
  const hint = 'line one\nline two'
  const err = new YuraError(CODES.UNKNOWN_PRESET, 'bad preset', hint)
  // Current contract: the hint string is inserted as-is after "Fix:\n  " —
  // continuation lines are NOT re-indented.
  expect(err.message).toContain(`\n\nFix:\n  ${hint}\n\n`)
})

// ---------------------------------------------------------------------------
// CODES: naming/format contract (duplicate-value check lives in core.test.ts)
// ---------------------------------------------------------------------------

test('every CODES value matches the YURA-0NN format (zero-padded, three digits)', () => {
  for (const value of Object.values(CODES)) {
    expect(value).toMatch(/^YURA-0\d{2}$/)
  }
})

test('every CODES key is SCREAMING_SNAKE_CASE', () => {
  for (const key of Object.keys(CODES)) {
    expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/)
  }
})

test('CODES numbers are strictly increasing in declaration order', () => {
  const nums = Object.values(CODES).map(codeNumber)
  for (const n of nums) expect(Number.isInteger(n)).toBe(true)
  for (let i = 1; i < nums.length; i++) {
    expect(nums[i]).toBeGreaterThan(nums[i - 1])
  }
})

test('CODES numbering is banded, not contiguous: gaps between categories are intentional', () => {
  const nums = Object.values(CODES).map(codeNumber)
  // The registry reserves ranges per category (environment 00x, config 01x,
  // assets 02x, runtime 05x), so the highest number exceeds the count —
  // i.e. holes exist and contiguity is NOT part of the contract.
  expect(Math.max(...nums)).toBeGreaterThan(nums.length)
  // Every code belongs to one of the currently reserved bands.
  const bands = new Set(nums.map((n) => Math.floor(n / 10)))
  expect([...bands].sort((a, b) => a - b)).toEqual([0, 1, 2, 5])
})

// ---------------------------------------------------------------------------
// warnCode: console output contract
// ---------------------------------------------------------------------------

test('warnCode logs "[Yura] <code>: <message>" plus docs link via console.info', () => {
  const info = spyOn(console, 'info').mockImplementation(() => {})
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  const error = spyOn(console, 'error').mockImplementation(() => {})
  try {
    warnCode(CODES.UNKNOWN_LOOK, 'unknown look "neon", falling back to default')
    expect(info).toHaveBeenCalledTimes(1)
    expect(info).toHaveBeenCalledWith(
      '[Yura] YURA-011: unknown look "neon", falling back to default' +
        `\nLearn more: ${DOCS_BASE}/YURA-011`,
    )
    // The channel is console.info — warnings must not pollute warn/error.
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  } finally {
    info.mockRestore()
    warn.mockRestore()
    error.mockRestore()
  }
})

test('warnCode has no warnOnce-style suppression: repeated identical calls each log', () => {
  const info = spyOn(console, 'info').mockImplementation(() => {})
  try {
    // Current contract: no dedup. If suppression is ever added, this test
    // must be updated deliberately alongside the docs.
    warnCode(CODES.INVALID_COLOR, 'bad color')
    warnCode(CODES.INVALID_COLOR, 'bad color')
    warnCode(CODES.INVALID_COLOR, 'bad color')
    expect(info).toHaveBeenCalledTimes(3)
    for (const call of info.mock.calls) {
      expect(call[0]).toBe(`[Yura] YURA-012: bad color\nLearn more: ${DOCS_BASE}/YURA-012`)
    }
  } finally {
    info.mockRestore()
  }
})

// ---------------------------------------------------------------------------
// Boundaries: empty message, undefined/empty hint
// ---------------------------------------------------------------------------

test('YuraError with an empty message still yields a well-formed string', () => {
  const err = new YuraError(CODES.DEVICE_LOST, '')
  expect(err.message).toBe(`YURA-050: \n\nLearn more: ${DOCS_BASE}/YURA-050`)
  expect(err.message).not.toContain('Fix:')
})

test('YuraError with an empty-string hint behaves like no hint in the message, but stores it', () => {
  const err = new YuraError(CODES.ASSET_LOAD_FAILED, 'fetch failed', '')
  // '' is falsy, so the Fix block is omitted from the user-facing message...
  expect(err.message).not.toContain('Fix:')
  // ...yet the hint property keeps the empty string (it is only undefined
  // when the argument is omitted). Current behavior, asserted on purpose.
  expect(err.hint).toBe('')
})

test('warnCode with an empty message keeps the "[Yura] <code>: " frame and docs link', () => {
  const info = spyOn(console, 'info').mockImplementation(() => {})
  try {
    warnCode(CODES.GROUND_REPLACED, '')
    expect(info).toHaveBeenCalledWith(`[Yura] YURA-014: \nLearn more: ${DOCS_BASE}/YURA-014`)
  } finally {
    info.mockRestore()
  }
})
