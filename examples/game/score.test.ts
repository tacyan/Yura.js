import { describe, expect, test } from 'bun:test'
import { ORB_GOAL, isWin, orbLabel, orbRing } from './score'

describe('ORB RUSH score logic', () => {
  test('orbLabel formats the HUD line', () => {
    expect(orbLabel(0)).toBe('ORBS 0')
    expect(orbLabel(7)).toBe('ORBS 7')
  })

  test('isWin fires exactly at the goal', () => {
    expect(isWin(ORB_GOAL - 1)).toBe(false)
    expect(isWin(ORB_GOAL)).toBe(true)
  })

  test('orbRing rings the arena, starting at the README orb [3, 1, 0]', () => {
    const ring = orbRing()
    expect(ring).toHaveLength(ORB_GOAL)
    expect(ring[0][0]).toBeCloseTo(3)
    expect(ring[0][1]).toBeCloseTo(1)
    expect(ring[0][2]).toBeCloseTo(0)
    for (const [x, y, z] of ring) {
      expect(Math.hypot(x, z)).toBeCloseTo(3)
      expect(y).toBe(1)
    }
  })
})
