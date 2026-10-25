import { describe,expect,it,vi } from 'vitest'
import { capturedStrategyFinancials,fetchStrategyTape,strategyChoiceUniverse,strategyInputRow,strategyPublicationSession,appendStrategyChoiceHistory,strategyUniverseVersion,compactStrategyFinancialInput,cachedStrategyFinancialInput,strategyFinancialNeedsRefresh } from './strategyChoiceInputs'
import { HISTORY_SECTORS } from './historicalFundamentals'
import type { HistoryTape } from './longHistory'
import { emptyBusinessHealth } from '../../shared/businessHealth'
import { buildStrategyChoices } from '../../shared/engine/strategyChoices'
import { loadUniverseSeed, type UniverseSeedRow } from '../../shared/engine/discovery/universeSeed'

const now=Date.parse('2026-10-25T13:00:00Z')/1000, DAY=86400
const tape=(sym:string,count=260):HistoryTape=>({sym,fetchedAt:now,splits:[],adjustment:Array(count).fill(1),candles:Array.from({length:count},(_,i)=>({t:now-(count-i+1)*DAY,o:100,h:102,l:99,c:101,v:1000}))})
const chart=(symbol:string,currency='USD')=>({chart:{result:[{meta:{symbol,currency},timestamp:[now-2*DAY,now-DAY],events:{splits:{}},indicators:{quote:[{open:[100,101],high:[102,103],low:[99,100],close:[101,102],volume:[1000,1200]}],adjclose:[{adjclose:[101,102]}]}}]}})
const raw={sym:'AAPL',fetchedAt:now,body:{cik:320193,facts:{'us-gaap':{}}}}

describe('free cloud strategy inputs',()=>{
  it('keeps the full predeclared sample, maps sectors explicitly and never publishes watchlist membership',()=>{
    const rows=strategyChoiceUniverse([{symbol:'TSLA'},{symbol:'VOD.L'},{symbol:'BTC-USD'},{symbol:'NOSECTOR'},{symbol:'bad/path'}])
    expect(Object.keys(HISTORY_SECTORS).every(symbol=>rows.some(row=>row.symbol===symbol))).toBe(true)
    expect(rows.find(row=>row.symbol==='AAPL')?.sector).toBe('XLK')
    expect(rows.find(row=>row.symbol==='TSLA')?.sector).toBe('XLY')
    expect(rows.find(row=>row.symbol==='NOSECTOR')?.sector).toBeNull()
    expect(rows.some(row=>['VOD.L','BTC-USD','BAD/PATH'].includes(row.symbol))).toBe(false)
    expect(JSON.stringify(rows)).not.toMatch(/watchlist|followed|selected/)
    expect(new Set(rows.map(row=>row.symbol)).size).toBe(rows.length)
    const bounded=strategyChoiceUniverse(Array.from({length:100},(_,i)=>({symbol:`ZZ${i}`})))
    expect(bounded).toHaveLength(250)
    expect(bounded.filter(row=>HISTORY_SECTORS[row.symbol])).toHaveLength(55)
    expect(bounded.filter(row=>row.symbol.startsWith('ZZ'))).toHaveLength(100)
  })
  it('adds a deterministic balanced 250-stock pool without changing the 55-stock historical sample',()=>{
    const seed=loadUniverseSeed(),pool=strategyChoiceUniverse([],seed)
    expect(pool).toHaveLength(250)
    expect(strategyChoiceUniverse([],[...seed].reverse())).toEqual(pool)
    const counts=Object.values(pool.reduce<Record<string,number>>((out,row)=>{out[row.sector!]=(out[row.sector!]??0)+1;return out},{}))
    expect(counts).toHaveLength(11)
    expect(Math.max(...counts)-Math.min(...counts)).toBeLessThanOrEqual(1)
    expect(Object.keys(HISTORY_SECTORS)).toHaveLength(55)
    expect(strategyUniverseVersion(pool)).toBe(strategyUniverseVersion([...pool].reverse()))
    expect(strategyUniverseVersion(pool.slice(1))).not.toBe(strategyUniverseVersion(pool))
  })
  it('does not automatically add unknown-sector, non-USD, fund or depositary listings',()=>{
    const seed:UniverseSeedRow[]=[
      {sym:'AUTO',name:'Example Company',exchange:'US',index:['sp400'],sector:'Technology',capBand:'mid',currency:'USD'},
      {sym:'FUNDS',name:'Example ETF Fund',exchange:'US',index:['sp400'],sector:'Technology',capBand:'mid',currency:'USD'},
      {sym:'ADRS',name:'Example American Depositary Shares',exchange:'US',index:['sp400'],sector:'Technology',capBand:'mid',currency:'USD'},
      {sym:'UNKN',name:'Unknown Company',exchange:'US',index:['sp400'],sector:null,capBand:'mid',currency:'USD'},
      {sym:'EURO',name:'Non USD Company',exchange:'US',index:['sp400'],sector:'Technology',capBand:'mid',currency:'EUR'},
    ]
    const symbols=strategyChoiceUniverse([],seed).map(row=>row.symbol)
    expect(symbols).toContain('AUTO')
    for(const symbol of ['FUNDS','ADRS','UNKN','EURO'])expect(symbols).not.toContain(symbol)
    expect(strategyChoiceUniverse([{symbol:'UNKN'},{symbol:'ADRS'}],seed).map(row=>row.symbol)).toEqual(expect.arrayContaining(['UNKN','ADRS']))
  })
  it('rejects wrong, expired, future and incomplete SEC handoffs',()=>{
    expect(capturedStrategyFinancials(raw,'AAPL',now)).toEqual(raw.body)
    for(const value of [null,{}, {...raw,sym:'MSFT'},{...raw,fetchedAt:now+1},{...raw,fetchedAt:now-2*DAY-1},{...raw,body:{facts:{}}}])expect(capturedStrategyFinancials(value,'AAPL',now)).toBeNull()
  })
  it('retries the second public host, and keeps its retry and time window bounded',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(new Response('',{status:429})).mockResolvedValueOnce(new Response(JSON.stringify(chart('AAPL')),{status:200}))
    const pause=vi.fn(async()=>{})
    const result=await fetchStrategyTape('AAPL',now,fetcher,pause)
    expect(result?.sym).toBe('AAPL');expect(result?.candles).toHaveLength(2)
    expect(fetcher).toHaveBeenCalledTimes(2);expect(pause).toHaveBeenCalledExactlyOnceWith(500)
    const first=new URL(fetcher.mock.calls[0][0]),second=new URL(fetcher.mock.calls[1][0])
    expect(first.hostname).toBe('query1.finance.yahoo.com');expect(second.hostname).toBe('query2.finance.yahoo.com')
    expect(Number(first.searchParams.get('period2'))-Number(first.searchParams.get('period1'))).toBe(2*366*DAY)
    expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })
  it('never accepts malformed, mismatched or permanently failing provider data',async()=>{
    const pause=vi.fn(async()=>{})
    const wrong=vi.fn(async()=>new Response(JSON.stringify(chart('MSFT'))))
    expect(await fetchStrategyTape('AAPL',now,wrong,pause)).toBeNull();expect(wrong).toHaveBeenCalledTimes(2)
    const broken=vi.fn(async()=>{throw new Error('network failed')})
    expect(await fetchStrategyTape('AAPL',now,broken,pause)).toBeNull();expect(broken).toHaveBeenCalledTimes(2)
    expect(await fetchStrategyTape('AAPL',now,async()=>new Response(JSON.stringify(chart('AAPL','EUR'))),pause)).toBeNull()
  })
  it('uses a saved dated report without inventing market cap and rejects wrong-symbol fallbacks',()=>{
    const report=emptyBusinessHealth('AAPL',now,'missing')
    const row=strategyInputRow({symbol:'AAPL',sector:'XLK'},tape('AAPL'),null,report,now)
    expect(row.financial).toBe(report);expect(row.valuation).toBeNull()
    expect(strategyInputRow({symbol:'MSFT',sector:'XLK'},tape('AAPL'),null,report,now)).toMatchObject({candles:[],financial:null,valuation:null})
  })
  it('reconstructs capitalization from disclosed shares and completed prices, never a future filing',()=>{
    const body={cik:1,facts:{'us-gaap':{CommonStockSharesOutstanding:{units:{shares:[
      {val:100,end:'2026-06-30',filed:'2026-08-15',form:'10-Q',accn:'known'},
      {val:9000,end:'2026-09-30',filed:'2026-10-30',form:'10-Q',accn:'future'},
    ]}}}}}
    const row=strategyInputRow({symbol:'AAPL',sector:'XLK'},tape('AAPL'),body,null,now)
    expect(row.valuation).toMatchObject({sym:'AAPL',marketCapUsdM:100*101/1e6,observedAt:now,currency:'USD'})
    expect(row.financial?.asOf).toBeLessThanOrEqual(now)
    const missingSplits={...tape('AAPL'),splits:undefined}
    expect(strategyInputRow({symbol:'AAPL',sector:'XLK'},missingSplits,body,null,now).valuation).toBeNull()
    const compact=compactStrategyFinancialInput(body,'AAPL',now)
    const next=now+9*3600, repriced={...tape('AAPL'),candles:tape('AAPL').candles.map(c=>({...c,o:200,h:202,l:199,c:201}))}
    expect(strategyInputRow({symbol:'AAPL',sector:'XLK'},repriced,null,null,next,compact).valuation).toMatchObject({marketCapUsdM:100*201/1e6,observedAt:next})
    expect(compact.fetchedAt).toBe(now)
    expect(strategyFinancialNeedsRefresh(compact,'AAPL',next)).toBe(false)
    expect(strategyFinancialNeedsRefresh(compact,'AAPL',now+18*3600)).toBe(true)
    expect(cachedStrategyFinancialInput(compact,'AAPL',now+48*3600+1)).toBeNull()
    expect(cachedStrategyFinancialInput(compact,'MSFT',now)).toBeNull()
    expect(cachedStrategyFinancialInput({...compact,fetchedAt:now+1},'AAPL',now)).toBeNull()
    expect(cachedStrategyFinancialInput({...compact,financialVersion:'unknown'},'AAPL',now)).toBeNull()
  })
  it('preserves the previous scan on missing, short, stale or misaligned market prices while allowing zero matches',()=>{
    const spy=tape('SPY'), rows=[{symbol:'AAPL',candles:tape('AAPL').candles}]
    expect(strategyPublicationSession(spy,rows,now)).toBe(Math.floor(spy.candles.at(-1)!.t/DAY)*DAY)
    expect(strategyPublicationSession(null,rows,now)).toBeNull()
    expect(strategyPublicationSession(tape('SPY',250),rows,now)).toBeNull()
    expect(strategyPublicationSession(spy,[{symbol:'AAPL',candles:[]}],now)).toBeNull()
    expect(strategyPublicationSession(spy,[{symbol:'AAPL',candles:rows[0].candles.slice(0,-1)}],now)).toBeNull()
    expect(strategyPublicationSession({...spy,candles:spy.candles.map(c=>({...c,t:c.t-8*DAY}))},rows,now)).toBeNull()
  })
})

describe('first-published independent strategy selections',()=>{
  const snapshot=()=>buildStrategyChoices({now,rows:[{symbol:'AAPL',sector:'XLK',candles:tape('AAPL').candles}],spy:tape('SPY').candles,sectors:{},scope:'US research universe'})
  it('freezes the initial scan for a price session even when reruns revise prices or matches',()=>{
    const first=snapshot(), sessionAt=Math.floor((now-2*DAY)/DAY)*DAY
    const saved=appendStrategyChoiceHistory(null,first,sessionAt)
    const revised={...first,generatedAt:now+100,scope:'changed',symbols:['MSFT']}
    expect(appendStrategyChoiceHistory(saved,revised,sessionAt)).toEqual(saved)
    expect(saved.sessions[0]).toMatchObject({firstPublishedAt:now,scope:'US research universe',scanned:1})
    expect(JSON.stringify(saved)).not.toMatch(/meanReturn|probability|score|outcome/)
  })
  it('records expanded universe selections separately without rewriting an old session',()=>{
    const first=snapshot(),sessionAt=Math.floor((now-2*DAY)/DAY)*DAY
    const legacy=appendStrategyChoiceHistory(null,first,sessionAt)
    const expanded={...first,generatedAt:now+1,universeVersion:'balanced-us-250-v1:new',symbols:['AAPL','MSFT']}
    const saved=appendStrategyChoiceHistory(legacy,expanded,sessionAt)
    expect(saved.sessions).toHaveLength(2)
    expect(saved.sessions[0]).toEqual(legacy.sessions[0])
    expect(saved.sessions[1]).toMatchObject({universeVersion:'balanced-us-250-v1:new',scanned:2,firstPublishedAt:now+1})
    expect(appendStrategyChoiceHistory(saved,{...expanded,generatedAt:now+2},sessionAt)).toEqual(saved)
  })
  it('retains at most 90 sessions and never creates backdated future records',()=>{
    const scan=snapshot()
    let saved=appendStrategyChoiceHistory(null,{...scan,generatedAt:now-100*DAY},Math.floor((now-101*DAY)/DAY)*DAY)
    for(let i=99;i>=0;i--)saved=appendStrategyChoiceHistory(saved,{...scan,generatedAt:now-i*DAY},Math.floor((now-(i+1)*DAY)/DAY)*DAY)
    expect(saved.sessions).toHaveLength(90)
    expect(saved.sessions[0].firstPublishedAt).toBe(now-89*DAY)
    expect(()=>appendStrategyChoiceHistory(saved,scan,now+1)).toThrow('Invalid strategy publication session')
  })
  it('drops whole oldest sessions when unusually large lists hit the storage budget',()=>{
    const scan=snapshot(), records=Array.from({length:1800},(_,i)=>({symbol:`STOCK${i}`,side:'long' as const,status:'matches' as const,price:101,asOf:now-DAY}))
    const previous={version:'strategy-choice-history-v1' as const,sessions:Array.from({length:15},(_,i)=>({sessionAt:now-(16-i)*DAY,firstPublishedAt:now-(15-i)*DAY,rulesVersion:scan.rulesVersion,scope:'US research universe',scanned:1800,strategies:[{key:'trend-price',horizon:20,matches:records}]}))}
    const result=appendStrategyChoiceHistory(previous,scan,Math.floor((now-DAY)/DAY)*DAY)
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(800000)
    expect(result.sessions.length).toBeLessThan(16)
    expect(result.sessions.slice(0,-1).every(session=>session.strategies[0].matches.length===1800)).toBe(true)
  })
})
