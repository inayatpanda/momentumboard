// Public daily prices plus already-downloaded SEC filings, all on GitHub.
// No paid API calls, LLM calls, local Mac process or production-board rewrite.
import { readFile } from 'node:fs/promises'
import { configureStoreForScript } from '../lib/configureStore'
import { appStore } from '../../netlify/functions/lib/storeProvider'
import { getCachedMany } from '../../netlify/functions/lib/cache'
import { businessHealthCacheKey } from '../../netlify/functions/lib/businessHealth'
import type { BusinessHealthSnapshot } from '../../shared/businessHealth'
import type { AppConfig } from '../../shared/config'
import type { HistoricalStudy } from '../../shared/engine/historyEvidence'
import { buildStrategyChoices } from '../../shared/engine/strategyChoices'
import type { HistoryTape } from '../lib/longHistory'
import { appendStrategyChoiceHistory,capturedStrategyFinancials,cachedStrategyFinancialInput,fetchStrategyTape,strategyChoiceUniverse,strategyInputRow,strategyPublicationSession,strategyUniverseVersion,strategyFinancialInputKey,type StrategyFinancialInput,type StrategyChoiceHistory } from '../lib/strategyChoiceInputs'

await configureStoreForScript()
const config=await appStore.read<AppConfig>('config')
const universe=strategyChoiceUniverse(config?.watchlist??[])
const startedAt=Math.floor(Date.now()/1000)
const deadline=startedAt+11*60
const spy=await fetchStrategyTape('SPY',startedAt)
if(!spy)throw new Error('Market prices unavailable; previous strategy scan preserved.')
const requested=[...new Set([...universe.map(row=>row.sector).filter((s):s is string=>!!s),...universe.map(row=>row.symbol)])].filter(sym=>sym!=='SPY')
const tapes=new Map<string,HistoryTape>([['SPY',spy]])
for(let i=0;i<requested.length;i+=4){
  if(Math.floor(Date.now()/1000)>=deadline)break
  const results=await Promise.allSettled(requested.slice(i,i+4).map(async symbol=>({symbol,tape:await fetchStrategyTape(symbol,Math.floor(Date.now()/1000))})))
  for(const result of results)if(result.status==='fulfilled' && result.value.tape)tapes.set(result.value.symbol,result.value.tape)
}
const [cached,study,history]=await Promise.all([
  getCachedMany<BusinessHealthSnapshot|StrategyFinancialInput>(universe.flatMap(row=>[businessHealthCacheKey(row.symbol),strategyFinancialInputKey(row.symbol)])),
  appStore.read<HistoricalStudy>('engine-historical-study'),
  appStore.read<StrategyChoiceHistory>('engine-strategy-choice-history'),
])
const captures=await Promise.all(universe.map(async row=>{
  try{return JSON.parse(await readFile(`.strategy-input/financial-${row.symbol}.json`,'utf8')) as unknown}catch{return null}
}))
// Freeze the scan clock after collection so valid new filings and prices are
// not rejected because their retrieval happened a few seconds into this run.
const now=Math.floor(Date.now()/1000)
let capturedFinancialN=0
let cachedFinancialN=0
const rows=universe.map((entry,i)=>{
  const body=capturedStrategyFinancials(captures[i],entry.symbol,now)
  if(body)capturedFinancialN++
  const compact=cachedStrategyFinancialInput(cached.get(strategyFinancialInputKey(entry.symbol)) as StrategyFinancialInput,entry.symbol,now)
  if(compact)cachedFinancialN++
  return strategyInputRow(entry,tapes.get(entry.symbol),body,cached.get(businessHealthCacheKey(entry.symbol)) as BusinessHealthSnapshot,now,compact)
})
const sessionAt=strategyPublicationSession(spy,rows,now)
if(sessionAt==null)throw new Error('No usable aligned stock and market prices; previous strategy scan preserved.')
const snapshot=buildStrategyChoices({now,rows,spy:spy.candles,
  sectors:Object.fromEntries([...new Set(universe.map(row=>row.sector).filter((s):s is string=>!!s))].map(sector=>[sector,tapes.get(sector)?.candles??[]])),
  historicalStudy:study,scope:'Balanced US research pool; historical test covers a separate fixed sample',universeVersion:strategyUniverseVersion(universe),unavailableSymbols:universe.filter(row=>!tapes.has(row.symbol)).map(row=>row.symbol),
})
const snapshotBytes=new TextEncoder().encode(JSON.stringify(snapshot)).length
if(snapshotBytes>900000)throw new Error(`Strategy scan exceeds safe storage budget (${snapshotBytes} bytes); previous strategy scan preserved.`)
const recorded=appendStrategyChoiceHistory(history,snapshot,sessionAt)
await appStore.write('engine-strategy-choices',snapshot)
await appStore.write('engine-strategy-choice-history',recorded)
console.log(JSON.stringify({scanned:rows.length,snapshotBytes,priceAvailable:rows.filter(row=>row.candles.length>0).length,financialCaptured:capturedFinancialN,financialCached:cachedFinancialN,
  strategies:snapshot.strategies.length,matched:snapshot.strategies.reduce((sum,s)=>sum+s.counts.matched,0),watchOnly:snapshot.strategies.reduce((sum,s)=>sum+s.counts.blocked,0),
  unavailable:snapshot.unavailableSymbols.length,savedSessions:recorded.sessions.length,paidCalls:0}))
