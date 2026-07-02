import type { Context } from '@netlify/functions'
import { blobAppStore, type AppStore } from './lib/store'
import { cachedQuote, cachedCandles } from './lib/marketCache'
import { fetchNews } from './lib/news'
import { detectSetups, regimeFromCandles } from '../../shared/setups'
import type { AppConfig } from '../../shared/config'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const CACHE_SEC = 1800

export type LlmCall = (prompt: string, env: Env) => Promise<{ text: string; provider: string }>

interface Env {
  APP_TOKEN?: string
  FINNHUB_API_KEY?: string
  GEMINI_API_KEY?: string
  GOOGLE_GEMINI_BASE_URL?: string // set by Netlify AI Gateway; keys are gateway-scoped
  GROQ_API_KEY?: string
}

// Shared LLM entry: the multi-provider router (Groq-first, then Gemini,
// OpenAI, Anthropic — each activated by its key, with fall-through on error).
export const callLlm: LlmCall = async (prompt, env) => {
  const { callLlm: route } = await import('./lib/llm')
  return route(prompt, env)
}

export async function routeAi(headers: Headers, env: Env, store: AppStore, llm: LlmCall = callLlm): Promise<Response> {
  const { authenticate } = await import('./lib/auth')
  const auth = await authenticate(headers, env, store)
  if (!auth) return json(401, { ok: false, error: 'unauthorized' })
  const ns = auth.ns

  // The owner's keys live in server env; licensees bring their own (strict: no fallback to ours)
  let llmEnv: Env & { strict?: boolean } = env
  if (auth.level !== 'admin') {
    const creds = await store.read<{ groqKey?: string }>(`${ns}llm`)
    if (!creds?.groqKey) return json(200, { ok: true, data: { unconfigured: true, byok: true } })
    llmEnv = { GROQ_API_KEY: creds.groqKey, strict: true }
  } else if (!env.GEMINI_API_KEY && !env.GROQ_API_KEY && !process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    return json(200, { ok: true, data: { unconfigured: true } })
  }

  const cached = await store.read<{ text: string; provider: string; at: number }>(`${ns}ai-read`)
  const nowSec = Math.floor(Date.now() / 1000)
  if (cached && nowSec - cached.at < CACHE_SEC) return json(200, { ok: true, data: cached })

  const cfg = await store.read<AppConfig>(`${ns}config`)
  if (!cfg?.watchlist?.length) return json(200, { ok: true, data: { empty: true } })

  const symbols = cfg.watchlist.map(w => w.symbol)
  const [tickerLines, spy, qqq, news] = await Promise.all([
    Promise.all(
      symbols.map(async sym => {
        const [q, candles] = await Promise.all([cachedQuote(sym, env.FINNHUB_API_KEY ?? ''), cachedCandles(sym)])
        const setups = candles && candles.length > 25 ? detectSetups(candles, null) : []
        return `${sym}: ${q ? `${q.price} (${q.changePct.toFixed(1)}% day)` : 'n/a'}${setups.length ? ` [${setups.join(', ')}]` : ''}`
      }),
    ),
    cachedCandles('SPY'),
    cachedCandles('QQQ'),
    fetchNews(symbols, env.FINNHUB_API_KEY ?? '', nowSec).catch(() => []),
  ])
  const regime = spy && qqq ? regimeFromCandles(spy, qqq) : 'unknown'

  const prompt = `You are a blunt, sceptical swing-trading analyst. Reader: UK retail, £${cfg.capital} capital, prefers confirmed reversals, 2-3 positions max.
Market regime: ${regime} (from SPY/QQQ vs 20/50-day structure).
Watchlist snapshot: ${tickerLines.join(' | ')}
Recent headlines: ${news.slice(0, 8).map(n => n.title).join(' • ') || 'none'}

In 150-200 words: what genuinely stands out today, which watchlist setups (if any) deserve attention and why, and what to avoid. If nothing is actionable, say "nothing actionable today" plainly. No hype, no predictions, no advice language.`

  try {
    const { text, provider } = await llm(prompt, llmEnv)
    const data = { text, provider, at: nowSec }
    await store.write(`${ns}ai-read`, data)
    return json(200, { ok: true, data })
  } catch (e) {
    return json(502, { ok: false, error: String(e) })
  }
}

export default async (req: Request, _context: Context) =>
  routeAi(
    req.headers,
    {
      APP_TOKEN: process.env.APP_TOKEN,
      FINNHUB_API_KEY: process.env.FINNHUB_API_KEY,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      GOOGLE_GEMINI_BASE_URL: process.env.GOOGLE_GEMINI_BASE_URL,
      GROQ_API_KEY: process.env.GROQ_API_KEY,
    },
    blobAppStore,
  )
