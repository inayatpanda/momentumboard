import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { StrategyObservation } from '../../../shared/engine/strategyLab'
import { StrategyGlance } from './StrategyGlance'
const row = (availableAt:number, reason:string, state:StrategyObservation['state']='watch') => ({ sym:'AAPL', sleeve:'quality-dip', availableAt, state, reasons:[reason], forecast:{horizonSessions:21} }) as StrategyObservation
describe('separate strategy overview', () => {
  it('uses the newest known view per strategy and opens its evidence without implying a buy', () => {
    const now = Date.now()/1000, open = vi.fn()
    render(<StrategyGlance symbol="AAPL" observations={[row(now-500,'Old view','setup'),row(now-100,'Needs a price recovery'),row(now+86400,'Future view')]} onEvidence={open}/> )
    expect(screen.getByText('Needs a price recovery')).toBeVisible()
    expect(screen.getByText('Watching')).toBeVisible()
    expect(screen.queryByText('Old view')).not.toBeInTheDocument()
    expect(screen.queryByText('Future view')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button',{name:/See the evidence for these strategies/}))
    expect(open).toHaveBeenCalledOnce()
  })
})
