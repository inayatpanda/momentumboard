import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MarketPatterns } from './MarketPatterns'
import { PATTERN_ASSETS, type MarketPatternsSnapshot } from '../../../shared/engine/marketPatterns'
const fixture: MarketPatternsSnapshot = {
  version: 1, generatedAt: 1, dataFrom: '2006-04-28', dataThrough: '2026-10-23', observations: 5155, digest: 'fixture',
  current: PATTERN_ASSETS.map(a => ({ symbol: a.symbol, monthPct: 1, quarterPct: 3 })),
  pairs: [{ a: 'SPY', b: 'TLT', recent: .4, historical: -.3, recentN: 252, historicalN: 5154 }],
  seasonal: [{ date: '2025-10-23', endDate: '2025-11-21', returns: [1, -2, 3, 4, 5] }],
  similar: [{ date: '2010-10-23', endDate: '2010-11-23', returns: [1, -2, 3, 4, 5], distance: 1, precedingReturns: [2, 3, 4, 5, 6] }],
}
describe('Market patterns', () => {
  it('shows current context and honest proxy labels, keeping raw evidence closed', () => {
    render(<MarketPatterns snapshot={fixture} />)
    expect(screen.getByRole('heading', { name: 'How the markets fit together' })).toBeVisible()
    expect(screen.getByText('USO · not the spot oil price')).toBeVisible()
    expect(screen.getByText(/Moving together does not mean one causes/)).toBeVisible()
    const evidence = screen.getByText('See the evidence: every year').closest('details')!
    expect(evidence).not.toHaveAttribute('open')
    fireEvent.click(screen.getByText('See the evidence: every year'))
    expect(evidence).toHaveAttribute('open')
    fireEvent.click(screen.getByRole('button', { name: 'US government bonds' }))
    expect(screen.getByText('0 of 1')).toBeVisible()
  })
  it('reports missing data without inventing patterns', () => {
    render(<MarketPatterns />)
    expect(screen.getByText('Market history is being prepared')).toBeVisible()
    expect(screen.queryByText('What is moving now?')).toBeNull()
  })
  it('labels old history explicitly', () => {
    render(<MarketPatterns snapshot={{ ...fixture, dataThrough: '2007-10-23' }} />)
    expect(screen.getByRole('status')).toHaveTextContent('more than a week old')
  })
})
