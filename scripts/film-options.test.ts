import { expect, test } from 'bun:test'
import { filmOptions } from './film-options'

const defaults = { fps: 30, duration: 12 }

test('film export defaults and value flags before the script path', () => {
  expect(filmOptions(['scene.json'], defaults)).toEqual({ script: 'scene.json', out: undefined, fps: 30, from: 0, to: 12, quality: 95, audio: true })
  expect(filmOptions(['--out', 'movie.mp4', '--from', '2', 'scene.json', '--to', '4', '--no-audio'], defaults)).toMatchObject({ script: 'scene.json', out: 'movie.mp4', from: 2, to: 4, audio: false })
})

test('film export rejects empty or reversed ranges, including an explicit zero end', () => {
  for (const args of [['--to', '0'], ['--from', '4', '--to', '2'], ['--from', '12'], ['--to', '-1']]) {
    expect(() => filmOptions(['scene.json', ...args], defaults)).toThrow('Export range')
  }
})

test('film export rejects malformed options before launching external tools', () => {
  for (const args of [[], ['scene.json', '--fps'], ['scene.json', '--fps', '--no-audio'], ['scene.json', '--typo'], ['scene.json', 'other.json'], ['scene.json', '--fps', '30', '--fps', '24']]) {
    expect(() => filmOptions(args, defaults)).toThrow()
  }
  for (const flag of ['--fps', '--from', '--to', '--jpeg-quality']) {
    for (const value of ['NaN', 'Infinity', '-Infinity', 'oops', ' ']) {
      expect(() => filmOptions(['scene.json', flag, value], defaults)).toThrow('finite number')
    }
  }
})

test('film export keeps finite limits and an explicit zero quality', () => {
  expect(filmOptions(['scene.json', '--fps', '100', '--to', '100', '--from', '-1', '--jpeg-quality', '0'], defaults)).toMatchObject({ fps: 60, from: 0, to: 12, quality: 50 })
})
