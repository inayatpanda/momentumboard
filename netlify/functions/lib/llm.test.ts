import { describe, it, expect, vi } from 'vitest'
import { callLlm, DEFAULT_MODELS, modelFor, probeGroqModel } from './llm'

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

  it('surfaces the real HTTP cause instead of a generic *-empty', async () => {
    // groq 429 with only that provider configured — the thrown error must name
    // the status and code, not mask it as "groq-empty" (audit H-3).
    const err = JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'slow down' } })
    const fetchFn = vi.fn(async () => new Response(err, { status: 429 }))
    await expect(callLlm('hi', { GROQ_API_KEY: 'g' }, fetchFn as never)).rejects.toThrow(/groq HTTP 429/)
    await expect(callLlm('hi', { GROQ_API_KEY: 'g' }, fetchFn as never)).rejects.toThrow(/rate_limit_exceeded/)
  })

  it('an HTTP error still falls through to a healthy provider', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('groq')) return new Response(JSON.stringify({ error: { message: 'expired' } }), { status: 401 })
      return new Response(geminiOk)
    })
    const r = await callLlm('hi', { GROQ_API_KEY: 'g', GEMINI_API_KEY: 'x' }, fetchFn as never)
    expect(r.provider).toBe('gemini')
  })

  it('a non-JSON error body still yields a status-bearing error', async () => {
    const fetchFn = vi.fn(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }))
    await expect(callLlm('hi', { GROQ_API_KEY: 'g' }, fetchFn as never)).rejects.toThrow(/groq HTTP 502/)
  })

  // 2026-07-23: the compose fell to plan C (forced gemini), gemini failed, groq
  // then failed, and the Action died with a bare "groq-empty" — the gemini cause
  // was overwritten and lost. Whoever reads the alert needs EVERY cause.
  it('names every provider that failed, not just the last one', async () => {
    const quota = JSON.stringify({ error: { code: 'RESOURCE_EXHAUSTED', message: 'quota' } })
    const fetchFn = vi.fn(async (url: string) => (url.includes('groq') ? new Response('{}') : new Response(quota, { status: 429 })))
    const call = callLlm('hi', { GROQ_API_KEY: 'g', GEMINI_API_KEY: 'x', LLM_PROVIDER: 'gemini' }, fetchFn as never)
    await expect(call).rejects.toThrow(/gemini HTTP 429/)
    await expect(call).rejects.toThrow(/groq-empty/)
  })

  // A 2xx carrying no text is almost always a stop reason (length/safety), and
  // "groq-empty" alone never said which.
  it('a 2xx with no text names the finish reason', async () => {
    const truncated = JSON.stringify({ choices: [{ finish_reason: 'length', message: {} }] })
    const fetchFn = vi.fn(async () => new Response(truncated))
    await expect(callLlm('hi', { GROQ_API_KEY: 'g' }, fetchFn as never)).rejects.toThrow(/groq-empty \(length\)/)
  })

  it('a truncated gemini answer names MAX_TOKENS', async () => {
    const truncated = JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] })
    const fetchFn = vi.fn(async () => new Response(truncated))
    await expect(callLlm('hi', { GEMINI_API_KEY: 'x' }, fetchFn as never)).rejects.toThrow(/gemini-empty \(MAX_TOKENS\)/)
  })

  it('LLM_PROVIDER forces the primary', async () => {
    const fetchFn = vi.fn(async (url: string) => new Response(url.includes('generativelanguage') || url.includes('netlify') ? geminiOk : groqOk))
    const r = await callLlm('hi', { GROQ_API_KEY: 'g', GEMINI_API_KEY: 'x', LLM_PROVIDER: 'gemini' }, fetchFn as never)
    expect(r.provider).toBe('gemini')
  })

  it('throws when nothing is configured', async () => {
    await expect(callLlm('hi', { GROQ_API_KEY: undefined, GEMINI_API_KEY: undefined, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, vi.fn() as never)).rejects.toThrow()
  })

  it('sends the pinned model by default, and an env override when set', async () => {
    const bodies: string[] = []
    const fetchFn = vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(init.body)
      return new Response(groqOk)
    })
    await callLlm('hi', { GROQ_API_KEY: 'g' }, fetchFn as never)
    expect(JSON.parse(bodies[0]).model).toBe(DEFAULT_MODELS.groq)
    await callLlm('hi', { GROQ_API_KEY: 'g', GROQ_MODEL: 'meta-llama/llama-4-scout-17b-16e-instruct' }, fetchFn as never)
    expect(JSON.parse(bodies[1]).model).toBe('meta-llama/llama-4-scout-17b-16e-instruct')
  })
})

describe('modelFor', () => {
  it('defaults to the current pin, prefers explicit env', () => {
    expect(modelFor('groq', {})).toBe(DEFAULT_MODELS.groq)
    expect(modelFor('groq', { GROQ_MODEL: 'x-new' })).toBe('x-new')
    expect(modelFor('gemini', {})).toBe(DEFAULT_MODELS.gemini)
  })
})

describe('probeGroqModel — the watchdog signal', () => {
  it('no key → alive (nothing to guard)', async () => {
    const r = await probeGroqModel({}, vi.fn() as never)
    expect(r.status).toBe('alive')
  })
  it('HTTP 200 → alive', async () => {
    const r = await probeGroqModel({ GROQ_API_KEY: 'g' }, (async () => new Response(groqOk)) as never)
    expect(r.status).toBe('alive')
  })
  it('400 naming the model → retired (this is the alert)', async () => {
    const err = JSON.stringify({ error: { code: 'model_decommissioned', message: 'The model `llama-3.3-70b-versatile` has been decommissioned' } })
    const r = await probeGroqModel({ GROQ_API_KEY: 'g' }, (async () => new Response(err, { status: 400 })) as never)
    expect(r.status).toBe('retired')
  })
  it('429 rate-limit → transient, NOT an alert', async () => {
    const err = JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'slow down' } })
    const r = await probeGroqModel({ GROQ_API_KEY: 'g' }, (async () => new Response(err, { status: 429 })) as never)
    expect(r.status).toBe('transient')
  })
  it('a thrown fetch → transient', async () => {
    const r = await probeGroqModel({ GROQ_API_KEY: 'g' }, (async () => { throw new Error('net') }) as never)
    expect(r.status).toBe('transient')
  })
})
