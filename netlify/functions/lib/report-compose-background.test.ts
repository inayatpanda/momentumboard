import { describe, expect, it } from 'vitest'
import { journalistBoardRows } from '../report-compose-background.mts'
import { constrainIdeasToBoard, fallbackIdeasFromBoard, type Idea } from './newspaper'
import type { FactorName, FactorScore, Prediction } from '../../../shared/engine/types'

const factors = Object.fromEntries(
  (['technical', 'momentum', 'sector', 'social', 'channels', 'insiders', 'news', 'seasonality', 'smartMoney', 'catalyst'] as FactorName[]).map(n => [
    n,
    { score: n === 'technical' ? -62 : null, detail: n === 'technical' ? 'below every moving average' : 'no data', weight: 1 },
  ]),
) as Record<FactorName, FactorScore & { weight: number }>

/** Exactly what buildBoard's observation rank writes: a short that cleared every
 * gate, was shadowed only because an ISA cannot place it, and was then promoted
 * onto an otherwise nameless side as a labelled watch row. */
const observation: Prediction = {
  id: '2026-08-12:NVDA:short',
  date: '2026-08-12',
  sym: 'NVDA',
  side: 'short',
  composite: -58,
  factors,
  setup: 'continuation',
  evidence: { coverage: 0.9, famAgree: 3, contract: true, contextPts: 0, detail: 'core 4/4 · no ISA route — observation only' },
  expectedMovePct: 7.4,
  entry: 162,
  stop: 178.2,
  target: 145.8,
  capacityPct: 9.1,
  smallCap: false,
  earningsRisk: false,
  stage: 'weak',
  note: 'weak, below the 50-day · no ISA route — observation only',
  probability: 0.68,
  provisional: false,
  grade: 'A',
  regime: 'amber',
  priceAtPrediction: 162,
  riskRung: 1,
  riskPct: 0,
  instrument: null,
  paperOnly: false,
  watchOnly: true,
}

const shortIdea = (over: Partial<Idea> = {}): Idea => ({
  ticker: 'NVDA',
  side: 'short',
  playbook: 'S',
  caseText: 'the journalist writes it up as a trade',
  entry: '162',
  invalidation: '178.2',
  target: '145.8',
  conviction: 'A',
  ...over,
})

// The observation rank (2026-08-12) put a real, graded, UNPLACEABLE short in front
// of the journalist for the first time. Everything downstream of the prompt reads
// two fields to keep that honest — the label in `note` and the `watchOnly` flag —
// and neither was covered on this path.
describe('journalistBoardRows — the board the paper is written from', () => {
  it('a promoted route-blocked observation reaches the journalist LABELLED', () => {
    const [row] = journalistBoardRows([observation])
    expect(row.note).toContain('no ISA route — observation only')
    expect(row.evidence).toContain('no ISA route — observation only')
    // and the flags that say it is not a position, carried through unchanged
    expect(row.watchOnly).toBe(true)
    expect(row.riskPct).toBe(0)
    expect(row.instrument).toBeNull()
    expect(row.paperOnly).toBe(false) // an observation is nobody's position
    expect(row.nearMiss).toBeUndefined() // …and it is not a near miss: it cleared every gate
  })

  it('…and can never be presented as a placeable short', () => {
    const rows = journalistBoardRows([observation])
    // the journalist writing it up as a trade is refused, by name
    const { ideas, rejected } = constrainIdeasToBoard([shortIdea()], rows)
    expect(ideas).toEqual([])
    expect(rejected).toEqual(['NVDA short (watch-only)'])
    // …and the desk's own fallback, which fires when the LLM files nothing usable,
    // will not promote it either — a paper with no ideas beats a paper that tells
    // the reader to sell something no ISA of theirs can sell.
    expect(fallbackIdeasFromBoard(rows)).toEqual([])
  })

  it('a routable short on the same board is still fully placeable', () => {
    // the control: the containment above must come from the observation's own
    // flags, not from journalistBoardRows quietly neutering every short
    const placeable: Prediction = {
      ...observation,
      id: '2026-08-12:AMD:short',
      sym: 'AMD',
      note: 'weak, below the 50-day',
      evidence: { ...observation.evidence, detail: 'core 4/4' },
      riskPct: 1,
      instrument: { ticker: 'SAMD', leverage: 2 },
      watchOnly: undefined,
    }
    const rows = journalistBoardRows([placeable])
    expect(rows[0].note).not.toContain('observation only')
    const { ideas, rejected } = constrainIdeasToBoard([shortIdea({ ticker: 'AMD' })], rows)
    expect(rejected).toEqual([])
    expect(ideas).toHaveLength(1)
    expect(ideas[0].predictionId).toBe('2026-08-12:AMD:short')
    expect(fallbackIdeasFromBoard(rows)).toHaveLength(1)
  })

  it('only the top 16 rows are shown — the prompt budget is finite', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...observation, id: `2026-08-12:S${i}:short`, sym: `S${i}` }))
    expect(journalistBoardRows(many)).toHaveLength(16)
    expect(journalistBoardRows(many).at(-1)!.sym).toBe('S15')
  })
})
