/**
 * Deterministic fuzz tests for the yura package boundaries:
 *   - noteToFreq: note-name-ish random strings -> finite positive Hz, or a
 *     RangeError (nothing else may escape).
 *   - normalizeLines / buildTimeline: random at/every mixtures -> timelines
 *     that are finite and monotonically non-decreasing.
 *   - FxPool.step: random burst storms + extreme dt -> every internal buffer
 *     stays finite, alive stays consistent with capacity/writeInstances.
 *
 * Randomness is a seeded LCG implemented below (no Math.random) so every run
 * is reproducible; assertion messages carry the seed and case number.
 */
import { test, expect, spyOn } from 'bun:test'
import { noteToFreq, clamp01, pickupTone, landTone } from '../src/audio'
import { sweepProgress } from '../src/app'
import { cameraFollowGoal, safeDt, YuraScene } from '../src/scene'
import { normalizeLines, buildTimeline, timelineDuration, wrapTime, type LyricInput } from '../src/lyrics'
import { FxPool, FX_FLOATS, type BurstOptions, type AttractorParams } from '../src/fx'

const SEED = 0xf00d01

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
// noteToFreq
// ---------------------------------------------------------------------------

const NOTE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'a', 'c', 'g', 'H', 'h', 'X', '1', ''] as const
const NOTE_ACCIDENTALS = ['', '', '', '#', '♯', 'b', '♭', '##', 'bb', 'x', '!'] as const
const NOTE_OCTAVES = [
  '0', '1', '2', '4', '5', '8', '9', '10', '12', '99',
  '-1', '-2', '-9', '-10', '-99', '100', '-100', '007', '', '4.5', '+4', ' 4',
] as const
const NOTE_PADDING = ['', '', ' ', '  ', '\t', '\n'] as const

function genNoteCase(rng: () => number, kind: number): string {
  if (kind === 0) {
    const len = randInt(rng, 0, 8)
    let s = ''
    for (let k = 0; k < len; k++) s += String.fromCharCode(randInt(rng, 32, 126))
    return s
  }
  const pad1 = pick(rng, NOTE_PADDING)
  const pad2 = pick(rng, NOTE_PADDING)
  return pad1 + pick(rng, NOTE_LETTERS) + pick(rng, NOTE_ACCIDENTALS) + pick(rng, NOTE_OCTAVES) + pad2
}

test('noteToFreq returns finite positive Hz or throws RangeError only', () => {
  const CASES = 400
  const rng = makeLcg(SEED ^ 0x11)
  const failures: string[] = []
  let parsed = 0
  let rejected = 0
  for (let i = 0; i < CASES; i++) {
    const input = genNoteCase(rng, i % 2)
    const tag = `case=${i} input=${JSON.stringify(input)}`
    try {
      const f = noteToFreq(input)
      parsed++
      if (!(typeof f === 'number' && Number.isFinite(f) && f > 0)) {
        failures.push(`${tag} -> non-finite/non-positive frequency ${f}`)
      }
    } catch (e) {
      rejected++
      if (!(e instanceof RangeError)) {
        const name = e instanceof Error ? e.constructor.name : typeof e
        const msg = e instanceof Error ? e.message : String(e)
        failures.push(`${tag} -> leaked ${name}: ${msg.slice(0, 100)}`)
      }
    }
  }
  report(failures, CASES, 'noteToFreq')
  // Both outcomes must actually be exercised by the corpus.
  expect(parsed).toBeGreaterThan(20)
  expect(rejected).toBeGreaterThan(20)
})

// ---------------------------------------------------------------------------
// normalizeLines / buildTimeline
// ---------------------------------------------------------------------------

const AT_VALUES = [0, -0, 0.5, 1, 3.5, -2, -1000, 1e6, -1e6, 1e-6, 42.42] as const
const EVERY_VALUES = [3.5, 0, 1e-6, 1e6, -2, -0.5, 7, 0.25] as const
const LEAD_VALUES = [0.9, 0, -1, 5, 1e6, 1e-6, -1e6] as const

test('buildTimeline stays finite and monotonically non-decreasing', () => {
  const CASES = 250
  const rng = makeLcg(SEED ^ 0x22)
  const failures: string[] = []
  for (let i = 0; i < CASES; i++) {
    const n = randInt(rng, 0, 12)
    const input: LyricInput[] = []
    for (let j = 0; j < n; j++) {
      if (randInt(rng, 0, 2) === 0) {
        input.push(`line-${i}-${j}`)
      } else {
        const withAt = randInt(rng, 0, 3) !== 0
        input.push(
          withAt
            ? { text: `line-${i}-${j}`, at: randInt(rng, 0, 1) === 0 ? pick(rng, AT_VALUES) : (rng() * 2 - 1) * 100 }
            : { text: `line-${i}-${j}` },
        )
      }
    }
    const useEvery = randInt(rng, 0, 2) !== 0
    const every = pick(rng, EVERY_VALUES)
    const out = randInt(rng, 0, 1) === 0 ? ('dissolve' as const) : ('explode' as const)
    const useLead = randInt(rng, 0, 1) === 0
    const lead = pick(rng, LEAD_VALUES)
    const tag = `case=${i} n=${n} every=${useEvery ? every : 'default'} out=${out} lead=${useLead ? lead : 'default'}`

    const norm = useEvery ? normalizeLines(input, every) : normalizeLines(input)
    if (norm.length !== input.length) {
      failures.push(`${tag} -> normalizeLines dropped lines: ${norm.length}/${input.length}`)
      continue
    }
    if (norm.some((l) => !Number.isFinite(l.at ?? NaN))) {
      failures.push(`${tag} -> normalizeLines produced non-finite at: [${norm.map((l) => l.at).join(', ')}]`)
      continue
    }

    const events = useLead ? buildTimeline(norm, { out, lead }) : buildTimeline(norm, { out })
    const lineEvents = events.filter((e) => e.kind === 'line')
    if (lineEvents.length !== norm.length) {
      failures.push(`${tag} -> ${lineEvents.length} line events for ${norm.length} lines`)
      continue
    }
    let prev = -Infinity
    for (const ev of events) {
      if (!Number.isFinite(ev.time)) {
        failures.push(`${tag} -> non-finite event time ${ev.time} (kind=${ev.kind} line=${ev.line})`)
        break
      }
      if (ev.time < prev) {
        failures.push(`${tag} -> timeline not monotonic: ${ev.time} after ${prev} (kind=${ev.kind})`)
        break
      }
      if (ev.kind === 'interstitial' && out !== 'explode') {
        failures.push(`${tag} -> interstitial event without out=explode`)
        break
      }
      if (ev.line < 0 || ev.line >= norm.length) {
        failures.push(`${tag} -> event line index ${ev.line} out of range`)
        break
      }
      prev = ev.time
    }
    const dur = timelineDuration(events)
    if (!Number.isFinite(dur) || (events.length > 0 && dur < events[events.length - 1].time)) {
      failures.push(`${tag} -> bad duration ${dur} (last event ${events.length ? events[events.length - 1].time : 'n/a'})`)
    }
  }
  report(failures, CASES, 'buildTimeline')
})

// ---------------------------------------------------------------------------
// FxPool.step
// ---------------------------------------------------------------------------

const FX_BUFFER_KEYS = [
  'px', 'py', 'pz', 'vx', 'vy', 'vz', 'age', 'life', 'size',
  'cr', 'cg', 'cb', 'grav', 'drag', 'ldrag', 'er', 'eg', 'eb', 'fpow',
] as const

const FX_PALETTE = ['#ffd166', '#06d6a0', '#4cc9f0', '#c77dff', '#ff5d8f', '#fff', '#000000'] as const
const FX_DTS = [0, 1e-9, 1e-6, 1 / 240, 1 / 60, 0.25, 2, 60, 1e3, 1e6] as const
const FX_COORDS = [0, 1, -1, 50, -50, 1e4, -1e4] as const

function randomBurstOpts(rng: () => number): BurstOptions {
  const coin = (): boolean => randInt(rng, 0, 1) === 0
  const opts: BurstOptions = {}
  if (coin()) opts.count = randInt(rng, 1, 120)
  if (coin()) opts.speed = rng() * 1e3
  if (coin()) opts.life = 1e-3 + rng() * 50
  if (coin()) opts.size = rng() * 10
  if (coin()) opts.gravity = (rng() * 2 - 1) * 1e3
  if (coin()) opts.intensity = rng() * 10
  if (coin()) opts.spread = rng() * Math.PI
  if (coin()) opts.direction = [(rng() * 2 - 1) * 2, (rng() * 2 - 1) * 2, (rng() * 2 - 1) * 2]
  else if (randInt(rng, 0, 7) === 0) opts.direction = [0, 0, 0] // degenerate direction
  if (coin()) opts.shape = pick(rng, ['sphere', 'disc', 'box'] as const)
  if (coin()) opts.radius = rng() * 100
  if (coin()) opts.drag = rng() * 20
  if (coin()) opts.color = pick(rng, FX_PALETTE)
  else if (coin()) opts.color = [pick(rng, FX_PALETTE), pick(rng, FX_PALETTE)]
  if (coin()) opts.colorEnd = coin() ? pick(rng, FX_PALETTE) : [rng() * 4, rng() * 4, rng() * 4]
  return opts
}

/** Checks every pool invariant; pushes a description into `failures` on violation. */
function checkPool(pool: FxPool, scratch: Float32Array, tag: string, failures: string[]): void {
  const alive = pool.alive
  if (!Number.isInteger(alive) || alive < 0 || alive > pool.capacity) {
    failures.push(`${tag} alive=${alive} out of [0, ${pool.capacity}]`)
    return
  }
  const raw = pool as unknown as Record<string, unknown>
  for (const key of FX_BUFFER_KEYS) {
    const arr = raw[key]
    if (!(arr instanceof Float32Array)) continue
    for (let i = 0; i < alive; i++) {
      if (!Number.isFinite(arr[i])) {
        failures.push(`${tag} buffer ${key}[${i}]=${arr[i]} (alive=${alive})`)
        return
      }
    }
  }
  const age = raw['age']
  const life = raw['life']
  if (age instanceof Float32Array && life instanceof Float32Array) {
    for (let i = 0; i < alive; i++) {
      if (!(life[i] > 0) || !(age[i] >= 0) || !(age[i] < life[i])) {
        failures.push(`${tag} age/life out of contract at ${i}: age=${age[i]} life=${life[i]}`)
        return
      }
    }
  }
  const n = pool.writeInstances(scratch)
  if (n !== alive) {
    failures.push(`${tag} writeInstances returned ${n}, alive=${alive}`)
    return
  }
  for (let k = 0; k < n * FX_FLOATS; k++) {
    if (!Number.isFinite(scratch[k])) {
      failures.push(`${tag} instance data [${k}]=${scratch[k]}`)
      return
    }
  }
}

/**
 * Runs one seeded burst/step scenario. When `failures` is given the pool
 * invariants are checked after every step; the returned digest fingerprints
 * the run for the determinism assertion.
 */
function runFxScenario(seed: number, iterations: number, failures: string[] | null): string {
  const rng = makeLcg(seed)
  const capacity = pick(rng, [1, 3, 64, 512, 2048] as const)
  const pool = new FxPool(capacity, makeLcg(seed ^ 0x9e3779b9))
  const scratch = new Float32Array(capacity * FX_FLOATS)
  const digest: number[] = [capacity]
  for (let i = 0; i < iterations; i++) {
    const op = randInt(rng, 0, 19)
    if (op < 12) {
      const position: [number, number, number] = [
        pick(rng, FX_COORDS), pick(rng, FX_COORDS), pick(rng, FX_COORDS),
      ]
      pool.burst(position, randomBurstOpts(rng))
    } else if (op < 14) {
      pool.celebrate({
        bursts: randInt(rng, 1, 6),
        interval: rng() * 0.3,
        count: randInt(rng, 1, 60),
        radius: rng() * 10,
      })
    } else if (op < 16) {
      const n = randInt(rng, 0, 5) // 5 > MAX_ATTRACTORS exercises clamping
      const list: AttractorParams[] = []
      for (let j = 0; j < n; j++) {
        list.push({
          position: [pick(rng, FX_COORDS), pick(rng, FX_COORDS), pick(rng, FX_COORDS)],
          strength: (rng() * 2 - 1) * 500,
          radius: randInt(rng, 0, 1) === 0 ? rng() * 3 : undefined,
        })
      }
      pool.attractors = list
    } else if (op === 16) {
      pool.clear()
      if (failures && pool.alive !== 0) {
        failures.push(`[seed=0x${seed.toString(16)} case=${i}] alive=${pool.alive} after clear()`)
      }
    } // remaining ops: step without new emission
    const dt = randInt(rng, 0, 3) === 0 ? pick(rng, FX_DTS) : rng() * 0.05
    pool.step(dt)
    if (failures) {
      checkPool(pool, scratch, `[seed=0x${seed.toString(16)} case=${i} dt=${dt}]`, failures)
      if (failures.length > 12) break // enough evidence; keep the run fast
    }
    digest.push(pool.alive)
    if (i % 25 === 0) {
      const n = pool.writeInstances(scratch)
      for (let k = 0; k < Math.min(n * FX_FLOATS, 24); k++) digest.push(scratch[k])
    }
  }
  return digest.join(',')
}

test('FxPool.step keeps all buffers finite and alive consistent under burst storms', () => {
  const ITERATIONS = 220
  const failures: string[] = []
  runFxScenario(SEED ^ 0x33, ITERATIONS, failures)
  report(failures, ITERATIONS, 'FxPool.step')
})

test('FxPool fuzz scenario is deterministic for a fixed seed', () => {
  const a = runFxScenario(SEED ^ 0x44, 120, null)
  const b = runFxScenario(SEED ^ 0x44, 120, null)
  expect(b).toBe(a)
  // A different seed must not reproduce the same run byte-for-byte.
  const c = runFxScenario(SEED ^ 0x45, 120, null)
  expect(c).not.toBe(a)
})

// ---------------------------------------------------------------------------
// Non-finite hostility sweep.
//
// Every helper below advertises a bounded, finite result. Math.min/Math.max
// pass NaN straight through, so several of them quietly did not: a clamp that
// does not clamp NaN produced a silent AudioParam TypeError, a permanently
// stuck morph sweep, a NaN lyric cursor, and a blanked camera. NaN never heals
// on its own, so one bad value ends the session — this sweep is the standing
// net for the whole class.

const HOSTILE = [NaN, Infinity, -Infinity] as const

/** Every ordinary value these helpers are also expected to keep handling. */
const ORDINARY = [-1e6, -1.5, -0.5, 0, 0.25, 1, 1.5, 1e6] as const

test('fuzz: bounded helpers stay finite and in range for hostile numbers', () => {
  const failures: string[] = []
  let total = 0
  const rng = makeLcg(SEED ^ 0x5eed)
  const values = [...HOSTILE, ...ORDINARY]

  for (let c = 0; c < 400; c++) {
    // Each case mixes hostile and ordinary arguments so a guard that only
    // works when every argument is bad does not pass by accident.
    const a = pick(rng, values)
    const b = pick(rng, values)
    const d = pick(rng, values)
    const note = (what: string, got: unknown) =>
      failures.push(`case ${c} ${what}(${a}, ${b}, ${d}) -> ${JSON.stringify(got)}`)

    total += 4

    const gain = clamp01(a)
    if (!Number.isFinite(gain) || gain < 0 || gain > 1) note('clamp01', gain)

    const sweep = sweepProgress(a, b, d)
    if (!Number.isFinite(sweep) || sweep < 0 || sweep > 1) note('sweepProgress', sweep)

    const wrapped = wrapTime(a, b)
    if (!Number.isFinite(wrapped) || wrapped < 0) note('wrapTime', wrapped)

    const dt = safeDt(a)
    if (!Number.isFinite(dt) || dt < 0) note('safeDt', dt)
  }
  report(failures, total, 'bounded-helpers')
})

test('fuzz: tone specs and the follow camera never emit a non-finite number', () => {
  const failures: string[] = []
  let total = 0
  const rng = makeLcg(SEED ^ 0xca77)
  const values = [...HOSTILE, ...ORDINARY]

  for (let c = 0; c < 400; c++) {
    const a = pick(rng, values)
    const b = pick(rng, values)
    total += 3

    for (const [what, spec] of [
      ['pickupTone', pickupTone(a)],
      ['landTone', landTone(a)],
    ] as const) {
      const nums = [spec.freq, spec.at, spec.dur, spec.attack, spec.peak, spec.freqEnd ?? 0]
      if (!nums.every(Number.isFinite)) failures.push(`case ${c} ${what}(${a}) -> ${JSON.stringify(spec)}`)
    }

    const goal = cameraFollowGoal([a, b, 0], [b, 0, a], { distance: 8, height: 3.6 }, a)
    if (!goal.eye.every(Number.isFinite) || !goal.look.every(Number.isFinite)) {
      // The camera may legitimately sit at a hostile *position* — that is the
      // caller's own number — so only flag output the helper itself invented.
      if ([a, b].every(Number.isFinite)) failures.push(`case ${c} cameraFollowGoal -> ${JSON.stringify(goal)}`)
    }
  }
  report(failures, total, 'tone-and-camera')
})

test('fuzz: a scene survives hostile frame deltas and hostile update code', () => {
  const failures: string[] = []
  const rng = makeLcg(SEED ^ 0x5cee)
  const deltas = [NaN, Infinity, -Infinity, -1 / 60, 0, 1 / 60, 1 / 30, 30]
  // Every case trips YURA-018 by design; keep the run's output readable.
  const info = spyOn(console, 'info').mockImplementation(() => {})
  try {
  for (let c = 0; c < 40; c++) {
    const scene = new YuraScene({ gravity: -20, bounds: 8 })
    scene.add('plane', { size: 16 })
    const ball = scene.add('sphere', { radius: 0.5, position: [0, 4, 0], body: 'dynamic' })
    scene.onUpdate(() => {
      // Game code that leaves the reals every few frames.
      if (rng() < 0.2) ball.velocity[randInt(rng, 0, 2)] += pick(rng, [NaN, Infinity, -Infinity, 0])
    })
    let time = 0
    for (let i = 0; i < 200; i++) {
      const dt = pick(rng, deltas)
      time += Number.isFinite(dt) && dt > 0 ? dt : 0
      scene.step(dt, time)
    }
    if (!ball.position.every(Number.isFinite) || !ball.velocity.every(Number.isFinite)) {
      failures.push(`case ${c} pos=${JSON.stringify(ball.position)} vel=${JSON.stringify(ball.velocity)}`)
    }
  }
  } finally {
    info.mockRestore()
  }
  report(failures, 40, 'scene-step')
})
