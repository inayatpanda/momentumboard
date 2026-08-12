import { describe, expect, it } from 'vitest'
import { journalistBoardRows } from '../report-compose-background.mts'
import { SECTIONS, boardExportRows, buildNewspaperHtml, constrainIdeasToBoard, fallbackIdeasFromBoard, type ComposedReport, type Idea } from './newspaper'
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
  observation: true, // the machine-readable stamp buildBoard writes beside the label
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
    // and the flags that say it is not a position, carried through unchanged.
    // `observation` rides with them so the prompt's own rule about these rows has
    // something to key on — prose in `note` is a hint, a flag is a contract.
    expect(row.observation).toBe(true)
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
      observation: undefined,
    }
    const rows = journalistBoardRows([placeable])
    expect(rows[0].note).not.toContain('observation only')
    expect(rows[0].observation).toBeUndefined()
    const { ideas, rejected } = constrainIdeasToBoard([shortIdea({ ticker: 'AMD' })], rows)
    expect(rejected).toEqual([])
    expect(ideas).toHaveLength(1)
    expect(ideas[0].predictionId).toBe('2026-08-12:AMD:short')
    expect(fallbackIdeasFromBoard(rows)).toHaveLength(1)
  })

  // The wiring the exports actually use: the emailed paper and the print edition
  // are rendered from boardExportRows(journalistBoardRows(board)), so a flag has to
  // survive BOTH hops. It survived neither, and the paper printed the observation
  // as an ordinary watch row under a footer explaining thin evidence.
  it('the flag survives the whole chain into the printed paper', () => {
    const composed: ComposedReport = {
      headline: 'H', standfirst: 'S', lead: 'L', portfolioDesk: 'p', tape: 't', ideas: [],
      shortDesk: 's', rotation: 'r', crypto: 'c', channels: 'ch', editorial: 'e', honestClose: 'h',
      regime: 'amber', fedStance: 'neutral', macroNotes: [],
    }
    const html = buildNewspaperHtml(composed, 'Wednesday, 12 August 2026', {
      engineBoard: boardExportRows(journalistBoardRows([observation])),
    })
    expect(html).toContain('no ISA route — observation only')
    expect(html).toContain('Observation rows cleared every gate')
    expect(html).not.toContain('grade C, thin evidence')
  })

  // The prompt carries an EXCEPTION for the velocity lane: a quarter- or half-size
  // momentum probe is deliberate sizing, so it must not be written up as the
  // half-conviction, evidence-short call a reduced riskPct otherwise means. That rule
  // keyed on catalyst.kind — a field this projection has never carried — so it could
  // never fire once, and every velocity probe reached the reader as the exact sentence
  // the exception exists to forbid. The field the rule keys on and the field the
  // projection carries are asserted TOGETHER: separately, either can drift silently.
  it('the door-cap rule keys on a field the journalist can actually see', () => {
    const velocity: Prediction = {
      ...observation,
      id: '2026-08-12:VELO:long',
      sym: 'VELO',
      side: 'long',
      setup: 'velocity',
      catalyst: { kind: 'velocity', reason: 'velocity (early door): 105 broke the 100 20-session high on 3× volume' },
      note: 'velocity (early door): 105 broke the 100 20-session high on 3× volume',
      riskPct: 0.25,
      watchOnly: undefined,
      observation: undefined,
    }
    const [row] = journalistBoardRows([velocity])
    expect(row.setup).toBe('velocity')
    expect(row.riskPct).toBe(0.25) // the reduced number the rule has to explain away
    expect(row).not.toHaveProperty('catalyst') // …and the field the rule used to key on

    const ideas = SECTIONS.find(s => s.key === 'ideas')!.brief
    expect(ideas).toContain('setup is "velocity"')
    expect(ideas).not.toContain('catalyst.kind')
    expect(ideas).toContain('door cap, NOT an evidence deficiency') // the sentence itself
  })

  it('only the top 16 rows are shown — the prompt budget is finite', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...observation, id: `2026-08-12:S${i}:short`, sym: `S${i}` }))
    expect(journalistBoardRows(many)).toHaveLength(16)
    expect(journalistBoardRows(many).at(-1)!.sym).toBe('S15')
  })
})
