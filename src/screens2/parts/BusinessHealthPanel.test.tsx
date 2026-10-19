import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { emptyBusinessHealth } from '../../../shared/businessHealth'
import { BusinessHealthRead } from './BusinessHealthPanel'

describe('business health evidence', () => {
  it('never dresses unavailable accounts as a healthy cheap stock', () => {
    render(<BusinessHealthRead snapshot={emptyBusinessHealth('TEST', Date.now() / 1000, 'No coverage')} />)
    expect(screen.getByText(/Financial screen: unknown/)).toBeInTheDocument()
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(5)
    expect(screen.getByText(/they do not establish fair value/)).toBeInTheDocument()
  })

  it('keeps metric period and filing provenance beside the reported value', () => {
    const snapshot = emptyBusinessHealth('TEST', Date.now() / 1000, '')
    snapshot.status = 'partial'
    snapshot.metrics.revenue = 1_250_000_000
    snapshot.evidence.revenue = { value: 1_250_000_000, periodStart: '2025-01-01', periodEnd: '2025-12-31', filed: '2026-02-10', availableAt: 1, unit: 'USD', tags: ['us-gaap:Revenues'], accessions: ['one'] }
    render(<BusinessHealthRead snapshot={snapshot} />)
    const row = screen.getByText('Annual revenue').closest('tr')!
    expect(row).toHaveTextContent('1.25')
    expect(row).toHaveTextContent('2025-01-01 to 2025-12-31')
    expect(row).toHaveTextContent('2026-02-10')
  })
})
