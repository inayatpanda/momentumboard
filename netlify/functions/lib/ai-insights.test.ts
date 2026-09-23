import { describe, it, expect, vi } from 'vitest'
import { routeAi } from '../ai-insights.mts'
import { memoryStore } from './store'

const auth = new Headers({ 'x-app-token': 'app' })

describe('ai-insights', () => {
  it('reports unconfigured without any LLM key', async () => {
    const res = await routeAi(auth, { APP_TOKEN: 'app' }, memoryStore())
    expect((await res.json()).data.unconfigured).toBe(true)
  })
  it('requires the app token', async () => {
    expect((await routeAi(new Headers(), { APP_TOKEN: 'app', GEMINI_API_KEY: 'g' }, memoryStore())).status).toBe(401)
  })
  it('reports empty without a watchlist', async () => {
    const res = await routeAi(auth, { APP_TOKEN: 'app', GEMINI_API_KEY: 'g' }, memoryStore())
    expect((await res.json()).data.empty).toBe(true)
  })
  it('calls the LLM once, then serves from cache', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline')) // market fetches fail fast; route degrades gracefully
    const store = memoryStore()
    await store.write('config', { watchlist: [{ symbol: 'ZZZTEST' }], rules: [], ytChannels: [], capital: 5000 })
    const llm = vi.fn(async (_prompt: string) => ({ text: 'calm tape, nothing actionable today', provider: 'gemini' }))
    const env = { APP_TOKEN: 'app', GEMINI_API_KEY: 'g', FINNHUB_API_KEY: 'f' }
    const first = await (await routeAi(auth, env, store, llm)).json()
    expect(first.data.text).toContain('nothing actionable')
    expect(llm.mock.calls[0][0]).toContain('ZZZTEST') // watchlist reached the prompt
    const second = await (await routeAi(auth, env, store, llm)).json()
    expect(second.data.text).toBe(first.data.text)
    expect(llm).toHaveBeenCalledTimes(1) // cached
    vi.restoreAllMocks()
  })
})

// THE AI READ DURING THE BYOK TRANSITION. /api/ai is one of the four routes
// the device key rides, so it has to honour the header — and keep reading the
// pre-device server copy behind it, or a licensee who has not migrated loses
// their morning read the day this ships.
describe('ai-insights — whose key answers', () => {
  const user = new Headers({ 'x-app-token': 'lic' })
  const DEVICE_KEY = 'gsk_deviceKEY0123456789abcdefghij'
  const STORED_KEY = 'gsk_storedKEY0123456789abcdefghij'

  const licensedStore = async () => {
    const store = memoryStore()
    await store.write('licences', [{ key: 'lic', label: 'reader', createdAt: 1 }])
    return store
  }

  /** `ns` for the licence key above — auth.ts hashes it, so ask auth itself. */
  const nsFor = async (store: Awaited<ReturnType<typeof licensedStore>>) => {
    const { authenticate } = await import('./auth')
    return (await authenticate(user, { APP_TOKEN: 'app' }, store))!.ns
  }

  const withWatchlist = async (store: Awaited<ReturnType<typeof licensedStore>>) => {
    const ns = await nsFor(store)
    await store.write(`${ns}config`, { watchlist: [{ symbol: 'ZZZTEST' }], rules: [], ytChannels: [], capital: 5000 })
    return ns
  }

  it('the device header wins, and the read carries no migration hint', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    const store = await licensedStore()
    const ns = await withWatchlist(store)
    await store.write(`${ns}llm`, { groqKey: STORED_KEY })
    const llm = vi.fn(async (_prompt: string, _env: { GROQ_API_KEY?: string; strict?: boolean }) => ({ text: 'a read', provider: 'groq' }))
    const headers = new Headers({ 'x-app-token': 'lic', 'x-groq-api-key': DEVICE_KEY })
    const body = await (await routeAi(headers, { APP_TOKEN: 'app' }, store, llm)).json()
    expect(body.data.text).toBe('a read')
    expect(llm.mock.calls[0][1].GROQ_API_KEY).toBe(DEVICE_KEY)
    expect(body.data.llmKeySource).toBeUndefined()
    vi.restoreAllMocks()
  })

  it('no header + a stored key: the old copy still answers, flagged for migration', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    const store = await licensedStore()
    const ns = await withWatchlist(store)
    await store.write(`${ns}llm`, { groqKey: STORED_KEY })
    const llm = vi.fn(async (_prompt: string, _env: { GROQ_API_KEY?: string; strict?: boolean }) => ({ text: 'a read', provider: 'groq' }))
    const body = await (await routeAi(user, { APP_TOKEN: 'app' }, store, llm)).json()
    expect(llm.mock.calls[0][1].GROQ_API_KEY).toBe(STORED_KEY)
    expect(llm.mock.calls[0][1].strict).toBe(true)
    expect(body.data.llmKeySource).toBe('server')
    vi.restoreAllMocks()
  })

  it('neither key: the licensee is told it is unconfigured, as before', async () => {
    const store = await licensedStore()
    await withWatchlist(store)
    const body = await (await routeAi(user, { APP_TOKEN: 'app' }, store)).json()
    expect(body.data).toEqual({ unconfigured: true, byok: true })
  })
})

