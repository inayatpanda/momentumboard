import type { BusinessHealthSnapshot } from '../../shared/businessHealth'
import { createHash } from 'node:crypto'
import type { StrategyChoicesSnapshot, StrategyChoiceInputRow } from '../../shared/engine/strategyChoices'
import { completedLabCandles } from '../../shared/engine/strategyLab'
import { loadUniverseSeed, type UniverseSeedRow } from '../../shared/engine/discovery/universeSeed'
import { SECTOR_MEMBERS } from '../../netlify/functions/lib/sectors'
import type { CompanyFacts } from '../../netlify/functions/lib/businessHealth'
import { buildFinancialPanel, historicalFinancialState, HISTORY_SECTORS, FINANCIAL_HISTORY_VERSION, type FinancialPanel } from './historicalFundamentals'
import { parseHistoryTape, type HistoryTape } from './longHistory'

const DAY = 86400
const sectorEtfs: Record<string, string> = {
  'Information Technology':'XLK', Technology:'XLK', Financials:'XLF', 'Financial Services':'XLF',
  Energy:'XLE', 'Health Care':'XLV', Healthcare:'XLV', Industrials:'XLI',
  'Consumer Discretionary':'XLY', 'Consumer Cyclical':'XLY', 'Consumer Staples':'XLP', 'Consumer Defensive':'XLP',
  Utilities:'XLU', Materials:'XLB', 'Basic Materials':'XLB', 'Communication Services':'XLC', 'Real Estate':'XLRE',
}
export interface StrategyUniverseEntry { symbol:string; name?:string; sector:string|null }
export const STRATEGY_UNIVERSE_LIMIT=250
export const STRATEGY_UNIVERSE_METHOD='balanced-us-250-v1'
const validSymbol=(symbol:string)=>/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol) && !symbol.endsWith('.L') && !symbol.endsWith('-USD')
const hash=(text:string)=>createHash('sha256').update(text).digest('hex')
export function strategyUniverseVersion(rows:StrategyUniverseEntry[]):string {
  return `${STRATEGY_UNIVERSE_METHOD}:${hash(JSON.stringify(rows.map(row=>[row.symbol,row.sector]).sort((a,b)=>a[0]!.localeCompare(b[0]!)))).slice(0,12)}`
}

/** Fixed historical panel and followed US names come first. Fill the remaining
 * slots across known sectors using stable company-seed ordering. This is a
 * bounded research pool, not an assertion of current index membership. */
export function strategyChoiceUniverse(watchlist:{symbol:string}[], seed:UniverseSeedRow[]=loadUniverseSeed()):StrategyUniverseEntry[] {
  const directory=new Map(seed.filter(row=>row.exchange==='US').map(row=>[row.sym,row]))
  const sectors=new Map<string,string>()
  for(const row of directory.values())if(row.sector && sectorEtfs[row.sector])sectors.set(row.sym,sectorEtfs[row.sector])
  for(const [sector,symbols] of Object.entries(SECTOR_MEMBERS))for(const symbol of symbols)sectors.set(symbol,sector)
  for(const [symbol,sector] of Object.entries(HISTORY_SECTORS))sectors.set(symbol,sector)
  const selected=new Set([...new Set([...Object.keys(HISTORY_SECTORS),...watchlist.map(row=>row.symbol.trim().toUpperCase()).filter(validSymbol)])].slice(0,STRATEGY_UNIVERSE_LIMIT))
  const bandRank={large:0,mid:1,small:2}
  const candidates=[...directory.values()].filter(row=>validSymbol(row.sym) && sectors.has(row.sym) && (!row.currency || row.currency==='USD') &&
    !/\b(ETF|ETN|ETP|Fund|Depositary|Depository|ADR|ADS|Units?|Warrants?|Acquisition)\b/i.test(row.name))
    .sort((a,b)=>bandRank[a.capBand]-bandRank[b.capBand] || hash(a.sym).localeCompare(hash(b.sym)) || a.sym.localeCompare(b.sym))
  const queues=new Map<string,UniverseSeedRow[]>()
  for(const row of candidates)if(!selected.has(row.sym)){
    const sector=sectors.get(row.sym)!
    queues.set(sector,[...(queues.get(sector)??[]),row])
  }
  const counts=new Map<string,number>()
  for(const symbol of selected){const sector=sectors.get(symbol);if(sector)counts.set(sector,(counts.get(sector)??0)+1)}
  while(selected.size<STRATEGY_UNIVERSE_LIMIT){
    const sector=[...queues.keys()].filter(key=>queues.get(key)!.length).sort((a,b)=>(counts.get(a)??0)-(counts.get(b)??0) || a.localeCompare(b))[0]
    if(!sector)break
    selected.add(queues.get(sector)!.shift()!.sym);counts.set(sector,(counts.get(sector)??0)+1)
  }
  return [...selected].sort().map(symbol=>({symbol,name:directory.get(symbol)?.name,sector:sectors.get(symbol)??null}))
}

export const STRATEGY_FINANCIAL_INPUT_VERSION='latest-sec-panel-v1'
export const strategyFinancialInputKey=(symbol:string)=>`strategy-financial-input:v1:${symbol}`
export interface StrategyFinancialInput {version:typeof STRATEGY_FINANCIAL_INPUT_VERSION;financialVersion:string;sym:string;fetchedAt:number;panel:FinancialPanel}
export function compactStrategyFinancialInput(body:CompanyFacts,sym:string,now:number):StrategyFinancialInput {
  return {version:STRATEGY_FINANCIAL_INPUT_VERSION,financialVersion:FINANCIAL_HISTORY_VERSION,sym,fetchedAt:now,panel:buildFinancialPanel(body,sym,now,'latest')}
}
export function cachedStrategyFinancialInput(value:StrategyFinancialInput|null|undefined,sym:string,now:number):StrategyFinancialInput|null {
  if(value?.version!==STRATEGY_FINANCIAL_INPUT_VERSION || value.financialVersion!==FINANCIAL_HISTORY_VERSION || value.sym!==sym ||
    !Number.isFinite(value.fetchedAt) || value.fetchedAt>now || now-value.fetchedAt>2*DAY || value.panel?.sym!==sym ||
    !Array.isArray(value.panel.points) || value.panel.points.length>1 || value.panel.points.some(point=>!Number.isFinite(point.availableAt) || point.availableAt>now || point.snapshot?.sym!==sym))return null
  return value
}
export function strategyFinancialNeedsRefresh(value:StrategyFinancialInput|null|undefined,sym:string,now:number):boolean {
  const cached=cachedStrategyFinancialInput(value,sym,now)
  return !cached || now-cached.fetchedAt>=18*3600
}

/** Raw SEC downloads are a private handoff between the two cloud steps. A stale
 * handoff may not masquerade as a fresh provider check. */
export function capturedStrategyFinancials(value:unknown,symbol:string,now:number):CompanyFacts|null {
  if(!value || typeof value!=='object')return null
  const record=value as {sym?:unknown;fetchedAt?:unknown;body?:CompanyFacts}
  if(record.sym!=null && record.sym!==symbol)return null
  if(typeof record.fetchedAt!=='number' || !Number.isFinite(record.fetchedAt) || record.fetchedAt>now || now-record.fetchedAt>2*DAY)return null
  return record.body?.facts && Number.isFinite(Number(record.body.cik)) && Number(record.body.cik)>0 ? record.body:null
}

/** Two public hosts, one retry, a finite timeout. No paid API or model call. */
export async function fetchStrategyTape(symbol:string,now:number,fetcher:typeof fetch=fetch,
  pause:(ms:number)=>Promise<void>=ms=>new Promise(resolve=>setTimeout(resolve,ms))):Promise<HistoryTape|null> {
  for(let attempt=0;attempt<2;attempt++){
    try {
      const url=`https://query${attempt+1}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${Math.floor(now-2*366*DAY)}&period2=${Math.floor(now)}&interval=1d&events=div%2Csplits&includeAdjustedClose=true`
      const response=await fetcher(url,{headers:{'User-Agent':'Mozilla/5.0 (StreetSignal research)'},signal:AbortSignal.timeout(15000)})
      if(!response.ok)throw new Error('public-price-unavailable')
      const body=await response.json()
      if(body?.chart?.result?.[0]?.meta?.currency!=='USD')throw new Error('unsupported-price-currency')
      const tape=parseHistoryTape(body,symbol,now,{includeCurrentDay:true})
      const completed=completedLabCandles(tape.candles,now,symbol)
      if(!completed.length || now-completed.at(-1)!.t>7*DAY)throw new Error('public-price-stale')
      return tape
    } catch { if(attempt===0)await pause(500) }
  }
  return null
}

export function strategyInputRow(entry:StrategyUniverseEntry,tape:HistoryTape|undefined,body:CompanyFacts|null,
  fallback:BusinessHealthSnapshot|null|undefined,now:number,cachedInput?:StrategyFinancialInput|null):StrategyChoiceInputRow {
  const candles=tape?.sym===entry.symbol?tape.candles:[]
  const last=completedLabCandles(candles,now,entry.symbol).at(-1)
  const saved=cachedStrategyFinancialInput(cachedInput,entry.symbol,now)
  if((body || saved) && last){
    const panel=body?buildFinancialPanel(body,entry.symbol,now,'latest'):saved!.panel
    const state=historicalFinancialState(panel,entry.symbol,now,last.c,tape?.splits)
    if(state.snapshot)return {...entry,candles,financial:state.snapshot,valuation:state.capitalization}
  }
  // Annual/quarterly health can still be checked with a saved dated report.
  // Never invent market cap from balance-sheet equity or untimed quote data.
  const financial=fallback?.sym===entry.symbol && fallback.asOf<=now ? fallback:null
  return {...entry,candles,financial,valuation:null}
}

/** A total price outage must preserve yesterday's snapshot. Partial outages
 * remain explicit missing rows; a zero-match result is still a valid scan. */
export function strategyPublicationSession(spy:HistoryTape|null|undefined,rows:StrategyChoiceInputRow[],now:number):number|null {
  if(spy?.sym!=='SPY')return null
  const benchmark=completedLabCandles(spy.candles,now,'SPY'),last=benchmark.at(-1)
  if(benchmark.length<252 || !last || now-last.t>7*DAY)return null
  const session=Math.floor(last.t/DAY)*DAY
  const usable=rows.some(row=>{
    const bar=completedLabCandles(row.candles,now,row.symbol).at(-1)
    return !!bar && Math.floor(bar.t/DAY)*DAY===session
  })
  return usable?session:null
}

export interface StrategyChoiceHistorySession {
  sessionAt:number; firstPublishedAt:number; rulesVersion:string; universeVersion?:string; scope:string; scanned:number
  strategies:{key:string;horizon:number;matches:{symbol:string;side:'long'|'short';status:'matches'|'blocked';price:number;asOf:number}[]}[]
}
export interface StrategyChoiceHistory { version:'strategy-choice-history-v1'; sessions:StrategyChoiceHistorySession[] }

/** Freeze the first published scan for each price session/rules version. Later
 * reruns cannot rewrite what was actually known then. These are ungraded
 * selections, never retroactively inserted into the forecast ledger. */
export function appendStrategyChoiceHistory(previous:StrategyChoiceHistory|null|undefined,snapshot:StrategyChoicesSnapshot,sessionAt:number):StrategyChoiceHistory {
  if(!Number.isFinite(sessionAt) || sessionAt<0 || sessionAt>snapshot.generatedAt)throw new Error('Invalid strategy publication session')
  const valid=previous?.version==='strategy-choice-history-v1' && Array.isArray(previous.sessions)?previous.sessions:[]
  const sessions=valid.filter(row=>Number.isFinite(row.sessionAt) && Number.isFinite(row.firstPublishedAt) && row.sessionAt<=row.firstPublishedAt && row.firstPublishedAt<=snapshot.generatedAt && Array.isArray(row.strategies))
  if(!sessions.some(row=>row.sessionAt===sessionAt && row.rulesVersion===snapshot.rulesVersion && row.universeVersion===snapshot.universeVersion))sessions.push({
    sessionAt,firstPublishedAt:snapshot.generatedAt,rulesVersion:snapshot.rulesVersion,universeVersion:snapshot.universeVersion,scope:snapshot.scope,scanned:snapshot.symbols.length,
    strategies:snapshot.strategies.map(group=>({key:group.key,horizon:group.horizon,matches:group.matches.map(row=>({symbol:row.symbol,side:row.side,status:row.status,price:row.lastPrice,asOf:row.asOf}))})),
  })
  const result:StrategyChoiceHistory={version:'strategy-choice-history-v1',sessions:sessions.sort((a,b)=>a.sessionAt-b.sessionAt || a.firstPublishedAt-b.firstPublishedAt).slice(-90)}
  // D1 values have a size ceiling. Busy screens may reach the byte budget
  // before 90 sessions, so discard the oldest full session, never truncate its
  // stock list or turn partial history into an apparent performance result.
  while(result.sessions.length>1 && new TextEncoder().encode(JSON.stringify(result)).length>800000)result.sessions.shift()
  return result
}
