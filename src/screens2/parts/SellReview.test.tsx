import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Router } from 'wouter'
import type { SellReviewRow, SellReviewSnapshot } from '../../../shared/engine/sellReview'
import { SellReview } from './SellReview'

const now = () => Math.floor(Date.now() / 1000)
const row = (symbol: string, status: SellReviewRow['status'], kind: 'price' | 'business' = 'price'): SellReviewRow => ({ symbol, name: `${symbol} Company`, sector: 'XLK', status, asOf: now() - 86400, checks: { price: 'checked', business: 'checked', valuation: status === 'data-gap' ? 'missing' : 'checked' }, gaps: status === 'data-gap' ? ['Dated cash-flow figures are missing.'] : [], signals: status === 'review' ? [{ kind, label: kind === 'price' ? 'Price weakness has persisted' : 'The business has weakened', summary: 'A reason to review the holding.', evidenceAt: now() - 86400, reasons: ['This is a dated, observed change.'], sources: [{ label: 'Company filing', url: 'https://www.sec.gov/test' }] }] : [] })
const sample = (): SellReviewSnapshot => ({ version: 'sell-review-v1', generatedAt: now() - 60, coverage: { scanned: 4, review: 2, noWarning: 1, dataGap: 1, incomplete: 1 }, rows: [row('AAA', 'review'), row('BBB', 'review', 'business'), row('CCC', 'data-gap'), row('DDD', 'no-warning')], caveats: [] })
const mount = (props: Partial<Parameters<typeof SellReview>[0]> = {}) => render(<Router base="/app"><SellReview snapshot={sample()} watchSymbols={['AAA', 'CCC', 'OUTSIDE']} {...props} /></Router>)
afterEach(() => window.history.replaceState({}, '', '/'))

describe('selling review', () => {
  it('starts with only watched warnings and identifies unknown and unscanned stocks separately', () => {
    mount()
    expect(screen.getByRole('article', { name: 'AAA sell review' })).toBeVisible()
    expect(screen.queryByRole('article', { name: 'BBB sell review' })).not.toBeInTheDocument()
    expect(screen.queryByRole('article', { name: 'CCC sell review' })).not.toBeInTheDocument()
    expect(screen.getByText(/Outside this scan: OUTSIDE/)).toBeVisible()
    fireEvent.click(screen.getByRole('checkbox'))
    const card = screen.getByRole('article', { name: 'CCC sell review' })
    expect(within(card).getByText('Checks incomplete')).toBeVisible()
    expect(within(card).queryByText('Worth reviewing')).not.toBeInTheDocument()
  })
  it('keeps different warning reasons separate when exploring the full scan', () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'All 4 stocks' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Choose a reason' }), { target: { value: 'business' } })
    expect(screen.getByRole('article', { name: 'BBB sell review' })).toBeVisible()
    expect(screen.queryByRole('article', { name: 'AAA sell review' })).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox')).toBeDisabled()
    expect(screen.getByText(/Choose All reasons to include/)).toBeVisible()
    fireEvent.click(within(screen.getByRole('article', { name: 'BBB sell review' })).getByText('See the evidence'))
    expect(screen.getByRole('link', { name: 'Company filing' })).toHaveAttribute('href', 'https://www.sec.gov/test')
  })
  it('preserves a stock detail link even for an unwatched company', () => {
    window.history.replaceState({}, '', '/app/stocks?view=sell&stock=DDD')
    mount()
    const card = screen.getByRole('article', { name: 'DDD sell review' })
    expect(within(card).getByText('No warning found')).toBeVisible()
    expect(within(card).getByText(/does not establish/)).toBeVisible()
    expect(screen.queryByRole('article', { name: 'AAA sell review' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: 'Back to your watchlist review' }))
    expect(screen.getByRole('button', { name: 'My watchlist' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('article', { name: 'BBB sell review' })).not.toBeInTheDocument()
  })
  it('counts gaps on warning rows as incomplete too', () => {
    const data = sample()
    data.rows[0].gaps = ['Valuation is missing.']
    mount({ snapshot: data })
    expect(screen.getByText('Checks incomplete').parentElement).toHaveTextContent('2')
    expect(screen.getByText('A stock can have a warning and incomplete checks.')).toBeVisible()
  })
  it.each([-49 * 3600, 3600])('hides stale or future results (%s seconds)', offset => {
    mount({ snapshot: { ...sample(), generatedAt: now() + offset } })
    expect(screen.getByText('This review needs a fresh scan')).toBeVisible()
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
  })
  it('explains that a missing first snapshot is not an empty warning result', () => {
    mount({ snapshot: null })
    expect(screen.getByText('The first sell review is being prepared')).toBeVisible()
    expect(screen.queryByText('No warnings match this view')).not.toBeInTheDocument()
  })
})
