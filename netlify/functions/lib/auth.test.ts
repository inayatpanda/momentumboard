import { describe, it, expect } from 'vitest'
import { scopedToken,issueFreeDeviceToken,authenticate } from './auth'
import { memoryStore } from './store'

describe('scopedToken (audit H-1 cutover)', () => {
  it('prefers the dedicated token once it is set', () => {
    expect(scopedToken('scoped', 'shared')).toBe('scoped')
  })

  it('falls back to the shared token while the dedicated one is absent', () => {
    expect(scopedToken(undefined, 'shared')).toBe('shared')
  })

  // The 2026-07-24/25 outage: the daily-paper workflow passes
  // `REPORT_PUBLISH_TOKEN: ${{ secrets.REPORT_PUBLISH_TOKEN }}`, and GitHub
  // materialises a MISSING secret as an empty string. `??` only falls back on
  // null/undefined, so the composer published with an empty header and the
  // site 401'd every morning. Blank means "not cut over yet", same as absent.
  it('treats a blank dedicated token as NOT set', () => {
    expect(scopedToken('', 'shared')).toBe('shared')
    expect(scopedToken('   ', 'shared')).toBe('shared')
  })

  it('is undefined when nothing is set, so callers still reject', () => {
    expect(scopedToken('', undefined)).toBeUndefined()
    expect(scopedToken('', '')).toBeUndefined()
  })
})

describe('signed free device authentication',()=>{
  it('creates distinct permanent user identities, without a shared namespace or owner privileges',async()=>{
    const store=memoryStore(),env={APP_TOKEN:'server-secret'}
    const a=await issueFreeDeviceToken(env.APP_TOKEN),b=await issueFreeDeviceToken(env.APP_TOKEN)
    expect(a).not.toBe(b)
    const first=await authenticate(new Headers({'x-app-token':a}),env,store)
    const second=await authenticate(new Headers({'x-app-token':b}),env,store)
    expect(first).toMatchObject({level:'user',freeDevice:true})
    expect(first?.ns).toMatch(/^u:free:[a-f0-9]{48}:$/)
    expect(first?.ns).not.toBe(second?.ns)
    expect(first?.house).toBeUndefined()
    expect(await store.read('licences')).toBeNull()
    expect(await authenticate(new Headers({'x-app-token':a}),env,store)).toEqual(first)
  })
  it('rejects forged identities, malformed signatures, wrong signing keys and missing configuration',async()=>{
    const store=memoryStore(),token=await issueFreeDeviceToken('secret'),parts=token.split('.')
    for(const invalid of [token.slice(0,-1)+(token.endsWith('0')?'1':'0'),`ss_free_v1.${'0'.repeat(48)}.${parts[2]}`,'ss_free_v1.admin','ss_free_v1.'+'x'.repeat(500)]){
      expect(await authenticate(new Headers({'x-app-token':invalid}),{APP_TOKEN:'secret'},store)).toBeNull()
    }
    expect(await authenticate(new Headers({'x-app-token':token}),{APP_TOKEN:'another-secret'},store)).toBeNull()
    expect(await authenticate(new Headers({'x-app-token':token}),{},store)).toBeNull()
    expect(await authenticate(new Headers({'x-app-token':'secret'}),{APP_TOKEN:'secret'},store)).toEqual({level:'admin',ns:''})
  })
})
