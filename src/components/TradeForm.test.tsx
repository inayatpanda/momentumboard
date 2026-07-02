import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TradeForm } from './TradeForm'
import type { EnginePrediction, EngineData } from '../lib/api'

const call: EnginePrediction = {
  id: '2026-07-02:AAPL:long', sym: 'AAPL', side: 'long', composite: 40, probability: 0.6,
  provisional: false, grade: 'B', expectedMovePct: 8, entry: 100, stop: 95, target: 112,
  capacityPct: 10, smallCap: false, earningsRisk: false, stage: 'early-reversal',
  note: 'base breakout', riskRung: 1, riskPct: 1.25, instrument: null, paperOnly: false, factors: {},
}

const riskState: EngineData['riskState'] = { rung: 1, sinceDate: '2026-06-01', gradedAtRung: 12, history: [] }

const typeInto = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } })

describe('TradeForm — point-of-commitment calculator', () => {
  it('sizes from the engine riskPct when the ticker has a live board call (worked example)', () => {
    const { container } = render(<TradeForm onAdd={() => {}} board={[call]} riskState={riskState} capital={5000} />)
    typeInto('Trade ticker', 'AAPL')
    typeInto('Trade entry', '100')
    typeInto('Trade stop', '95')

    const line = container.querySelector('.tf-size-main')!.textContent!
    // capital 5000 × 1.25% = £62.50 risk; ÷ £5 stop distance = 12 shares ≈ £1,200
    expect(line).toContain('risk £62.50')
    expect(line).toContain('1.25% at R1')
    expect(line).toContain('12 shares')
    expect(line).toContain('£1,200')
    // 12 × £100 = £1,200 breaches the 20% (£1,000) cap → shared/risk warning surfaces
    expect(screen.getByText(/position cap/i)).toBeInTheDocument()
  })

  it('falls back to shared/risk defaults, halving to 1% for a speculative class', () => {
    const { container } = render(<TradeForm onAdd={() => {}} board={[]} riskState={riskState} capital={5000} />)
    typeInto('Trade ticker', 'ZZZZ') // no board call
    typeInto('Trade entry', '100')
    typeInto('Trade stop', '95')
    // default normal = 2%
    expect(container.querySelector('.tf-size-main')!.textContent).toContain('risk £100.00')

    fireEvent.change(screen.getByDisplayValue('Normal') as HTMLSelectElement, { target: { value: 'speculative' } })
    const line = container.querySelector('.tf-size-main')!.textContent!
    // 5000 × 1% = £50 → 10 shares ≈ £1,000 (exactly the cap, no warning)
    expect(line).toContain('risk £50.00')
    expect(line).toContain('1% default')
    expect(line).toContain('10 shares')
  })

  it('prefills entry and stop from the call on "use engine levels"', () => {
    render(<TradeForm onAdd={() => {}} board={[call]} riskState={riskState} capital={5000} />)
    typeInto('Trade ticker', 'AAPL')
    expect((screen.getByLabelText('Trade entry') as HTMLInputElement).value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: /use engine levels/i }))
    expect((screen.getByLabelText('Trade entry') as HTMLInputElement).value).toBe('100')
    expect((screen.getByLabelText('Trade stop') as HTMLInputElement).value).toBe('95')
  })

  it('lets the user overtype the engine levels — their numbers win', () => {
    const onAdd = vi.fn()
    render(<TradeForm onAdd={onAdd} board={[call]} riskState={riskState} capital={5000} />)
    typeInto('Trade ticker', 'AAPL')
    fireEvent.click(screen.getByRole('button', { name: /use engine levels/i }))
    typeInto('Trade stop', '97')
    typeInto('Trade value', '500')
    fireEvent.click(screen.getByRole('button', { name: /log trade/i }))
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'AAPL', entryPrice: 100, stop: 97 }))
  })
})
