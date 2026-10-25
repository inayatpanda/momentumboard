import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { emptyBusinessHealth } from '../../../shared/businessHealth'
import { QuarterlyFinancialPanel } from './QuarterlyFinancialPanel'
import type { FinancialQuarter } from '../../../shared/quarterlyFinancials'
const quarter = (end: string, availableAt: number): FinancialQuarter => ({start:end.slice(0,4)+'-01-01',end,availableAt,values:{revenue:100,netIncome:20,operatingCashFlow:30,capitalExpenditure:10,freeCashFlow:20},evidence:{},derived:true,revenueGrowthPct:5,netMarginPct:20,netMarginChangePp:0,freeCashFlowMarginPct:20,freeCashFlowMarginChangePp:0})
describe('quarterly evidence shown to readers', () => {
  it('keeps unpublished quarters and trailing-year totals out of the page', () => {
    const now = Date.now()/1000, data = emptyBusinessHealth('AAPL', now, '')
    data.quarterly = {version:'quarterly-asof-v1',asOf:now,status:'improving',gaps:[],quarters:[quarter('2025-03-31',1),quarter('2099-03-31',now+86400)],trailingYear:{start:'2098-04-01',end:'2099-03-31',availableAt:now+86400,values:quarter('2099-03-31',now).values}}
    render(<QuarterlyFinancialPanel snapshot={data}/> )
    expect(screen.queryByText(/2099/)).not.toBeInTheDocument()
    expect(screen.getByText('More evidence needed')).toBeVisible()
    expect(screen.getAllByText('+5.0%')[0]).toBeVisible()
    const caption=screen.getByText(/Individual quarters/)
    expect(caption).not.toBeVisible()
    fireEvent.click(screen.getByText('See the evidence: quarterly figures'))
    expect(caption).toBeVisible()
    expect(screen.queryByText(/Last four consecutive quarters/)).not.toBeInTheDocument()
  })
})
