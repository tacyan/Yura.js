/**
 * ORB RUSH — pure game logic. No DOM, no GPU, unit-testable with `bun test`.
 */

/** How many orbs ring the arena (win when they are all collected). */
export const ORB_GOAL = 10

/** HUD label for the current score. */
export function orbLabel(score: number): string {
  return `ORBS ${score}`
}

/** True once every orb has been collected. */
export function isWin(score: number, goal = ORB_GOAL): boolean {
  return score >= goal
}

/**
 * Ring the arena with orbs: `count` positions on a circle of `radius` at
 * height `y`. The first position lands at `[3, 1, 0]` with the defaults.
 */
export function orbRing(count = ORB_GOAL, radius = 3, y = 1): [number, number, number][] {
  return Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2
    return [Math.cos(a) * radius, y, Math.sin(a) * radius]
  })
}
