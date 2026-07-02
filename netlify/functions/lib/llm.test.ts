import { describe, it, expect, vi } from 'vitest'
import { callLlm } from './llm'

const groqOk = JSON.stringify({ choices: [{ message: { content: 'groq says hi' } }] })
const geminiOk = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'gemini says hi' }] } }] })

describe('llm router', () => {
  it('prefers groq when its key exists', async () => {
    const fetchFn = vi.fn(async (url: string) => new Response(url.includes('groq') ? groqOk : geminiOk))
    const r = await callLlm('hi', { GROQ_API_KEY: 'g', GEMINI_API_KEY: 'x', LLM_PROVIDER: undefined }, fetchFn as never)
    expect(r.provider).toBe('groq')
    expect(r.text).toBe('groq says hi')
  })

  it('falls through to the next provider on failure', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('groq')) return new Response('{}') // empty → groq-empty error
      return new Response(geminiOk)
    })
    const r = await callLlm('hi', { GROQ_API_KEY: 'g', GEMINI_API_KEY: 'x' }, fetchFn as never)
    expect(r.provider).toBe('gemini')
  })

  it('LLM_PROVIDER forces the primary', async () => {
    const fetchFn = vi.fn(async (url: string) => new Response(url.includes('generativelanguage') || url.includes('netlify') ? geminiOk : groqOk))
    const r = await callLlm('hi', { GROQ_API_KEY: 'g', GEMINI_API_KEY: 'x', LLM_PROVIDER: 'gemini' }, fetchFn as never)
    expect(r.provider).toBe('gemini')
  })

  it('throws when nothing is configured', async () => {
    await expect(callLlm('hi', { GROQ_API_KEY: undefined, GEMINI_API_KEY: undefined, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, vi.fn() as never)).rejects.toThrow()
  })
})
