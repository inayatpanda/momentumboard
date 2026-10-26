import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { QuarterlyTrendChart } from './QuarterlyTrendChart'
import type { FinancialQuarter } from '../../../shared/quarterlyFinancials'
const quarter = (end:string, profit:number|null):FinancialQuarter => ({ start:'2025-01-01',end,availableAt:1, values:{ revenue:1000,netIncome:profit,freeCashFlow:null,operatingCashFlow:null,capitalExpenditure:null },evidence:{},derived:false,revenueGrowthPct:null,netMarginPct:null,netMarginChangePp:null,freeCashFlowMarginPct:null,freeCashFlowMarginChangePp:null })
describe('quarterly chart interactions', () => {
  it('shows losses below zero, selects a quarter, and preserves missing cash figures', () => {
    render(<QuarterlyTrendChart quarters={[quarter('2025-03-31',-100),quarter('2025-06-30',200)]}/> )
    fireEvent.click(screen.getByRole('button',{name:'Profit'}))
    fireEvent.click(screen.getByRole('button',{name:'Mar 25: -$100'}))
    expect(screen.getByText('-$100')).toBeVisible()
    expect(screen.getByRole('button',{name:'Mar 25: -$100'}).querySelector('.negative')).not.toBeNull()
    fireEvent.click(screen.getByRole('button',{name:'Free cash flow'}))
    expect(screen.getByText('Unavailable')).toBeVisible()
    expect(screen.getByText(/No reported values/)).toBeVisible()
    expect(screen.queryByText('$0')).not.toBeInTheDocument()
  })
})
