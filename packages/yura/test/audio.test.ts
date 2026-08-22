import { test, expect } from 'bun:test'
import { clamp01, gameAudio, noteToFreq, pickupTone, jumpTone, landTone, winTones } from '../src/audio'
import type { GameAudio, LoopHandle } from '../src/audio'

// --- fake WebAudio graph, enough for gameAudio()'s node chains -------------

interface ParamEvent { fn: 'set' | 'linear' | 'exp'; v: number; t: number }

interface FakeParam {
  value: number
  events: ParamEvent[]
  setValueAtTime(v: number, t: number): void
  linearRampToValueAtTime(v: number, t: number): void
  exponentialRampToValueAtTime(v: number, t: number): void
}

const fakeParam = (): FakeParam => ({
  value: 0,
  events: [],
  setValueAtTime(v, t) { this.value = v; this.events.push({ fn: 'set', v, t }) },
  linearRampToValueAtTime(v, t) { this.value = v; this.events.push({ fn: 'linear', v, t }) },
  exponentialRampToValueAtTime(v, t) { this.value = v; this.events.push({ fn: 'exp', v, t }) },
})

interface FakeGain {
  gain: FakeParam
  connectedTo: unknown[]
  disconnected: boolean
  connect(n: unknown): unknown
  disconnect(): void
}

interface FakeOsc {
  type: string
  frequency: FakeParam
  onended: (() => void) | null
  connectedTo: unknown[]
  disconnected: boolean
  startedAt: number | null
  stoppedAt: number | null
  connect(n: unknown): unknown
  disconnect(): void
  start(t?: number): void
  stop(t?: number): void
}

class FakeAudioContext {
  static created: FakeAudioContext[] = []
  currentTime = 0
  state = 'running'
  destination = {}
  gains: FakeGain[] = []
  oscillators: FakeOsc[] = []
  constructor() { FakeAudioContext.created.push(this) }
  resume() { return Promise.resolve() }
  createGain(): FakeGain {
    const node: FakeGain = {
      gain: fakeParam(),
      connectedTo: [],
      disconnected: false,
      connect(n: unknown) { this.connectedTo.push(n); return n },
      disconnect() { this.disconnected = true },
    }
    this.gains.push(node)
    return node
  }
  createOscillator(): FakeOsc {
    const osc: FakeOsc = {
      type: 'sine',
      frequency: fakeParam(),
      onended: null,
      connectedTo: [],
      disconnected: false,
      startedAt: null,
      stoppedAt: null,
      connect(n: unknown) { this.connectedTo.push(n); return n },
      disconnect() { this.disconnected = true },
      start(t = 0) { this.startedAt = t },
      stop(t = 0) { this.stoppedAt = t },
    }
    this.oscillators.push(osc)
    return osc
  }
}

/** Run `fn` with the fake AudioContext installed; `master` is the lazily created master GainNode. */
function withFakeAudio(fn: (audio: GameAudio, master: FakeGain, ctx: FakeAudioContext) => void): void {
  const g = globalThis as { AudioContext?: unknown }
  const prev = g.AudioContext
  g.AudioContext = FakeAudioContext
  try {
    const audio = gameAudio()
    audio.pickup() // first play lazily creates the context and master gain
    const ctx = FakeAudioContext.created[FakeAudioContext.created.length - 1]
    fn(audio, ctx.gains[0], ctx)
  } finally {
    if (prev === undefined) delete g.AudioContext
    else g.AudioContext = prev
  }
}

test('pickup pitch rises with combo', () => {
  let prev = 0
  for (let combo = 0; combo <= 8; combo++) {
    const f = pickupTone(combo).freq
    expect(f).toBeGreaterThan(prev)
    prev = f
  }
})

test('pickup pitch is one semitone per combo step, capped at +24', () => {
  expect(pickupTone(12).freq).toBeCloseTo(pickupTone(0).freq * 2, 5)
  expect(pickupTone(99).freq).toBe(pickupTone(24).freq)
  expect(pickupTone(-3).freq).toBe(pickupTone(0).freq)
})

test('every descriptor has positive, ordered envelope times', () => {
  for (const t of [pickupTone(0), pickupTone(5), jumpTone(), landTone(), ...winTones()]) {
    expect(t.attack).toBeGreaterThan(0)
    expect(t.dur).toBeGreaterThan(t.attack)
    expect(t.at).toBeGreaterThanOrEqual(0)
    expect(t.peak).toBeGreaterThan(0)
    expect(t.peak).toBeLessThanOrEqual(1)
  }
})

test('win arpeggio ascends in pitch and start time', () => {
  const notes = winTones()
  expect(notes.length).toBeGreaterThanOrEqual(3)
  for (let i = 1; i < notes.length; i++) {
    expect(notes[i].freq).toBeGreaterThan(notes[i - 1].freq)
    expect(notes[i].at).toBeGreaterThan(notes[i - 1].at)
  }
})

test('jump chirps upward', () => {
  const t = jumpTone()
  expect(t.freqEnd ?? 0).toBeGreaterThan(t.freq)
})

test('land peak scales with intensity and clamps to 0..1', () => {
  expect(landTone(1).peak).toBeGreaterThan(landTone(0.3).peak)
  expect(landTone(5).peak).toBe(landTone(1).peak)
  expect(landTone(-2).peak).toBe(0)
  expect(landTone(1).peak).toBeLessThanOrEqual(1)
})

test('volume clamp holds 0..1', () => {
  expect(clamp01(-1)).toBe(0)
  expect(clamp01(0)).toBe(0)
  expect(clamp01(0.42)).toBe(0.42)
  expect(clamp01(1)).toBe(1)
  expect(clamp01(2)).toBe(1)
})

test('volume reaches the master gain, defaults unchanged', () => {
  withFakeAudio((audio, master) => {
    expect(audio.muted).toBe(false)
    expect(master.gain.value).toBe(audio.volume) // default volume applied on creation
    audio.volume = 0.3
    expect(audio.volume).toBe(0.3)
    expect(master.gain.value).toBe(0.3)
  })
})

test('volume assignments clamp to 0..1', () => {
  withFakeAudio((audio, master) => {
    audio.volume = 2
    expect(audio.volume).toBe(1)
    expect(master.gain.value).toBe(1)
    audio.volume = -0.5
    expect(audio.volume).toBe(0)
    expect(master.gain.value).toBe(0)
  })
})

test('non-finite volume assignments are ignored', () => {
  withFakeAudio((audio, master) => {
    audio.volume = 0.4
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      audio.volume = bad
      expect(audio.volume).toBe(0.4)
      expect(master.gain.value).toBe(0.4)
    }
  })
})

test('mute toggles, silences the master gain, and keeps volume', () => {
  withFakeAudio((audio, master) => {
    audio.volume = 0.4
    expect(audio.mute()).toBe(true)
    expect(audio.muted).toBe(true)
    expect(master.gain.value).toBe(0)
    expect(audio.volume).toBe(0.4) // volume survives mute
    expect(audio.mute()).toBe(false)
    expect(audio.muted).toBe(false)
    expect(master.gain.value).toBe(0.4)
  })
})

test('mute accepts an explicit on/off argument', () => {
  withFakeAudio((audio, master) => {
    audio.volume = 0.7
    expect(audio.mute(true)).toBe(true)
    expect(audio.mute(true)).toBe(true) // idempotent, not a toggle
    expect(master.gain.value).toBe(0)
    audio.volume = 0.2 // volume changes while muted stay silent...
    expect(master.gain.value).toBe(0)
    expect(audio.mute(false)).toBe(false)
    expect(master.gain.value).toBe(0.2) // ...and apply on unmute
  })
})

test('safe without AudioContext: no throw, state still tracked', () => {
  const g = globalThis as { AudioContext?: unknown }
  const prev = g.AudioContext
  delete g.AudioContext
  try {
    const audio = gameAudio()
    expect(() => {
      audio.pickup(3)
      audio.jump()
      audio.land(0.5)
      audio.win()
    }).not.toThrow()
    audio.volume = 0.2
    expect(audio.volume).toBe(0.2)
    expect(audio.mute()).toBe(true)
    expect(audio.muted).toBe(true)
    expect(audio.mute(false)).toBe(false)
  } finally {
    if (prev !== undefined) g.AudioContext = prev
  }
})

// --- noteToFreq -------------------------------------------------------------

test('noteToFreq derives equal temperament from A4 = 440', () => {
  expect(noteToFreq('A4')).toBe(440)
  expect(noteToFreq('C4')).toBeCloseTo(261.6256, 3)
  expect(noteToFreq('A5')).toBeCloseTo(880, 9)
  expect(noteToFreq('A3')).toBeCloseTo(220, 9)
  expect(noteToFreq('E5')).toBeCloseTo(659.2551, 3)
  expect(noteToFreq('C0')).toBeCloseTo(16.3516, 3)
})

test('sharps raise and flats lower by exactly one semitone', () => {
  const semitone = 2 ** (1 / 12)
  expect(noteToFreq('C#4')).toBeCloseTo(noteToFreq('C4') * semitone, 9)
  expect(noteToFreq('Bb3')).toBeCloseTo(noteToFreq('B3') / semitone, 9)
  expect(noteToFreq('C#4')).toBeCloseTo(noteToFreq('Db4'), 9) // enharmonic
  expect(noteToFreq('F♯3')).toBeCloseTo(noteToFreq('G♭3'), 9) // unicode accidentals
  expect(noteToFreq('C#4')).toBeCloseTo(277.1826, 3)
})

test('noteToFreq is case-insensitive and trims whitespace', () => {
  expect(noteToFreq('a4')).toBe(440)
  expect(noteToFreq(' g3 ')).toBeCloseTo(noteToFreq('G3'), 9)
})

test('noteToFreq rejects non-note input', () => {
  for (const bad of ['', 'H4', 'C', '4', 'C##4', 'do4', 'C4x', '#4']) {
    expect(() => noteToFreq(bad)).toThrow(RangeError)
  }
})

// --- loop sequencer ---------------------------------------------------------

test('loop schedules one oscillator per note on the beat grid, rests skipped', () => {
  withFakeAudio((audio, _master, ctx) => {
    const before = ctx.oscillators.length
    const handle = audio.loop(['C4', null, 'E4', 'G4'], { bpm: 120, wave: 'triangle' })
    try {
      const oscs = ctx.oscillators.slice(before)
      expect(oscs.length).toBe(3) // null steps schedule nothing
      const step = 60 / 120
      expect(oscs[0].startedAt).toBeCloseTo(0, 9)
      expect(oscs[1].startedAt).toBeCloseTo(2 * step, 9)
      expect(oscs[2].startedAt).toBeCloseTo(3 * step, 9)
      expect(oscs[0].frequency.events[0].v).toBeCloseTo(noteToFreq('C4'), 9)
      expect(oscs[1].frequency.events[0].v).toBeCloseTo(noteToFreq('E4'), 9)
      expect(oscs[2].frequency.events[0].v).toBeCloseTo(noteToFreq('G4'), 9)
      for (const o of oscs) expect(o.type).toBe('triangle')
      // each note ends before its step does, leaving a gap to the next note
      expect(oscs[0].stoppedAt ?? Infinity).toBeLessThan(step)
      expect(handle.playing).toBe(true)
    } finally {
      handle.stop()
    }
  })
})

test('loop notes route through the master gain, so volume/mute apply', () => {
  withFakeAudio((audio, master, ctx) => {
    const beforeGains = ctx.gains.length
    const beforeOscs = ctx.oscillators.length
    const handle = audio.loop(['A4'], { gain: 0.3 })
    try {
      const noteGain = ctx.gains[beforeGains]
      const osc = ctx.oscillators[beforeOscs]
      expect(osc.connectedTo).toContain(noteGain)
      expect(noteGain.connectedTo).toContain(master)
      const peak = noteGain.gain.events.find((e) => e.fn === 'linear')
      expect(peak?.v).toBe(0.3)
      audio.mute(true)
      expect(master.gain.value).toBe(0) // everything downstream is silenced
      expect(handle.playing).toBe(true)
      audio.mute(false)
    } finally {
      handle.stop()
    }
  })
})

test('loop defaults: square wave, 120 bpm, 0.5 gain', () => {
  withFakeAudio((audio, _master, ctx) => {
    const beforeGains = ctx.gains.length
    const beforeOscs = ctx.oscillators.length
    const handle = audio.loop(['C4', 'C4'])
    try {
      const oscs = ctx.oscillators.slice(beforeOscs)
      expect(oscs[0].type).toBe('square')
      expect(oscs[1].startedAt).toBeCloseTo(60 / 120, 9)
      const peak = ctx.gains[beforeGains].gain.events.find((e) => e.fn === 'linear')
      expect(peak?.v).toBe(0.5)
    } finally {
      handle.stop()
    }
  })
})

test('loop stop() releases every scheduled node and flips playing', () => {
  withFakeAudio((audio, _master, ctx) => {
    const beforeGains = ctx.gains.length
    const beforeOscs = ctx.oscillators.length
    const handle = audio.loop(['C4', 'E4', 'G4'])
    expect(handle.playing).toBe(true)
    handle.stop()
    expect(handle.playing).toBe(false)
    for (const o of ctx.oscillators.slice(beforeOscs)) {
      expect(o.disconnected).toBe(true)
      expect(o.onended).toBeNull()
    }
    for (const g of ctx.gains.slice(beforeGains)) expect(g.disconnected).toBe(true)
    expect(() => handle.stop()).not.toThrow() // idempotent
    expect(handle.playing).toBe(false)
  })
})

test('loop with an empty pattern is inert', () => {
  withFakeAudio((audio, _master, ctx) => {
    const before = ctx.oscillators.length
    const handle = audio.loop([])
    expect(handle.playing).toBe(false)
    expect(ctx.oscillators.length).toBe(before)
    expect(() => handle.stop()).not.toThrow()
  })
})

test('loop rejects invalid note names up front, scheduling nothing', () => {
  withFakeAudio((audio, _master, ctx) => {
    const before = ctx.oscillators.length
    expect(() => audio.loop(['C4', 'X9'])).toThrow(RangeError)
    expect(ctx.oscillators.length).toBe(before)
  })
})

test('loop is safe without AudioContext: no throw, handle still works', () => {
  const g = globalThis as { AudioContext?: unknown }
  const prev = g.AudioContext
  delete g.AudioContext
  try {
    const audio = gameAudio()
    let handle: LoopHandle | null = null
    expect(() => { handle = audio.loop(['C4', 'E4'], { bpm: 240 }) }).not.toThrow()
    expect(handle!.playing).toBe(true)
    handle!.stop()
    expect(handle!.playing).toBe(false)
  } finally {
    if (prev !== undefined) g.AudioContext = prev
  }
})
