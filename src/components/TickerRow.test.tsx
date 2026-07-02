import { render, screen } from '@testing-library/react'
import { TickerRow } from './TickerRow'

it('renders price, change, rvol and badges', () => {
  render(
    <TickerRow
      row={{
        symbol: '3LTS.L',
        quote: { symbol: '3LTS.L', price: 2.981, prevClose: 2.167, changePct: 37.56, currency: 'USD', todayVolume: 5771, asOf: 0, source: 'yahoo' },
        rvol: 2.3,
        setups: ['basing', 'reclaim'],
      }}
      onRemove={() => {}}
    />,
  )
  expect(screen.getByText('3LTS.L')).toBeInTheDocument()
  expect(screen.getByText('$2.98')).toBeInTheDocument()
  expect(screen.getByText('+37.56%')).toBeInTheDocument()
  expect(screen.getByText('RVOL 2.3x')).toBeInTheDocument()
  expect(screen.getByText('Basing')).toBeInTheDocument()
  expect(screen.getByText('Reclaim')).toBeInTheDocument()
})
