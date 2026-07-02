import { describe, it, expect } from 'vitest'
import { parseComposed, buildNewspaperHtml, mergeSections, sectionPrompt, SECTIONS, type ComposedReport } from './newspaper'

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
