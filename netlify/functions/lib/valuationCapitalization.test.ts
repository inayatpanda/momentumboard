import { afterEach, describe, expect, it, vi } from 'vitest'
import { cachedValuationCapitalization } from './marketCache'
import { getCached, setCached } from './cache'
vi.mock('./cache', () => ({ getCached: vi.fn(async () => null), setCached: vi.fn(async () => {}), getCachedMany: vi.fn() }))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })
describe('free dated valuation metadata', () => {
  it('records the observation time and validates ticker and currency before caching', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ticker: 'ADBE', currency: 'USD', marketCapitalization: 100_000 }) })))
    const value = await cachedValuationCapitalization('ADBE', 'test-only')
    expect(value).toMatchObject({ sym: 'ADBE', currency: 'USD', marketCapUsdM: 100_000, source: 'finnhub-profile' })
    expect(value!.observedAt).toBeGreaterThan(0)
    expect(setCached).toHaveBeenCalledWith('valuation-cap:v1:ADBE', value, 21600)
  })
  it('does not invent values on quota failure, foreign currency, missing authorization or symbol mismatch', async () => {
    const fetcher = vi.fn(async () => ({ ok: false, json: async () => ({}) }))
    vi.stubGlobal('fetch', fetcher)
    expect(await cachedValuationCapitalization('ADBE', '')).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
    expect(await cachedValuationCapitalization('ADBE', 'test-only')).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ticker: 'ADBE', currency: 'EUR', marketCapitalization: 100_000 }) })))
    expect(await cachedValuationCapitalization('ADBE', 'test-only')).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ticker: 'OTHER', currency: 'USD', marketCapitalization: 100_000 }) })))
    expect(await cachedValuationCapitalization('ADBE', 'test-only')).toBeNull()
    expect(setCached).not.toHaveBeenCalled()
    expect(getCached).toHaveBeenCalled()
  })
})
