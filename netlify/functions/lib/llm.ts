// Multi-provider LLM router. Priority: Groq (fastest) → Gemini → OpenAI →
// Anthropic; each activates simply by its key existing, and failures fall
// through to the next. LLM_PROVIDER env forces a specific primary.
// Note: YouTube video WATCHING stays Gemini-only (native video input).
//
// Every model ID is env-overridable (GROQ_MODEL, GEMINI_MODEL, …) so a
// provider retiring or renaming a model — Groq decommissions Llama versions
// aggressively — is a one env-var change on Netlify + the Actions runners, no
// code deploy. Defaults below stay the current pins. modelFor() also falls
// back to process.env even in strict (BYOK) mode: a model NAME isn't a secret
// like a key, so the server's chosen model applies to licensees too, and
// bumping it in one place fixes everyone at once.

export interface LlmEnv {
  strict?: boolean // true = use ONLY the KEYS in this object (never the server's own) — licensee isolation
  maxTokens?: number // response budget; default 700
  LLM_PROVIDER?: string
  GROQ_API_KEY?: string
  GROQ_MODEL?: string
  GEMINI_API_KEY?: string
  GEMINI_MODEL?: string
  GOOGLE_GEMINI_BASE_URL?: string
  OPENAI_API_KEY?: string
  OPENAI_MODEL?: string
  OPENAI_BASE_URL?: string
  ANTHROPIC_API_KEY?: string
  ANTHROPIC_MODEL?: string
  ANTHROPIC_BASE_URL?: string
}

export interface LlmResult {
  text: string
  provider: string
}

// The current pins. Change here only for a new DEFAULT; to switch live, set
// the matching env var instead (no deploy).
export const DEFAULT_MODELS = {
  groq: 'llama-3.3-70b-versatile',
  gemini: 'gemini-2.5-flash',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5-20251001',
} as const

/** Resolve a provider's model: explicit env on the call → the server's own env
 * (model names aren't secrets, so this crosses the strict boundary on purpose)
 * → the default pin. */
export function modelFor(provider: keyof typeof DEFAULT_MODELS, e: LlmEnv): string {
  const key = `${provider.toUpperCase()}_MODEL` as const
  return (e as Record<string, string | undefined>)[key] || process.env[key] || DEFAULT_MODELS[provider]
}

type Provider = { name: string; available: (e: LlmEnv) => boolean; call: (prompt: string, e: LlmEnv, fetchFn: typeof fetch) => Promise<string> }

/** Turn a non-2xx provider response into an error that names the real cause —
 * status plus the provider's own error code/message — instead of the old
 * `${name}-empty` symptom that made a 429/expired-key/retired-model all look
 * identical. Bounded and secret-free (only status + error code/message, never
 * the request). Returns null on a 2xx so the caller proceeds to parse. */
async function httpErrorFor(name: string, res: Response): Promise<Error | null> {
  if (res.ok !== false) return null // 2xx (or a status-less mock) → let the caller parse the body
  let detail = ''
  try {
    const body = (await res.clone().json()) as { error?: { message?: string; code?: string; type?: string } | string }
    const err = body?.error
    detail = typeof err === 'string' ? err : [err?.code, err?.type, err?.message].filter(Boolean).join(': ')
  } catch {
    try { detail = (await res.clone().text()).slice(0, 200) } catch { /* body already consumed / unreadable */ }
  }
  return new Error(`${name} HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
}

const PROVIDERS: Provider[] = [
  {
    name: 'groq',
    available: e => !!e.GROQ_API_KEY,
    call: async (prompt, e, fetchFn) => {
      const res = await fetchFn('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${e.GROQ_API_KEY}` },
        body: JSON.stringify({ model: modelFor('groq', e), messages: [{ role: 'user', content: prompt }], max_tokens: e.maxTokens ?? 700 }),
      })
      const httpErr = await httpErrorFor('groq', res)
      if (httpErr) throw httpErr
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
      const res = await fetchFn(`${base}/v1beta/models/${modelFor('gemini', e)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': e.GEMINI_API_KEY! },
        // thinkingBudget 0: 2.5-flash otherwise spends the output budget on hidden reasoning and truncates long JSON
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: e.maxTokens ?? 2048, thinkingConfig: { thinkingBudget: 0 } } }),
      })
      const httpErr = await httpErrorFor('gemini', res)
      if (httpErr) throw httpErr
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
        body: JSON.stringify({ model: modelFor('openai', e), messages: [{ role: 'user', content: prompt }], max_tokens: e.maxTokens ?? 700 }),
      })
      const httpErr = await httpErrorFor('openai', res)
      if (httpErr) throw httpErr
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
        body: JSON.stringify({ model: modelFor('anthropic', e), max_tokens: e.maxTokens ?? 700, messages: [{ role: 'user', content: prompt }] }),
      })
      const httpErr = await httpErrorFor('anthropic', res)
      if (httpErr) throw httpErr
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

/** Cheap liveness probe for the Groq PRIMARY, for the watchdog's daily run.
 * Sends a 1-token request to whatever model the app will actually use and
 * classifies the result so the watchdog only cries wolf when it matters:
 *   - alive: the pinned model answered (HTTP 200).
 *   - retired: 400/404 whose error names the model — the case this whole
 *     future-proofing guards against (Groq decommissioned/renamed the ID).
 *     Fix = set GROQ_MODEL to the replacement; no deploy.
 *   - transient: 429 / 5xx / network — NOT flagged, so a momentary blip at
 *     07:15 doesn't page anyone.
 * No key → alive (nothing to guard; the router simply skips Groq). */
export async function probeGroqModel(
  e: LlmEnv = process.env as LlmEnv,
  fetchFn: typeof fetch = fetch,
): Promise<{ status: 'alive' | 'retired' | 'transient'; model: string; detail: string }> {
  const model = modelFor('groq', e)
  if (!e.GROQ_API_KEY) return { status: 'alive', model, detail: 'no groq key — provider skipped' }
  try {
    const res = await fetchFn('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${e.GROQ_API_KEY}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
    })
    if (res.ok) return { status: 'alive', model, detail: `${model} answered` }
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }
    const msg = `${body.error?.code ?? ''} ${body.error?.message ?? ''}`.toLowerCase()
    const modelGone = (res.status === 400 || res.status === 404) && /model|decommission|not.?found|does not exist/.test(msg)
    return modelGone
      ? { status: 'retired', model, detail: `${model} rejected (${res.status}): ${body.error?.code ?? body.error?.message ?? 'model error'}` }
      : { status: 'transient', model, detail: `${model} HTTP ${res.status} — treated as transient` }
  } catch (err) {
    return { status: 'transient', model, detail: `probe threw: ${err instanceof Error ? err.message : String(err)}` }
  }
}
