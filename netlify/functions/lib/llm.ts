// Multi-provider LLM router. Priority: Groq (fastest) → Gemini → OpenAI →
// Anthropic; each activates simply by its key existing, and failures fall
// through to the next. LLM_PROVIDER env forces a specific primary.
// Note: YouTube video WATCHING stays Gemini-only (native video input).

export interface LlmEnv {
  strict?: boolean // true = use ONLY the keys in this object (never the server's own) — licensee isolation
  LLM_PROVIDER?: string
  GROQ_API_KEY?: string
  GEMINI_API_KEY?: string
  GOOGLE_GEMINI_BASE_URL?: string
  OPENAI_API_KEY?: string
  OPENAI_BASE_URL?: string
  ANTHROPIC_API_KEY?: string
  ANTHROPIC_BASE_URL?: string
}

export interface LlmResult {
  text: string
  provider: string
}

type Provider = { name: string; available: (e: LlmEnv) => boolean; call: (prompt: string, e: LlmEnv, fetchFn: typeof fetch) => Promise<string> }

const PROVIDERS: Provider[] = [
  {
    name: 'groq',
    available: e => !!e.GROQ_API_KEY,
    call: async (prompt, e, fetchFn) => {
      const res = await fetchFn('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${e.GROQ_API_KEY}` },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 700 }),
      })
      const j = (await res.json()) as { choices?: { message?: { content?: string } }[] }
      const text = j.choices?.[0]?.message?.content
      if (!text) throw new Error('groq-empty')
      return text
    },
  },
  {
    name: 'gemini',
    available: e => !!e.GEMINI_API_KEY,
    call: async (prompt, e, fetchFn) => {
      const base = e.GOOGLE_GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com'
      const res = await fetchFn(`${base}/v1beta/models/gemini-2.5-flash:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': e.GEMINI_API_KEY! },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
      })
      const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
      const text = j.candidates?.[0]?.content?.parts?.[0]?.text
      if (!text) throw new Error('gemini-empty')
      return text
    },
  },
  {
    name: 'openai',
    available: e => !!e.OPENAI_API_KEY,
    call: async (prompt, e, fetchFn) => {
      const base = e.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'
      const res = await fetchFn(`${base.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${e.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 700 }),
      })
      const j = (await res.json()) as { choices?: { message?: { content?: string } }[] }
      const text = j.choices?.[0]?.message?.content
      if (!text) throw new Error('openai-empty')
      return text
    },
  },
  {
    name: 'anthropic',
    available: e => !!e.ANTHROPIC_API_KEY,
    call: async (prompt, e, fetchFn) => {
      const base = e.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'
      const res = await fetchFn(`${base.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': e.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 700, messages: [{ role: 'user', content: prompt }] }),
      })
      const j = (await res.json()) as { content?: { text?: string }[] }
      const text = j.content?.[0]?.text
      if (!text) throw new Error('anthropic-empty')
      return text
    },
  },
]

export function anyProviderAvailable(env: Partial<LlmEnv> = {}): boolean {
  const e = { ...(process.env as LlmEnv), ...env }
  return PROVIDERS.some(p => p.available(e))
}

export async function callLlm(prompt: string, env: Partial<LlmEnv> = {}, fetchFn: typeof fetch = fetch): Promise<LlmResult> {
  const e = env.strict ? (env as LlmEnv) : { ...(process.env as LlmEnv), ...env }
  const forced = e.LLM_PROVIDER?.toLowerCase()
  const order = forced ? [...PROVIDERS.filter(p => p.name === forced), ...PROVIDERS.filter(p => p.name !== forced)] : PROVIDERS
  let lastErr: unknown = new Error('no-llm-provider-configured')
  for (const p of order) {
    if (!p.available(e)) continue
    try {
      return { text: await p.call(prompt, e, fetchFn), provider: p.name }
    } catch (err) {
      lastErr = err // fall through to the next provider
    }
  }
  throw lastErr
}
