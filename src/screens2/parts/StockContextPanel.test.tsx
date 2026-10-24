import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StockContextPanel } from './StockContextPanel'
import { buildDropCheck } from '../../../shared/engine/stockUpdates'
import { ContextTrialPanel } from './ContextTrialPanel'
import type { StockContext } from '../../../shared/engine/stockContext'
const context: StockContext = { version: 'market-sector-news-v1', symbol: 'MSFT', generatedAt: Date.now() / 1000, priceDate: '2026-10-23', status: 'mixed', summary: 'The signals do not all point in the same direction.', nextCheck: 'Look for the stock to catch up with its sector.', support: ['Technology is leading.'], risks: ['The stock is lagging.'], gaps: ['No news.'], sector: 'Technology', sectorSymbol: 'XLK', stockMonthPct: 1, stockVsSectorPp: -2, sectorVsMarketPp: 3, market: null, news: [], newsView: null, trialShift: .01 }
describe('simple stock context', () => {
  it('keeps watchlist detail closed and explains positives, risks and a next check on opening', () => {
    render(<StockContextPanel compact symbol="MSFT" context={context} />)
    expect(screen.getByText('Mixed signals')).toBeVisible()
    expect(screen.getByText('Technology is leading.')).not.toBeVisible()
    fireEvent.click(screen.getByText('Mixed signals'))
    expect(screen.getByText('Technology is leading.')).toBeVisible()
    expect(screen.getByText('What would change the view?')).toBeVisible()
    expect(screen.getByText(/Company news coverage is incomplete/)).toBeVisible()
    expect(screen.getByText('See the evidence').closest('details')).not.toHaveAttribute('open')
  })
  it('labels missing or stale information without a positive assessment', () => {
    const { rerender } = render(<StockContextPanel symbol="OTHER" />)
    expect(screen.getByText('Awaiting a market view')).toBeVisible()
    rerender(<StockContextPanel symbol="MSFT" context={{ ...context, generatedAt: 1 }} />)
    expect(screen.getByRole('status')).toHaveTextContent('needs updating')
  })
  it('shows daily changes and a simple business check while keeping calculations in evidence', () => {
    render(<StockContextPanel symbol="MSFT" context={{ ...context,
      changes: { heading: 'What changed since yesterday?', baselineAt: null, lines: ['Daily tracking has started.'], session: 'Latest completed session: -2.0%.' },
      dropCheck: buildDropCheck({ symbol: 'MSFT', now: Date.now() / 1000, candles: [] }) }} />)
    expect(screen.getByText('What changed since yesterday?')).toBeVisible()
    expect(screen.getByText('Big drop or weaker business?')).toBeVisible()
    expect(screen.getByText('More evidence needed')).toBeVisible()
    expect(screen.getByText(/large-drop check means/)).not.toBeVisible()
    fireEvent.click(screen.getByText('See the evidence'))
    expect(screen.getByText(/large-drop check means/)).toBeVisible()
    expect(screen.getByText(/do not reconstruct old news/)).toBeVisible()
  })
  it('distinguishes probability accuracy from market returns in the trial', () => {
    render(<ContextTrialPanel audit={{ version: 'market-sector-news-v1', pending: 10, completed: 0, changed: 0, publicationDays: 0, baselineBrier: null, candidateBrier: null, dayBalancedImprovement: null, earlierImprovement: null, recentImprovement: null, status: 'collecting' }} />)
    expect(screen.getByText(/experimental version is not used/)).toBeVisible()
    fireEvent.click(screen.getByText('See the evidence: the paired prediction test'))
    expect(screen.getByText(/not portfolio returns or beating the market/)).toBeVisible()
  })
})
