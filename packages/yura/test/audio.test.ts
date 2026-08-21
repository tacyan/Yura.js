import { test, expect } from 'bun:test'
import { clamp01, pickupTone, jumpTone, landTone, winTones } from '../src/audio'

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
