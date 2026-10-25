import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HistoricalStudy } from './HistoricalStudy'
import type { HistoricalStudy as Study } from '../../../shared/engine/historyEvidence'

describe('historical results shown honestly', () => {
  it('distinguishes a positive average from established outperformance and names unavailable strategies', () => {
    const stats = { n: 200, quarters: 20, meanReturnPct: 4, meanMarketPct: 3, excessPp: 1, beatRate: .5, brier: null, baselineBrier: null, uncertaintyPp: [-2, 4] as [number, number] }
    const study: Study = { version: 'test', coreModel: 'test', generatedAt: Date.now() / 1000, dataThrough: 1792503000, dataFrom: 1451907000, evaluationFrom: 1577836800, symbols: ['AAPL'], missingSymbols: [], strategies: [{ key: 'pullback-price', label: 'Stabilising pullback', horizon: 63, description: 'Price only.', status: 'uncertain', stats, sectorStats: {...stats,meanMarketPct:5,excessPp:-1}, sectorStatus:'behind', sectors:[{sector:'XLK',stats,sectorStats:{...stats,excessPp:-1}}], years: [{ year: 2020, stats }], cancelledN: 0, missingN: 0 }], gates: [], liveGate: { year: 2026, trainingFrom: 1, trainingThrough: 1767225599, n: 400, months: 24, excessPp: -1, brierSkill: -.1, allow: false }, costBpsPerSide: 10, dataDigest: 'abc', caveats: ['Survivorship bias remains.'], unavailable: [{ label: 'Quality recovery', reason: 'Dated financial evidence is missing.' }] }
    render(<HistoricalStudy study={study} />)
    expect(screen.getByLabelText('Longer historical test')).toHaveTextContent('No strategy has established a reliable advantage')
    expect(screen.getByText('Better average return · not yet reliable')).toBeInTheDocument()
    expect(screen.getByText(/0 of 1 strategies had better average returns than both/)).toBeVisible()
    expect(screen.getByText(/below the sector average/)).toBeVisible()
    expect(screen.getByText('Technology')).toBeInTheDocument()
    expect(screen.getByText(/direction signals stay on watch/)).toBeInTheDocument()
    expect(screen.getByText(/Dated financial evidence is missing/)).toBeInTheDocument()
    const range = screen.getByText(/Uncertainty range for the difference/)
    expect(range).toHaveTextContent('-2.00pp to +4.00pp')
    expect(range).not.toBeVisible()
    expect(screen.getByText('Better average return · not yet reliable')).toBeVisible()
    fireEvent.click(screen.getByText('See the evidence', { exact: true }))
    expect(range).toBeVisible()
  })
})
