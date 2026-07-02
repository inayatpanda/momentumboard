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
  GROQ_API_KEY?: string
}

export const callLlm: LlmCall = async (prompt, env) => {
  if (env.GEMINI_API_KEY) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    })
    const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
    const text = j.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) throw new Error('gemini-empty')
    return { text, provider: 'gemini' }
  }
  if (env.GROQ_API_KEY) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 500 }),
    })
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const text = j.choices?.[0]?.message?.content
    if (!text) throw new Error('groq-empty')
    return { text, provider: 'groq' }
  }
  throw new Error('unconfigured')
}

export async function routeAi(headers: Headers, env: Env, store: AppStore, llm: LlmCall = callLlm): Promise<Response> {
  if (!env.APP_TOKEN || headers.get('x-app-token') !== env.APP_TOKEN) return json(401, { ok: false, error: 'unauthorized' })
  if (!env.GEMINI_API_KEY && !env.GROQ_API_KEY) return json(200, { ok: true, data: { unconfigured: true } })

  const cached = await store.read<{ text: string; provider: string; at: number }>('ai-read')
  const nowSec = Math.floor(Date.now() / 1000)
  if (cached && nowSec - cached.at < CACHE_SEC) return json(200, { ok: true, data: cached })

  const cfg = await store.read<AppConfig>('config')
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
    const { text, provider } = await llm(prompt, env)
    const data = { text, provider, at: nowSec }
    await store.write('ai-read', data)
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
      GROQ_API_KEY: process.env.GROQ_API_KEY,
    },
    blobAppStore,
  )
