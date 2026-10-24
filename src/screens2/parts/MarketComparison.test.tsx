import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MarketComparison } from './MarketComparison'
import type { MarketComparisonSnapshot } from '../../../shared/engine/marketComparison'
describe('visible market comparison', () => {
  it('shows underperformance and labels older results without claiming current skill', () => {
    const snapshot: MarketComparisonSnapshot = { version: 'test', generatedAt: 1, benchmark: 'SPY', costBpsPerSide: 10, excludedUnverifiableN: 8, excludedUnsupportedN: 2, caveats: ['Returns exclude dividends.'], cohorts: [{
      sleeve: 'composite-control', modelVersion: 'older', current: false, horizonSessions: 10, matchedN: 30, pendingN: 4, missingBenchmarkN: 1, overlappingN: 3, cancelledN: 2,
      meanReturnPct: 1, meanMarketPct: 3, meanExcessPp: -2, beatRate: .3, publicationDays: 9, independentWindows: 3, status: 'behind', firstPublicationAt: 1, lastOutcomeAt: 2,
    }] }
    render(<MarketComparison snapshot={snapshot} />)
    const panel = screen.getByLabelText('Market comparison')
    expect(panel).toHaveTextContent('Behind the market in this sample')
    expect(panel).toHaveTextContent('-2.00 pts')
    expect(panel).toHaveTextContent('current models do not yet have completed')
    expect(panel).toHaveTextContent('8 records lack verifiable execution')
    expect(panel).toHaveTextContent('Not yet proven')
  })
})
