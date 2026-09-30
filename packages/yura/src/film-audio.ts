import type { FilmPlan } from './film'
import { hash01 } from './motion-kit'

/**
 * The soundtrack of a {@link yuraFilm}, synthesised entirely in code: a music
 * bed (kick, hats, bass and a pad on a four-chord loop at the film's tempo,
 * ducked under every kick) and sound design locked to the picture — a
 * whoosh on each transition, pops when numbers land and list items tick,
 * clicks when the cursor presses, key ticks while a terminal types, a riser
 * into the end card and a hit on it. No samples, no assets, no network.
 *
 * What plays when is pure data ({@link filmCues}, {@link filmMusic}); only
 * {@link renderFilmAudio} touches Web Audio, through an OfflineAudioContext,
 * so the same film always renders the same waveform.
 */

export type CueKind = 'whoosh' | 'hit' | 'pop' | 'click' | 'type' | 'tick' | 'riser' | 'impact'

/** One sound-design event. */
export interface FilmCue {
  t: number
  kind: CueKind
  gain: number
}

/** Key-tick spacing while a terminal types (seconds). */
const TYPE_STEP = 0.07
const RISER_SECONDS = 1.6

/** Sound design for a plan, sorted by time. (Pure.) */
export function filmCues(plan: FilmPlan): FilmCue[] {
  const cues: FilmCue[] = []
  const add = (t: number, kind: CueKind, gain = 1): void => {
    if (Number.isFinite(t) && t >= 0 && t <= plan.duration) cues.push({ t, kind, gain })
  }
  for (const s of plan.scenes) {
    const dur = s.end - s.start
    if (s.index > 0) add(s.start - 0.18, s.transition === 'cut' ? 'hit' : 'whoosh', s.transition === 'cut' ? 0.5 : 0.8)
    const sc = s.scene
    switch (sc.kind) {
      case 'impact':
        add(s.start + 0.08, 'impact')
        break
      case 'stat':
        add(s.start + 0.15 + Math.min(1.8, dur * 0.55), 'pop', 0.9)
        break
      case 'list': {
        const items = (sc.items ?? []).slice(0, 8)
        const gap = Math.min(0.45, (dur - 1.4) / Math.max(1, items.length))
        items.forEach((_, i) => add(s.start + 0.65 + i * gap, 'pop', 0.55))
        break
      }
      case 'ui':
        if (sc.card?.button) add(s.start + dur * 0.62, 'click', 0.9)
        ;(sc.card?.checklist ?? []).slice(0, 6).forEach((_, i) => add(s.start + 0.9 + i * 0.35, 'pop', 0.45))
        break
      case 'code': {
        const chars = (sc.lines ?? []).slice(0, 10).reduce((n, l) => n + Array.from(l).length, 0)
        // Typing runs from 0.4 s over 70% of the scene (the same pace the code scene draws at).
        const typing = chars > 0 ? Math.max(0.5, dur * 0.7) : 0
        for (let k = 0.4; k < 0.4 + typing; k += TYPE_STEP) add(s.start + k, 'type', 0.35 + hash01(s.seed, Math.round(k * 100), 5) * 0.2)
        break
      }
      case 'countdown': {
        const from = Math.max(1, Math.min(99, Math.floor(sc.from ?? 3)))
        for (let k = 0; k <= from; k++) add(s.start + (k / (from + 1)) * dur, 'tick', k === from ? 1 : 0.7)
        break
      }
      case 'end':
        add(s.start - RISER_SECONDS, 'riser', 0.7)
        add(s.start + 0.05, 'impact', 0.9)
        break
    }
  }
  return cues.sort((a, b) => a.t - b.t)
}

/** A note of the music bed. */
export interface MusicNote {
  t: number
  kind: 'kick' | 'hat' | 'bass' | 'pad'
  /** MIDI note (0 for drums). */
  midi: number
  dur: number
}

/** Four-chord loops (semitones from the key root); bright looks get the major one. */
const PROGRESSIONS = {
  major: [
    [0, 4, 7, 11],
    [9, 12, 16, 19],
    [5, 9, 12, 16],
    [7, 11, 14, 17],
  ],
  minor: [
    [0, 3, 7, 10],
    [8, 12, 15, 19],
    [3, 7, 10, 14],
    [10, 14, 17, 20],
  ],
} as const
const KEY_ROOT = 57 // A3
const BRIGHT_LOOKS = new Set(['saas', 'aqua', 'editorial'])

/** The music bed: drums on the beat grid, one chord per bar, silent over the last half second. (Pure.) */
export function filmMusic(plan: FilmPlan): MusicNote[] {
  const beat = 60 / plan.bpm
  const bar = beat * 4
  const prog = BRIGHT_LOOKS.has(plan.lookName) ? PROGRESSIONS.major : PROGRESSIONS.minor
  const end = Math.max(0, plan.duration - 0.5)
  const notes: MusicNote[] = []
  for (let b = 0; b * beat < end; b++) {
    const t = b * beat
    // Drums wait for the first bar to finish: the film opens on the pad alone.
    if (b >= 4) {
      notes.push({ t, kind: 'kick', midi: 0, dur: 0.3 })
      notes.push({ t: t + beat / 2, kind: 'hat', midi: 0, dur: 0.05 })
    }
    if (b % 4 === 0) {
      const chord = prog[Math.floor(b / 4) % prog.length]
      for (const n of chord) notes.push({ t, kind: 'pad', midi: KEY_ROOT + n, dur: Math.min(bar, end - t) })
      notes.push({ t, kind: 'bass', midi: KEY_ROOT - 12 + chord[0], dur: Math.min(bar, end - t) })
    }
  }
  return notes.filter((n) => n.t < end && n.dur > 0)
}

export const midiToHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12)

// ------------------------------------------------------------------ WAV

/** Anything shaped like an AudioBuffer. */
export interface PcmSource {
  numberOfChannels: number
  sampleRate: number
  length: number
  getChannelData(channel: number): Float32Array
}

/** 16-bit PCM WAV bytes of a buffer (samples clamped to ±1, NaN → silence). (Pure.) */
export function encodeWav(buf: PcmSource): Uint8Array {
  const ch = Math.max(1, buf.numberOfChannels)
  const n = buf.length
  const bytes = new Uint8Array(44 + n * ch * 2)
  const v = new DataView(bytes.buffer)
  const str = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  v.setUint32(4, 36 + n * ch * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, ch, true)
  v.setUint32(24, buf.sampleRate, true)
  v.setUint32(28, buf.sampleRate * ch * 2, true)
  v.setUint16(32, ch * 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, n * ch * 2, true)
  const data = Array.from({ length: ch }, (_, c) => buf.getChannelData(c))
  let o = 44
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const s = data[c][i]
      const x = Number.isFinite(s) ? Math.max(-1, Math.min(1, s)) : 0
      v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true)
      o += 2
    }
  }
  return bytes
}

// ------------------------------------------------------------------ synthesis

/** The OfflineAudioContext constructor, injectable for non-browser hosts. */
export type OfflineContextCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext

export const FILM_SAMPLE_RATE = 44100
const MASTER_GAIN = 0.8

/**
 * Renders the film's soundtrack to an AudioBuffer (music bed + sound
 * design). Returns null where Web Audio is unavailable — the film still
 * plays and exports, silently.
 */
export async function renderFilmAudio(plan: FilmPlan, opts: { context?: OfflineContextCtor; music?: boolean; sfx?: boolean } = {}): Promise<AudioBuffer | null> {
  const Ctor = opts.context ?? (globalThis as { OfflineAudioContext?: OfflineContextCtor }).OfflineAudioContext
  if (typeof Ctor !== 'function') return null
  const sr = FILM_SAMPLE_RATE
  const ctx = new Ctor(2, Math.ceil((plan.duration + 0.5) * sr), sr)
  const comp = ctx.createDynamicsCompressor()
  comp.threshold.value = -14
  comp.ratio.value = 4
  const master = ctx.createGain()
  master.gain.value = MASTER_GAIN
  comp.connect(master).connect(ctx.destination)
  // Music and sfx buses; the music bus is ducked under each kick.
  const music = ctx.createGain()
  music.gain.value = 0.55
  music.connect(comp)
  const padBus = ctx.createGain()
  padBus.gain.value = 1
  const padFilter = ctx.createBiquadFilter()
  padFilter.type = 'lowpass'
  padFilter.frequency.value = 1500
  padBus.connect(padFilter).connect(music)
  const sfx = ctx.createGain()
  sfx.gain.value = 0.9
  sfx.connect(comp)

  const noise = ctx.createBuffer(1, sr, sr)
  const nd = noise.getChannelData(0)
  for (let i = 0; i < nd.length; i++) nd[i] = hash01(i, 11, 97) * 2 - 1
  const noiseSrc = (t: number, dur: number): AudioBufferSourceNode => {
    const s = ctx.createBufferSource()
    s.buffer = noise
    s.loop = true
    s.start(t)
    s.stop(t + dur + 0.05)
    return s
  }
  const env = (g: GainNode, t: number, peak: number, attack: number, dur: number): void => {
    g.gain.setValueAtTime(0.0001, t)
    g.gain.linearRampToValueAtTime(peak, t + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(attack + 0.01, dur))
  }
  const tone = (type: OscillatorType, t: number, f0: number, f1: number, dur: number, peak: number, out: AudioNode, attack = 0.005): void => {
    const o = ctx.createOscillator()
    o.type = type
    o.frequency.setValueAtTime(f0, t)
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur)
    const g = ctx.createGain()
    env(g, t, peak, attack, dur)
    o.connect(g).connect(out)
    o.start(t)
    o.stop(t + dur + 0.05)
  }
  const filtered = (t: number, dur: number, type: BiquadFilterType, f0: number, f1: number, peak: number, attack: number, out: AudioNode): void => {
    const f = ctx.createBiquadFilter()
    f.type = type
    f.Q.value = 1.2
    f.frequency.setValueAtTime(f0, t)
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur)
    const g = ctx.createGain()
    env(g, t, peak, attack, dur)
    noiseSrc(t, dur).connect(f).connect(g).connect(out)
  }

  if (opts.music ?? true) {
    for (const n of filmMusic(plan)) {
      if (n.kind === 'kick') {
        tone('sine', n.t, 130, 42, 0.28, 0.9, music)
        // Duck the pad under the kick: the pump that makes a bed feel produced.
        padBus.gain.setValueAtTime(0.35, n.t)
        padBus.gain.linearRampToValueAtTime(1, n.t + 0.22)
      } else if (n.kind === 'hat') filtered(n.t, n.dur, 'highpass', 7000, 9000, 0.18, 0.002, music)
      else if (n.kind === 'bass') tone('triangle', n.t, midiToHz(n.midi), midiToHz(n.midi), n.dur, 0.35, music, 0.02)
      else {
        for (const detune of [-6, 6]) {
          const o = ctx.createOscillator()
          o.type = 'sawtooth'
          o.frequency.value = midiToHz(n.midi)
          o.detune.value = detune
          const g = ctx.createGain()
          g.gain.setValueAtTime(0.0001, n.t)
          g.gain.linearRampToValueAtTime(0.045, n.t + 0.35)
          g.gain.setValueAtTime(0.045, n.t + Math.max(0.36, n.dur - 0.3))
          g.gain.linearRampToValueAtTime(0.0001, n.t + n.dur)
          o.connect(g).connect(padBus)
          o.start(n.t)
          o.stop(n.t + n.dur + 0.05)
        }
      }
    }
  }
  if (opts.sfx ?? true) {
    for (const c of filmCues(plan)) {
      const g = c.gain
      switch (c.kind) {
        case 'whoosh':
          filtered(c.t, 0.5, 'bandpass', 400, 4000, 0.5 * g, 0.2, sfx)
          break
        case 'hit':
          tone('sine', c.t, 90, 40, 0.3, 0.6 * g, sfx)
          filtered(c.t, 0.12, 'highpass', 2000, 3000, 0.25 * g, 0.002, sfx)
          break
        case 'impact':
          tone('sine', c.t, 110, 32, 0.7, 1 * g, sfx)
          filtered(c.t, 0.4, 'lowpass', 3000, 200, 0.6 * g, 0.002, sfx)
          break
        case 'pop':
          tone('sine', c.t, 520, 1100, 0.12, 0.45 * g, sfx)
          break
        case 'click':
          filtered(c.t, 0.04, 'highpass', 3000, 4000, 0.6 * g, 0.001, sfx)
          tone('square', c.t, 1800, 1200, 0.03, 0.08 * g, sfx)
          break
        case 'type':
          filtered(c.t, 0.025, 'bandpass', 2500, 3500, 0.3 * g, 0.001, sfx)
          break
        case 'tick':
          tone('sine', c.t, 1320, 1320, 0.08, 0.35 * g, sfx)
          break
        case 'riser':
          filtered(c.t, RISER_SECONDS, 'bandpass', 300, 6000, 0.4 * g, RISER_SECONDS * 0.9, sfx)
          tone('sawtooth', c.t, 110, 440, RISER_SECONDS, 0.06 * g, sfx, RISER_SECONDS * 0.9)
          break
      }
    }
  }
  return ctx.startRendering()
}
