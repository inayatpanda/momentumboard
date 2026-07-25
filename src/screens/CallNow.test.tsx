import { render, screen } from '@testing-library/react'
import { CallNow } from './Desk'
import type { EnginePrediction } from '../lib/api'
import type { Candle } from '../../shared/types'

const call = (over: Partial<EnginePrediction> = {}) =>
  ({ sym: 'PATH', side: 'long', entry: 12.0, stop: 11.0, target: 14.0, ...over }) as EnginePrediction

const at = (close: number): Candle[] => [{ t: 1, o: close, h: close, l: close, c: close, v: 1 }]

it('shows where price is now against the call, not just the fixed levels', () => {
  render(<CallNow call={call()} candles={at(12.2)} />)
  expect(screen.getByText(/now 12\.20/)).toBeInTheDocument()
  expect(screen.getByText(/\+1\.7% from entry/)).toBeInTheDocument()
  expect(screen.getByText(/stop 9\.8% away/)).toBeInTheDocument()
})

it('warns when the setup has already run — this is the chasing case', () => {
  render(<CallNow call={call()} candles={at(12.6)} />)
  expect(screen.getByText('extended')).toBeInTheDocument()
})

it('says plainly when a call is invalidated', () => {
  render(<CallNow call={call()} candles={at(10.8)} />)
  expect(screen.getByText('through stop')).toBeInTheDocument()
  expect(screen.getByText(/stop breached by/)).toBeInTheDocument()
})

it('reads a short in its own direction', () => {
  render(<CallNow call={call({ side: 'short', stop: 13, target: 10 })} candles={at(11.4)} />)
  expect(screen.getByText(/\+5\.0% from entry/)).toBeInTheDocument() // fell 5% = your way
})

it('renders nothing at all rather than a fake price when candles have not loaded', () => {
  const { container } = render(<CallNow call={call()} candles={[]} />)
  expect(container).toBeEmptyDOMElement()
})
