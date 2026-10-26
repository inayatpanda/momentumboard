import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Candle } from '../../../shared/types'
const { slices } = vi.hoisted(() => ({ slices: new Map<string, unknown>() }))
vi.mock('../../lib/useSlice', () => ({ useSlice: (key:string) => slices.get(key) ?? {data:null,error:'Unavailable'} }))
import PerformanceComparison from './PerformanceComparison'
const bars = (start:number, end:number):Candle[] => [start,end].map((c,i) => ({t:Date.UTC(2025,0,i+1)/1000,o:c,h:c,l:c,c,v:1}))
describe('market comparison display', () => {
  it('shows common-period stock, market and sector returns with a plain explanation', () => {
    slices.set('candles:SPY:1mo',{data:{candles:bars(100,105)}})
    slices.set('candles:XLK:1mo',{data:{candles:bars(100,108)}})
    render(<PerformanceComparison symbol="AAPL" name="Apple" candles={bars(100,110)} range="1mo" sectorSymbol="XLK" sectorName="Technology"/> )
    expect(screen.getByText('5.0 percentage points.')).toBeVisible()
    expect(screen.getByRole('img',{name:/Apple: \+10.0%.*SPY: \+5.0%.*XLK: \+8.0%/})).toBeVisible()
  })
  it('still compares the market if the sector request fails, without inventing a sector return', () => {
    slices.set('candles:SPY:1mo',{data:{candles:bars(100,105)}})
    slices.set('candles:XLK:1mo',{data:null,error:'Unavailable'})
    render(<PerformanceComparison symbol="AAPL" name="Apple" candles={bars(100,90)} range="1mo" sectorSymbol="XLK" sectorName="Technology"/> )
    expect(screen.getByText(/Behind/)).toBeVisible()
    expect(screen.getByText(/Sector prices are unavailable/)).toBeVisible()
    expect(screen.queryByText('Technology · XLK')).not.toBeInTheDocument()
  })
})
