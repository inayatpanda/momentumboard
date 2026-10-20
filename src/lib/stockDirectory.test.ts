import { describe, expect, it } from 'vitest'
import { directorySector, loadStockDirectory, searchStocks } from './stockDirectory'
describe('stock directory discovery', () => {
  it('finds company names and tickers, including UK listings', async () => {
    const { rows } = await loadStockDirectory()
    expect(searchStocks(rows, 'Apple')[0]).toMatchObject({ sym: 'AAPL' })
    expect(searchStocks(rows, 'vodafone', '', 'LSE')[0].sym).toBe('VOD.L')
    expect(searchStocks(rows, 'NVDA')[0].sym).toBe('NVDA')
    expect(searchStocks(rows, '', 'Technology', 'US').every(r => r.exchange === 'US' && directorySector(r.sector) === 'Technology')).toBe(true)
  })
  it('keeps funds separate from operating companies and unknown sectors honest', () => {
    expect(directorySector('Investment trusts')).toBe('Funds & trusts')
    expect(directorySector(null)).toBe('Other')
    expect(directorySector('An unknown industry')).toBe('Other')
  })
})
