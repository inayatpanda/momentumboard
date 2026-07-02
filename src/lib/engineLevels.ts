import type { EntryQuality, Stage, TechnicalRead } from '../../shared/technicals'

// Pure, canvas-free builders that turn engine data into chart-annotation specs.
// PriceChart consumes these and resolves the colour ROLE to a themed CSS value at
// draw time — so the mapping (which is what we test) never touches the DOM.

export type ColorRole = 'ink' | 'up' | 'down'

export interface PriceLineSpec {
  price: number
  title: string
  role: ColorRole
}

export interface StageMarkerSpec {
  position: 'aboveBar' | 'belowBar'
  role: ColorRole
  text: string
}

// A live board call carries side-encoded levels already: a short's stop sits
// ABOVE entry and its target BELOW. We never re-orient — we trust the values and
// only colour them (stop = red semantic, target = green semantic, entry = ink).
export interface CallLevels {
  side: 'long' | 'short'
  entry: number
  stop: number
  target: number
}

export function engineLevelLines(call: CallLevels): PriceLineSpec[] {
  return [
    { price: call.entry, title: 'engine entry', role: 'ink' },
    { price: call.stop, title: 'engine stop', role: 'down' },
    { price: call.target, title: 'engine target', role: 'up' },
  ]
}

// early = green semantic, chase = red semantic, neutral/wait = ink.
export function entryQualityRole(q: EntryQuality): ColorRole {
  return q === 'early' ? 'up' : q === 'chase' ? 'down' : 'ink'
}

const STAGE_SHORT: Record<Stage, string> = {
  'early-reversal': 'reversal',
  basing: 'basing',
  pullback: 'pullback',
  trending: 'trending',
  extended: 'extended',
  exhausted: 'exhausted',
  'falling-knife': 'knife',
  weak: 'weak',
}

export function stageShortLabel(stage: Stage): string {
  return STAGE_SHORT[stage] ?? stage
}

export function stageMarkerSpec(read: TechnicalRead): StageMarkerSpec {
  // above the last bar: the recent high usually has open space, so the label
  // clears the candles and (when present) the clustered price-line titles.
  return {
    position: 'aboveBar',
    role: entryQualityRole(read.entryQuality),
    text: stageShortLabel(read.stage),
  }
}
