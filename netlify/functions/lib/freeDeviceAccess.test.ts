import {describe,expect,it} from 'vitest'
import {routeLicences} from '../licences.mts'
import {routeConfig} from '../config-sync.mts'
import {routeBackup} from '../backup.mts'
import {authenticate,hash8,type Licence} from './auth'
import {memoryStore} from './store'

const env={APP_TOKEN:'private-owner-token'}
const headers=(ip='203.0.113.1')=>new Headers({'cf-connecting-ip':ip})
const create=(store:ReturnType<typeof memoryStore>,h=headers())=>routeLicences('POST',h,JSON.stringify({free:true}),env,store)

describe('automatic permanent free access',()=>{
  it('has no expiry and preserves distinct config namespaces and protected admin routes',async()=>{
    const store=memoryStore(),a=await(await create(store)).json(),b=await(await create(store)).json()
    expect(a.data).not.toHaveProperty('expiresAt')
    expect(a.data.key).not.toBe(b.data.key)
    const ah=new Headers({'x-app-token':a.data.key}),bh=new Headers({'x-app-token':b.data.key})
    const url=new URL('https://example.com/api/config')
    const cfg=(symbol:string)=>JSON.stringify({watchlist:[{symbol,riskClass:'normal'}],rules:[],ytChannels:[],capital:5000})
    await routeConfig(url,'PUT',new Headers({'x-app-token':env.APP_TOKEN}),cfg('ADMIN'),env,store)
    await routeConfig(url,'PUT',ah,cfg('AAPL'),env,store)
    const other=await(await routeConfig(url,'GET',bh,null,env,store)).json()
    expect(other.data?.watchlist??[]).toEqual([])
    expect((await routeLicences('GET',ah,null,env,store)).status).toBe(401)
    expect((await routeLicences('POST',ah,JSON.stringify({label:'promote'}),env,store)).status).toBe(401)
    expect((await authenticate(ah,env,store))?.house).toBeUndefined()
    expect(await store.read('licences')).toBeNull()
  })
  it('retains valid owner and existing reader credentials instead of replacing them',async()=>{
    const store=memoryStore()
    await store.write('licences',[{key:'old-reader',label:'friend',createdAt:1}] satisfies Licence[])
    for(const key of [env.APP_TOKEN,'old-reader']){
      const h=headers();h.set('x-app-token',key)
      expect((await(await create(store,h)).json()).data.key).toBe(key)
    }
    expect(await store.read('free-device-issues')).toBeNull()
  })
  it('keeps each free device backup separate from another device and the owner',async()=>{
    const store=memoryStore(),a=await(await create(store)).json(),b=await(await create(store)).json()
    const owner=new Headers({'x-app-token':env.APP_TOKEN}),ah=new Headers({'x-app-token':a.data.key}),bh=new Headers({'x-app-token':b.data.key})
    await routeBackup('PUT',owner,JSON.stringify({trades:[{id:'owner-trade'}],settings:[{key:'groqApiKey',value:'private-key'}]}),env,store)
    await routeBackup('PUT',ah,JSON.stringify({trades:[{id:'device-a-trade'}]}),env,store)
    expect((await(await routeBackup('GET',bh,null,env,store)).json()).data).toBeNull()
    const data=(await(await routeBackup('GET',ah,null,env,store)).json()).data
    expect(data.trades).toEqual([{id:'device-a-trade'}])
    expect(JSON.stringify(data)).not.toMatch(/owner-trade|private-key/)
  })
  it('hides owner rule/position alerts in every config view while retaining shared research',async()=>{
    const store=memoryStore(),created=await(await create(store)).json()
    const reader=new Headers({'x-app-token':created.data.key}),owner=new Headers({'x-app-token':env.APP_TOKEN})
    const date='2026-10-25',at=Date.parse(date+'T12:00:00Z')/1000
    await store.write('signal-log',[{symbol:'PRIVATE',level:99}])
    await store.write('alert-history',[{text:'Owner holding stop at 99',tier:'instant',at}])
    await store.write('runlog',[{error:'private-operation'}])
    await store.write('report-index',[date])
    await store.write('report-picks',[{date,picks:[{ticker:'AAPL',side:'long'}]}])
    const read=async(view:string,h=reader)=>(await(await routeConfig(new URL(`https://example.com/api/config?${view}`),'GET',h,null,env,store)).json()).data
    for(const view of ['signals','history','runlog']){
      expect(await read(`view=${view}`)).toEqual([])
      expect((await read(`view=${view}`,owner)).length).toBe(1)
    }
    const day=await read(`view=day&date=${date}`)
    expect(day.alerts).toEqual([]);expect(day.picks).toEqual([{ticker:'AAPL',side:'long'}]);expect(day.hasReport).toBe(true)
    expect((await read(`view=day&date=${date}`,owner)).alerts).toHaveLength(1)
    expect((await read(`view=month&month=2026-10`))[date]).toEqual({r:true,p:1})
    expect((await read(`view=month&month=2026-10`,owner))[date].a).toBe(1)
    await store.write('licences',[{key:'house',label:'owner-device',createdAt:1,house:true}])
    expect((await read('view=history',new Headers({'x-app-token':'house'}))).length).toBe(1)
  })
  it('gives expired legacy trials a separate empty identity without copying old or admin data',async()=>{
    const store=memoryStore(),old='expired-reader'
    await store.write('licences',[{key:old,label:'old',createdAt:1,expiresAt:2,trial:true}] satisfies Licence[])
    await store.write('config',{watchlist:[{symbol:'OWNER'}]})
    await store.write(`u:${await hash8(old)}:config`,{watchlist:[{symbol:'OLDTRIAL'}]})
    const h=headers();h.set('x-app-token',old)
    const issued=await(await create(store,h)).json()
    const auth=await authenticate(new Headers({'x-app-token':issued.data.key}),env,store)
    expect(auth?.ns).not.toBe(`u:${await hash8(old)}:`)
    expect(await store.read(`${auth?.ns}config`)).toBeNull()
    expect(await store.read(`u:${await hash8(old)}:config`)).toEqual({watchlist:[{symbol:'OLDTRIAL'}]})
  })
  it('limits issuance by platform IP and ignores spoofed forwarded addresses',async()=>{
    const store=memoryStore()
    for(let i=0;i<8;i++){const h=headers();h.set('x-forwarded-for',`10.0.0.${i}`);expect((await create(store,h)).status).toBe(200)}
    expect((await create(store)).status).toBe(429)
    expect((await create(store,headers('203.0.113.2'))).status).toBe(200)
    const records=await store.read<{ipHash:string;at:number}[]>('free-device-issues')
    expect(records).toHaveLength(9)
    expect(JSON.stringify(records)).not.toContain('203.0.113')
    expect(records![0].ipHash).toHaveLength(32)
  })
  it('enforces a global cap and declines requests while another issuer holds the lock',async()=>{
    const store=memoryStore(),now=Math.floor(Date.now()/1000)
    await store.write('free-device-issues',Array.from({length:250},(_,i)=>({ipHash:String(i),at:now})))
    expect((await create(store)).status).toBe(429)
    await store.write('free-device-issues',[])
    await store.write('lease:free-device-issuance',{token:'busy',expiresAt:now+20})
    expect((await create(store)).status).toBe(429)
  })
  it('records aggregate free-device access without a per-device or named licence activity entry',async()=>{
    const store=memoryStore(),issued=await(await create(store)).json()
    const check=await routeLicences('GET',new Headers({'x-app-token':issued.data.key}),null,env,store,true)
    expect(check.status).toBe(200)
    expect(check.headers.get('cache-control')).toContain('no-store')
    const stats=await store.read<{byDay:Record<string,{web:number}>;byLicence:Record<string,unknown>}>('access-stats')
    expect(Object.values(stats!.byDay)[0].web).toBe(1)
    expect(stats?.byLicence).toEqual({})
  })
})
