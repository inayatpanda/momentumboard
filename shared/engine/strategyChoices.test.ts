import { describe, expect, it } from 'vitest'
import type { Candle } from '../types'
import { emptyBusinessHealth, type BusinessHealthMetric, type BusinessHealthSnapshot } from '../businessHealth'
import type { ValuationCapitalization } from '../sectorFinancials'
import { buildStrategyChoices, type StrategyChoicesInput, type StrategyChoicesSnapshot } from './strategyChoices'
import { historyGate, HISTORY_CORE_MODEL, HISTORY_VERSION, type HistoricalStudy, type HistoricalTrade } from './historyEvidence'
import { STRATEGY_DEFINITIONS } from './strategyScreens'

const DAY=86400, NOW=Date.parse('2026-10-23T23:00:00Z')/1000
// Session dates are shared by all assets. The rules are about completed
// sessions, so using weekdays also exercises weekend/date-window alignment.
const dates:number[]=[]
for(let t=Date.parse('2026-10-23T13:30:00Z')/1000;dates.length<252;t-=DAY){if(![0,6].includes(new Date(t*1000).getUTCDay()))dates.unshift(t)}
const tape=(fn:(i:number)=>number):Candle[]=>dates.map((t,i)=>{const c=fn(i);return {t,o:c,h:c*1.01,l:c*.99,c,v:1000000}})
const rising=tape(i=>100+i*.4), spy=tape(i=>100+i*.05), sector=tape(i=>100+i*.15)
const recovery=tape(i=>i<150?150:i<210?90:90+(i-210)*.2)
const cap=(marketCapUsdM=1000):ValuationCapitalization=>({sym:'AAPL',marketCapUsdM,currency:'USD',observedAt:NOW-60,source:'historical-sec-shares'})
function financial():BusinessHealthSnapshot {
  const s=emptyBusinessHealth('AAPL',NOW-60,'')
  Object.assign(s,{status:'available',availableAt:NOW-60*DAY,currency:'USD',annualPeriodEnd:'2026-06-30',balancePeriodEnd:'2026-06-30',periodEnd:'2026-06-30',gaps:[]})
  const values:Partial<Record<BusinessHealthMetric,number>>={netIncome:100e6,operatingCashFlow:140e6,freeCashFlow:90e6,revenueGrowthPct:10,shareCountChangePct:0,cash:100e6,totalDebt:180e6,currentRatio:2,totalEquity:600e6,liabilitiesToEquity:.3}
  for(const [key,value] of Object.entries(values)){
    const k=key as BusinessHealthMetric
    s.metrics[k]=value
    s.evidence[k]={value,periodStart:'2025-07-01',periodEnd:'2026-06-30',filed:'2026-08-01',availableAt:NOW-60*DAY,unit:'USD',tags:['fixture'],accessions:['fixture']}
  }
  s.quarterly={version:'quarterly-asof-v1',asOf:NOW-60,status:'stable',gaps:[],quarters:[['2025-10-01','2025-12-31'],['2026-01-01','2026-03-31'],['2026-04-01','2026-06-30']].map(([start,end])=>({start,end,availableAt:Date.parse(end)/1000+32*DAY,values:{revenue:250e6,netIncome:25e6,operatingCashFlow:35e6,capitalExpenditure:10e6,freeCashFlow:25e6},evidence:{},revenueGrowthPct:5,netMarginPct:10,netMarginChangePp:0,freeCashFlowMarginPct:10,freeCashFlowMarginChangePp:0,derived:false})),trailingYear:{start:'2025-07-01',end:'2026-06-30',availableAt:NOW-60*DAY,values:{revenue:1000e6,netIncome:100e6,operatingCashFlow:140e6,capitalExpenditure:50e6,freeCashFlow:90e6}}}
  return s
}
const input=(bars=rising):StrategyChoicesInput=>({now:NOW,rows:[{symbol:'AAPL',sector:'XLK',candles:bars}],spy,sectors:{XLK:sector}})
const group=(s:StrategyChoicesSnapshot,key:string)=>s.strategies.find(s=>s.key===key)!
const prior:HistoricalTrade[]=Array.from({length:96},(_,i)=>({sym:'AAPL',signalAt:Date.UTC(2024+Math.floor(i/48),Math.floor(i%48/4),2+i%4*5)/1000,endAt:Date.UTC(2024+Math.floor(i/48),Math.floor(i%48/4),5+i%4*5)/1000,returnPct:2,marketPct:1,brier:.1,baselineBrier:.2}))
const study=():HistoricalStudy=>({version:HISTORY_VERSION,coreModel:HISTORY_CORE_MODEL,generatedAt:NOW-60,dataThrough:NOW-DAY,dataFrom:1,evaluationFrom:1,symbols:['AAPL'],missingSymbols:[],strategies:[],gates:[],liveGate:historyGate(prior,2026),costBpsPerSide:10,dataDigest:'fixture',caveats:[],unavailable:[]})

describe('independent current strategy screens',()=>{
  it('keeps all 12 strategies separate and preserves a stock qualifying for more than one',()=>{
    const s=buildStrategyChoices(input())
    expect(s.strategies.map(s=>s.key)).toEqual(STRATEGY_DEFINITIONS.map(s=>s.key))
    expect(group(s,'trend-price').matches.map(m=>m.symbol)).toEqual(['AAPL'])
    expect(group(s,'sector-leader').matches.map(m=>m.symbol)).toEqual(['AAPL'])
    expect(group(s,'quality-trend').counts).toMatchObject({missing:1,matched:0})
    expect(group(s,'big-drop-price').counts).toMatchObject({noMatch:1,matched:0})
    expect(group(s,'trend-price').matches[0]).not.toHaveProperty('score')
    expect(group(s,'trend-price').matches[0]).not.toHaveProperty('probability')
    expect(group(s,'trend-price').matches[0].asOf).toBe(Date.parse('2026-10-23T20:00:00Z')/1000)
  })
  it('does not let expensive valuation veto health-only recovery, or failed health veto price-only recovery',()=>{
    const a=input(recovery);a.rows[0].financial=financial();a.rows[0].valuation=cap(100000)
    const s=buildStrategyChoices(a)
    for(const key of ['big-drop-price','healthy-drop','quarterly-recovery'])expect(group(s,key).counts.matched,key).toBe(1)
    expect(group(s,'healthy-value-drop').counts).toMatchObject({noMatch:1,matched:0})
    a.rows[0].financial!.metrics.netIncome=-1
    const failing=buildStrategyChoices(a)
    expect(group(failing,'big-drop-price').counts.matched).toBe(1)
    expect(group(failing,'healthy-drop').counts.noMatch).toBe(1)
  })
  it('requires the exact 252-session recovery high and classified financial sector',()=>{
    const a=input(recovery.slice(1));a.rows[0].financial=financial()
    expect(group(buildStrategyChoices(a),'big-drop-price').counts.missing).toBe(1)
    a.rows[0].candles=recovery;a.rows[0].sector=null
    const s=buildStrategyChoices(a)
    expect(group(s,'big-drop-price').counts.matched).toBe(1)
    expect(group(s,'healthy-drop').counts.missing).toBe(1)
  })
  it('isolates missing sector prices and distinguishes absent input from a failed rule',()=>{
    const a=input();a.sectors={};a.unavailableSymbols=['MSFT']
    const s=buildStrategyChoices(a)
    expect(group(s,'trend-price').counts).toMatchObject({matched:1,missing:1})
    expect(group(s,'sector-leader').counts).toMatchObject({matched:0,missing:2})
    expect(group(s,'big-drop-price').counts).toMatchObject({noMatch:1,missing:1})
    expect(s.symbols).toEqual(['AAPL','MSFT'])
  })
  it.each(['stale','gap','duplicate','unordered','invalid'] as const)('refuses %s required prices',kind=>{
    const a=input();a.rows[0].candles=rising.map(c=>({...c}))
    if(kind==='stale')a.now=NOW+8*DAY
    if(kind==='gap')a.rows[0].candles.splice(100,1)
    if(kind==='duplicate')a.rows[0].candles.splice(100,0,{...rising[100]})
    if(kind==='unordered')a.rows[0].candles.reverse()
    if(kind==='invalid')a.rows[0].candles[100].h=1
    const s=buildStrategyChoices(a)
    expect(group(s,'trend-price').counts).toMatchObject({missing:1,matched:0})
  })
  it('ignores future and unfinished session bars instead of leaking them into a screen',()=>{
    const a=input(),base=buildStrategyChoices(a)
    a.rows[0].candles=[...rising,{...rising.at(-1)!,t:NOW+DAY,c:1,h:1,l:1,o:1}]
    expect(buildStrategyChoices(a)).toEqual(base)
    const early=input();early.now=Date.parse('2026-10-23T15:00:00Z')/1000
    expect(group(buildStrategyChoices(early),'trend-price').matches[0].asOf).toBe(Date.parse('2026-10-22T20:00:00Z')/1000)
  })
  it('keeps the core direction model watch-only and enforces actual prior-history permission',()=>{
    const a=input(tape(i=>100+i*.03+Math.sin((i+3)/5)*15))
    const denied=buildStrategyChoices(a)
    expect(group(denied,'direction-core').counts).toMatchObject({blocked:1,matched:0})
    expect(group(denied,'direction-gated').counts).toMatchObject({blocked:1,matched:0})
    a.historicalStudy=study()
    expect(group(buildStrategyChoices(a),'direction-gated').counts).toMatchObject({blocked:0,matched:1})
    a.historicalStudy.liveGate.allow=false
    expect(group(buildStrategyChoices(a),'direction-gated').counts).toMatchObject({blocked:1,matched:0})
  })
  it('does not call a price-only historical sample financial coverage',()=>{
    const a=input();a.rows[0].financial=financial();a.rows[0].valuation=cap();a.historicalStudy=study()
    const s=buildStrategyChoices(a)
    expect(group(s,'trend-price').matches[0].backtestCovered).toBe(true)
    expect(group(s,'quality-trend').matches[0].backtestCovered).toBe(false)
    a.historicalStudy.financialCoverage={version:'sec-asof-quarterly-v2',symbols:['AAPL'],unavailableSymbols:[],snapshots:1}
    expect(group(buildStrategyChoices(a),'quality-trend').matches[0].backtestCovered).toBe(true)
    a.historicalStudy.coreModel='old'
    expect(group(buildStrategyChoices(a),'trend-price').matches[0].backtestCovered).toBe(false)
  })
  it('does not admit future filings, future capitalization or unavailable quarterly trends',()=>{
    const a=input(recovery);a.rows[0].financial=financial();a.rows[0].valuation=cap()
    a.rows[0].financial!.quarterly!.quarters.at(-1)!.availableAt=NOW+1
    const s=buildStrategyChoices(a)
    expect(group(s,'healthy-drop').counts.matched).toBe(1)
    expect(group(s,'quarterly-recovery').counts.missing).toBe(1)
    a.rows[0].valuation!.observedAt=NOW+1
    expect(group(buildStrategyChoices(a),'healthy-value-drop').counts.missing).toBe(1)
    a.rows[0].financial!.evidence.netIncome!.availableAt=NOW+1
    expect(group(buildStrategyChoices(a),'healthy-drop').counts.missing).toBe(1)
  })
  it('uses filing availability rather than a slightly later retrieval clock',()=>{
    const a=input(recovery);a.rows[0].financial=financial();a.rows[0].financial!.asOf=NOW+5
    expect(group(buildStrategyChoices(a),'healthy-drop').counts.matched).toBe(1)
    a.rows[0].financial!.availableAt=NOW+1
    expect(group(buildStrategyChoices(a),'healthy-drop').counts.missing).toBe(1)
  })
  it('separates a known debt ceiling failure from missing financial evidence without changing the rule',()=>{
    const a=input(recovery),s=financial();a.rows[0].financial=s
    s.metrics.totalDebt=600e6
    const g=group(buildStrategyChoices(a),'healthy-drop')
    // Legacy unknown/missing classification is retained for comparability;
    // the diagnostic explains that this is a known conservative limit.
    expect(g.counts).toMatchObject({matched:0,missing:1})
    expect(g.diagnostics).toMatchObject({priceMatched:1,priceFailed:0,missingPrices:0,failedFinancial:1,missingFinancial:0})
    expect(g.diagnostics!.candidates[0]).toMatchObject({category:'financial-rule',healthStatus:'unknown',missing:[]})
    expect(g.diagnostics!.candidates[0].failed[0]).toContain('ceiling')
    s.metrics.totalDebt=null
    const missing=group(buildStrategyChoices(a),'healthy-drop').diagnostics!
    expect(missing).toMatchObject({failedFinancial:0,missingFinancial:1})
    expect(missing.candidates[0].category).toBe('missing-data')
  })
  it('distinguishes uncertain debt upper bounds from a known liquidity failure',()=>{
    const a=input(recovery),s=financial();a.rows[0].financial=s;a.rows[0].sector='XLP'
    // PEP-like reported values: liabilities bound cannot prove actual debt,
    // but the cash-flow liquidity floor can be checked with available data.
    s.metrics.totalDebt=null;s.metrics.totalLiabilities=89489e6;s.metrics.cash=10675e6;s.metrics.operatingCashFlow=12087e6
    s.metrics.currentRatio=.8;s.metrics.currentLiabilities=34529e6
    for(const key of ['totalLiabilities','currentLiabilities'] as const)s.evidence[key]={...s.evidence.cash!,value:s.metrics[key]!}
    const d=group(buildStrategyChoices(a),'healthy-drop').diagnostics!
    expect(d).toMatchObject({failedFinancial:1,missingFinancial:1})
    expect(d.candidates[0]).toMatchObject({category:'mixed',healthStatus:'unknown'})
    expect(d.candidates[0].missing.join(' ')).toContain('cannot establish that actual debt is excessive')
    expect(d.candidates[0].failed.join(' ')).toContain('0.7×')
    expect(d.candidates[0].failed.join(' ')).not.toContain('net total-liabilities')
  })
  it('retains known deterioration when separate borrowing data is unavailable',()=>{
    const a=input(recovery),s=financial();a.rows[0].financial=s
    s.metrics.totalDebt=null;s.metrics.revenueGrowthPct=-4.3
    const d=group(buildStrategyChoices(a),'healthy-drop').diagnostics!
    expect(d).toMatchObject({failedFinancial:1,missingFinancial:1})
    expect(d.candidates[0]).toMatchObject({category:'mixed',healthStatus:'deteriorating'})
    expect(d.candidates[0].failed).toContain('Annual revenue declined against the comparable prior year.')
  })
  it('uses a proven minimum borrowing amount only to explain a strict-rule exclusion',()=>{
    const a=input(recovery),s=financial();a.rows[0].financial=s;a.rows[0].sector='XLY'
    s.metrics.totalDebt=null;s.metrics.cash=822e6;s.metrics.operatingCashFlow=10551e6
    s.debtMinimum={...s.evidence.cash!,value:39863e6}
    const g=group(buildStrategyChoices(a),'healthy-drop'),d=g.diagnostics!
    expect(g.counts).toMatchObject({matched:0,missing:1})
    expect(d).toMatchObject({failedFinancial:1,missingFinancial:1})
    expect(d.candidates[0]).toMatchObject({category:'mixed',healthStatus:'unknown'})
    expect(d.candidates[0].failed[0]).toContain('at least 3.7×')
    s.debtMinimum.availableAt=NOW+1
    expect(group(buildStrategyChoices(a),'healthy-drop').diagnostics!.failedFinancial).toBe(0)
  })
  it('reports specialist exclusions separately and carries the scan-universe version',()=>{
    const a=input(recovery);a.rows[0].sector='XLF';a.universeVersion='balanced-test:123'
    const s=buildStrategyChoices(a),d=group(s,'healthy-drop').diagnostics!
    expect(d).toMatchObject({priceMatched:1,specialist:1,failedFinancial:0,missingFinancial:0})
    expect(d.candidates[0]).toMatchObject({category:'specialist',missing:[],failed:[]})
    expect(s.universeVersion).toBe('balanced-test:123')
  })
  it('counts incomplete prices and failed price rules before considering financial evidence',()=>{
    const a=input(recovery);a.rows.push({symbol:'MSFT',sector:'XLK',candles:rising},{symbol:'BAD',candles:[]})
    const d=group(buildStrategyChoices(a),'healthy-drop').diagnostics!
    expect(d).toMatchObject({priceMatched:1,priceFailed:1,missingPrices:1,missingFinancial:1})
    expect(d.candidates.map(c=>c.symbol)).toEqual(['AAPL'])
  })
  it('bounds example payloads while preserving the complete financial diagnosis counts',()=>{
    const a=input(recovery);a.rows=Array.from({length:45},(_,i)=>({symbol:`T${i}`,sector:'XLK',candles:recovery}))
    const d=group(buildStrategyChoices(a),'healthy-drop').diagnostics!
    expect(d).toMatchObject({priceMatched:45,missingFinancial:45,failedFinancial:0,candidatesTotal:45,candidatesTruncated:true})
    expect(d.candidates).toHaveLength(40)
  })
  it('keeps valuation failures and missing capitalization distinct',()=>{
    const a=input(recovery);a.rows[0].financial=financial();a.rows[0].valuation=cap(100000)
    const expensive=group(buildStrategyChoices(a),'healthy-value-drop').diagnostics!
    expect(expensive).toMatchObject({failedFinancial:1,missingFinancial:0})
    expect(expensive.candidates[0]).toMatchObject({category:'financial-rule',healthStatus:'healthy'})
    a.rows[0].valuation=null
    expect(group(buildStrategyChoices(a),'healthy-value-drop').diagnostics!.candidates[0].category).toBe('missing-data')
  })
})
