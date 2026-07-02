import { describe, it, expect } from 'vitest'
import { parseComposed, buildNewspaperHtml, constrainIdeasToBoard, mergeSections, sectionPrompt, SECTIONS, type ComposedReport } from './newspaper'

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
