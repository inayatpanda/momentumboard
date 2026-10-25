import { describe,expect,it } from 'vitest'
import type { Candle } from '../types'
import { emptyBusinessHealth,type BusinessHealthSnapshot } from '../businessHealth'
import type { ValuationCapitalization } from '../sectorFinancials'
import { buildSellReview,type SellReviewInput } from './sellReview'
import { buildStrategyChoices } from './strategyChoices'

const DAY=86400,NOW=Date.parse('2026-10-23T23:00:00Z')/1000
const dates:number[]=[]
for(let t=Date.parse('2026-10-23T13:30:00Z')/1000;dates.length<252;t-=DAY)if(![0,6].includes(new Date(t*1000).getUTCDay()))dates.unshift(t)
const tape=(fn:(i:number)=>number):Candle[]=>dates.map((t,i)=>{const c=fn(i);return {t,o:c,h:c*1.01,l:c*.99,c,v:1000000}})
const rising=tape(i=>100+i*.3),spy=tape(i=>100+i*.05),weak=tape(i=>i<180?120:120-(i-180)*.5)
function financial():BusinessHealthSnapshot {
  const s=emptyBusinessHealth('AAPL',NOW-60,'')
  Object.assign(s,{status:'available',availableAt:NOW-60*DAY,currency:'USD',annualPeriodEnd:'2026-06-30',balancePeriodEnd:'2026-06-30',periodEnd:'2026-06-30',sourceUrl:'https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json',gaps:[]})
  for(const [key,value] of [['netIncome',100e6],['freeCashFlow',90e6]] as const){
    s.metrics[key]=value;s.evidence[key]={value,periodStart:'2025-07-01',periodEnd:'2026-06-30',filed:'2026-08-01',availableAt:NOW-60*DAY,unit:'USD',tags:['fixture'],accessions:['fixture']}
  }
  s.quarterly={version:'quarterly-asof-v1',asOf:NOW-60,status:'stable',gaps:[],quarters:[['2025-10-01','2025-12-31'],['2026-01-01','2026-03-31'],['2026-04-01','2026-06-30']].map(([start,end])=>({start,end,availableAt:Date.parse(end)/1000+32*DAY,values:{revenue:250e6,netIncome:25e6,operatingCashFlow:35e6,capitalExpenditure:10e6,freeCashFlow:25e6},evidence:{},revenueGrowthPct:5,netMarginPct:10,netMarginChangePp:0,freeCashFlowMarginPct:10,freeCashFlowMarginChangePp:0,derived:false})),trailingYear:null}
  return s
}
const cap=(marketCapUsdM=1000):ValuationCapitalization=>({sym:'AAPL',marketCapUsdM,currency:'USD',observedAt:NOW-60,source:'historical-sec-shares'})
const input=(bars=rising):SellReviewInput=>({now:NOW,spy,rows:[{symbol:'AAPL',name:'Apple',sector:'XLK',candles:bars,financial:financial(),valuation:cap()}]})
const first=(a:SellReviewInput)=>buildSellReview(a).rows[0]

describe('independent exit review, never automatic sell instructions',()=>{
  it('shows no warning when all applicable checks are known and do not trigger',()=>{
    const s=buildSellReview(input())
    expect(s.coverage).toEqual({scanned:1,review:0,noWarning:1,dataGap:0,incomplete:0})
    expect(s.rows[0]).toMatchObject({status:'no-warning',signals:[],gaps:[],checks:{price:'checked',business:'checked',valuation:'checked'}})
    expect(s.rows[0]).not.toHaveProperty('score')
    expect(s.rows[0]).not.toHaveProperty('probability')
    expect(s.caveats.join(' ')).toContain('not instructions to sell')
  })
  it('requires a sustained broken trend, absolute decline and market underperformance together',()=>{
    const a=input(weak),r=first(a)
    expect(r.status).toBe('review')
    expect(r.signals.map(s=>s.kind)).toEqual(['price'])
    expect(r.signals[0].reasons.join(' ')).toContain('price warning only')
    expect(r.signals[0].evidenceAt).toBe(Date.parse('2026-10-23T20:00:00Z')/1000)
    a.spy=weak
    expect(first(a).signals).toEqual([])
    a.spy=spy;a.rows[0].candles=rising.map((c,i)=>i===251?{...c,o:80,h:81,l:79,c:80}:c)
    expect(first(a).signals).toEqual([])
  })
  it('keeps a known price warning separate from unknown business health',()=>{
    const a=input(weak);a.rows[0].financial=null;a.rows[0].valuation=null
    const s=buildSellReview(a),r=s.rows[0]
    expect(r.status).toBe('review')
    expect(r.signals.map(s=>s.kind)).toEqual(['price'])
    expect(r.checks).toMatchObject({business:'missing',valuation:'missing'})
    expect(s.coverage.incomplete).toBe(1)
  })
  it.each(['stale','gap','duplicate','invalid','future-only'] as const)('does not turn %s prices into a sell warning',kind=>{
    const a=input(weak);a.rows[0].financial=null;a.rows[0].valuation=null;a.rows[0].candles=weak.map(c=>({...c}))
    if(kind==='stale')a.now=NOW+8*DAY
    if(kind==='gap')a.rows[0].candles.splice(100,1)
    if(kind==='duplicate')a.rows[0].candles.splice(100,0,{...weak[100]})
    if(kind==='invalid')a.rows[0].candles[100].h=1
    if(kind==='future-only')a.rows[0].candles=weak.map(c=>({...c,t:c.t+500*DAY}))
    const r=first(a)
    expect(r.status).toBe('data-gap');expect(r.signals).toEqual([])
    expect(r.checks.price).not.toBe('checked')
  })
  it('ignores future prices instead of letting them create or remove a warning',()=>{
    const a=input(weak),baseline=buildSellReview(a)
    a.rows[0].candles=[...weak,{t:NOW+DAY,o:999,h:1000,l:998,c:999,v:1}]
    expect(buildSellReview(a)).toEqual(baseline)
  })
  it('requires repeated, recent quarterly operating weakness and labels its reporting period separately',()=>{
    const a=input(),q=a.rows[0].financial!.quarterly!.quarters
    for(const quarter of q){quarter.revenueGrowthPct=-4;quarter.netMarginChangePp=-2}
    const r=first(a),s=r.signals[0]
    expect(r.status).toBe('review');expect(s.kind).toBe('business')
    expect(s.periodEnd).toBe('2026-06-30')
    expect(s.financialAvailableAt).toBe(q.at(-1)!.availableAt)
    expect(s.evidenceAt).toBeGreaterThan(Date.parse(s.periodEnd!)/1000)
    expect(s.sources?.[0].url).toContain('data.sec.gov')
    q.at(-1)!.revenueGrowthPct=5;q.at(-1)!.netMarginChangePp=0
    expect(first(a).signals).toEqual([])
  })
  it('does not infer a business warning from missing, stale, future or specialist quarterly data',()=>{
    for(const kind of ['missing','stale','future','specialist','nonfinite'] as const){
      const a=input(),s=a.rows[0].financial!,quarters=s.quarterly!.quarters
      for(const q of quarters){q.revenueGrowthPct=-4;q.netMarginChangePp=-2}
      if(kind==='missing')quarters.pop()
      if(kind==='stale')a.now=NOW+100*DAY
      if(kind==='future')quarters.at(-1)!.availableAt=NOW+1
      if(kind==='specialist')a.rows[0].sector='XLF'
      if(kind==='nonfinite'){quarters.at(-1)!.netMarginChangePp=NaN;quarters.at(-1)!.freeCashFlowMarginChangePp=null}
      expect(first(a).signals.filter(s=>s.kind==='business'),kind).toEqual([])
      expect(first(a).checks.business,kind).not.toBe('checked')
    }
  })
  it('does not invert buy valuation ceilings or warn on one stretched valuation measure alone',()=>{
    const a=input();a.rows[0].valuation=cap(4000)
    expect(first(a).signals).toEqual([]) // P/E40 fails the buy30 ceiling but not review60.
    a.rows[0].valuation=cap(10000)
    const r=first(a),s=r.signals[0]
    expect(s.kind).toBe('valuation');expect(s.periodEnd).toBe('2026-06-30')
    expect(s.priceObservedAt).toBe(NOW-60);expect(s.financialAvailableAt).toBe(NOW-60*DAY)
    a.rows[0].financial!.metrics.freeCashFlow=500e6
    expect(first(a).signals).toEqual([]) // P/E alone is insufficient.
    a.rows[0].financial!.metrics.freeCashFlow=90e6;a.rows[0].financial!.metrics.netIncome=200e6
    expect(first(a).signals).toEqual([]) // Cash-flow yield alone is insufficient.
  })
  it('refuses valuation warnings from future, stale, missing or mismatched annual evidence',()=>{
    for(const kind of ['cap-future','cap-stale','filing-future','annual-future','annual-stale','missing-profit','wrong-symbol'] as const){
      const a=input(),s=a.rows[0].financial!;a.rows[0].valuation=cap(10000)
      if(kind==='cap-future')a.rows[0].valuation!.observedAt=NOW+1
      if(kind==='cap-stale')a.rows[0].valuation!.observedAt=NOW-2*DAY
      if(kind==='filing-future')s.evidence.netIncome!.availableAt=NOW+1
      if(kind==='annual-future')s.annualPeriodEnd='2027-01-01'
      if(kind==='annual-stale'){s.annualPeriodEnd='2024-12-31';s.evidence.netIncome!.periodEnd=s.annualPeriodEnd;s.evidence.freeCashFlow!.periodEnd=s.annualPeriodEnd}
      if(kind==='missing-profit')s.metrics.netIncome=null
      if(kind==='wrong-symbol')s.sym='MSFT'
      expect(first(a).signals.filter(s=>s.kind==='valuation'),kind).toEqual([])
      expect(first(a).checks.valuation,kind).not.toBe('checked')
    }
  })
  it('retains every scanned symbol, including unavailable rows, in the cloud snapshot',()=>{
    const a=input(weak)
    const choices=buildStrategyChoices({...a,sectors:{},unavailableSymbols:['MSFT']})
    expect(choices.sellReview?.rows.map(r=>r.symbol)).toEqual(['AAPL','MSFT'])
    expect(choices.sellReview?.coverage).toMatchObject({scanned:2,review:1,dataGap:1})
    expect(choices.sellReview?.rows[1].signals).toEqual([])
  })
  it('keeps a 250-stock snapshot with all three warnings within the existing storage budget',()=>{
    const a=input(weak),s=financial()
    for(const q of s.quarterly!.quarters){q.revenueGrowthPct=-4;q.netMarginChangePp=-2}
    a.rows=Array.from({length:250},(_,i)=>({symbol:`T${i}`,sector:'XLK',candles:weak,financial:{...s,sym:`T${i}`},valuation:{...cap(10000),sym:`T${i}`}}))
    const choices=buildStrategyChoices({...a,sectors:{}})
    expect(choices.sellReview!.coverage.review).toBe(250)
    expect(choices.sellReview!.rows.every(r=>r.signals.length===3)).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify(choices)).length).toBeLessThan(900000)
  })
})
