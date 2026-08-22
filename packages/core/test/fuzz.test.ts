/**
 * Deterministic fuzz tests for @yura/core numeric/parser boundaries:
 *   - hexToLinear: any string in -> 3 finite components in [0,1]; the warn
 *     path must report YURA-012 (CODES.INVALID_COLOR) and fall back to white.
 *   - eulerToQuat / trsToMat4: extreme-but-finite inputs (±1e30, ±0, no NaN)
 *     -> every output component stays finite.
 *
 * Randomness is a seeded LCG implemented below (no Math.random) so every run
 * is reproducible; assertion messages carry the seed and case number.
 */
import { test, expect } from 'bun:test'
import { hexToLinear, eulerToQuat, trsToMat4, type Vec3, type Vec4 } from '../src/math'
import { CODES } from '../src/errors'

const SEED = 0xc0de01

function makeLcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

const randInt = (rng: () => number, min: number, maxIncl: number): number =>
  min + Math.floor(rng() * (maxIncl - min + 1))

const pick = <T,>(rng: () => number, arr: readonly T[]): T => arr[randInt(rng, 0, arr.length - 1)]

function report(failures: string[], total: number, target: string): void {
  if (failures.length === 0) return
  throw new Error(
    `[fuzz seed=0x${SEED.toString(16)} target=${target}] ${failures.length}/${total} cases failed:\n` +
      failures
        .slice(0, 6)
        .map((f) => `  ${f}`)
        .join('\n') +
      (failures.length > 6 ? `\n  ... and ${failures.length - 6} more` : ''),
  )
}

// ---------------------------------------------------------------------------
// hexToLinear
// ---------------------------------------------------------------------------

const HEX_CHARS = '0123456789abcdefABCDEF'
const CORRUPT_CHARS = 'ghijklmnzZ!@ .-#切'

function genColorCase(rng: () => number, kind: number): { input: string; guaranteedValid: boolean } {
  if (kind === 0) {
    // Guaranteed-valid: #rgb / #rrggbb / #rrggbbaa (leading # optional).
    const len = pick(rng, [3, 6, 8])
    let s = randInt(rng, 0, 1) === 0 ? '#' : ''
    for (let k = 0; k < len; k++) s += HEX_CHARS[randInt(rng, 0, HEX_CHARS.length - 1)]
    return { input: s, guaranteedValid: true }
  }
  if (kind === 1) {
    // Random printable ASCII.
    const len = randInt(rng, 0, 12)
    let s = ''
    for (let k = 0; k < len; k++) s += String.fromCharCode(randInt(rng, 32, 126))
    return { input: s, guaranteedValid: false }
  }
  // Near-hex: hex digits with off lengths and/or one corrupted character.
  const len = pick(rng, [1, 2, 3, 4, 5, 6, 7, 8, 9])
  const chars: string[] = []
  for (let k = 0; k < len; k++) chars.push(HEX_CHARS[randInt(rng, 0, HEX_CHARS.length - 1)])
  if (len > 0 && randInt(rng, 0, 1) === 0) {
    chars[randInt(rng, 0, len - 1)] = CORRUPT_CHARS[randInt(rng, 0, CORRUPT_CHARS.length - 1)]
  }
  return { input: '#' + chars.join(''), guaranteedValid: false }
}

test('hexToLinear always yields finite [0,1] components; warn path is YURA-012', () => {
  const CASES = 450
  const rng = makeLcg(SEED ^ 0x11)
  const failures: string[] = []
  const captured: string[] = []
  let warnHits = 0
  const origInfo = console.info
  console.info = (...args: unknown[]) => {
    captured.push(args.map(String).join(' '))
  }
  try {
    for (let i = 0; i < CASES; i++) {
      const { input, guaranteedValid } = genColorCase(rng, i % 3)
      const tag = `case=${i} input=${JSON.stringify(input)}`
      const before = captured.length
      const out = hexToLinear(input)
      const warned = captured.length > before
      if (out.length !== 3 || out.some((c) => !Number.isFinite(c) || c < 0 || c > 1)) {
        failures.push(`${tag} -> out of contract: [${out.join(', ')}]`)
        continue
      }
      if (guaranteedValid && warned) {
        failures.push(`${tag} -> warned on a valid color`)
        continue
      }
      if (warned) {
        warnHits++
        const msg = captured.slice(before).join(' ')
        if (!msg.includes(CODES.INVALID_COLOR)) {
          failures.push(`${tag} -> warn without ${CODES.INVALID_COLOR}: ${msg.slice(0, 100)}`)
        } else if (!(out[0] === 1 && out[1] === 1 && out[2] === 1)) {
          failures.push(`${tag} -> warned but fallback is not white: [${out.join(', ')}]`)
        }
      }
    }
  } finally {
    console.info = origInfo
  }
  report(failures, CASES, 'hexToLinear')
  // The invalid corpora must actually exercise the warn path.
  expect(warnHits).toBeGreaterThan(100)
})

// ---------------------------------------------------------------------------
// eulerToQuat / trsToMat4
// ---------------------------------------------------------------------------

/** Extreme but finite values; NaN and Infinity are deliberately excluded. */
const EXTREME_ANGLES: readonly number[] = [
  0, -0, 1e-320, -1e-320, 1e-9, -1e-9, 0.5, -0.5, 1, -1,
  Math.PI, -Math.PI, 1e10, -1e10, 1e30, -1e30, 1.7e308, -1.7e308,
]

/** Same idea, capped at ±1e30 (the magnitude the spec calls out). */
const EXTREME_TRS: readonly number[] = [
  0, -0, 1e-320, -1e-320, 1e-9, -1e-9, 0.5, -0.5, 1, -1,
  Math.PI, -Math.PI, 1e5, -1e5, 1e10, -1e10, 1e30, -1e30,
]

test('eulerToQuat stays finite for extreme finite angles', () => {
  const CASES = 300
  const rng = makeLcg(SEED ^ 0x22)
  const failures: string[] = []
  for (let i = 0; i < CASES; i++) {
    const val = (): number =>
      i % 4 === 3 ? (rng() * 2 - 1) * 10 ** randInt(rng, -30, 30) : pick(rng, EXTREME_ANGLES)
    const x = val()
    const y = val()
    const z = val()
    const q = eulerToQuat(x, y, z)
    if (q.length !== 4 || q.some((v) => !Number.isFinite(v))) {
      failures.push(`case=${i} euler=(${x}, ${y}, ${z}) -> quat=[${q.join(', ')}]`)
    }
  }
  report(failures, CASES, 'eulerToQuat')
})

test('trsToMat4 stays finite for extreme finite TRS inputs', () => {
  const CASES = 300
  const rng = makeLcg(SEED ^ 0x33)
  const failures: string[] = []
  for (let i = 0; i < CASES; i++) {
    // First third: sane inputs (unit quaternion, moderate T/S) — these must
    // never fail. Rest: extreme finite components up to ±1e30.
    const moderate = i < 100
    const val = (): number => (moderate ? (rng() * 2 - 1) * 10 : pick(rng, EXTREME_TRS))
    const t: Vec3 = [val(), val(), val()]
    const q: Vec4 = moderate
      ? eulerToQuat((rng() * 2 - 1) * Math.PI, (rng() * 2 - 1) * Math.PI, (rng() * 2 - 1) * Math.PI)
      : [val(), val(), val(), val()]
    const s: Vec3 = [val(), val(), val()]
    const m = trsToMat4(t, q, s)
    const tag = `case=${i}${moderate ? ' (moderate)' : ''} t=[${t}] q=[${q}] s=[${s}]`
    if (m.length !== 16) {
      failures.push(`${tag} -> matrix length ${m.length}`)
      continue
    }
    for (let k = 0; k < 16; k++) {
      if (!Number.isFinite(m[k])) {
        failures.push(`${tag} -> out[${k}]=${m[k]}`)
        break
      }
    }
    // Structural invariants of an affine TRS matrix.
    if (m[15] !== 1 || m[3] !== 0 || m[7] !== 0 || m[11] !== 0) {
      failures.push(`${tag} -> bottom row corrupted: [${m[3]}, ${m[7]}, ${m[11]}, ${m[15]}]`)
    }
  }
  report(failures, CASES, 'trsToMat4')
})
