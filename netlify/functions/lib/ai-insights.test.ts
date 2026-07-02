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
