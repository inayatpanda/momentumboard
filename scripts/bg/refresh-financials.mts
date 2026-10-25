// Free SEC reports fetched on GitHub, where long public-data downloads are
// reliable, then shared with Cloudflare. No AI calls or paid data providers.
import { configureStoreForScript } from '../lib/configureStore'
import { appStore } from '../../netlify/functions/lib/storeProvider'
import { fetchBusinessHealth, businessHealthCacheKey } from '../../netlify/functions/lib/businessHealth'
import { getCachedMany, setCached } from '../../netlify/functions/lib/cache'
import { HISTORY_SECTORS } from '../lib/historicalFundamentals'
import { cachedStrategyFinancialInput,compactStrategyFinancialInput,strategyChoiceUniverse,strategyFinancialInputKey,strategyFinancialNeedsRefresh,type StrategyFinancialInput } from '../lib/strategyChoiceInputs'
import type { AppConfig } from '../../shared/config'
import type { BusinessHealthSnapshot } from '../../shared/businessHealth'
import type { CompanyFacts } from '../../netlify/functions/lib/businessHealth'

// Only one compact latest filing snapshot and dated share count are retained.
// The evening scan reuses the morning download; original provider timestamps
// remain unchanged. Large raw SEC bodies never become persistent app data.
const captured=new Map<string,{body:CompanyFacts;fetchedAt:number}>()
const fetchForScan = (sym: string) => async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const response = await fetch(input, init)
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (response.ok && url.startsWith('https://data.sec.gov/api/xbrl/companyfacts/')) {
    const body = await response.clone().json() as CompanyFacts
    const cik=Number(url.match(/CIK(\d+)\.json$/)?.[1])
    if(body?.facts && Number.isFinite(cik) && Number(body.cik)===cik)captured.set(sym,{body,fetchedAt:Math.floor(Date.now()/1000)})
  }
  return response
}

await configureStoreForScript()
const config = await appStore.read<AppConfig>('config')
const symbols = strategyChoiceUniverse(config?.watchlist??[]).map(row=>row.symbol)
const cached=await getCachedMany<StrategyFinancialInput|BusinessHealthSnapshot>(symbols.flatMap(sym=>[strategyFinancialInputKey(sym),businessHealthCacheKey(sym)]))
const startedAt=Math.floor(Date.now()/1000),deadline=startedAt+8*60
// Oldest inputs first prevents the end of a larger universe being starved by
// the time budget. Historical/followed names win ties on a cold first run.
const priority=new Set([...Object.keys(HISTORY_SECTORS),...(config?.watchlist??[]).map(row=>row.symbol.toUpperCase())])
const queue=[...symbols].sort((a,b)=>{
  const aAt=cachedStrategyFinancialInput(cached.get(strategyFinancialInputKey(a)) as StrategyFinancialInput,a,startedAt)?.fetchedAt??0
  const bAt=cachedStrategyFinancialInput(cached.get(strategyFinancialInputKey(b)) as StrategyFinancialInput,b,startedAt)?.fetchedAt??0
  return aAt-bAt || Number(priority.has(b))-Number(priority.has(a)) || a.localeCompare(b)
})
const result={requested:symbols.length,checked:0,published:0,reused:0,downloaded:0,unavailable:0,deferred:0,provider:'SEC company facts',paidCalls:0}
for(let i=0;i<queue.length;i++){
  if(Math.floor(Date.now()/1000)>=deadline){result.deferred=queue.length-i;break}
  const sym=queue[i],now=Math.floor(Date.now()/1000)
  const input=cachedStrategyFinancialInput(cached.get(strategyFinancialInputKey(sym)) as StrategyFinancialInput,sym,now)
  let report:BusinessHealthSnapshot|null=null
  if(!strategyFinancialNeedsRefresh(input,sym,now)){
    report=(cached.get(businessHealthCacheKey(sym)) as BusinessHealthSnapshot|undefined)??input?.panel.points.at(-1)?.snapshot??null
    result.reused++
  }else{
    report=await fetchBusinessHealth(sym,fetchForScan(sym))
    const raw=captured.get(sym)
    if(raw){
      const compact=compactStrategyFinancialInput(raw.body,sym,raw.fetchedAt)
      await setCached(strategyFinancialInputKey(sym),compact,48*3600)
      captured.delete(sym);result.downloaded++
    }
    await new Promise(resolve=>setTimeout(resolve,300))
  }
  result.checked++
  if(report?.sym===sym && report.status!=='unavailable' && report.quarterly?.quarters.length){await setCached(businessHealthCacheKey(sym),report,48*3600);result.published++}
  else result.unavailable++
}
console.log(JSON.stringify(result))
// A partial financial outage must not prevent the separate price screens from
// updating. Missing financial inputs stay missing; older good cache is retained.
