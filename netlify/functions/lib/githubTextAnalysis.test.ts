import { describe, expect, it, vi } from 'vitest'
import { memoryStore } from './store'
import { githubTextAnalysis, GithubTextBudgetWait } from './githubTextAnalysis'
import type { LlmEnv } from './llm'
const nine = Date.UTC(2026, 9, 20, 9) / 1000
const env = { OPENAI_API_KEY: 'primary', OPENAI_BASE_URL: 'https://api.deepseek.com', OPENAI_MODEL: 'deepseek-flash', GROQ_API_KEY: 'fallback' }

describe('bounded GitHub text analysis', () => {
  it('uses the primary alone when it is healthy', async () => {
    const call = vi.fn(async () => ({ text: 'source-linked facts', provider: 'openai' }))
    await githubTextAnalysis('words', memoryStore(), env, call, nine)
    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0]).toEqual(['words', { strict: true, LLM_PROVIDER: 'openai', maxTokens: 4000, OPENAI_API_KEY: 'primary', OPENAI_BASE_URL: env.OPENAI_BASE_URL, OPENAI_MODEL: 'deepseek-flash' }])
  })
  it('does not spend shared fallback capacity before the morning paper', async () => {
    const call = vi.fn(async () => { throw new Error('primary unavailable') })
    await expect(githubTextAnalysis('words', memoryStore(), env, call, nine - 7200)).rejects.toMatchObject({ retryAfterSec: 3600 })
    expect(call).toHaveBeenCalledTimes(1)
  })
  it('permits only two bounded fallback section requests a day, with isolated keys', async () => {
    const store = memoryStore()
    const call = vi.fn(async (_prompt: string, options: LlmEnv) => {
      if (options.OPENAI_API_KEY) throw new Error('primary unavailable')
      expect(options).toMatchObject({ strict: true, maxTokens: 4000, GROQ_API_KEY: 'fallback' })
      expect(options.OPENAI_API_KEY).toBeUndefined()
      return { text: 'facts', provider: 'groq' }
    })
    await githubTextAnalysis('one', store, env, call, nine)
    await githubTextAnalysis('two', store, env, call, nine)
    await expect(githubTextAnalysis('three', store, env, call, nine)).rejects.toBeInstanceOf(GithubTextBudgetWait)
    expect(call.mock.calls.filter(([, options]) => options.GROQ_API_KEY)).toHaveLength(2)
  })
  it('counts failed fallback requests too, so an outage cannot create unlimited retries', async () => {
    const store = memoryStore(), call = vi.fn(async () => { throw new Error('unavailable') })
    await expect(githubTextAnalysis('one', store, env, call, nine)).rejects.toThrow('unavailable')
    await expect(githubTextAnalysis('two', store, env, call, nine)).rejects.toThrow('unavailable')
    await expect(githubTextAnalysis('three', store, env, call, nine)).rejects.toBeInstanceOf(GithubTextBudgetWait)
    expect(call).toHaveBeenCalledTimes(5)
  })
})
