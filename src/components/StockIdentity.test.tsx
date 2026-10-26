import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StockIdentity } from './StockIdentity'

describe('stock identity', () => {
  it('loads a company name from the existing directory when only a ticker is supplied', async () => {
    const { rerender } = render(<StockIdentity symbol="PLTR" />)
    expect(await screen.findByText('Palantir Technologies (PLTR)')).toBeInTheDocument()
    rerender(<StockIdentity symbol="SOUN" />)
    expect(screen.getByText('SoundHound AI (SOUN)')).toBeInTheDocument()
    expect(screen.queryByText(/Palantir/)).not.toBeInTheDocument()
  })
  it('uses a supplied name, and never invents a name for an unknown ticker', () => {
    const { rerender } = render(<StockIdentity symbol="TEST" name="Example Company" />)
    expect(screen.getByText('Example Company (TEST)')).toBeInTheDocument()
    rerender(<StockIdentity symbol="UNKNOWN-SYMBOL" />)
    expect(screen.getByText('UNKNOWN-SYMBOL')).toBeInTheDocument()
    expect(screen.queryByText(/Example Company/)).not.toBeInTheDocument()
  })
})
