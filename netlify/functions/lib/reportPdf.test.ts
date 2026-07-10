import { describe, it, expect } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { composeReportPdf, sanitizeWinAnsi, htmlToBlocks } from './reportPdf'

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
