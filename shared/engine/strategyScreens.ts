import type { Candle } from '../types'
import type { BusinessHealthAssessment, BusinessHealthSnapshot } from '../businessHealth'
import type { assessBusinessValuation } from '../businessValuation'
import { quarterlyTrend } from '../quarterlyFinancials'

/** One catalogue and one set of predicates for current screens and historical
 * replay. Changing these rules requires a new rules version and a new test. */
export const STRATEGY_SCREEN_VERSION = 'independent-screens-v1'
export type StrategyScreenKey = 'direction-core' | 'direction-gated' | 'pullback-price' | 'trend-price' | 'big-drop-price' | 'healthy-drop' | 'healthy-value-drop' | 'quality-trend' | 'quality-value' | 'quarterly-recovery' | 'sector-leader' | 'shock-rebound'
export interface StrategyDefinition { key:StrategyScreenKey;label:string;horizon:number;description:string;financial?:boolean }
export const STRATEGY_DEFINITIONS: readonly StrategyDefinition[] = [
    { key: 'direction-core', label: 'Three-session direction', horizon: 3, description: 'Existing analogue model, tested on price data. Historical earnings exclusions and daily board ranking cannot be reconstructed.' },
    { key: 'direction-gated', label: 'Direction with an evidence filter', horizon: 3, description: 'Same signals; each year is allowed only if the prior two years beat SPY and improved probability error over the stock’s normal drift.' },
    { key: 'pullback-price', label: 'Stabilising pullback', horizon: 63, description: 'Price-only control: 8–35% below the 63-session high, above a rising 20-session average. This does not test business health or valuation.' },
    { key: 'trend-price', label: 'Trend and relative strength', horizon: 20, description: 'Price-only control: above the 200-session average, 50-session average above 200, and a stronger 20-session return than SPY.' },
    { key: 'big-drop-price', label: 'Big drop · price only', horizon: 63, description: 'Control for the financial recovery tests: 20–60% below the 252-session highest close, above a rising 20-session average. Hold 63 sessions.' },
    { key: 'healthy-drop', label: 'Healthy business after a big drop', horizon: 63, financial: true, description: 'Same 20–60% drawdown and stabilisation as the big-drop control, plus the dated sector health screen: profit, cash flow, growth, dilution, leverage and liquidity. Hold 63 sessions.' },
    { key: 'healthy-value-drop', label: 'Healthy, good-value recovery', horizon: 63, financial: true, description: 'Healthy big-drop screen plus sector-specific ceilings on annual P/E and floors on annual free-cash-flow yield. Historical market cap uses dated shares and split-consistent prices. Hold 63 sessions; no historical news or catalyst filter.' },
    { key: 'quality-trend', label: 'Healthy business with momentum', horizon: 20, financial: true, description: 'Same trend and relative-strength rules as the price control, plus the dated sector health screen. Hold 20 sessions.' },
    { key: 'quality-value', label: 'Healthy business at a fair valuation', horizon: 63, financial: true, description: 'Dated sector health and annual valuation screens, with no drawdown or momentum requirement. Hold 63 sessions.' },
    { key: 'quarterly-recovery', label: 'Recovery with healthy quarterly trends', horizon: 63, financial: true, description: 'Same big-drop and stabilisation screen plus annual sector health, three comparable quarters, non-deteriorating quarterly trends, non-negative latest year-on-year revenue growth and positive trailing-four-quarter profit and free cash flow. No news filter.' },
    { key: 'sector-leader', label: 'Strength within a strong sector', horizon: 20, description: 'Stock above its 200-session average, beating its sector over 20 sessions, with the sector itself beating SPY. Next-open entry; fixed 20-session hold.' },
    { key: 'shock-rebound', label: 'Recovery after a sharp sell-off', horizon: 20, description: 'A fall of at least 7% in the preceding five sessions, followed by a 2% rise today, a close in the upper half of today’s range and volume at least 1.5 times its prior 20-session average. Price-and-volume test only; the cause is not assumed to be news.' },
  ]
export interface StrategyPriceSignals {
  pullback: boolean | null; trend: boolean | null; recovering: boolean | null
  sectorLeader: boolean | null; shockRebound: boolean | null
  drawdownPct: number | null; return20Pct: number | null; sectorReturn20Pct: number | null
}
const day = (t: number) => Math.floor(t / 86400)

/** Callers pass an as-of index, never future prices. Historical replay keeps
 * its original session treatment; the current scanner separately checks that
 * every required stock/benchmark date is present before applying these rules. */
export function strategyPriceSignals(bars: Candle[], i: number, spy: Candle[], si: number,
  sector: Candle[] = [], sci = -1): StrategyPriceSignals {
  const last = bars[i]
  if (!last || i < 0) return {pullback:null,trend:null,recovering:null,sectorLeader:null,shockRebound:null,drawdownPct:null,return20Pct:null,sectorReturn20Pct:null}
  const avg = (n: number, end = i) => bars.slice(end-n+1,end+1).reduce((s,c)=>s+c.c,0)/n
  const drop = i >= 62 ? (1-last.c/Math.max(...bars.slice(i-62,i+1).map(c=>c.h)))*100 : null
  const bigDrop = i >= 251 ? (1-last.c/Math.max(...bars.slice(i-251,i+1).map(c=>c.c)))*100 : null
  const alignedSpy = si >= 20 && !!spy[si] && day(spy[si].t) === day(last.t)
  const return20 = i >= 20 ? last.c/bars[i-20].c : null
  const sector20 = sci >= 20 && !!sector[sci] && i >= 20 && day(sector[sci].t) === day(last.t) && day(sector[sci-20].t) === day(bars[i-20].t)
    ? sector[sci].c/sector[sci-20].c : null
  const shock = i >= 20 && Array.from({length:5},(_,j)=>i-1-j).some(k=>bars[k].c/bars[k-1].c<=.93)
  const volumeBase = i >= 20 ? bars.slice(i-20,i).reduce((n,c)=>n+c.v,0)/20 : 0
  return {
    pullback: drop == null ? null : drop>=8 && drop<=35 && last.c>avg(20) && avg(20)>avg(20,i-5),
    trend: i<199 || !alignedSpy ? null : last.c>avg(200) && avg(50)>avg(200) && return20!>spy[si].c/spy[si-20].c,
    recovering: bigDrop==null ? null : bigDrop>=20 && bigDrop<=60 && last.c>avg(20) && avg(20)>avg(20,i-5),
    sectorLeader: i<199 || !alignedSpy || sector20==null ? null : last.c>avg(200) && return20!>sector20 && sector20>spy[si].c/spy[si-20].c,
    shockRebound: i<20 ? null : shock && last.c/bars[i-1].c>=1.02 && last.c>=(last.h+last.l)/2 && volumeBase>0 && last.v>=volumeBase*1.5,
    drawdownPct: bigDrop, return20Pct: return20==null?null:(return20-1)*100, sectorReturn20Pct:sector20==null?null:(sector20-1)*100,
  }
}

export function strategyPriceEligible(key: StrategyScreenKey, signals: StrategyPriceSignals, directionSetup: boolean | null): boolean | null {
  if (key==='direction-core' || key==='direction-gated') return directionSetup
  if (key==='pullback-price') return signals.pullback
  if (key==='sector-leader') return signals.sectorLeader
  if (key==='shock-rebound') return signals.shockRebound
  if (key==='trend-price' || key==='quality-trend') return signals.trend
  if (key==='quality-value') return true
  return signals.recovering
}
export interface StrategyFinancialState {
  health: BusinessHealthAssessment
  valuation: ReturnType<typeof assessBusinessValuation>
  snapshot?: BusinessHealthSnapshot | null
}
export function strategyFinancialDecision(key: StrategyScreenKey, financial: StrategyFinancialState, now: number): 'pass'|'missing'|'fail' {
  const definition = STRATEGY_DEFINITIONS.find(d=>d.key===key)!
  if (!('financial' in definition && definition.financial)) return 'pass'
  const needsValue = key==='healthy-value-drop' || key==='quality-value'
  const quarterly=financial.snapshot?.quarterly, last=quarterly?.quarters.at(-1), trailing=quarterly?.trailingYear
  const trend=quarterly?quarterlyTrend(quarterly.quarters,now):'insufficient'
  const quarterKnown=!!quarterly && trend!=='insufficient' && last!=null && last.availableAt<=now && trailing!=null && trailing.availableAt<=now &&
    trailing.values.netIncome!=null && trailing.values.freeCashFlow!=null && last.revenueGrowthPct!=null
  if ((key==='quarterly-recovery' && !quarterKnown) || financial.health.status==='unknown' || (needsValue && financial.valuation.status==='unknown')) return 'missing'
  const quarterOK=quarterKnown && trend!=='deteriorating' && trailing!.values.netIncome!>0 && trailing!.values.freeCashFlow!>0 && last!.revenueGrowthPct!>=0
  return financial.health.status==='healthy' && (!needsValue || financial.valuation.status==='supported') && (key!=='quarterly-recovery' || quarterOK) ? 'pass':'fail'
}
