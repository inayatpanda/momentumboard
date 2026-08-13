import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { journalistBoardRows } from '../report-compose-background.mts'
import { ledgerRow } from '../engine.mts'
import { SECTIONS, boardExportRows, buildNewspaperHtml, composePrompt, constrainIdeasToBoard, fallbackIdeasFromBoard, type ComposedReport, type Idea } from './newspaper'
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

// THE VOICE, THROUGH EVERY PROJECTION (voice.ts). A thesis stored on a row is
// worth nothing if the hop into the paper drops it — which is exactly how
// `nearMiss` and `observation` were each lost once (see boardExportRows' own
// docblock). Presence is asserted on trade rows; near misses legitimately carry
// neither field, and every projection has to survive that too.
describe('thesis + falsifier — the two sentences reach the paper', () => {
  const spoken: Prediction = {
    ...observation,
    id: '2026-08-12:ABBV:long',
    sym: 'ABBV',
    side: 'long',
    stage: 'pullback',
    watchOnly: undefined,
    observation: undefined,
    riskPct: 1,
    note: 'technical: pullback, every timeframe pointing up · momentum: 21d RS vs SPY +6.4pp',
    thesis: 'Long ABBV — it has pulled back into support with volume behind it. Wrong if it closes below 178.2.',
    falsifier: 'Wrong if it closes below 178.2.',
  }

  it('journalistBoardRows carries both — the journalist cannot polish what it cannot see', () => {
    const [row] = journalistBoardRows([spoken])
    expect(row.thesis).toBe(spoken.thesis)
    expect(row.falsifier).toBe(spoken.falsifier)
    expect(row.note).toBe(spoken.note) // …and the evidence line is untouched beneath it
  })

  it('boardExportRows carries both — the second hop, where fields have gone missing before', () => {
    const [row] = boardExportRows(journalistBoardRows([spoken]))
    expect(row.thesis).toBe(spoken.thesis)
    expect(row.falsifier).toBe(spoken.falsifier)
  })

  it('the ideas brief tells the model the thesis is its BASE, not a suggestion', () => {
    const brief = SECTIONS.find(s => s.key === 'ideas')!.brief
    expect(brief).toContain('thesis')
    expect(brief).toContain('POLISH, NEVER INVENT')
    expect(brief).toContain('falsifier')
  })

  // …and so does the single-shot fallback prompt. It is the SAME paper written by
  // one call instead of six, reached exactly when the sectioned compose has
  // already failed — the day the rule is least likely to be obeyed is not the day
  // to stop stating it.
  it('the single-shot fallback prompt carries the same rule as the sectioned one', () => {
    const prompt = composePrompt('DATA', 'Wednesday, 12 August 2026')
    expect(prompt).toContain('POLISH, NEVER INVENT')
    expect(prompt).toContain('falsifier')
  })

  it('the printed invalidation cell is the stored falsifier, VERBATIM', () => {
    const { ideas } = constrainIdeasToBoard(
      [{ ...shortIdea({ ticker: 'ABBV', side: 'long', invalidation: 'a level the model made up' }) }],
      journalistBoardRows([spoken]),
    )
    expect(ideas[0].falsifier).toBe(spoken.falsifier) // the model's paraphrase is overwritten, like the numbers
    expect(ideas[0].invalidation).toBe('178.2') // …and the bare level survives for callStrip's live read
    const composed: ComposedReport = {
      headline: 'H', standfirst: 'S', lead: 'L', portfolioDesk: 'p', tape: 't', ideas,
      shortDesk: 's', rotation: 'r', crypto: 'c', channels: 'ch', editorial: 'e', honestClose: 'h',
      regime: 'amber', fedStance: 'neutral', macroNotes: [],
    }
    const html = buildNewspaperHtml(composed, 'Wednesday, 12 August 2026', {})
    expect(html).toContain('Wrong if it closes below 178.2.')
    expect(html).not.toContain('a level the model made up')
  })

  it('…and the desk\'s own fallback writes the case FROM the thesis, not from the factor line', () => {
    const [idea] = fallbackIdeasFromBoard(journalistBoardRows([spoken]))
    expect(idea.caseText).toBe('Long ABBV — it has pulled back into support with volume behind it.')
    expect(idea.caseText).not.toContain('technical:')
    expect(idea.falsifier).toBe(spoken.falsifier)
  })

  // The thesis ENDS with the falsifier by construction (voice.ts) and the
  // invalidation cell prints the falsifier on its own line — so a fallback case
  // that copies the whole thesis makes the paper say "Wrong if it closes below
  // 178.2." twice in one idea, once as the case and once as the level.
  it('the fallback case does not reprint the falsifier the invalidation cell already carries', () => {
    const [idea] = fallbackIdeasFromBoard(journalistBoardRows([spoken]))
    expect(idea.caseText).not.toContain(spoken.falsifier!)
    const composed: ComposedReport = {
      headline: 'H', standfirst: 'S', lead: 'L', portfolioDesk: 'p', tape: 't', ideas: [idea],
      shortDesk: 's', rotation: 'r', crypto: 'c', channels: 'ch', editorial: 'e', honestClose: 'h',
      regime: 'amber', fedStance: 'neutral', macroNotes: [],
    }
    const html = buildNewspaperHtml(composed, 'Wednesday, 12 August 2026', {})
    expect(html.split(spoken.falsifier!).length - 1).toBe(1) // printed once, in the cell that owns it
  })

  it('…and a row whose thesis is NOT the engine\'s (or has no falsifier) is copied whole', () => {
    const legacy = { ...spoken, thesis: 'An older row whose case was written before the falsifier was its own field.', falsifier: undefined }
    const [idea] = fallbackIdeasFromBoard(journalistBoardRows([legacy]))
    expect(idea.caseText).toBe(legacy.thesis)
  })

  it('a near miss has neither, and every projection handles that cleanly', () => {
    const miss: Prediction = { ...spoken, id: '2026-08-12:MISS:long', sym: 'MISS', nearMiss: true, watchOnly: true, thesis: undefined, falsifier: undefined }
    const [row] = journalistBoardRows([miss])
    expect(row.thesis).toBeUndefined()
    expect(row.falsifier).toBeUndefined()
    const [exported] = boardExportRows(journalistBoardRows([miss]))
    expect(exported.thesis).toBeUndefined()
    expect(exported.falsifier).toBeUndefined()
    // …and the fixed level is still what the invalidation cell shows
    const { ideas } = constrainIdeasToBoard([shortIdea({ ticker: 'MISS', side: 'long' })], journalistBoardRows([{ ...miss, watchOnly: undefined }]))
    expect(ideas[0].falsifier).toBeUndefined()
    const composed: ComposedReport = {
      headline: 'H', standfirst: 'S', lead: 'L', portfolioDesk: 'p', tape: 't', ideas,
      shortDesk: 's', rotation: 'r', crypto: 'c', channels: 'ch', editorial: 'e', honestClose: 'h',
      regime: 'amber', fedStance: 'neutral', macroNotes: [],
    }
    expect(buildNewspaperHtml(composed, 'Wednesday, 12 August 2026', {})).toContain('>178.2<')
  })

  it('the ledger projection carries them too — a historical call can still be audited', () => {
    expect(ledgerRow(spoken).thesis).toBe(spoken.thesis)
    expect(ledgerRow(spoken).falsifier).toBe(spoken.falsifier)
    expect(ledgerRow({ ...spoken, thesis: undefined, falsifier: undefined }).thesis).toBeUndefined()
  })
})

// The gathering half of the handler runs inside a Netlify background function
// against live blobs, so the seam is pinned where it lives: in the source. What
// matters is WHICH read feeds the paper — `gateStateSummary` is the panel's
// standing record and handing it to the writer re-announced months-old notches
// as today's news (Task-3 review, Important 2).
describe('the compose handler asks the gate blob for TODAY, not for everything', () => {
  const src = readFileSync(join(process.cwd(), 'netlify', 'functions', 'report-compose-background.mts'), 'utf8')

  it('reads the date-bounded announcement and carries its two keys separately', () => {
    expect(src).toContain('gateAnnouncement(await blobAppStore.read(GATE_STATE_KEY), dateISO)')
    expect(src).not.toContain('gateStateSummary')
    // moves and notes travel under their own keys — never concatenated
    expect(src).toMatch(/gateMoves = gateAnnounce\?\.moves\.length/)
    expect(src).toMatch(/gateNotes = gateAnnounce\?\.notes\.length/)
    expect(src).toMatch(/\n\s+gateMoves,\n\s+gateNotes,\n/)
  })
})
