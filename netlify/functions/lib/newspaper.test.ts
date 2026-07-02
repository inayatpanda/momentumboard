import { describe, it, expect } from 'vitest'
import { buildDataJson, fallbackIdeasFromBoard, parseComposed, buildNewspaperHtml, constrainIdeasToBoard, mergeSections, sectionPrompt, SECTIONS, validateNominations, mergeNominations, type ComposedReport, type StoredNomination } from './newspaper'

const sample: ComposedReport = {
  headline: 'Tech Leads a Cautious Tape Higher',
  standfirst: 'Rotation into growth firms up while the short week keeps volumes thin.',
  lead: 'First paragraph.\n\nSecond paragraph with <angle brackets>.',
  portfolioDesk: 'Journal empty; nothing to review.',
  tape: 'SPY above both averages; regime green.',
  ideas: [
    { ticker: 'NBIS', side: 'long', playbook: 'R', caseText: 'Base reclaim on volume', entry: '52.40', invalidation: '48.90', target: '61', conviction: 'B' },
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
    expect(html).toContain('Portfolio Desk')
    expect(html).toContain('I STRONGLY SUGGEST')
    expect(html).toContain('NBIS')
    expect(html).toContain('SHORT')
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
