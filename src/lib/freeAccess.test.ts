import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {provisionFreeAccess} from './api'
import {deviceDatabaseName,freeDeviceId} from '../../shared/deviceAccess'

const token=`ss_free_v1.${'a'.repeat(48)}.${'b'.repeat(64)}`
beforeEach(()=>localStorage.clear())
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()})
describe('free device client',()=>{
  it('deduplicates concurrent enrollment and persists the one returned credential',async()=>{
    let finish!:(r:Response)=>void
    const fetcher=vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve}));vi.stubGlobal('fetch',fetcher)
    const a=provisionFreeAccess(),b=provisionFreeAccess();expect(a).toBe(b);expect(fetcher).toHaveBeenCalledTimes(1)
    finish(new Response(JSON.stringify({ok:true,data:{key:token}})))
    await a;expect(localStorage.getItem('mb-token')).toBe(token)
  })
  it('does not overwrite an explicit owner unlock while enrollment is pending',async()=>{
    let finish!:(r:Response)=>void
    vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve})))
    const request=provisionFreeAccess();localStorage.setItem('mb-token','owner-unlock')
    finish(new Response(JSON.stringify({ok:true,data:{key:token}})))
    expect(await request).toEqual({key:'owner-unlock'});expect(localStorage.getItem('mb-token')).toBe('owner-unlock')
  })
  it('times out a stalled enrollment instead of leaving the opening screen forever',async()=>{
    vi.useFakeTimers()
    vi.stubGlobal('fetch',vi.fn((_url,_init)=>new Promise<Response>((_resolve,reject)=>{_init.signal.addEventListener('abort',()=>reject(new Error('aborted')))})))
    const request=provisionFreeAccess(),check=expect(request).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(15000);await check;expect(localStorage.getItem('mb-token')).toBeNull()
  })
  it('uses separate local databases while preserving legacy admin and expired-trial data',()=>{
    const second=`ss_free_v1.${'c'.repeat(48)}.${'d'.repeat(64)}`
    expect(freeDeviceId(token)).toHaveLength(48)
    expect(deviceDatabaseName(token)).not.toBe(deviceDatabaseName(second))
    expect(deviceDatabaseName(token)).not.toBe(deviceDatabaseName('expired-trial'))
    expect(deviceDatabaseName('expired-trial')).toBe('momentumboard');expect(deviceDatabaseName('owner-token')).toBe('momentumboard')
    expect(freeDeviceId('ss_free_v1.fake')).toBeNull()
  })
})
