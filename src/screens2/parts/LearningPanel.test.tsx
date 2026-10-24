import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { buildResearchLearning, type ResearchLearningSnapshot, type ResearchLearningStats } from '../../../shared/engine/researchLearning'
import { LearningPanel } from './LearningPanel'

function fixture(): ResearchLearningSnapshot {
  const base = buildResearchLearning([], 1_792_382_400)
  const stats: ResearchLearningStats = {
    ...base.strategies[0].overall, independentN: 40, filledN: 35, cancelledN: 5,
    meanNetReturnPct: 1.2, medianNetReturnPct: 0.8, directionN: 40, directionAccuracy: 0.6,
    brierN: 40, brierScore: 0.22, baselinePairedN: 40, pairedBrierScore: 0.22,
    baselineBrierScore: 0.2, brierSkillScore: -0.1,
  }
  const conditionStats = { ...stats, independentN: 8, filledN: 6, meanNetReturnPct: -2, directionN: 8, directionAccuracy: 0.25, brierN: 8, brierScore: 0.35 }
  base.history.eligibleCompletedN = 40
  base.history.pendingN = 12
  base.history.excludedCompletedN = 3
  base.status = 'observing'
  base.strategies[0] = {
    ...base.strategies[0], status: 'observing', summary: 'Forty independent forecasts have matured.', overall: stats,
    chronology: { ...base.strategies[0].chronology, summary: 'This chronological split is not held-out validation.', older: { ...stats, independentN: 20, filledN: 18, meanNetReturnPct: 2 }, recent: { ...stats, independentN: 20, filledN: 17, meanNetReturnPct: 0.4 } },
    conditions: [{
      key: 'world:risk-off', label: 'International markets: risk-off', status: 'collecting',
      summary: 'Eight recorded risk-off campaigns; evidence is still collecting.', stats: conditionStats,
      chronology: base.strategies[0].chronology, comparison: null,
    }],
  }
  return base
}

describe('Historical learning', () => {
  it('distinguishes an unavailable snapshot from zero measured outcomes', () => {
    const { rerender } = render(<LearningPanel />)
    expect(screen.getByText(/Historical learning is not available/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Learning history coverage')).not.toBeInTheDocument()
    rerender(<LearningPanel learning={buildResearchLearning([], 1_792_382_400)} />)
    expect(screen.getByLabelText('Learning history coverage')).toHaveTextContent('0Completed results')
    expect(screen.queryByLabelText('Selected campaign results')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Research awaiting outcomes')).toHaveTextContent('What appears next')
    expect(screen.queryByText('+0.0%')).not.toBeInTheDocument()
  })

  it('filters the measured sample by recorded condition and resets it on strategy change', () => {
    render(<LearningPanel learning={fixture()} />)
    const results = screen.getByLabelText('Selected campaign results')
    expect(results).toHaveTextContent('+1.2%')
    expect(results).toHaveTextContent('40 directional outcomes')
    fireEvent.change(screen.getByLabelText('Filter results'), { target: { value: 'world:risk-off' } })
    expect(results).toHaveTextContent('-2.0%')
    expect(results).toHaveTextContent('8 directional outcomes')
    expect(screen.getByText(/Eight recorded risk-off campaigns/)).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '8')
    fireEvent.change(screen.getByLabelText('Strategy'), { target: { value: 'quality-dip' } })
    expect(screen.queryByLabelText('Filter results')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Selected campaign results')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Research awaiting outcomes')).toHaveTextContent('a low price alone does not qualify')
  })

  it('shows actual pending stocks without counting older campaigns as current forecasts', () => {
    const snapshot = buildResearchLearning([], 1_792_382_400)
    snapshot.history = { ...snapshot.history, pendingN: 87, currentPendingN: 14, earlierPendingN: 73, excludedCompletedN: 148, excludedLegacyN: 148 }
    snapshot.strategies[0].tracking = { pendingN: 14, firstPublicationAt: 1_792_382_400, latestPublicationAt: 1_792_382_400, symbols: ['AAPL', 'MSFT'] }
    const onResearch = vi.fn()
    render(<LearningPanel learning={snapshot} onResearch={onResearch} />)
    expect(screen.getByLabelText('Learning history coverage')).toHaveTextContent('14Predictions being followed')
    expect(screen.getByLabelText('Research awaiting outcomes')).toHaveTextContent('14 saved forecasts')
    expect(screen.getByRole('link', { name: 'AAPL ↗' })).toHaveAttribute('href', '/stock/AAPL')
    expect(screen.getByText(/73 additional unscored records/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Selected campaign results')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Explore current research →' }))
    expect(onResearch).toHaveBeenCalledOnce()
  })

  it('keeps failed baseline skill, rolling retention and chronology limits inspectable', () => {
    render(<LearningPanel learning={fixture()} />)
    const calibration = screen.getByText('See the evidence: accuracy and measurement').closest('details')!
    fireEvent.click(within(calibration).getByText('See the evidence: accuracy and measurement'))
    expect(calibration).toHaveAttribute('open')
    expect(calibration).toHaveTextContent('Brier skill -0.100')
    expect(calibration).toHaveTextContent('recorded baseline 0.200 across 40 paired forecasts')
    const chronology = screen.getByText('See the evidence: recent and earlier results').closest('details')!
    fireEvent.click(within(chronology).getByText('See the evidence: recent and earlier results'))
    expect(chronology).toHaveTextContent('+2.0%')
    expect(chronology).toHaveTextContent('+0.4%')
    expect(chronology).toHaveTextContent('not held-out validation')
    expect(screen.getByText(/Rolling history:/)).toHaveTextContent('up to 500')
  })
})
