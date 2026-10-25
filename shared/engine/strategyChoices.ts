import type { Candle } from '../types'
import { exchangeFor } from '../symbols'
import { sessionUtcHours } from '../rvol'
import { assessBusinessHealth, type BusinessHealthSnapshot } from '../businessHealth'
import { assessBusinessValuation } from '../businessValuation'
import { sectorFinancialPolicy, type ValuationCapitalization } from '../sectorFinancials'
import { quarterlyTrend } from '../quarterlyFinancials'
import { completedLabCandles, shortHorizonObservations } from './strategyLab'
import { applyHistoryGate, HISTORY_VERSION, HISTORY_CORE_MODEL, type HistoricalStudy } from './historyEvidence'
import { STRATEGY_DEFINITIONS, STRATEGY_SCREEN_VERSION, strategyPriceSignals, strategyPriceEligible, strategyFinancialDecision, type StrategyScreenKey, type StrategyFinancialState } from './strategyScreens'
export type { StrategyScreenKey } from './strategyScreens'
export interface StrategyChoiceMatch {
  symbol:string; name?:string; sector:string|null; lastPrice:number; asOf:number
  backtestCovered?:boolean; side:'long'|'short'; status:'matches'|'blocked'; reasons:string[]; risks:string[]
}
export interface StrategyChoiceGroup {
  key:StrategyScreenKey; label:string; description:string; horizon:number; financial?:boolean
  status:'ready'|'no-matches'|'missing-data'
  counts:{evaluated:number;missing:number;noMatch:number;matched:number;blocked:number}
  matches:StrategyChoiceMatch[]; gaps:string[]
  diagnostics?:StrategyChoiceDiagnostics
}
export interface StrategyChoiceCandidate {
  symbol:string; name?:string; sector:string|null
  category:'missing-data'|'financial-rule'|'deteriorating'|'specialist'|'mixed'
  healthStatus:'healthy'|'unknown'|'deteriorating'
  reasons:string[]; missing:string[]; failed:string[]
}
/** Diagnostic financial counters can overlap when a candidate has both an
 * unmet rule and missing evidence. Specialist exclusions are separate. */
export interface StrategyChoiceDiagnostics {
  priceMatched:number; priceFailed:number; missingPrices:number
  failedFinancial:number; missingFinancial:number; specialist:number
  candidates:StrategyChoiceCandidate[]; candidatesTotal:number; candidatesTruncated:boolean
}
export interface StrategyChoicesSnapshot {
  version:'current-strategy-choices-v1'; rulesVersion:typeof STRATEGY_SCREEN_VERSION
  generatedAt:number; scope:string; symbols:string[]; unavailableSymbols:string[]
  strategies:StrategyChoiceGroup[]
  universeVersion?:string
}
export interface StrategyChoiceInputRow {
  symbol:string; name?:string; sector?:string|null; candles:Candle[]
  financial?:BusinessHealthSnapshot|null; valuation?:ValuationCapitalization|null; earningsRisk?:boolean
}
export interface StrategyChoicesInput {
  now:number; rows:StrategyChoiceInputRow[]; spy:Candle[]; sectors:Record<string,Candle[]>
  historicalStudy?:HistoricalStudy|null; scope?:string; unavailableSymbols?:string[]
  universeVersion?:string
}
const day=(t:number)=>Math.floor(t/86400)
const pct=(n:number|null)=>n==null?'unavailable':`${n>=0?'+':''}${n.toFixed(1)}%`
const sessionClose=(symbol:string,t:number)=>{
  const exchange=exchangeFor(symbol),midnight=day(t)*86400
  return midnight+(exchange==='CRYPTO'?24:sessionUtcHours(exchange,midnight).close)*3600
}
const REQUIRED_SESSIONS:Record<StrategyScreenKey,number>={
  'direction-core':250,'direction-gated':250,'pullback-price':63,'trend-price':200,
  'big-drop-price':252,'healthy-drop':252,'healthy-value-drop':252,'quality-trend':200,
  'quality-value':1,'quarterly-recovery':252,'sector-leader':200,'shock-rebound':21,
}
function alignedWindow(stock:Candle[],benchmark:Candle[],n:number):boolean {
  if(stock.length<n || benchmark.length<n)return false
  const a=stock.slice(-n),b=benchmark.slice(-n)
  return a.every((bar,i)=>day(bar.t)===day(b[i].t))
}
function validTape(raw:Candle[],now:number,symbol:string):Candle[] {
  // Reject malformed/duplicate history rather than silently compressing a gap
  // into a shorter apparent time window. Future/incomplete bars are excluded.
  const known=raw.filter(bar=>bar.t<=now)
  if(known.some((bar,i)=>i>0 && day(bar.t)<=day(known[i-1].t)))return []
  const completed=completedLabCandles(raw,now,symbol)
  if(completed.some((bar,i)=>i>0 && day(bar.t)<=day(completed[i-1].t)))return []
  return completed
}
function reasonsFor(key:StrategyScreenKey,signals:ReturnType<typeof strategyPriceSignals>):string[] {
  const recovery=`${signals.drawdownPct?.toFixed(1)??'Unknown'}% below the highest close in 252 completed sessions, with price above a rising 20-session average.`
  switch(key){
    case 'direction-core':return ['The three-session price model met its own setup rules. This unfiltered model remains a watch-only comparison.']
    case 'direction-gated':return ['The three-session price model met its setup rules and is checked separately against its prior historical evidence.']
    case 'pullback-price':return ['Price is 8–35% below its recent 63-session high and above a rising 20-session average.']
    case 'trend-price':case 'quality-trend':return [`Price is above its 200-session average, the 50-session average is higher, and the stock beat SPY over 20 sessions (${pct(signals.return20Pct)} stock return).`]
    case 'sector-leader':return [`The stock gained ${pct(signals.return20Pct)} over 20 sessions versus ${pct(signals.sectorReturn20Pct)} for its sector; the sector itself beat SPY. Price is above its 200-session average.`]
    case 'shock-rebound':return ['A fall of at least 7% occurred in the prior five sessions. The latest close rebounded at least 2%, finished in the upper half of its range and had at least 1.5 times normal volume.']
    case 'quality-value':return ['The company passes its sector business-health and annual valuation screens. No price-fall or momentum rule is required.']
    case 'healthy-drop':return [recovery,'The reported business passes its sector-specific health checks.']
    case 'healthy-value-drop':return [recovery,'Business health and annual valuation both pass their sector-specific screens.']
    case 'quarterly-recovery':return [recovery,'Three recent comparable quarters show no persistent broad deterioration; latest sales growth and trailing-year profit and free cash flow pass the quarterly rules.']
    default:return [recovery]
  }
}
/** Explain exclusions without changing the historical pass/fail predicate.
 * A conservative debt ceiling is a known rule failure, not absent data and
 * not proof that the business is deteriorating. Keep both facts when mixed. */
function explainFinancialExclusion(row:StrategyChoiceInputRow,key:StrategyScreenKey,state:StrategyFinancialState,now:number):StrategyChoiceCandidate {
  const base={symbol:row.symbol,name:row.name,sector:row.sector??null,healthStatus:state.health.status}
  const policy=sectorFinancialPolicy(row.sector)
  if(policy?.specialist)return {...base,category:'specialist',reasons:[policy.specialist],missing:[],failed:[]}
  const details=state.health.diagnostics
  const missing=[...(details?.missing??(state.health.status==='unknown'?state.health.gaps:[]))]
  const failed=[...(details?.limits??[]),...(details?.deterioration??(state.health.status==='deteriorating'?state.health.risks:[]))]
  let deteriorating=state.health.status==='deteriorating'
  if(!policy)missing.push('Sector classification is unavailable, so the sector-specific financial rules cannot be checked.')
  if(key==='healthy-value-drop'||key==='quality-value'){
    missing.push(...(state.valuation.diagnostics?.missing??(state.valuation.status==='unknown'?state.valuation.gaps:[])))
    failed.push(...(state.valuation.diagnostics?.failed??(state.valuation.status==='demanding'?[state.valuation.summary]:[])))
  }
  if(key==='quarterly-recovery'){
    const q=state.snapshot?.quarterly,last=q?.quarters.at(-1),trailing=q?.trailingYear
    const trend=q?quarterlyTrend(q.quarters,now):'insufficient'
    if(trend==='insufficient')missing.push('Three recent, consecutive and comparable quarters are needed to check the business trend.')
    if(trend==='deteriorating'){failed.push('Several recent quarters show worsening sales, profit margin or cash-flow margin.');deteriorating=true}
    if(!last||last.availableAt>now||last.revenueGrowthPct==null||!Number.isFinite(last.revenueGrowthPct))missing.push('The latest available quarter needs comparable year-on-year sales growth.')
    else if(last.revenueGrowthPct<0){failed.push(`Latest quarterly sales fell ${Math.abs(last.revenueGrowthPct).toFixed(1)}% from a year earlier; this rule requires non-negative growth.`);deteriorating=true}
    for(const [metric,label] of [['netIncome','profit'],['freeCashFlow','free cash flow']] as const){
      const value=trailing?.values[metric]
      if(!trailing||trailing.availableAt>now||value==null||!Number.isFinite(value))missing.push(`Comparable trailing-year ${label} is unavailable.`)
      else if(value<=0){failed.push(`Trailing-year ${label} is not positive, as this recovery rule requires.`);deteriorating=true}
    }
  }
  if(!missing.length&&!failed.length)missing.push('The financial evidence does not yet establish all of this strategy’s required checks.')
  const uniqueMissing=[...new Set(missing)],uniqueFailed=[...new Set(failed)]
  const category=uniqueMissing.length&&uniqueFailed.length?'mixed':uniqueMissing.length?'missing-data':deteriorating?'deteriorating':'financial-rule'
  return {...base,category,reasons:[...uniqueFailed,...uniqueMissing],missing:uniqueMissing,failed:uniqueFailed}
}
/** Independent research screens. The same stock may qualify for several rules;
 * that is preserved, never turned into an invented consensus score. No result
 * here sizes money, alters the production board or creates a trade forecast. */
export function buildStrategyChoices(input:StrategyChoicesInput):StrategyChoicesSnapshot {
  const {now}=input
  const history=input.historicalStudy
  const historyCurrent=history?.version===HISTORY_VERSION && history.coreModel===HISTORY_CORE_MODEL && history.generatedAt<=now && now-history.generatedAt<=45*86400 && history.dataThrough<=now && now-history.dataThrough<=14*86400
  const groups:StrategyChoiceGroup[]=STRATEGY_DEFINITIONS.map(d=>({...d,status:'no-matches',counts:{evaluated:0,missing:0,noMatch:0,matched:0,blocked:0},matches:[],gaps:[],diagnostics:{priceMatched:0,priceFailed:0,missingPrices:0,failedFinancial:0,missingFinancial:0,specialist:0,candidates:[],candidatesTotal:0,candidatesTruncated:false}}))
  const bySymbol=new Map<string,StrategyChoiceInputRow>(input.rows.map(row=>[row.symbol.toUpperCase(),{...row,symbol:row.symbol.toUpperCase()}]))
  for(const symbol of input.unavailableSymbols??[])if(!bySymbol.has(symbol.toUpperCase()))bySymbol.set(symbol.toUpperCase(),{symbol:symbol.toUpperCase(),candles:[]})
  const unique=[...bySymbol.values()].sort((a,b)=>a.symbol.localeCompare(b.symbol))
  const spy=validTape(input.spy,now,'SPY'), sectors=Object.fromEntries(Object.entries(input.sectors).map(([sym,bars])=>[sym,validTape(bars,now,sym)]))
  const unavailable=new Set((input.unavailableSymbols??[]).map(s=>s.toUpperCase()))
  for(const row of unique){
    const bars=validTape(row.candles,now,row.symbol),last=bars.at(-1),sector=row.sector?sectors[row.sector]??[]:[]
    const pricesFresh=!!last && now-last.t<=7*86400 && !!spy.at(-1) && now-spy.at(-1)!.t<=7*86400
    if(!pricesFresh)unavailable.add(row.symbol)
    const signals=strategyPriceSignals(bars,bars.length-1,spy,spy.length-1,sector,sector.length-1)
    // Retrieval can finish just after a fixed scan clock; publication dates on
    // each filing, not its retrieval timestamp, determine what was knowable.
    const financial=row.financial?.sym.toUpperCase()===row.symbol ? row.financial:null
    const state={snapshot:financial,health:assessBusinessHealth(financial,now,row.sector),valuation:assessBusinessValuation(financial,row.valuation,row.sector,now)}
    const direction=pricesFresh && bars.length>=250?shortHorizonObservations([{sym:row.symbol,candles:bars.slice(-250)}],now)[0]:undefined
    const gated=direction?applyHistoryGate(direction,input.historicalStudy,now):undefined
    for(const group of groups){
      const diagnostics=group.diagnostics!
      const n=REQUIRED_SESSIONS[group.key]
      const priceKnown=pricesFresh && alignedWindow(bars,spy,n) && (group.key!=='sector-leader'||alignedWindow(bars,sector,n))
      const directionKnown=group.key!=='direction-core'&&group.key!=='direction-gated'||!!direction
      const eligible=priceKnown&&directionKnown?strategyPriceEligible(group.key,signals,direction?.state==='setup'):null
      if(eligible==null){diagnostics.missingPrices++;group.counts.missing++;continue}
      if(!eligible){diagnostics.priceFailed++;group.counts.evaluated++;group.counts.noMatch++;continue}
      diagnostics.priceMatched++
      // The historical financial rules use a classified sector. An unknown
      // sector must not silently fall back to a different generic health rule.
      const financialDecision=group.financial&&!sectorFinancialPolicy(row.sector)?'missing':strategyFinancialDecision(group.key,state,now)
      if(group.financial&&financialDecision!=='pass'){
        const candidate=explainFinancialExclusion(row,group.key,state,now)
        diagnostics.candidatesTotal++
        if(diagnostics.candidates.length<40)diagnostics.candidates.push(candidate)
        else diagnostics.candidatesTruncated=true
        if(candidate.category==='specialist')diagnostics.specialist++
        if(candidate.missing.length)diagnostics.missingFinancial++
        if(candidate.failed.length)diagnostics.failedFinancial++
      }
      if(financialDecision==='missing'){group.counts.missing++;continue}
      group.counts.evaluated++
      if(financialDecision==='fail'){group.counts.noMatch++;continue}
      const gatedBlocked=group.key==='direction-gated'&&gated?.metrics.historyGate!=='passed'
      const blocked=group.key==='direction-core'||gatedBlocked||!!row.earningsRisk
      const backtestCovered=!!historyCurrent && !!history?.symbols.includes(row.symbol) && !history.missingSymbols.includes(row.symbol) && (!group.financial || (history.financialCoverage?.version==='sec-asof-quarterly-v2' && history.financialCoverage.symbols.includes(row.symbol)))
      const risks=['A rule match is a research idea, not a buy/sell recommendation or a tested live trade plan. Historical averages do not establish a reliable advantage.']
      if(!backtestCovered)risks.push('This stock is not covered by the supplied historical sample; the strategy results do not validate this individual choice.')
      if(group.key==='direction-core')risks.push('The unfiltered direction model is shown only for comparison and cannot bypass the historical safety check.')
      if(gatedBlocked)risks.push(gated?.risks.at(-1)??'Current comparable historical evidence is unavailable; kept on watch.')
      if(row.earningsRisk)risks.push('Earnings are close. This rule match remains on watch until the event risk is reviewed.')
      if(group.financial)risks.push('Company filings are backward-looking. New news can change the business after the reporting period.')
      else risks.push('This price screen does not establish financial health or inexpensive valuation.')
      if(group.key==='shock-rebound')risks.push('The screen observes price and volume. It does not identify or verify a news cause.')
      group.matches.push({symbol:row.symbol,name:row.name,sector:row.sector??null,lastPrice:last!.c,asOf:sessionClose(row.symbol,last!.t),backtestCovered,side:direction&&(group.key==='direction-core'||group.key==='direction-gated')&&direction.side==='short'?'short':'long',status:blocked?'blocked':'matches',reasons:reasonsFor(group.key,signals),risks})
      if(blocked)group.counts.blocked++;else group.counts.matched++
    }
  }
  for(const group of groups){
    group.status=group.counts.matched>0?'ready':group.counts.evaluated===0&&group.counts.missing>0?'missing-data':'no-matches'
    const diagnostics=group.diagnostics!
    if(diagnostics.missingPrices)group.gaps.push(`${diagnostics.missingPrices} scanned stocks lacked fresh, aligned prices for these rules.`)
    if(diagnostics.missingFinancial)group.gaps.push(`${diagnostics.missingFinancial} price-qualified stocks are missing required financial evidence.`)
    if(diagnostics.failedFinancial)group.gaps.push(`${diagnostics.failedFinancial} price-qualified stocks did not meet one or more financial rules. Known rule failures are separate from missing evidence; the counts can overlap.`)
    if(diagnostics.specialist)group.gaps.push(`${diagnostics.specialist} price-qualified stocks need specialist financial, utility or real-estate models. This is not a judgement that their businesses are unhealthy.`)
    if(group.counts.blocked)group.gaps.push(`${group.counts.blocked} rule matches remain on watch because a safety check did not pass.`)
    group.matches.sort((a,b)=>a.symbol.localeCompare(b.symbol))
  }
  return {version:'current-strategy-choices-v1',rulesVersion:STRATEGY_SCREEN_VERSION,generatedAt:now,scope:input.scope??'Current research sample and followed US stocks; not the whole market.',symbols:unique.map(r=>r.symbol),unavailableSymbols:[...unavailable].sort(),strategies:groups,...(input.universeVersion?{universeVersion:input.universeVersion}:{})}
}
