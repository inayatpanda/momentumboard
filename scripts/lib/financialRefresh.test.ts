import {describe,it,expect,vi} from 'vitest'
import {financialRefreshSymbols,publishFinancialReports} from './financialRefresh'
import {emptyBusinessHealth} from '../../shared/businessHealth'
import type {FinancialQuarter} from '../../shared/quarterlyFinancials'
describe('daily cloud financial publication',()=>{
  it('prioritises followed US symbols without duplicating the research sample',()=>{
    expect(financialRefreshSymbols([{symbol:'tsla'},{symbol:'VOD.L'},{symbol:'BTC-USD'},{symbol:'TSLA'},{symbol:'bad/path'}],['AAPL','TSLA'])).toEqual(['TSLA','AAPL'])
  })
  it('publishes usable reports and never overwrites good evidence with a failed or mismatched response',async()=>{
    const good={...emptyBusinessHealth('AAPL',1,''),status:'partial' as const,quarterly:{version:'quarterly-asof-v1' as const,asOf:1,status:'insufficient' as const,gaps:[],trailingYear:null,quarters:[{end:'2026-06-30'} as FinancialQuarter]}}
    const save=vi.fn(),pause=vi.fn(async()=>{})
    const result=await publishFinancialReports(['AAPL','MSFT','TSLA'],async sym=>sym==='TSLA'?good:sym==='AAPL'?good:emptyBusinessHealth(sym,1,'SEC unavailable'),save,pause)
    expect(save).toHaveBeenCalledExactlyOnceWith('AAPL',good)
    expect(result).toMatchObject({published:1,unavailable:2,paidCalls:0})
    expect(pause).toHaveBeenCalledTimes(3)
  })
})
