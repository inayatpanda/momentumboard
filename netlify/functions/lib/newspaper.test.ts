import { describe, it, expect } from 'vitest'
import { buildDataJson, boardExportRows, paperPostMortems, COMPOSE_DROP_ORDER, PAPER_POSTMORTEM_MAX, fallbackIdeasFromBoard, parseComposed, buildNewspaperHtml, constrainIdeasToBoard, mergeSections, sectionPrompt, SECTIONS, validateNominations, mergeNominations, findVerbatimRepeats, type ComposedReport, type StoredNomination } from './newspaper'
import type { Prediction } from '../../../shared/engine/types'

const sample: ComposedReport = {
  headline: 'Tech Leads a Cautious Tape Higher',
  standfirst: 'Rotation into growth firms up while the short week keeps volumes thin.',
  lead: 'First paragraph.\n\nSecond paragraph with <angle brackets>.',
  portfolioDesk: 'Journal empty; nothing to review.',
  tape: 'SPY above both averages; regime green.',
  ideas: [
    { ticker: 'NBIS', name: 'Nebius Group', side: 'long', playbook: 'R', caseText: 'Base reclaim on volume', entry: '52.40', invalidation: '48.90', target: '61', conviction: 'B' },
    { ticker: 'XLE', side: 'short', playbook: 'S', caseText: 'Overextended vs 20-day', entry: '3CRS.L', invalidation: 'oil > 84', target: '-6%', conviction: 'C', strength: 'strong', reasons: ['RSI 81', 'analogues fade', 'rotation out'] },
  ],
  shortDesk: 'One clean fade (see table).',
  rotation: 'Money into tech and comms, out of defensives.',
  crypto: 'BTC holding 60k; Uptober seasonality far off.',
  channels: 'Josh cautious; take: agrees with regime.',
  editorial: 'In 1999 the same rotation preceded the melt-up.\n\nDiscipline beat conviction then too.',
  honestClose: 'Confidence B. Wrong if SPY loses 20-day.',
  regime: 'green',
  fedStance: 'neutral',
  macroNotes: ['Short week', 'NFP Friday'],
}

describe('parseComposed', () => {
  it('parses a JSON blob with surrounding prose and validates regime', () => {
    const r = parseComposed(`Here you go:\n${JSON.stringify({ ...sample, regime: 'weird' })}`)
    expect(r?.headline).toBe(sample.headline)
    expect(r?.regime).toBe('amber') // invalid regime coerced
  })
  it('rejects non-JSON and missing essentials', () => {
    expect(parseComposed('no json here')).toBeNull()
    expect(parseComposed('{"foo":1}')).toBeNull()
  })
})

describe('buildNewspaperHtml', () => {
  const html = buildNewspaperHtml(sample, 'Thursday 2 July 2026')
  it('renders masthead, departments, ideas table and og meta', () => {
    expect(html).toContain('THE STREET SIGNAL')
    expect(html).toContain('Regime: <b>GREEN</b>')
    expect(html).toContain('og:title" content="Tech Leads a Cautious Tape Higher"')
    // the publisher's personal book left the paper 2026-07-15 — its section must NOT render even when old composed JSON still carries the field
    expect(html).not.toContain('Portfolio Desk')
    expect(html).toContain('I STRONGLY SUGGEST')
    expect(html).toContain('NBIS')
    expect(html).toContain('SHORT')
  })
  it('renders ideas as stacked blocks: company name, level labels, no legacy table header', () => {
    expect(html).toContain('Nebius Group') // company name enriched onto the idea
    expect(html).toContain('class="idea"') // stacked block, not a 7-column row
    for (const label of ['Entry', 'Invalidation', 'Target', 'Potential']) expect(html).toContain(`>${label}</div>`)
    expect(html).toContain('Reversal') // playbook badge label, not the bare letter 'R'
    expect(html).toContain('Grade B') // conviction chip
    expect(html).not.toContain('The case') // the old THE CASE / prose column header is gone
    expect(html).not.toContain('class="ideas"') // the crushing fixed-layout table is gone
  })
  it('renders the sector heatmap as an email-safe tinted table with names + values (no svg dependency)', () => {
    const withHeat = buildNewspaperHtml(sample, 'x', { sectorBars: [{ name: 'Technology', rs21: 3.2 }, { name: 'Energy', rs21: -1.5 }, { name: 'Utilities', rs21: null }] })
    expect(withHeat).toContain('Technology')
    expect(withHeat).toContain('+3.2') // value shown, never colour-alone
    expect(withHeat).toContain('Energy')
    expect(withHeat).toContain('-1.5')
    expect(withHeat).toContain('rgba(12,122,85') // green tint for positive rs21
    expect(withHeat).toContain('rgba(176,48,64') // red tint for negative rs21
    expect(withHeat).not.toContain('Utilities') // null rs21 dropped, not rendered
  })
  it('escapes html in model output and omits empty departments', () => {
    expect(html).toContain('&lt;angle brackets&gt;')
    expect(html).not.toContain("Reader's Notes") // omitted when absent
    expect(html).not.toContain('Small-Cap Wire')
  })
  it('marks first editions and pdf links when provided', () => {
    const first = buildNewspaperHtml(sample, 'x', { firstEdition: true, pdfLink: 'https://canva/x.pdf' })
    expect(first).toContain('First edition')
    expect(first).toContain('Print edition (PDF)')
  })
})

describe('event radar in the paper', () => {
  const radar = [
    { sym: 'IBM', name: 'International Business Machines', date: '2026-07-23', daysToPrint: 4, stage: 'weak', rs21: -3.2, note: 'Below the 50-day and drifting — no edge here.' },
    { sym: 'NVDA', name: 'NVIDIA Corp', date: '2026-07-28', daysToPrint: 9, stage: 'pullback', rs21: 2.1, note: 'Healthy pullback.' },
  ]
  const html = buildNewspaperHtml(sample, 'Thursday 2 July 2026', { eventRadar: radar })
  it('renders the Event Radar section with a merged company cell and days-to-print', () => {
    expect(html).toContain('Event Radar — Prints Ahead')
    // ticker bold + name subtle share ONE cell (the phone-safe New Listings pattern)
    expect(html).toContain('<b>IBM</b> <span class="subtle">International Business Machines</span>')
    expect(html).toContain('4d') // days to print
    expect(html).toContain('weak') // the shape going in
  })
  it('colours rs21 by sign and prints the never-bet-a-print footer', () => {
    expect(html).toContain('RS -3.2pp')
    expect(html).toContain('class="num dn"') // negative RS renders red
    expect(html).toContain('RS +2.1pp')
    expect(html).toContain('never bets an earnings print')
  })
  it('no radar → no section', () => {
    expect(buildNewspaperHtml(sample, 'x').includes('Event Radar')).toBe(false)
  })
})

describe('sectioned compose', () => {
  it('merges section outputs into a valid report', () => {
    const parts = [
      { headline: 'H', standfirst: 'S', lead: 'L', regime: 'green', fedStance: 'neutral', macroNotes: ['x'] },
      { portfolioDesk: 'empty', tape: 'tape' },
      { ideas: [], shortDesk: 'none' },
      { channels: 'c' },
      { rotation: 'r', crypto: 'b' },
      { editorial: 'e', honestClose: 'h' },
    ]
    const merged = mergeSections(parts as never)
    expect(merged?.headline).toBe('H')
    expect(merged?.editorial).toBe('e')
    expect(mergeSections([null, { tape: 'only' }] as never)).toBeNull() // essentials missing
  })
  it('every section prompt names its own fields and carries the data', () => {
    for (const spec of SECTIONS) {
      const p = sectionPrompt(spec, 'DATA-MARKER', 'Friday 3 July 2026')
      expect(p).toContain('DATA-MARKER')
      for (const f of spec.fields) expect(p).toContain(f)
    }
  })
})

describe('constrainIdeasToBoard', () => {
  const board = [
    { id: '2026-07-02:NVDA:short', sym: 'NVDA', side: 'short' as const, entry: 162, stop: 178.2, target: 145.8, probability: 0.67, grade: 'A' as const, expectedMovePct: 6.1, instrument: null, paperOnly: true },
    { id: '2026-07-02:PLTR:long', sym: 'PLTR', side: 'long' as const, entry: 30, stop: 27, target: 36, probability: 0.58, grade: 'B' as const, expectedMovePct: 8, instrument: { ticker: 'LPLT', leverage: 2 }, paperOnly: false },
  ]
  const idea = (over: Record<string, unknown> = {}) => ({
    ticker: 'NVDA', side: 'short' as const, playbook: 'S' as const, caseText: 'case',
    entry: '999', invalidation: '1', target: '2', conviction: 'C' as const, ...over,
  })

  it('rejects tickers not on the board; board numbers overwrite LLM numbers', () => {
    const { ideas, rejected } = constrainIdeasToBoard([idea(), idea({ ticker: 'HALLUCIN' })] as never, board)
    expect(rejected).toEqual(['HALLUCIN short'])
    expect(ideas).toHaveLength(1)
    expect(ideas[0].entry).toBe('162')
    expect(ideas[0].invalidation).toBe('178.2')
    expect(ideas[0].target).toBe('145.8')
    expect(ideas[0].conviction).toBe('A') // grade, not the LLM's C
    expect(ideas[0].predictionId).toBe('2026-07-02:NVDA:short')
  })

  it('veto drops the idea from the paper but records the overlay for grading', () => {
    const { ideas, overlays } = constrainIdeasToBoard(
      [idea({ overlay: { flag: 'veto', reason: 'CEO subpoenaed this morning' } }), idea({ ticker: 'PLTR', side: 'long', overlay: { flag: 'boost', reason: 'earnings beat in headlines' } })] as never,
      board,
    )
    expect(ideas).toHaveLength(1)
    expect(ideas[0].ticker).toBe('PLTR')
    expect(ideas[0].overlay?.flag).toBe('boost')
    expect(overlays).toEqual([
      { predictionId: '2026-07-02:NVDA:short', flag: 'veto', reason: 'CEO subpoenaed this morning' },
      { predictionId: '2026-07-02:PLTR:long', flag: 'boost', reason: 'earnings beat in headlines' },
    ])
  })

  it('junk overlay flags are ignored, idea kept', () => {
    const { ideas, overlays } = constrainIdeasToBoard([idea({ overlay: { flag: 'nuke', reason: 'x' } })] as never, board)
    expect(ideas).toHaveLength(1)
    expect(ideas[0].overlay).toBeUndefined()
    expect(overlays).toEqual([])
  })
})

describe('validateNominations', () => {
  it('uppercases the ticker, trims the reason to 180 chars, dedupes, caps at 3', () => {
    const out = validateNominations([
      { ticker: 'nbis', reason: '  AI data-centre deal in [FT] headline  ' },
      { ticker: 'NBIS', reason: 'duplicate — dropped before the cap' },
      { ticker: 'brk.b', reason: 'a'.repeat(300) },
      { ticker: 'SMCI', reason: 'third unique — the last that fits' },
      { ticker: 'TSLA', reason: 'a fourth unique — over the cap' },
    ])
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual({ sym: 'NBIS', reason: 'AI data-centre deal in [FT] headline' })
    expect(out.find(n => n.sym === 'BRK.B')!.reason).toHaveLength(180)
    expect(out.some(n => n.sym === 'SMCI')).toBe(true) // dupe freed the slot
    expect(out.some(n => n.sym === 'TSLA')).toBe(false) // cap of 3
  })

  it('rejects junk: non-array, non-objects, bad tickers, empty/whitespace reasons, non-string fields', () => {
    expect(validateNominations(null)).toEqual([])
    expect(validateNominations('nope')).toEqual([])
    expect(validateNominations(undefined)).toEqual([])
    expect(
      validateNominations([
        { ticker: 'TOOLONGTICKER1', reason: 'over 10 chars' },
        { ticker: 'BAD SYM', reason: 'space fails the regex' },
        { ticker: 'AAPL', reason: '' },
        { ticker: 'AAPL', reason: '   ' },
        { ticker: 42, reason: 'ticker not a string' },
        { ticker: 'MSFT', reason: 99 },
        'garbage',
        { reason: 'no ticker at all' },
      ]),
    ).toEqual([])
  })
})

describe('mergeNominations', () => {
  const DAY = 86_400
  const now = 2_000_000_000
  it('merges fresh over existing, dedupes by sym keeping the newest, drops >7d, refreshes date/at', () => {
    const existing: StoredNomination[] = [
      { sym: 'AAA', reason: 'old aaa', date: '2026-06-01', at: now - 2 * DAY },
      { sym: 'BBB', reason: 'keep bbb', date: '2026-06-01', at: now - 3 * DAY },
      { sym: 'OLD', reason: 'expired', date: '2026-05-01', at: now - 8 * DAY },
    ]
    const out = mergeNominations(existing, [{ sym: 'AAA', reason: 'new aaa' }, { sym: 'CCC', reason: 'new ccc' }], '2026-06-10', now)
    const bySym = Object.fromEntries(out.map(n => [n.sym, n]))
    expect(out).toHaveLength(3)
    expect(bySym.AAA).toEqual({ sym: 'AAA', reason: 'new aaa', date: '2026-06-10', at: now }) // newest wins
    expect(bySym.BBB.reason).toBe('keep bbb') // untouched, still fresh
    expect(bySym.CCC).toBeDefined()
    expect(bySym.OLD).toBeUndefined() // expired past the 7-day TTL
  })

  it('runs expiry with no fresh nominations and caps at 15 newest-first', () => {
    const stale = mergeNominations([{ sym: 'Z', reason: 'z', date: 'x', at: now - 10 * DAY }], [], '2026-06-10', now)
    expect(stale).toEqual([])
    const many: StoredNomination[] = Array.from({ length: 20 }, (_, i) => ({ sym: `S${i}`, reason: 'r', date: 'd', at: now - i * 3600 }))
    const capped = mergeNominations(many, [], '2026-06-10', now)
    expect(capped).toHaveLength(15)
    expect(capped[0].sym).toBe('S0') // newest first
    expect(capped.some(n => n.sym === 'S15')).toBe(false) // oldest trimmed
  })
})

describe('buildDataJson', () => {
  const obj = { keep: 'x'.repeat(50), colourA: 'y'.repeat(200), colourB: 'z'.repeat(200) }
  it('fits → untouched, nothing dropped', () => {
    const { json, dropped } = buildDataJson(obj, ['colourA', 'colourB'], 10_000)
    expect(dropped).toEqual([])
    expect(JSON.parse(json).keep).toBeDefined()
  })
  it('over budget → drops whole keys in order, minimally, stays valid JSON', () => {
    const { json, dropped } = buildDataJson(obj, ['colourA', 'colourB'], 350)
    expect(dropped).toEqual(['colourA']) // dropping A suffices — B survives
    const parsed = JSON.parse(json) // must never be a mid-string cut
    expect(parsed.keep).toBeDefined()
    expect(parsed.colourB).toBeDefined()
    expect(parsed.colourA).toBeUndefined()
    // tighter budget takes both
    expect(buildDataJson(obj, ['colourA', 'colourB'], 120).dropped).toEqual(['colourA', 'colourB'])
  })
  it('an oversized NON-droppable field stays valid JSON, never a mid-string slice (L-4)', () => {
    const big = { headlines: 'H'.repeat(5000), board: ['A'.repeat(3000)] } // nothing in dropOrder
    const { json } = buildDataJson(big, [], 1_000)
    expect(json.length).toBeLessThanOrEqual(1_000)
    expect(() => JSON.parse(json)).not.toThrow() // the old code sliced → SyntaxError
    expect(JSON.parse(json).headlines).toBeDefined()
  })
})

describe('deterministic board table in the paper', () => {
  const composed: ComposedReport = {
    headline: 'H', standfirst: 'S', lead: 'L', portfolioDesk: 'p', tape: 't', ideas: [],
    shortDesk: 's', rotation: 'r', crypto: 'c', channels: 'ch', editorial: 'e', honestClose: 'h',
    regime: 'amber', fedStance: 'neutral', macroNotes: [],
  }
  const board = [{
    sym: 'IREN', side: 'short' as const, grade: 'C' as const, provisional: false, probability: 0.5,
    entry: 38.82, stop: 46.16, target: 29.03, expectedMovePct: 8.8, paperOnly: true, earningsRisk: false, instrument: null,
  }]
  it('renders grades/levels in code even when the LLM wrote no ideas', () => {
    const html = buildNewspaperHtml(composed, 'Thursday, 2 July 2026', { engineBoard: board })
    expect(html).toContain('The Board — Engine Calls')
    expect(html).toContain('IREN')
    expect(html).toContain('50%')
    expect(html).toContain('46.16')
    expect(html).toContain('paper-only')
  })
  it('no board → no section', () => {
    const html = buildNewspaperHtml(composed, 'Thursday, 2 July 2026', { engineBoard: [] })
    expect(html).not.toContain('The Board — Engine Calls')
  })

  // A near miss cleared NO gate. Printing "C · watch" and a 50% probability
  // beside it dresses two placeholders as measurements — on precisely the
  // mornings when near misses are the only rows the paper has.
  const nearMissRow = {
    sym: 'DROP', side: 'short' as const, grade: 'C' as const, provisional: true, probability: 0.5,
    entry: 10, stop: 11.5, target: 8.6, expectedMovePct: 4.2, paperOnly: false, watchOnly: true,
    nearMiss: true, earningsRisk: false, instrument: null,
  }

  it('a near-miss row wears no letter grade and no probability — it says what it is', () => {
    const html = buildNewspaperHtml(composed, 'Thursday, 2 July 2026', { engineBoard: [nearMissRow] })
    expect(html).toContain('DROP')
    expect(html).toContain('nearest miss &mdash; did not clear the gates')
    expect(html).not.toContain('C&middot;prov') // no grade chip
    expect(html).not.toContain('&middot;watch')
    expect(html).not.toContain('50%') // no calibrated probability it never earned
  })

  it('the footer explains only the row kinds actually on the board', () => {
    const nm = buildNewspaperHtml(composed, 'Thursday, 2 July 2026', { engineBoard: [nearMissRow] })
    expect(nm).toContain('Nearest-miss rows cleared NO gate')
    expect(nm).not.toContain('Paper-only calls are analysis') // no paper-only row present
    expect(nm).not.toContain('grade C, thin evidence') // the watch clause is not the near-miss clause

    const sized = buildNewspaperHtml(composed, 'Thursday, 2 July 2026', { engineBoard: board })
    expect(sized).toContain('Paper-only calls are analysis')
    expect(sized).not.toContain('Nearest-miss rows cleared NO gate')
  })

  it('an ordinary watch row keeps its grade and probability', () => {
    const watch = { ...nearMissRow, sym: 'WTCH', nearMiss: false, provisional: false }
    const html = buildNewspaperHtml(composed, 'Thursday, 2 July 2026', { engineBoard: [watch] })
    expect(html).toContain('50%')
    expect(html).toContain('&middot;watch')
    expect(html).not.toContain('nearest miss')
    expect(html).toContain('grade C, thin evidence')
  })

  // The near miss's mirror image: this row cleared EVERY gate, so its grade and
  // probability are real and stay. What it cannot do is be bought — no ISA route
  // exists — and printing it as an ordinary watch row under a footer explaining
  // watch rows as "grade C, thin evidence" tells the reader a true sentence about
  // a different row, which is the one thing this board is not allowed to do.
  const observationRow = {
    ...nearMissRow, sym: 'OBS', grade: 'B' as const, provisional: false, probability: 0.62,
    nearMiss: false, observation: true,
  }

  it('an observation row keeps its real numbers but says the route is what stops it', () => {
    const html = buildNewspaperHtml(composed, 'Thursday, 2 July 2026', { engineBoard: [observationRow] })
    expect(html).toContain('OBS')
    expect(html).toContain('62%') // the probability is earned, unlike a near miss's
    expect(html).toContain('B&middot;observation')
    expect(html).toContain('no ISA route — observation only')
    expect(html).not.toContain('&middot;watch') // …and it is not filed as thin evidence
    expect(html).not.toContain('nearest miss')
  })

  it('the footer explains the observation instead of miscasting it as a thin-evidence watch row', () => {
    const html = buildNewspaperHtml(composed, 'Thursday, 2 July 2026', { engineBoard: [observationRow] })
    expect(html).toContain('Observation rows cleared every gate')
    expect(html).not.toContain('grade C, thin evidence')
    expect(html).not.toContain('Nearest-miss rows cleared NO gate')

    // …and a board with BOTH kinds earns both clauses, each about its own rows
    const mixed = buildNewspaperHtml(composed, 'Thursday, 2 July 2026', {
      engineBoard: [observationRow, { ...nearMissRow, sym: 'WTCH', nearMiss: false }],
    })
    expect(mixed).toContain('Observation rows cleared every gate')
    expect(mixed).toContain('grade C, thin evidence')
  })

  // The projection the compose pipe hands BOTH exports (email HTML + print PDF).
  // It used to be a hand-written literal that silently dropped nearMiss, so the
  // containment above was dead code in production: every renderer downstream saw
  // a graded call where the engine had said no.
  describe('boardExportRows — the projection every export renders from', () => {
    it('carries the row kinds through — nearMiss and observation included', () => {
      const rows = boardExportRows([nearMissRow, { ...board[0], watchOnly: false }, observationRow])
      expect(rows[0].nearMiss).toBe(true)
      expect(rows[0].watchOnly).toBe(true)
      expect(rows[1].nearMiss).toBeUndefined()
      expect(rows[2].observation).toBe(true)
      expect(rows[0].observation).toBeUndefined()
      // and the numbers ride through untouched
      expect(rows[1]).toMatchObject({ sym: 'IREN', side: 'short', grade: 'C', probability: 0.5, entry: 38.82, stop: 46.16, target: 29.03, paperOnly: true, instrument: null })
    })

    it('leaves name undefined for the post-projection cap-cache enrichment', () => {
      expect(boardExportRows([nearMissRow])[0].name).toBeUndefined()
    })

    it('the projected near miss still prints as a near miss in the paper', () => {
      const html = buildNewspaperHtml(composed, 'Thursday, 2 July 2026', { engineBoard: boardExportRows([nearMissRow]) })
      expect(html).toContain('nearest miss &mdash; did not clear the gates')
      expect(html).not.toContain('50%')
    })

    it('the projected observation still prints as an observation in the paper', () => {
      const html = buildNewspaperHtml(composed, 'Thursday, 2 July 2026', { engineBoard: boardExportRows([observationRow]) })
      expect(html).toContain('no ISA route — observation only')
      expect(html).toContain('Observation rows cleared every gate')
    })
  })
})

describe('fallbackIdeasFromBoard', () => {
  it('synthesizes ideas from top board calls — numbers verbatim, picks never starve', () => {
    const board = [
      { id: '2026-07-02:IREN:short', sym: 'IREN', side: 'short' as const, entry: 38.82, stop: 46.16, target: 29.03, probability: 0.5, grade: 'C' as const, expectedMovePct: 8.8, instrument: null, paperOnly: true, note: 'weak, below the 50-day.', stage: 'weak' },
      { id: '2026-07-02:NOK:short', sym: 'NOK', side: 'short' as const, entry: 12.07, stop: 13.42, target: 10.26, probability: 0.5, grade: 'C' as const, expectedMovePct: 5.1, instrument: null, paperOnly: true, note: 'weak.', stage: 'weak' },
      { id: 'x', sym: 'ZZZ', side: 'long' as const, entry: 1, stop: 0.9, target: 1.2, probability: 0.6, grade: 'B' as const, expectedMovePct: 5, instrument: null, paperOnly: false },
    ]
    const ideas = fallbackIdeasFromBoard(board as never)
    expect(ideas).toHaveLength(2) // top 2 only
    expect(ideas[0]).toMatchObject({ ticker: 'IREN', side: 'short', playbook: 'S', entry: '38.82', invalidation: '46.16', target: '29.03', conviction: 'C', predictionId: '2026-07-02:IREN:short' })
    expect(ideas[0].caseText).toContain('Paper-only')
  })
})

describe('findVerbatimRepeats', () => {
  const prior = `The Signal No conviction call today. No compelling small-cap discovery from social chatter today that meets liquidity or reversal-first criteria. Energy leads while technology fades on the week. XOM 151.71 +4.6%`
  it('flags sentences recycled from the previous edition', () => {
    const hits = findVerbatimRepeats(
      { smallCap: 'No compelling small-cap discovery from social chatter today that meets liquidity or reversal-first criteria.', rotation: 'Fresh take on the same tape with new numbers.' },
      prior,
    )
    expect(hits).toHaveLength(1)
    expect(hits[0].field).toBe('smallCap')
  })
  it('ignores short sentences, case and whitespace differences count as repeats', () => {
    const hits = findVerbatimRepeats(
      { crypto: 'ENERGY leads   while technology fades on the week. BTC basing.', tape: 'No conviction call today.' },
      prior,
    )
    expect(hits).toHaveLength(1) // "No conviction call today." is under the length floor
    expect(hits[0].field).toBe('crypto')
  })
  it('empty and missing fields are safe', () => {
    expect(findVerbatimRepeats({ smallCap: undefined, tape: '' }, prior)).toHaveLength(0)
    expect(findVerbatimRepeats({ tape: 'Anything.' }, '')).toHaveLength(0)
  })
})

describe('the paper is told what it lost — the two accountability keys and where they sit in the drop order', () => {
  const loser = (over: Partial<Prediction> = {}): Prediction =>
    ({
      sym: 'ACME', side: 'long', riskPct: 1,
      postMortem: { cls: 'stopped', detail: 'closed through the 92.5 stop on 2026-08-07 (session 3)', at: 1 },
      ...over,
    }) as unknown as Prediction

  it('projects SIZED losers only, newest day first, and says which line the reader is getting', () => {
    const rows = paperPostMortems([
      { date: '2026-08-03', preds: [loser({ sym: 'OLD' })] },
      {
        date: '2026-08-05',
        preds: [
          loser({ sym: 'SIZED', postMortem: { cls: 'adverse-move', detail: 'no level broke', at: 1, sentence: 'It faded with the sector and never came back.', via: 'llm' } }),
          loser({ sym: 'SHADOW', riskPct: 0 }), // a shadow's failure is the engine's business, not the paper's
          { sym: 'WINNER', side: 'long', riskPct: 1 } as unknown as Prediction, // nothing to explain
        ],
      },
    ])
    expect(rows.map(r => r.sym)).toEqual(['SIZED', 'OLD'])
    // the bought sentence where there was one…
    expect(rows[0]).toMatchObject({ date: '2026-08-05', cls: 'adverse-move', why: 'It faded with the sector and never came back.', via: 'llm' })
    // …the deterministic line where there was not, and never labelled as written
    expect(rows[1].why).toContain('closed through the 92.5 stop')
    expect(rows[1].via).toBeUndefined()
  })

  it('is bounded — a bad fortnight cannot flood a budgeted prompt', () => {
    const days = Array.from({ length: 5 }, (_, d) => ({ date: `2026-08-0${d + 1}`, preds: Array.from({ length: 4 }, (_, i) => loser({ sym: `S${d}${i}` })) }))
    expect(paperPostMortems(days)).toHaveLength(PAPER_POSTMORTEM_MAX)
    expect(paperPostMortems(days, 2).map(r => r.sym)).toEqual(['S40', 'S41'])
  })

  it('drops LAST: the smallest keys in the document are the last things the paper loses', () => {
    expect(COMPOSE_DROP_ORDER.slice(-4)).toEqual(['previousEditions', 'missLedger', 'postMortems', 'gateMoves'])
    // and they are really in the order the compose pipe uses: with everything
    // droppable gone, these two are still standing
    const obj = {
      engineBoard: 'B'.repeat(400),
      candidateReads: 'c'.repeat(400),
      previousEditions: 'p'.repeat(400),
      missLedger: { misses: 4, topGates: [{ gate: 'dead-zone-core', cost: 3, unchecked: 1 }] },
      postMortems: [{ sym: 'ACME', cls: 'stopped', why: 'It stopped out on day three.' }],
      gateMoves: ['dead zone 25 → 22.5 on 2026-08-13 — cost 190 vs saved 12 over 202 attributed outcomes'],
    }
    const { json, dropped } = buildDataJson(obj, [...COMPOSE_DROP_ORDER], 800)
    expect(dropped).toEqual(['candidateReads', 'previousEditions'])
    const parsed = JSON.parse(json)
    expect(parsed.missLedger.topGates[0].unchecked).toBe(1)
    expect(parsed.postMortems[0].why).toContain('stopped out')
    // the announcement outlives every other droppable key: a threshold the
    // engine moved on itself is the one thing a reader cannot learn elsewhere
    expect(parsed.gateMoves[0]).toContain('dead zone 25 → 22.5')
  })

  it('the writer is TOLD about them, with the unchecked caveat attached — data with no instruction is the same silence', () => {
    const voice = SECTIONS.find(s => s.key === 'voice')!
    expect(voice.brief).toContain('postMortems')
    expect(voice.brief).toContain('missLedger')
    expect(voice.brief).toMatch(/unchecked/)
    expect(voice.brief).toMatch(/stopless/)
  })
})
