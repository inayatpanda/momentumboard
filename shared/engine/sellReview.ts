import type { Candle } from '../types'
import type { BusinessHealthSnapshot } from '../businessHealth'
import type { ValuationCapitalization } from '../sectorFinancials'
import { sectorFinancialPolicy } from '../sectorFinancials'
import { assessBusinessValuation } from '../businessValuation'
import { quarterlyTrend, type FinancialQuarter } from '../quarterlyFinancials'
import { exchangeFor } from '../symbols'
import { sessionUtcHours } from '../rvol'
import { completedLabCandles } from './strategyLab'

export const SELL_REVIEW_VERSION='sell-review-v1'
/** Fixed descriptive review rules, not fitted to subsequent prices or a
 * reversal of the buy screens. A rule change requires a new version. */
export const SELL_REVIEW_RULES={trendSessions:200,confirmationSessions:5,relativeSessions:60,declinePct:-10,marketLagPp:-10,peCeilingMultiple:2,fcfYieldFloorMultiple:.5} as const
export type SellReviewSignalKind='business'|'price'|'valuation'
export type SellReviewCheckStatus='checked'|'missing'|'stale'|'not-supported'
export interface SellReviewSignal {
  kind:SellReviewSignalKind; label:string; summary:string; evidenceAt:number
  periodEnd?:string; financialAvailableAt?:number; priceObservedAt?:number
  reasons:string[]; sources?:{label:string;url:string}[]
}
export interface SellReviewRow {
  symbol:string; name?:string; sector:string|null
  status:'review'|'no-warning'|'data-gap'; asOf:number|null
  checks:{price:SellReviewCheckStatus;business:SellReviewCheckStatus;valuation:SellReviewCheckStatus}
  signals:SellReviewSignal[]; gaps:string[]
}
export interface SellReviewSnapshot {
  version:typeof SELL_REVIEW_VERSION; generatedAt:number
  coverage:{scanned:number;review:number;noWarning:number;dataGap:number;incomplete:number}
  rows:SellReviewRow[]; caveats:string[]
}
export interface SellReviewInputRow {
  symbol:string; name?:string; sector?:string|null; candles:Candle[]
  financial?:BusinessHealthSnapshot|null; valuation?:ValuationCapitalization|null
}
export interface SellReviewInput {now:number;rows:SellReviewInputRow[];spy:Candle[]}
type Check={status:SellReviewCheckStatus;gaps:string[];signal?:SellReviewSignal}
const DAY=86400,day=(t:number)=>Math.floor(t/DAY)
const percentage=(ratio:number)=>`${ratio.toFixed(1)}%`
const sessionClose=(symbol:string,t:number)=>{
  const exchange=exchangeFor(symbol),midnight=day(t)*DAY
  return midnight+(exchange==='CRYPTO'?24:sessionUtcHours(exchange,midnight).close)*3600
}
function tape(raw:Candle[],now:number,symbol:string):Candle[]{
  const known=raw.filter(bar=>bar.t<=now)
  if(known.some((bar,i)=>i>0&&day(bar.t)<=day(known[i-1].t)))return []
  return completedLabCandles(raw,now,symbol)
}
function filingSources(snapshot:BusinessHealthSnapshot):{label:string;url:string}[]{
  try{
    const url=new URL(snapshot.sourceUrl??'')
    return url.protocol==='https:'&&['www.sec.gov','data.sec.gov','sec.gov'].includes(url.hostname)?[{label:'Reported SEC financials',url:url.href}]:[]
  }catch{return []}
}
function priceCheck(symbol:string,bars:Candle[],spy:Candle[],now:number):Check {
  const needed=SELL_REVIEW_RULES.trendSessions+SELL_REVIEW_RULES.confirmationSessions-1
  const last=bars.at(-1),market=spy.at(-1)
  if(!last||!market)return {status:'missing',gaps:['Price review needs usable stock and SPY daily prices.']}
  if(now-last.t>7*DAY||now-market.t>7*DAY)return {status:'stale',gaps:['Price review is paused because stock or market prices are more than seven days old.']}
  if(bars.length<needed||spy.length<needed||!bars.slice(-needed).every((bar,i)=>day(bar.t)===day(spy[spy.length-needed+i].t)))return {status:'missing',gaps:[`Price review needs ${needed} completed sessions aligned with SPY; missing days are not compressed.`]}
  const lastIndex=bars.length-1,avg=(end:number,n:number)=>bars.slice(end-n+1,end+1).reduce((sum,c)=>sum+c.c,0)/n
  const broken=Array.from({length:SELL_REVIEW_RULES.confirmationSessions},(_,offset)=>lastIndex-offset).every(i=>bars[i].c<avg(i,SELL_REVIEW_RULES.trendSessions))
  const fallingTrend=avg(lastIndex,50)<avg(lastIndex,SELL_REVIEW_RULES.trendSessions)
  const change=(last.c/bars[lastIndex-SELL_REVIEW_RULES.relativeSessions].c-1)*100
  const marketChange=(market.c/spy[spy.length-1-SELL_REVIEW_RULES.relativeSessions].c-1)*100,lag=change-marketChange
  if(!broken||!fallingTrend||change>SELL_REVIEW_RULES.declinePct||lag>SELL_REVIEW_RULES.marketLagPp)return {status:'checked',gaps:[]}
  return {status:'checked',gaps:[],signal:{kind:'price',label:'A sustained weak price trend',summary:'The stock has fallen sharply and lagged the market while its longer trend remains weak.',evidenceAt:sessionClose(symbol,last.t),priceObservedAt:sessionClose(symbol,last.t),periodEnd:new Date(last.t*1000).toISOString().slice(0,10),
    reasons:[`All five latest completed closes were below their 200-session averages, and the 50-session average is below the 200-session average.`,
      `Over 60 sessions the stock changed ${percentage(change)}, versus ${percentage(marketChange)} for SPY: ${Math.abs(lag).toFixed(1)} percentage points behind. The rule requires a fall of at least 10% and a market lag of at least 10 points.`,
      'This is a price warning only. It does not establish that the business is getting worse.'],sources:[{label:'Stock price history',url:`https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/history/`}]}}
}
function snapshotCheck(snapshot:BusinessHealthSnapshot|null|undefined,symbol:string,now:number):Check|null {
  if(!snapshot||snapshot.sym.toUpperCase()!==symbol||snapshot.status==='unavailable')return {status:'missing',gaps:['Dated financial reports are unavailable for this stock.']}
  if(snapshot.availableAt==null||!Number.isFinite(snapshot.availableAt)||snapshot.availableAt>now)return {status:'missing',gaps:['Financial reports were not verifiably available at this review time.']}
  return null
}
function knownQuarter(q:FinancialQuarter,now:number):boolean {
  return Number.isFinite(q.availableAt)&&q.availableAt<=now&&Number.isFinite(Date.parse(q.end))&&Date.parse(q.end)/1000<=now&&
    [q.revenueGrowthPct,q.netMarginChangePp,q.freeCashFlowMarginChangePp].filter(value=>value!=null&&Number.isFinite(value)).length>=2
}
function businessCheck(symbol:string,snapshot:BusinessHealthSnapshot|null|undefined,sector:string|null|undefined,now:number):Check {
  const policy=sectorFinancialPolicy(sector)
  if(!policy||policy.specialist)return {status:'not-supported',gaps:[policy?.specialist??'Quarterly business review needs a known sector classification.']}
  const unavailable=snapshotCheck(snapshot,symbol,now)
  if(unavailable)return unavailable
  const quarters=snapshot!.quarterly?.version==='quarterly-asof-v1'?snapshot!.quarterly.quarters.filter(q=>Number.isFinite(q.availableAt)&&q.availableAt<=now&&Date.parse(q.end)/1000<=now).sort((a,b)=>a.end.localeCompare(b.end)).slice(-3):[]
  const last=quarters.at(-1)
  if(last&&now-Date.parse(last.end)/1000>180*DAY)return {status:'stale',gaps:['The latest comparable quarter is more than 180 days old, so it cannot create a current business warning.']}
  if(quarters.length<3||quarters.some(q=>!knownQuarter(q,now)))return {status:'missing',gaps:['Business review needs three recent comparable quarters with at least two reported operating measures each.']}
  const trend=quarterlyTrend(quarters,now)
  if(trend==='insufficient')return {status:'missing',gaps:['The recent quarters are not consecutive or comparable enough to judge a business trend.']}
  if(trend!=='deteriorating')return {status:'checked',gaps:[]}
  return {status:'checked',gaps:[],signal:{kind:'business',label:'The reported business trend is worsening',summary:'Weakness has repeated across recent quarterly reports, rather than appearing only in the share price.',
    evidenceAt:Math.max(...quarters.map(q=>q.availableAt)),financialAvailableAt:Math.max(...quarters.map(q=>q.availableAt)),periodEnd:last!.end,reasons:[
      'The latest quarter and at least one other of the latest three quarters had two or more weak operating measures.',
      'The measures are sales growth below −2% year on year, profit-margin change below −1 percentage point, and free-cash-flow-margin change below −1 percentage point.',
      ...quarters.map(q=>`${q.end}: sales growth ${q.revenueGrowthPct!=null&&Number.isFinite(q.revenueGrowthPct)?percentage(q.revenueGrowthPct):'unavailable'}; profit-margin change ${q.netMarginChangePp!=null&&Number.isFinite(q.netMarginChangePp)?`${q.netMarginChangePp.toFixed(1)} points`:'unavailable'}; free-cash-flow-margin change ${q.freeCashFlowMarginChangePp!=null&&Number.isFinite(q.freeCashFlowMarginChangePp)?`${q.freeCashFlowMarginChangePp.toFixed(1)} points`:'unavailable'}.`),
    ],sources:filingSources(snapshot!)}}
}
function valuationCheck(symbol:string,snapshot:BusinessHealthSnapshot|null|undefined,cap:ValuationCapitalization|null|undefined,sector:string|null|undefined,now:number):Check {
  const policy=sectorFinancialPolicy(sector)
  if(!policy||policy.specialist)return {status:'not-supported',gaps:[policy?.specialist??'Valuation review needs a known sector classification.']}
  const unavailable=snapshotCheck(snapshot,symbol,now)
  if(unavailable)return unavailable
  const end=snapshot!.annualPeriodEnd,age=end?(now-Date.parse(`${end}T00:00:00Z`)/1000)/DAY:Infinity
  if(!end||!Number.isFinite(age)||age<0||snapshot!.evidence.netIncome?.periodEnd!==end||snapshot!.evidence.freeCashFlow?.periodEnd!==end)return {status:'missing',gaps:['Valuation review needs profit and free cash flow from the same completed annual reporting period.']}
  if(age>450)return {status:'stale',gaps:['Annual financial results are older than 450 days; they cannot create a current valuation warning.']}
  const valuation=assessBusinessValuation(snapshot,cap,sector,now)
  if(valuation.status==='unknown'||valuation.pe==null||valuation.fcfYieldPct==null)return {status:'missing',gaps:valuation.diagnostics?.missing.length?valuation.diagnostics.missing:['Valuation review needs a current dated market value and matching positive annual profit and free cash flow.']}
  const peLimit=policy.maxAnnualPE*SELL_REVIEW_RULES.peCeilingMultiple,yieldLimit=policy.minAnnualFcfYield*SELL_REVIEW_RULES.fcfYieldFloorMultiple
  if(valuation.pe<=peLimit||valuation.fcfYieldPct>=yieldLimit)return {status:'checked',gaps:[]}
  const evidenceAt=Math.max(snapshot!.evidence.netIncome!.availableAt,snapshot!.evidence.freeCashFlow!.availableAt,cap!.observedAt)
  return {status:'checked',gaps:[],signal:{kind:'valuation',label:'Annual valuation looks stretched',summary:'The price is unusually high against both reported annual profit and free cash flow for this sector.',evidenceAt,financialAvailableAt:Math.max(snapshot!.evidence.netIncome!.availableAt,snapshot!.evidence.freeCashFlow!.availableAt),priceObservedAt:cap!.observedAt,periodEnd:end!,reasons:[
    `Annual P/E is ${valuation.pe.toFixed(1)}×, above the review threshold of ${peLimit.toFixed(0)}× (twice this sector’s research ceiling).`,
    `Annual free-cash-flow yield is ${valuation.fcfYieldPct.toFixed(1)}%, below the review threshold of ${yieldLimit.toFixed(2)}% (half this sector’s research floor).`,
    'Both conditions must hold. Annual figures are backward-looking; expected growth can justify a higher valuation. This does not estimate a fair price.',
  ],sources:filingSources(snapshot!)}}
}
/** No holdings, cost basis, portfolio target or tax data is inferred. Missing
 * evidence never creates a warning and a failed buy screen is not a sell rule. */
export function buildSellReview(input:SellReviewInput):SellReviewSnapshot {
  const spy=tape(input.spy,input.now,'SPY')
  const unique=[...new Map(input.rows.map(row=>[row.symbol.toUpperCase(),{...row,symbol:row.symbol.toUpperCase()}])).values()].sort((a,b)=>a.symbol.localeCompare(b.symbol))
  const rows:SellReviewRow[]=unique.map(row=>{
    const bars=tape(row.candles,input.now,row.symbol)
    const price=priceCheck(row.symbol,bars,spy,input.now),business=businessCheck(row.symbol,row.financial,row.sector,input.now),valuation=valuationCheck(row.symbol,row.financial,row.valuation,row.sector,input.now)
    const checks=[price,business,valuation],signals=checks.flatMap(check=>check.signal?[check.signal]:[]),gaps=[...new Set(checks.flatMap(check=>check.gaps))]
    return {symbol:row.symbol,name:row.name,sector:row.sector??null,status:signals.length?'review':gaps.length?'data-gap':'no-warning',asOf:bars.at(-1)?sessionClose(row.symbol,bars.at(-1)!.t):null,
      checks:{price:price.status,business:business.status,valuation:valuation.status},signals,gaps}
  })
  return {version:SELL_REVIEW_VERSION,generatedAt:input.now,rows,coverage:{scanned:rows.length,review:rows.filter(r=>r.status==='review').length,noWarning:rows.filter(r=>r.status==='no-warning').length,dataGap:rows.filter(r=>r.status==='data-gap').length,incomplete:rows.filter(r=>r.gaps.length>0).length},caveats:[
    'These are independent prompts to review a holding, not instructions to sell. They do not know what you own, your purchase price, goals, taxes or portfolio concentration.',
    'The rules have not been shown to improve exit timing or beat holding the stock. No probability, target sell price or automatic order is produced.',
    'Price weakness, reported business deterioration and expensive annual valuation are different warnings. Missing evidence does not count as a warning; no warning does not prove a stock is safe.',
  ]}
}
