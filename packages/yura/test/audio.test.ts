import { test, expect } from 'bun:test'
import { clamp01, gameAudio, pickupTone, jumpTone, landTone, winTones } from '../src/audio'
import type { GameAudio } from '../src/audio'

// --- fake WebAudio graph, enough for gameAudio()'s node chains -------------

interface FakeParam {
  value: number
  setValueAtTime(v: number, t: number): void
  linearRampToValueAtTime(v: number, t: number): void
  exponentialRampToValueAtTime(v: number, t: number): void
}

const fakeParam = (): FakeParam => ({
  value: 0,
  setValueAtTime(v) { this.value = v },
  linearRampToValueAtTime(v) { this.value = v },
  exponentialRampToValueAtTime(v) { this.value = v },
})

interface FakeGain {
  gain: FakeParam
  connect(n: unknown): unknown
  disconnect(): void
}

class FakeAudioContext {
  static created: FakeAudioContext[] = []
  currentTime = 0
  state = 'running'
  destination = {}
  gains: FakeGain[] = []
  constructor() { FakeAudioContext.created.push(this) }
  resume() { return Promise.resolve() }
  createGain(): FakeGain {
    const node: FakeGain = { gain: fakeParam(), connect: (n: unknown) => n, disconnect() {} }
    this.gains.push(node)
    return node
  }
  createOscillator() {
    return {
      type: 'sine',
      frequency: fakeParam(),
      onended: null as (() => void) | null,
      connect: (n: unknown) => n,
      disconnect() {},
      start(_t: number) {},
      stop(_t: number) {},
    }
  }
}

/** Run `fn` with the fake AudioContext installed; `master` is the lazily created master GainNode. */
function withFakeAudio(fn: (audio: GameAudio, master: FakeGain) => void): void {
  const g = globalThis as { AudioContext?: unknown }
  const prev = g.AudioContext
  g.AudioContext = FakeAudioContext
  try {
    const audio = gameAudio()
    audio.pickup() // first play lazily creates the context and master gain
    const ctx = FakeAudioContext.created[FakeAudioContext.created.length - 1]
    fn(audio, ctx.gains[0])
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
