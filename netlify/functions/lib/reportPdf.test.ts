import { describe, it, expect } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { composeReportPdf, sanitizeWinAnsi, htmlToBlocks, type ReportPrintData } from './reportPdf'

// a representative full-fat payload — the data path renders every section, so the
// smoke tests exercise the heat map, sparkline, board, ideas and every table.
const PRINT: ReportPrintData = {
  report: {
    headline: 'Healthcare rotation hits day three as tech cools into jobs Friday',
    standfirst: 'A quieter tape, but the money is moving — defensives lead while the AI complex digests.',
    lead: 'Rotation, not retreat.\n\nThe healthcare bid we flagged is now three days confirmed — rs5 still leads rs21.',
    portfolioDesk: 'Hold ABBV, trail the stop. Tighten the semis basket; do not add.',
    tape: 'Jobs Friday is the hinge — 180k vs 200k prior. Position defensively into it.',
    ideas: [
      {
        ticker: 'ABBV', name: 'AbbVie Inc.', side: 'long', playbook: 'A',
        caseText: 'Clean expression of the healthcare bid; reclaimed the 20-day on volume — an early-reversal entry, not a chase.',
        entry: '178.40', invalidation: '171.20', target: '196.00', conviction: 'A', strength: 'strong',
        reasons: ['Leads on 1mo and 1wk relative strength', 'Reclaimed the 20-day on 1.4x volume', 'Defensive cash-flow into a jobs-week de-risking'],
        expectedMove: '+8-10% in 3-4 weeks', chartRead: 'Early-reversal near support', streetCheck: 'Stocks with Josh constructive',
      },
      {
        ticker: 'NBIS', name: 'Nebius Group', side: 'short', playbook: 'S',
        caseText: 'Extended and exhausted — a fade into strength via the inverse ETP, not a naked short.',
        entry: '32.10', invalidation: '35.40', target: '26.80', conviction: 'B',
        reasons: ['RSI 78, stretched above the 20-day', 'Volume fading on the last up-days'],
        expectedMove: '-12-16% over 5-10 sessions',
      },
    ],
    shortDesk: 'One fade: Nebius. The route is the LSE inverse ETP — max ten sessions, half size.',
    smallCap: 'IONQ lighting up the Reddit tape at 3.1x on a $9B cap — watch, do not chase.',
    rotation: 'Healthcare and staples lead both windows; tech and discretionary are the funding source.',
    crypto: 'BTC holds 62k; ETH lags. Regime neutral, no new size.',
    channels: 'Stocks with Josh constructive on healthcare; Meet Kevin cautious on megacap tech.',
    editorial: 'Leadership changes hands before the index does — the Nifty Fifty handoff of 1972 rhymes with today.',
    honestClose: 'Confidence B+. A hot jobs number is what proves this wrong.',
    regime: 'amber',
    signal: {
      ticker: 'ABBV', company: 'AbbVie Inc.',
      thesis: 'The full stack aligns and the chart is at a genuine early-reversal entry rather than a chase.',
      evidence: { data: 'Typical 10-day move 9.2%; volume-confirmed reclaim.', news: 'Rinvoq label-expansion headline Friday.', channels: 'Stocks with Josh named it.', social: 'Uncrowded on Reddit.', company: 'Immunology-led pharma past the Humira cliff.' },
      expectedMove: '+8-10% / 3-4 wks', conviction: 'A',
      action: 'Enter 178.40 on a hold of the 20-day; invalidation 171.20; target 196.00. Size full.',
    },
    fedStance: 'neutral', macroNotes: ['Jobs Friday 180k vs 200k'],
  },
  engineBoard: [
    { sym: 'ABBV', name: 'AbbVie Inc.', side: 'long', grade: 'A', provisional: false, probability: 0.68, entry: 178.4, stop: 171.2, target: 196, expectedMovePct: 9, paperOnly: false, earningsRisk: false, instrument: null },
    { sym: 'NBIS', name: 'Nebius Group', side: 'short', grade: 'B', provisional: false, probability: 0.57, entry: 32.1, stop: 35.4, target: 26.8, expectedMovePct: 14, paperOnly: false, earningsRisk: false, instrument: { ticker: 'SNBS', leverage: 2 } },
    { sym: 'SMCI', name: 'Super Micro', side: 'short', grade: 'C', provisional: true, probability: 0.52, entry: 44.2, stop: 48, target: 38, expectedMovePct: 12, paperOnly: true, watchOnly: true, earningsRisk: false, instrument: null },
  ],
  sectorBars: [
    { name: 'Healthcare', rs21: 3.4 }, { name: 'Staples', rs21: 2.1 }, { name: 'Energy', rs21: 1.2 },
    { name: 'Financials', rs21: 0.4 }, { name: 'Technology', rs21: -2.6 }, { name: 'Discretionary', rs21: -1.8 },
    { name: 'Industrials', rs21: -0.3 }, { name: 'Utilities', rs21: 0.8 },
  ],
  spyCloses: Array.from({ length: 63 }, (_, i) => 540 + Math.sin(i / 5) * 12 + i * 0.35),
  calendar: [
    { title: 'Non-Farm Payrolls', country: 'USD', at: 1_800_000_000, impact: 'High', forecast: '180k', previous: '200k' },
    { title: 'ISM Services PMI with a deliberately long title to force the event cell to wrap onto a second line', country: 'USD', at: 1_800_100_000, impact: 'Medium', forecast: '52.4', previous: '51.8' },
  ],
  ipos: { upcoming: [{ sym: 'CRWV', name: 'CoreWeave Inc.', date: '2026-07-18', status: 'Expected' }], recent: [{ sym: 'RDDT', name: 'Reddit Inc.', date: '2026-07-10', status: 'Priced' }] },
  eventRadar: [
    { sym: 'IBM', name: 'International Business Machines', date: '2026-07-23', daysToPrint: 4, stage: 'weak', rs21: -3.2, note: 'Below the 50-day and drifting — no edge here.' },
    { sym: 'NVDA', name: 'NVIDIA Corp', date: '2026-07-28', daysToPrint: 9, stage: 'pullback', rs21: 2.1, note: 'Healthy pullback in an uptrend.' },
  ],
  socialBoard: [
    { sym: 'IONQ', redditRank: 1, redditMentions: 842, surgeMultiple: 3.1, sources: 2, capUsdM: 9000 },
    { sym: 'ABBV', redditRank: 12, redditMentions: 88, surgeMultiple: 1.1, sources: 1, capUsdM: 316000 },
  ],
  rotationTables: [
    { sector: 'Healthcare', etf: 'XLV', rows: [{ sym: 'ABBV', price: 178.4, wkPct: 4.2 }, { sym: 'UNH', price: 512.3, wkPct: -0.6 }] },
  ],
}

const SAMPLE = `<!doctype html><html><head><style>body{color:red}</style><title>x</title></head>
<body><div class="sheet">
<h1>THE STREET SIGNAL</h1>
<div class="lead"><h2>Rotation into healthcare accelerates</h2>
<p class="standfirst">A quieter tape, but the money is moving.</p>
<p>First body paragraph with a long enough run of words to force the word-wrapper to break the line across the A4 column at least once or twice over.</p></div>
<section class="dept"><h2>The Tape</h2><p>Jobs report Friday &mdash; consensus 180k vs 200k prior.</p></section>
<svg width="10"><polyline points="1,2 3,4"/></svg>
<h3 class="subhead">Technology (XLK)</h3>
<table class="ideas"><thead><tr><th>Ticker</th><th>Side</th><th>Entry</th></tr></thead>
<tbody><tr><td>ABBV</td><td>LONG</td><td>178.40</td></tr><tr><td>NBIS</td><td>SHORT</td><td>32.10</td></tr></tbody></table>
</div></body></html>`

const pdfMagic = (b: Uint8Array) => String.fromCharCode(b[0], b[1], b[2], b[3], b[4])

describe('sanitizeWinAnsi', () => {
  it('maps arrows and shape glyphs to ASCII', () => {
    expect(sanitizeWinAnsi('▲ up')).toBe('up up')
    expect(sanitizeWinAnsi('▼ down')).toBe('down down')
    expect(sanitizeWinAnsi('A → B')).toBe('A -> B')
    expect(sanitizeWinAnsi('x ≥ 5 and y ≤ 3')).toBe('x >= 5 and y <= 3')
  })
  it('strips emoji and other non-encodable glyphs but keeps the text', () => {
    expect(sanitizeWinAnsi('🎯 STRONG call')).toBe(' STRONG call') // emoji dropped, space stays
    expect(sanitizeWinAnsi('box │ drawing ┌─┐')).toBe('box  drawing ')
  })
  it('keeps WinAnsi-legal chars: £, em dash mapped, curly quotes, accents', () => {
    expect(sanitizeWinAnsi('£100')).toBe('£100')
    expect(sanitizeWinAnsi('café résumé naïve')).toBe('café résumé naïve')
  })
  it('empty / whitespace input never throws', () => {
    expect(sanitizeWinAnsi('')).toBe('')
    expect(sanitizeWinAnsi('   ')).toBe('   ')
  })
  it('produces output pdf-lib can actually encode (the real draw-time oracle)', async () => {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.TimesRoman)
    const out = sanitizeWinAnsi('mix 🚀 of ▲ arrows → and 中文 text ┌┐ with £ and — plus 你好 😀')
    // encodeText throws on any non-WinAnsi code point; a clean sanitizer never lets that happen
    expect(() => font.encodeText(out)).not.toThrow()
    expect(out).toContain('up')
    expect(out).toContain('->')
    expect(out).toContain('£')
  })
})

describe('htmlToBlocks', () => {
  it('extracts headings, paragraphs and tables in document order', () => {
    const blocks = htmlToBlocks(SAMPLE)
    const h2s = blocks.filter(b => b.type === 'heading' && b.level === 2).map(b => (b as { text: string }).text)
    expect(h2s).toContain('Rotation into healthcare accelerates')
    expect(h2s).toContain('The Tape')
    const paras = blocks.filter(b => b.type === 'para').map(b => (b as { text: string }).text)
    expect(paras.some(p => p.includes('money is moving'))).toBe(true)
    expect(paras.some(p => p.includes('180k vs 200k'))).toBe(true) // &mdash; decoded, entities handled
    const tables = blocks.filter(b => b.type === 'table') as { head: string[]; rows: string[][] }[]
    expect(tables).toHaveLength(1)
    expect(tables[0].head).toEqual(['Ticker', 'Side', 'Entry'])
    expect(tables[0].rows).toEqual([['ABBV', 'LONG', '178.40'], ['NBIS', 'SHORT', '32.10']])
  })
  it('drops style/script/svg content', () => {
    const blocks = htmlToBlocks(SAMPLE)
    const all = JSON.stringify(blocks)
    expect(all).not.toContain('color:red')
    expect(all).not.toContain('polyline')
  })
  it('empty / malformed input yields an empty block list, never throws', () => {
    expect(htmlToBlocks('')).toEqual([])
    expect(htmlToBlocks('not html at all')).toEqual([])
    expect(htmlToBlocks('<p>unclosed paragraph <table><tr><td>x')).toEqual([]) // no closing tags → nothing captured
  })
})

describe('composeReportPdf', () => {
  it('produces non-empty PDF bytes that start with %PDF', async () => {
    const bytes = await composeReportPdf({ html: SAMPLE, dateLabel: 'Thursday, 10 July 2026' })
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.length).toBeGreaterThan(500)
    expect(pdfMagic(bytes)).toBe('%PDF-')
  })
  it('survives HTML riddled with non-WinAnsi glyphs (arrows, emoji, CJK)', async () => {
    const html = '<h2>Signal ▲</h2><p>Buy 🎯 now → target £100, momentum 中文 confirmed —</p>'
    const bytes = await composeReportPdf({ html })
    expect(pdfMagic(bytes)).toBe('%PDF-')
  })
  it('handles empty / malformed input without throwing', async () => {
    expect(pdfMagic(await composeReportPdf({ html: '' }))).toBe('%PDF-')
    expect(pdfMagic(await composeReportPdf({ html: '<garbage', dateLabel: undefined }))).toBe('%PDF-')
    expect(pdfMagic(await composeReportPdf({ html: '<p>'.repeat(1000) }))).toBe('%PDF-')
  })
  it('paginates a very long report across multiple pages', async () => {
    const many = Array.from({ length: 120 }, (_, i) => `<p>Paragraph number ${i} with a fair amount of filler text to consume vertical space on the page.</p>`).join('')
    const bytes = await composeReportPdf({ html: `<h2>Long</h2>${many}` })
    expect(pdfMagic(bytes)).toBe('%PDF-')
    expect(bytes.length).toBeGreaterThan(3000)
  })
})

describe('composeReportPdf — structured print path', () => {
  const pageCount = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPageCount()

  it('typesets a full edition across multiple pages from the print payload', async () => {
    const bytes = await composeReportPdf({ html: '<h2>ignored when print is present</h2>', dateLabel: 'Wednesday, 15 July 2026', print: PRINT })
    expect(pdfMagic(bytes)).toBe('%PDF-')
    // masthead + signal + heat map + board + calendar + ideas + tables spill past one page
    expect(await pageCount(bytes)).toBeGreaterThan(1)
    expect(bytes.length).toBeGreaterThan(5000)
  })

  it('renders a valid PDF from empty print data (never throws)', async () => {
    expect(pdfMagic(await composeReportPdf({ html: '', print: {} }))).toBe('%PDF-')
    expect(pdfMagic(await composeReportPdf({ html: '', print: { report: {} } }))).toBe('%PDF-')
  })

  it('tolerates partial payloads — a lone section, missing extras, ragged rows', async () => {
    // report with only a headline, no extras
    expect(pdfMagic(await composeReportPdf({ html: '', print: { report: { headline: 'Just a headline', regime: 'green' } } }))).toBe('%PDF-')
    // extras present but the composed report entirely absent
    expect(pdfMagic(await composeReportPdf({ html: '', print: { sectorBars: PRINT.sectorBars, spyCloses: PRINT.spyCloses, engineBoard: PRINT.engineBoard } }))).toBe('%PDF-')
    // ragged / null-riddled data must not throw
    const ragged: ReportPrintData = {
      report: { ideas: [{ ticker: 'X', side: 'long', playbook: 'B', caseText: '', entry: '', invalidation: '', target: '', conviction: 'C' }] },
      sectorBars: [{ name: 'Solo', rs21: null }, { name: 'Real', rs21: -1.2 }],
      spyCloses: [100],
      calendar: [{ title: 'Event', country: 'USD', at: 0, impact: 'Low' }],
      socialBoard: [{ sym: 'AAA', redditRank: null, redditMentions: null, surgeMultiple: null, sources: 0 }],
      ipos: { upcoming: [], recent: [] },
      eventRadar: [{ sym: 'A', name: null, date: '', daysToPrint: 0, stage: null, rs21: null, note: null }],
      rotationTables: [{ sector: 'S', etf: 'E', rows: [{ sym: 'A', price: null, wkPct: null }] }],
    }
    expect(pdfMagic(await composeReportPdf({ html: '', print: ragged }))).toBe('%PDF-')
  })

  it('survives non-WinAnsi glyphs on the data path (arrows, emoji, CJK)', async () => {
    const bytes = await composeReportPdf({ html: '', print: { report: { headline: 'Signal ▲ 🎯 中文 → target', standfirst: 'move — now', regime: 'red', lead: 'Buy 🎯 now → £100', honestClose: 'done —' } } })
    expect(pdfMagic(bytes)).toBe('%PDF-')
  })

  it('still uses the HTML fallback when print is absent', async () => {
    const bytes = await composeReportPdf({ html: SAMPLE, dateLabel: 'Thursday, 10 July 2026' })
    expect(pdfMagic(bytes)).toBe('%PDF-')
    expect(bytes.length).toBeGreaterThan(500)
  })
})
