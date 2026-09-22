import { describe, expect, it } from 'vitest'
import { fetchRecentFilings, parseRecentFilings } from './secFilings'

describe('SEC filings', () => {
  it('keeps catalyst-class forms and builds original-document URLs', () => {
    const rows = parseRecentFilings(320193, {
      form: ['8-K', '4', '10-Q'], accessionNumber: ['0001-01', '0002-02', '0003-03'],
      filingDate: ['2026-08-20', '2026-08-19', '2026-08-18'], reportDate: ['', '', '2026-06-30'],
      primaryDocument: ['a.htm', 'b.htm', 'c.htm'], primaryDocDescription: ['Current report', 'Insider', 'Quarterly report'], items: ['2.02', '', ''],
    })
    expect(rows.map(r => r.form)).toEqual(['8-K', '10-Q'])
    expect(rows[0].url).toContain('/320193/000101/a.htm')
  })

  it('resolves a ticker and reads the company submission feed with an identifying header', async () => {
    const seen: { url: string; userAgent: string | null }[] = []
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      seen.push({ url, userAgent: new Headers(init?.headers).get('User-Agent') })
      if (url.includes('company_tickers')) return new Response(JSON.stringify({ 0: { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' } }))
      return new Response(JSON.stringify({ name: 'Apple Inc.', filings: { recent: { form: [] } } }))
    }
    const out = await fetchRecentFilings('AAPL', fetchFn as typeof fetch, 'StreetSignal test@example.com')
    expect(out).toMatchObject({ company: 'Apple Inc.', cik: 320193, filings: [] })
    expect(seen).toHaveLength(2)
    expect(seen.every(s => s.userAgent === 'StreetSignal test@example.com')).toBe(true)
  })
})
