/**
 * Zero-asset synthesized game audio.
 *
 * All tone parameters (frequencies, durations, envelope times) flow through
 * pure builder functions — `pickupTone`, `jumpTone`, `landTone`, `winTones` —
 * that return plain descriptor objects, so every number is testable without
 * an AudioContext. `gameAudio()` turns descriptors into short-lived WebAudio
 * node chains (create → connect → start/stop → auto-disconnect on `ended`).
 */

/** Oscillator waveform for a tone descriptor. */
export type ToneWave = 'sine' | 'triangle' | 'square' | 'sawtooth'

/** Plain description of one synthesized tone — no WebAudio objects. */
export interface ToneSpec {
  /** Waveform. */
  wave: ToneWave
  /** Start frequency in Hz. */
  freq: number
  /** Optional glide target in Hz (exponential ramp over `dur`). */
  freqEnd?: number
  /** Start offset in seconds relative to "now". */
  at: number
  /** Total length in seconds. */
  dur: number
  /** Envelope attack in seconds (0 < attack < dur). */
  attack: number
  /** Peak gain, 0..1. */
  peak: number
}

/**
 * Clamp to [lo, hi]. NaN reads as `lo`: `Math.min`/`Math.max` propagate NaN
 * silently, and every value here ends up in an `AudioParam`, which rejects a
 * non-finite number with a raw TypeError from the Web Audio API.
 */
const clampTo = (v: number, lo: number, hi: number): number =>
  Number.isNaN(v) ? lo : Math.min(hi, Math.max(lo, v))

/** Clamp a volume/gain/intensity value to the 0..1 range; NaN reads as silent. */
export const clamp01 = (v: number): number => clampTo(v, 0, 1)

/** Highest combo step the pickup blip transposes by, in semitones. */
const PICKUP_MAX_SEMITONES = 24
/** Base frequency of the pickup blip, in Hz. */
const PICKUP_BASE_HZ = 660

/** Pickup blip: triangle wave one semitone higher per combo step (capped at +24). */
export const pickupTone = (combo = 0): ToneSpec => ({
  wave: 'triangle',
  freq: PICKUP_BASE_HZ * 2 ** (clampTo(combo, 0, PICKUP_MAX_SEMITONES) / SEMITONES),
  at: 0, dur: 0.09, attack: 0.004, peak: 0.55,
})

/** Jump: quick sine up-chirp. */
export const jumpTone = (): ToneSpec => ({
  wave: 'sine', freq: 280, freqEnd: 620, at: 0, dur: 0.12, attack: 0.006, peak: 0.6,
})

/** Land: low sine thud with a fast downward glide; `intensity` 0..1 scales loudness. */
export const landTone = (intensity = 1): ToneSpec => ({
  wave: 'sine', freq: 110, freqEnd: 50, at: 0, dur: 0.18, attack: 0.005,
  peak: 0.9 * clamp01(intensity),
})

/** Win: small ascending triangle arpeggio (C5 → E5 → G5 → C6), notes staggered. */
export const winTones = (): ToneSpec[] =>
  [523.25, 659.25, 783.99, 1046.5].map((freq, i): ToneSpec => ({
    wave: 'triangle', freq, at: i * 0.09, dur: 0.16, attack: 0.008, peak: 0.5,
  }))

/** Reference pitch: MIDI note number and frequency of A4 in equal temperament. */
const A4_MIDI = 69
const A4_HZ = 440
/** Semitones per octave in 12-tone equal temperament. */
const SEMITONES = 12
/** Semitone offset of each natural note letter within an octave (C=0 … B=11). */
const LETTER_SEMITONE: Readonly<Record<string, number>> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
}
/** Note name: letter, optional accidental (#/♯ or b/♭), octave number. */
const NOTE_RE = /^([A-Ga-g])([#♯b♭]?)(-?\d{1,2})$/

/**
 * Convert a scientific-pitch note name ('C4', 'F#3', 'Bb5', …) to its
 * frequency in Hz, derived from equal temperament around A4 = 440 Hz:
 * `440 * 2^((midi - 69) / 12)`. Case-insensitive; supports `#`/`♯` and
 * `b`/`♭`. Throws a RangeError for anything that is not a note name.
 */
export const noteToFreq = (name: string): number => {
  const m = NOTE_RE.exec(name.trim())
  if (!m) throw new RangeError(`not a note name: ${JSON.stringify(name)}`)
  const accidental = m[2] === '#' || m[2] === '♯' ? 1 : m[2] === '' ? 0 : -1
  const midi =
    (Number(m[3]) + 1) * SEMITONES + LETTER_SEMITONE[m[1].toUpperCase()] + accidental
  return A4_HZ * 2 ** ((midi - A4_MIDI) / SEMITONES)
}

/** Options for {@link GameAudio.loop}. */
export interface LoopOpts {
  /** Tempo in beats per minute; each pattern step lasts one beat. Default 120. */
  bpm?: number
  /** Oscillator waveform for every note. Default 'square' (chiptune). */
  wave?: ToneWave
  /** Per-note peak gain 0..1 (under the master volume/mute). Default 0.5. */
  gain?: number
}

/** Handle returned by {@link GameAudio.loop}. */
export interface LoopHandle {
  /** Stop the loop: cancel future bars and release all live nodes. Idempotent. */
  stop(): void
  /** True until {@link LoopHandle.stop} is called (false from the start for an empty pattern). */
  readonly playing: boolean
}

/** Loop sequencer defaults and envelope shape — one place, no magic numbers inline. */
const LOOP_DEFAULT_BPM = 120
const LOOP_DEFAULT_WAVE: ToneWave = 'square'
const LOOP_DEFAULT_GAIN = 0.5
/** Fraction of a step the note actually sounds (the rest is a gap between notes). */
const LOOP_GATE = 0.9
/** Envelope attack for loop notes, in seconds. */
const LOOP_ATTACK = 0.005
/** How far ahead of the next bar the scheduler timer fires, in seconds. */
const LOOP_LEAD = 0.05

/** One-liner game sound effects. Create with {@link gameAudio}. */
export interface GameAudio {
  /** Short blip whose pitch rises with the combo count. */
  pickup(combo?: number): void
  /** Quick up-chirp. */
  jump(): void
  /** Low thud; `intensity` 0..1 scales loudness. */
  land(intensity?: number): void
  /** Small ascending arpeggio. */
  win(): void
  /**
   * Chiptune-style BGM: loop `pattern` — note names ('C4', 'F#3', …) or
   * `null` rests, one beat per step — until the handle's `stop()` is called.
   * Notes play through the master gain, so `volume` and `mute` apply.
   * Throws a RangeError if a pattern entry is not a note name.
   */
  loop(pattern: (string | null)[], opts?: LoopOpts): LoopHandle
  /** Master volume, clamped to 0..1. Non-finite assignments are ignored. */
  volume: number
  /**
   * Mute (`true`), unmute (`false`), or toggle when omitted. Silences output
   * via the master gain while keeping `volume`. Returns the new muted state.
   */
  mute(on?: boolean): boolean
  /** Current muted state. */
  readonly muted: boolean
}

/**
 * Create zero-asset game sound effects. The AudioContext is created (and
 * resumed) lazily on the first user gesture — 'pointerdown' or 'keydown',
 * whichever comes first — which satisfies browser autoplay rules. Every
 * effect builds a short-lived oscillator → gain → master chain that stops
 * itself and disconnects on `ended`, so nothing accumulates between calls.
 */
export function gameAudio(): GameAudio {
  let ctx: AudioContext | null = null
  let master: GainNode | null = null
  let volume = 0.5
  let muted = false
  const apply = () => { if (master) master.gain.value = muted ? 0 : volume }
  const ensure = (): AudioContext | null => {
    if (typeof AudioContext === 'undefined') return null
    if (!ctx) {
      ctx = new AudioContext()
      master = ctx.createGain()
      master.connect(ctx.destination)
      apply()
    }
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  }
  if (typeof window !== 'undefined') {
    const arm = () => { unarm(); ensure() }
    const unarm = () => {
      window.removeEventListener('pointerdown', arm)
      window.removeEventListener('keydown', arm)
    }
    window.addEventListener('pointerdown', arm)
    window.addEventListener('keydown', arm)
  }
  const play = (t: ToneSpec): { osc: OscillatorNode; gain: GainNode } | null => {
    const c = ensure()
    if (!c || !master) return null
    const t0 = c.currentTime + t.at
    const osc = c.createOscillator()
    const gain = c.createGain()
    osc.type = t.wave
    osc.frequency.setValueAtTime(t.freq, t0)
    if (t.freqEnd) osc.frequency.exponentialRampToValueAtTime(t.freqEnd, t0 + t.dur)
    gain.gain.setValueAtTime(0, t0)
    gain.gain.linearRampToValueAtTime(Math.max(t.peak, 0.0001), t0 + t.attack)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + t.dur)
    osc.connect(gain).connect(master)
    osc.onended = () => { osc.disconnect(); gain.disconnect() }
    osc.start(t0)
    osc.stop(t0 + t.dur)
    return { osc, gain }
  }
  const loop = (pattern: (string | null)[], opts: LoopOpts = {}): LoopHandle => {
    const freqs = pattern.map((n) => (n === null ? null : noteToFreq(n)))
    const bpm = opts.bpm !== undefined && Number.isFinite(opts.bpm) && opts.bpm > 0
      ? opts.bpm : LOOP_DEFAULT_BPM
    const wave = opts.wave ?? LOOP_DEFAULT_WAVE
    const peak = clamp01(opts.gain ?? LOOP_DEFAULT_GAIN)
    const step = 60 / bpm
    const barDur = freqs.length * step
    let playing = freqs.length > 0
    let timer: ReturnType<typeof setTimeout> | null = null
    let barStart: number | null = null
    const live = new Set<{ osc: OscillatorNode; gain: GainNode }>()
    const scheduleBar = () => {
      if (!playing) return
      let delay = barDur
      const c = ensure()
      if (c && master) {
        if (barStart === null || barStart < c.currentTime) barStart = c.currentTime
        for (let i = 0; i < freqs.length; i++) {
          const freq = freqs[i]
          if (freq === null) continue
          const nodes = play({
            wave, freq, at: barStart + i * step - c.currentTime,
            dur: step * LOOP_GATE, attack: LOOP_ATTACK, peak,
          })
          if (nodes) {
            live.add(nodes)
            nodes.osc.onended = () => {
              nodes.osc.disconnect()
              nodes.gain.disconnect()
              live.delete(nodes)
            }
          }
        }
        barStart += barDur
        delay = Math.max(barStart - c.currentTime - LOOP_LEAD, 0)
      }
      timer = setTimeout(scheduleBar, delay * 1000)
    }
    scheduleBar()
    return {
      stop() {
        if (!playing) return
        playing = false
        if (timer !== null) { clearTimeout(timer); timer = null }
        for (const nodes of live) {
          nodes.osc.onended = null
          try { nodes.osc.stop() } catch { /* already stopped */ }
          nodes.osc.disconnect()
          nodes.gain.disconnect()
        }
        live.clear()
      },
      get playing() { return playing },
    }
  }
  return {
    pickup(combo = 0) { play(pickupTone(combo)) },
    jump() { play(jumpTone()) },
    land(intensity = 1) { play(landTone(intensity)) },
    win() { for (const t of winTones()) play(t) },
    loop,
    get volume() { return volume },
    set volume(v: number) { if (Number.isFinite(v)) { volume = clamp01(v); apply() } },
    mute(on = !muted) { muted = on; apply(); return muted },
    get muted() { return muted },
  }
}
