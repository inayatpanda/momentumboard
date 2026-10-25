import { beforeEach,describe,expect,it,vi } from 'vitest'
import { routeRequest } from '../market-data.mts'
import { authenticate,issueFreeDeviceToken } from './auth'

const state=vi.hoisted(()=>({stored:new Map<string,unknown>(),cached:new Map<string,unknown>(),llm:vi.fn()}))
vi.mock('./storeProvider',()=>({appStore:{read:async(key:string)=>state.stored.get(key)??null,readStrong:async(key:string)=>state.stored.get(key)??null,write:async(key:string,value:unknown)=>{state.stored.set(key,value)}}}))
vi.mock('./cache',()=>({getCached:async(key:string)=>state.cached.get(key)??null,setCached:async(key:string,value:unknown)=>{state.cached.set(key,value)},getCachedMany:async()=>new Map()}))
vi.mock('../ai-insights.mts',()=>({callLlm:state.llm}))
vi.mock('./videoTrends',()=>({computeConsensus:()=>({tickers:[]})}))
vi.mock('./social',async()=>{
  const actual=await vi.importActual<typeof import('./social')>('./social')
  return {...actual,fetchRedditTrends:async()=>['FUBO','SOFI','HOOD','SNAP'].map((ticker,i)=>({ticker,name:ticker,rank:i+1,mentions:100-i*10,mentions24hAgo:20,upvotes:100,rank24hAgo:i+3})),fetchStocktwitsTrending:async()=>['FUBO','SOFI','HOOD','SNAP']}
})
const env={APP_TOKEN:'private-owner-secret',FINNHUB_API_KEY:'fixture'}
const deps={yahoo:vi.fn(),finnhub:vi.fn()}
const call=(token:string)=>routeRequest(new URL('https://example.com/api/market-data?type=social'),new Headers({'x-app-token':token}),env,deps as never)
const rows=(body:any)=>[...body.data.discoveries,...body.data.pulse] as {sym:string;onWatchlist:boolean;opinion?:string}[]
let freeToken:string,freeNs:string

beforeEach(async()=>{
  state.stored.clear();state.cached.clear();state.llm.mockReset().mockResolvedValue({text:'{"opinions":[{"sym":"FUBO","take":"A cached shared opinion."}]}',provider:'fixture'})
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({marketCapitalization:500,name:'Example company'}))))
  freeToken=await issueFreeDeviceToken(env.APP_TOKEN)
  const store={read:async<T,>(key:string)=>(state.stored.get(key)??null) as T|null,write:async(key:string,value:unknown)=>{state.stored.set(key,value)}}
  freeNs=(await authenticate(new Headers({'x-app-token':freeToken}),env,store))!.ns
  state.stored.set('config',{watchlist:[{symbol:'FUBO'},{symbol:'SNAP'}]})
  state.stored.set(`${freeNs}config`,{watchlist:[{symbol:'SOFI'}]})
  state.stored.set('licences',[{key:'reader',label:'Reader',createdAt:1},{key:'house',label:'Owner device',createdAt:1,house:true}])
})

describe('social free access respects owner AI and personal watchlists',()=>{
  it.each(['free','reader'] as const)('serves fresh deterministic evidence to a %s caller without triggering owner-key AI',async kind=>{
    const response=await call(kind==='free'?freeToken:'reader'),body=await response.json()
    expect(response.status).toBe(200)
    expect(rows(body).length).toBeGreaterThan(0)
    expect(state.llm).not.toHaveBeenCalled()
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('vary')).toContain('x-app-token')
    const shared=state.cached.get('social-pulse:v3') as any
    expect([...shared.discoveries,...shared.pulse].every(row=>row.onWatchlist===false)).toBe(true)
    expect(rows(body).find(r=>r.sym==='FUBO')?.onWatchlist).toBe(false)
    expect(rows(body).find(r=>r.sym==='SNAP')?.onWatchlist).toBe(false)
    expect(rows(body).find(r=>r.sym==='SOFI')?.onWatchlist).toBe(kind==='free')
  })
  it.each(['admin','house'] as const)('retains authorized shared-opinion generation for %s',async kind=>{
    const response=await call(kind==='admin'?env.APP_TOKEN:'house')
    expect(response.status).toBe(200)
    expect(state.llm).toHaveBeenCalledTimes(1)
    const cached=state.cached.get('social-pulse:v3') as any
    expect([...cached.discoveries,...cached.pulse].every(row=>row.onWatchlist===false)).toBe(true)
    expect(rows(await response.json()).find(r=>r.sym==='FUBO')?.onWatchlist).toBe(kind==='admin')
  })
  it('overlays each caller on legacy cache hits without leaking owner flags or mutating shared evidence',async()=>{
    const cached={discoveries:[{sym:'FUBO',onWatchlist:true,opinion:'Already published opinion.'},{sym:'SOFI',onWatchlist:false}],pulse:[{sym:'SNAP',onWatchlist:true}],alsoLoud:[],at:1}
    state.cached.set('social-pulse:v3',cached)
    const free=rows(await(await call(freeToken)).json())
    expect(free.map(r=>[r.sym,r.onWatchlist])).toEqual([['FUBO',false],['SOFI',true],['SNAP',false]])
    expect(free[0].opinion).toBe('Already published opinion.')
    const admin=rows(await(await call(env.APP_TOKEN)).json())
    expect(admin.map(r=>[r.sym,r.onWatchlist])).toEqual([['FUBO',true],['SOFI',false],['SNAP',true]])
    expect(cached.discoveries[0].onWatchlist).toBe(true)
    expect(state.llm).not.toHaveBeenCalled()
  })
})
