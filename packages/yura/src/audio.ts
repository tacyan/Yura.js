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

/** Clamp a volume/gain/intensity value to the 0..1 range. */
export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

/** Pickup blip: triangle wave one semitone higher per combo step (capped at +24). */
export const pickupTone = (combo = 0): ToneSpec => ({
  wave: 'triangle',
  freq: 660 * 2 ** (Math.min(Math.max(combo, 0), 24) / 12),
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
  const play = (t: ToneSpec) => {
    const c = ensure()
    if (!c || !master) return
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
  }
  return {
    pickup(combo = 0) { play(pickupTone(combo)) },
    jump() { play(jumpTone()) },
    land(intensity = 1) { play(landTone(intensity)) },
    win() { for (const t of winTones()) play(t) },
    get volume() { return volume },
    set volume(v: number) { if (Number.isFinite(v)) { volume = clamp01(v); apply() } },
    mute(on = !muted) { muted = on; apply(); return muted },
    get muted() { return muted },
  }
}
