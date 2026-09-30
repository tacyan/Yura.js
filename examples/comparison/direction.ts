import { stageThemes, stageWorlds, stageDecor, motions, cameraMoves, stageTransitions } from 'yura'
import type { StageOptions, KineticLine } from 'yura'
import { briefs, LINES, SEED, EVERY, type BriefName } from './briefs'

const choose = (table: object, candidates: readonly string[]) => {
  const name = candidates.find((candidate) => Object.hasOwn(table, candidate))
  if (!name) throw new Error(`No supported recipe in: ${candidates.join(', ')}`)
  return name
}

/** Identical capability selection policy in both bundles. */
export function direction(key: BriefName) {
  const brief = briefs[key]
  const selected = {
    theme: choose(stageThemes, brief.theme), world: choose(stageWorlds, brief.world),
    enter: choose(motions.enter, brief.enter), hold: choose(motions.hold, brief.hold), exit: choose(motions.exit, brief.exit),
    transition: choose(stageTransitions, brief.transition), camera: choose(cameraMoves, brief.camera),
  }
  const lines = LINES.map((text, i) => ({ text, at: i * EVERY, enter: selected.enter, hold: selected.hold, exit: selected.exit, layout: 'center', treat: 'none' })) as KineticLine[]
  const options = {
    ...selected, seed: SEED, every: EVERY, loop: false, loopTail: EVERY,
    enterDuration: 1, exitDuration: 0.7,
    decor: brief.decor.filter((name) => Object.hasOwn(stageDecor, name)),
  } as StageOptions
  const counts = {
    themes: Object.keys(stageThemes).length, worlds: Object.keys(stageWorlds).length,
    motions: Object.values(motions).reduce((total, registry) => total + Object.keys(registry).length, 0),
    transitions: Object.keys(stageTransitions).length,
  }
  return { selected, lines, options, counts }
}
