import type { Context } from '@netlify/functions'
import { fetchYahooChart } from './lib/yahoo'
import { fetchFinnhubQuote } from './lib/finnhub'
import { fetchSymbolNews } from './lib/news'
import { getCached, setCached } from './lib/cache'
import type { Quote } from '../../shared/types'
import { isYahooSymbol } from '../../shared/symbols'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** What the board actually says about a name, for the Ask-AI evidence block.
 * The distinction is the whole point: a sized call, an unsized observation and
 * a near miss the engine DECLINED are three different statements, and calling
 * all three "a live call" hands the model a falsehood to reason from. A near
 * miss is given no grade, no probability and no levels — it never earned them. */
export function boardEvidenceLine(
  date: string,
  row: { side: string; grade: string; probability: number; entry: number; stop: number; target: number; note: string; watchOnly?: boolean; nearMiss?: boolean } | undefined,
): string {
  if (!row) return 'Engine board: no live call on this name today.'
  if (row.nearMiss)
    return `Engine board (${date}): NEAR MISS — the engine scored this name and DECLINED it; nothing cleared the gates, so there is no call, no grade, no probability and no levels. It is named only so the board is not blank.`
  const kind = row.watchOnly ? 'watch-only observation (no size)' : 'live call'
  return `Engine board (${date}): ${kind}, ${row.side}, grade ${row.grade}, p=${Math.round(row.probability * 100)}%, entry ${row.entry} / stop ${row.stop} / target ${row.target} — ${row.note}.`
}

/** The states the v2 Ask sheet's hero can be in — `AskState` in
 * src/screens2/parts/AskSheet.tsx, kept as a literal set here because this is a
 * validator and a validator that imports its allowed values from the thing it is
 * validating is not one. */
const ASK_STATES = new Set(['sized', 'unsized', 'refused', 'published-elsewhere', 'near-miss', 'on-demand', 'no-read'])

/** Every string field is bounded HERE, not by the 2000-char envelope. */
const ASK_FIELD_MAX = 200

const askStr = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.slice(0, ASK_FIELD_MAX) : null)
const askNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** The validated shape — `AskContext` in AskSheet.tsx, rebuilt field by field. */
export interface AskContextSafe {
  sym: string
  state: string | null
  grade: string | null
  side: 'long' | 'short' | null
  core: number | null
  gateLabel: string | null
  openTrace: { status: string | null; verdict: string | null } | null
}

/** CX-20: decode the v2 Ask sheet's `context` param (the journey page's own
 * hero-state summary). Fail-soft — an absent or malformed param is simply "no
 * context", never a 400; a reader must not lose the whole answer because one
 * param round-tripped oddly.
 *
 * VALIDATED STRUCTURALLY, NOT MERELY MEASURED (D5). The old version parsed the
 * JSON and handed the WHOLE object to the prompt, where it is pinned as "ground
 * truth — do not contradict it". A query parameter is attacker-controlled by
 * definition: any key at all rode into that block, under that instruction, and
 * the 2000-char envelope was the only bound on it. So the object is now REBUILT
 * — known keys only, each one type-checked, every string clamped to 200 chars —
 * and it is the rebuilt object, never the parsed one, that reaches the model.
 * Anything else the caller sent is dropped without comment. */
export function parseAskContext(raw: string | null): AskContextSafe | null {
  if (!raw) return null
  if (raw.length > 2000) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const o = parsed as Record<string, unknown>
  // the symbol is the thing the whole block is ABOUT — a context without one
  // pins nothing, and is dropped rather than half-rendered
  const sym = askStr(o.sym)
  if (!sym) return null
  const ot = o.openTrace && typeof o.openTrace === 'object' && !Array.isArray(o.openTrace) ? (o.openTrace as Record<string, unknown>) : null
  return {
    sym,
    state: typeof o.state === 'string' && ASK_STATES.has(o.state) ? o.state : null,
    grade: askStr(o.grade),
    side: o.side === 'long' || o.side === 'short' ? o.side : null,
    core: askNum(o.core),
    gateLabel: askStr(o.gateLabel),
    openTrace: ot ? { status: askStr(ot.status), verdict: askStr(ot.verdict) } : null,
  }
}

/** The server-side ask backstop (T18). Generous by design — the client's own
 * 20/day is the product's limit and this is the runaway one. */
export const ASK_SERVER_DAILY_CAP = 100

/** 48h, so a key outlives its own day comfortably and still collects itself. */
const ASK_COUNT_TTL_SEC = 172_800

/** Who is asking, in a form that is safe as a cache key: the licensee's own
 * namespace hash (`u:<hash8>:`), or 'admin' for the APP_TOKEN master. Never the
 * token itself — this string is stored. */
export const askCounterId = (auth: { level: string; ns: string }): string => auth.ns.replace(/^u:/, '').replace(/:$/, '') || auth.level

export const askCountKey = (auth: { level: string; ns: string }, day = new Date().toISOString().slice(0, 10)): string =>
  `ask-count:${askCounterId(auth)}:${day}`

/** Counts this ask, and returns a 429 Response when the caller is over the day's
 * cap (null means "carry on"). Counted BEFORE the work: the point is to stop a
 * runaway from spending, and a loop that fails late spends just the same. */
async function bumpAskCount(auth: { level: string; ns: string }): Promise<Response | null> {
  const key = askCountKey(auth)
  const used = (await getCached<number>(key)) ?? 0
  if (used >= ASK_SERVER_DAILY_CAP)
    return json(429, {
      ok: false,
      error: 'ask-cap',
      message: 'The desk has answered all it can today — it will be back tomorrow.',
    })
  await setCached(key, used + 1, ASK_COUNT_TTL_SEC)
  return null
}

export async function routeRequest(
  url: URL,
  headers: Headers,
  env: { APP_TOKEN?: string; FINNHUB_API_KEY?: string; QUIVER_API_KEY?: string; FMP_API_KEY?: string },
  deps: { yahoo: typeof fetchYahooChart; finnhub: typeof fetchFinnhubQuote; news?: typeof fetchSymbolNews },
): Promise<Response> {
  const { authenticate } = await import('./lib/auth')
  const { appStore: blobAppStore } = await import('./lib/storeProvider')
  const auth = await authenticate(headers, env, blobAppStore)
  if (!auth) return json(401, { ok: false, error: 'unauthorized' })
  const type = url.searchParams.get('type')

  // Admin AI calls use the server's keys; licensees use their own stored key or none.
  const llmEnvForCaller = async (): Promise<{ [k: string]: unknown } | null> => {
    // house licences are the owner's own devices — they ride the server's keys
    // like the admin token does. Ordinary licensees still bring their own key
    // (Helm: /house <label> flips a licence either way).
    if (auth.level === 'admin' || auth.house)
      return { GEMINI_API_KEY: process.env.GEMINI_API_KEY, GOOGLE_GEMINI_BASE_URL: process.env.GOOGLE_GEMINI_BASE_URL, GROQ_API_KEY: process.env.GROQ_API_KEY }
    const creds = await blobAppStore.read<{ groqKey?: string }>(`${auth.ns}llm`)
    return creds?.groqKey ? { GROQ_API_KEY: creds.groqKey, strict: true } : null
  }

  if (type === 'movers') {
    // market-wide movers for the Movers tab: gainers, losers, most active.
    // Same Yahoo predefined screeners the engine's roster hunts with; 10-min
    // cache keeps every licensee off Yahoo's rate limits.
    const hit = await getCached<unknown>('movers')
    if (hit) return json(200, { ok: true, data: hit })
    const { fetchScreen } = await import('./lib/screener')
    const [gainersAll, losersAll, activesAll] = await Promise.all([fetchScreen('day_gainers'), fetchScreen('day_losers'), fetchScreen('most_actives')])
    const [gainers, losers, actives] = [gainersAll.slice(0, 12), losersAll.slice(0, 12), activesAll.slice(0, 12)]
    // the engine's stage read per name — a big loser that's a falling knife and
    // one basing for a turn are different trades. Candle cache is shared with
    // the engine, per-symbol fail-soft, and the whole payload caches 10 min.
    const { cachedCandles } = await import('./lib/marketCache')
    const { technicalStage } = await import('../../shared/technicals')
    const uniq = [...new Set([...gainers, ...losers, ...actives].map(r => r.sym))]
    const stages = new Map<string, string | null>()
    for (let i = 0; i < uniq.length; i += 8) {
      await Promise.all(
        uniq.slice(i, i + 8).map(async sym => {
          try {
            const c = await cachedCandles(sym)
            stages.set(sym, c && c.length >= 30 ? (technicalStage(sym, c)?.stage ?? null) : null)
          } catch {
            stages.set(sym, null)
          }
        }),
      )
    }
    const withStage = (rows: typeof gainers) => rows.map(r => ({ ...r, stage: stages.get(r.sym) ?? null }))
    const data = { gainers: withStage(gainers), losers: withStage(losers), actives: withStage(actives), at: Math.floor(Date.now() / 1000) }
    if (gainers.length || losers.length || actives.length) await setCached('movers', data, 600)
    return json(200, { ok: true, data })
  }

  if (type === 'quote') {
    const symbols = (url.searchParams.get('symbols') ?? '').split(',').filter(Boolean).slice(0, 30)
    const quotes = await Promise.all(
      symbols.map(async (sym): Promise<Quote | null> => {
        const key = `quote:${sym}`
        const hit = await getCached<Quote>(key)
        if (hit) return hit
        try {
          const quote = isYahooSymbol(sym) ? (await deps.yahoo(sym, '3mo')).quote : await deps.finnhub(sym, env.FINNHUB_API_KEY ?? '')
          await setCached(key, quote, 60)
          return quote
        } catch {
          return null
        }
      }),
    )
    return json(200, { ok: true, data: { quotes } })
  }

  if (type === 'candles') {
    const symbol = url.searchParams.get('symbol')
    const range = (url.searchParams.get('range') ?? '1y') as '3mo' | '6mo' | '1y'
    if (!symbol) return json(400, { ok: false, error: 'missing-symbol' })
    const key = `candles:${symbol}:${range}`
    const hit = await getCached<unknown>(key)
    if (hit) return json(200, { ok: true, data: hit })
    try {
      const data = await deps.yahoo(symbol, range)
      await setCached(key, data, 900)
      return json(200, { ok: true, data })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  if (type === 'calendar') {
    const symbols = (url.searchParams.get('symbols') ?? '').split(',').filter(Boolean).slice(0, 30)
    if (!symbols.length) return json(200, { ok: true, data: { earnings: [] } })
    const key = `calendar:${symbols.slice().sort().join(',')}`
    const hit = await getCached<unknown>(key)
    if (hit) return json(200, { ok: true, data: hit })
    try {
      const now = new Date()
      const to = new Date(now.getTime() + 14 * 86_400_000)
      const iso = (d: Date) => d.toISOString().slice(0, 10)
      const res = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${iso(now)}&to=${iso(to)}&token=${env.FINNHUB_API_KEY}`)
      const j = (await res.json()) as { earningsCalendar?: { symbol: string; date: string; hour: string; epsEstimate: number | null }[] }
      const wanted = new Set(symbols.map(s => s.split('.')[0].split('-')[0]))
      const earnings = (j.earningsCalendar ?? []).filter(e => wanted.has(e.symbol)).map(e => ({ symbol: e.symbol, date: e.date, hour: e.hour, epsEstimate: e.epsEstimate }))
      const data = { earnings }
      await setCached(key, data, 21_600)
      return json(200, { ok: true, data })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  if (type === 'feed') {
    const hit = await getCached<unknown>('digest-feed')
    if (hit) return json(200, { ok: true, data: hit })
    try {
      const { appStore: blobAppStore } = await import('./lib/storeProvider')
      const { fetchNews } = await import('./lib/news')
      const { fetchVideos } = await import('./lib/youtube')
      const cfg = await blobAppStore.read<{ watchlist: { symbol: string }[]; ytChannels: { id: string; name: string }[] }>('config')
      const nowSec = Math.floor(Date.now() / 1000)
      const [news, videos] = await Promise.all([
        fetchNews((cfg?.watchlist ?? []).map(w => w.symbol), env.FINNHUB_API_KEY ?? '', nowSec),
        fetchVideos((await import('../../shared/channels')).withDefaults(cfg?.ytChannels), nowSec),
      ])
      const data = { news: news.slice(0, 20), videos: videos.slice(0, 12) }
      await setCached('digest-feed', data, 600)
      return json(200, { ok: true, data })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  if (type === 'resolve-channel') {
    const handle = (url.searchParams.get('handle') ?? '').replace(/^@/, '')
    if (!handle) return json(400, { ok: false, error: 'missing-handle' })
    try {
      const res = await fetch(`https://www.youtube.com/@${encodeURIComponent(handle)}`, { headers: { 'User-Agent': 'Mozilla/5.0 (MomentumBoard)' } })
      const page = await res.text()
      const id = page.match(/channel_id=(UC[A-Za-z0-9_-]{10,})/)?.[1]
      const name = page.match(/<title>([^<]+?)\s*- YouTube<\/title>/)?.[1] ?? handle
      if (!id) return json(404, { ok: false, error: 'channel-not-found' })
      return json(200, { ok: true, data: { id, name } })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  if (type === 'insiders') {
    const symbols = (url.searchParams.get('symbols') ?? '').split(',').filter(Boolean).slice(0, 30)
    const key = `insiders:${symbols.slice().sort().join(',')}`
    const hit = await getCached<unknown>(key)
    if (hit) return json(200, { ok: true, data: hit })
    try {
      const { fetchInsiderBuys } = await import('./lib/insiders')
      const data = { insiders: await fetchInsiderBuys(symbols, env.FINNHUB_API_KEY ?? '') }
      await setCached(key, data, 21_600)
      return json(200, { ok: true, data })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  if (type === 'congress') {
    // Congressional trades for the Intel screen. The upstream sweep (source
    // ladder in lib/congress) is cached ONCE market-wide for a day; the
    // watchlist filter is applied per-request on top of the cache. Fail-soft:
    // a dead ladder yields { trades: [], source: 'none' }, never a 500.
    const symbols = (url.searchParams.get('symbols') ?? '').split(',').filter(Boolean).map(s => s.toUpperCase()).slice(0, 30)
    try {
      type CongressBlob = { trades: import('./lib/congress').CongressTrade[]; source: string; asOf: number }
      const { accumulateCongressHistory, congressAggregates, resolveCongressSectors } = await import('./lib/congress')
      const { cachedIndustry } = await import('./lib/marketCache')
      let blob = await getCached<CongressBlob>('congress:v1')
      let history: import('./lib/congress').CongressTrade[]
      if (!blob) {
        const { fetchCongressTrades } = await import('./lib/congress')
        const { trades, source } = await fetchCongressTrades(env, symbols)
        blob = { trades, source, asOf: Math.floor(Date.now() / 1000) }
        // an empty sweep is re-tried hourly (so adding QUIVER_API_KEY lights up
        // within the hour); a live one holds for the full day.
        await setCached('congress:v1', blob, trades.length ? 86_400 : 3600)
        // fold the fresh sweep into the rolling 90d history (one write per sweep, not per request)
        history = await accumulateCongressHistory(blobAppStore, blob.trades)
      } else {
        history = (await blobAppStore.read<import('./lib/congress').CongressTrade[]>('congress-history')) ?? []
      }
      const base = (s: string) => s.split('.')[0].split('-')[0].toUpperCase()
      const wanted = new Set(symbols.map(base))
      const watchlistHits = wanted.size ? blob.trades.filter(t => wanted.has(base(t.symbol))) : []
      // sector map: bulk resolution happens in the scheduled warm; each request may trickle a few more
      const sectors = await resolveCongressSectors(blobAppStore, history, s => cachedIndustry(s, env.FINNHUB_API_KEY ?? ''), 8)
      // the buys-vs-SPY scorecard is PRECOMPUTED by the warm sweep — read-only here (null until it first runs)
      const scorecard = await blobAppStore.read<import('./lib/congress').CongressScorecard>('congress-scorecard').catch(() => null)
      return json(200, { ok: true, data: { trades: blob.trades.slice(0, 100), watchlistHits, source: blob.source, asOf: blob.asOf, aggregates: congressAggregates(history, sectors), scorecard } })
    } catch {
      return json(200, { ok: true, data: { trades: [], watchlistHits: [], source: 'none', asOf: Math.floor(Date.now() / 1000), aggregates: null, scorecard: null } })
    }
  }

  if (type === 'insider-clusters') {
    // Market-wide insider-buying clusters, aggregated from the per-symbol
    // coverage blobs the engine's daily rotation already collected
    // (insiders:cov:*). Aggregation only — this endpoint NEVER hits Finnhub,
    // so a cold engine simply means a shorter (or empty) list.
    const hit = await getCached<unknown>('insider-clusters:v1')
    if (hit) return json(200, { ok: true, data: hit })
    try {
      const { aggregateInsiderClusters } = await import('./lib/insiders')
      const roster = (await blobAppStore.read<{ sym: string }[]>('engine-roster')) ?? []
      const cfg = await blobAppStore.read<{ watchlist?: { symbol: string }[] }>('config')
      const syms = [...new Set([...roster.map(r => r.sym), ...(cfg?.watchlist ?? []).map(w => w.symbol)])]
      const data = { clusters: await aggregateInsiderClusters(syms), asOf: Math.floor(Date.now() / 1000) }
      await setCached('insider-clusters:v1', data, 21_600)
      return json(200, { ok: true, data })
    } catch {
      return json(200, { ok: true, data: { clusters: [], asOf: Math.floor(Date.now() / 1000) } })
    }
  }

  if (type === 'news-desk') {
    // The triaged news desk (lib/newsTriage.ts via alert-check): every fresh
    // headline analysed and importance-scored. Read-only — alert-check owns
    // the writes; newest first, importance carried per item for the UI.
    try {
      const desk = ((await blobAppStore.read<import('./lib/newsTriage').TriagedNews[]>('news-desk')) ?? []).slice(-120).reverse()
      return json(200, { ok: true, data: { items: desk } })
    } catch {
      return json(200, { ok: true, data: { items: [] } })
    }
  }

  if (type === 'signal-stats') {
    const hit = await getCached<unknown>('signal-stats')
    if (hit) return json(200, { ok: true, data: hit })
    try {
      const { appStore: blobAppStore } = await import('./lib/storeProvider')
      const { scoreSignals } = await import('./lib/signalStats')
      const { cachedCandles } = await import('./lib/marketCache')
      const log = ((await blobAppStore.read<unknown[]>('signal-log')) ?? []) as Parameters<typeof scoreSignals>[0]
      const symbols = [...new Set(log.map(l => l.symbol))].slice(0, 40)
      const candlePairs = await Promise.all(symbols.map(async s => [s, await cachedCandles(s)] as const))
      const candlesBySymbol = new Map(candlePairs.filter((p): p is [string, NonNullable<(typeof candlePairs)[0][1]>] => p[1] !== null))
      const data = { scores: scoreSignals(log, candlesBySymbol), totalSignals: log.length }
      await setCached('signal-stats', data, 3600)
      return json(200, { ok: true, data })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  if (type === 'ask') {
    // Ask the desk: a free-form question about ONE symbol, answered by the LLM
    // but grounded in measured chart evidence computed right here — stage,
    // setups, RSI/RVOL, returns, capacity, regime, the engine's live call and
    // the latest headlines. The model narrates the numbers; it never invents them.
    //
    // CX-20: the v2 Ask sheet ALWAYS carries the page's own verdict state as a
    // `context` param — a compact JSON summary of exactly what the hero card is
    // showing (sized/refused/on-demand, grade-or-not, core/lean, gate label,
    // live open-trace verdict). The 400-char clamp below is for `q` alone; a
    // reader typing a long question must never truncate the engine's own
    // evidence. Optional and additive — the legacy AskDesk client never sends
    // it, and that call is unchanged.
    const symbol = url.searchParams.get('symbol')?.toUpperCase()
    const q = url.searchParams.get('q')?.slice(0, 400)
    const askContext = parseAskContext(url.searchParams.get('context'))
    if (!symbol || !q) return json(400, { ok: false, error: 'missing-params' })
    // THE CAP THAT IS ACTUALLY A CAP (T18). The 20/day limit lives in
    // localStorage on the client, which makes it a courtesy: it is the UX, it
    // is not a control. This endpoint spends the owner's LLM keys (admin and
    // house licences ride them outright) and does real market work besides, and
    // nothing server-side counted a single call. This does — per caller, per
    // London-free calendar day, in the CACHE store so the rows expire on their
    // own. Deliberately generous: it is a runaway backstop, not the product's
    // limit, and a reader who somehow passes it is told plainly.
    const capped = await bumpAskCount(auth)
    if (capped) return capped
    try {
      const llmEnv = await llmEnvForCaller()
      if (!llmEnv) return json(200, { ok: true, data: { answer: 'Add your own AI key in Settings to ask the desk questions.', at: 0 } })
      const { cachedQuote, cachedCandles } = await import('./lib/marketCache')
      const { technicalStage } = await import('../../shared/technicals')
      const { detectSetups, regimeFromCandles } = await import('../../shared/setups')
      const { swingCapacity } = await import('../../shared/indicators')
      const nowSec = Math.floor(Date.now() / 1000)
      const [quote, candles, spy, qqq, news] = await Promise.all([
        cachedQuote(symbol, env.FINNHUB_API_KEY ?? '').catch(() => null),
        cachedCandles(symbol).catch(() => null),
        cachedCandles('SPY').catch(() => null),
        cachedCandles('QQQ').catch(() => null),
        (deps.news ?? fetchSymbolNews)(symbol, env.FINNHUB_API_KEY ?? '', nowSec).catch(() => []),
      ])
      if (!candles || candles.length < 30) {
        return json(200, { ok: true, data: { answer: `Not enough chart history on ${symbol} for a grounded answer — the desk doesn't guess without data.`, at: nowSec } })
      }
      const closes = candles.map(c => c.c)
      const last = closes[closes.length - 1]
      const ret = (days: number) => (closes.length > days ? Math.round(((last - closes[closes.length - 1 - days]) / closes[closes.length - 1 - days]) * 1000) / 10 : null)
      const read = technicalStage(symbol, candles)
      const setups = detectSetups(candles, read?.rvol ?? null)
      const capacity = swingCapacity(closes)
      const regime = spy && qqq ? regimeFromCandles(spy, qqq) : 'unknown'
      const boardBlob = await blobAppStore
        .read<{ date: string; board: { sym: string; side: string; grade: string; probability: number; entry: number; stop: number; target: number; note: string; watchOnly?: boolean; nearMiss?: boolean }[] }>('engine-board')
        .catch(() => null)
      const call = boardBlob?.board?.find(p => p.sym === symbol)
      const evidence = [
        `Price ${quote?.price ?? last}${quote && quote.changePct != null ? ` (${quote.changePct.toFixed(1)}% today)` : ''}; 21d return ${ret(21) ?? '?'}%, 63d return ${ret(63) ?? '?'}%.`,
        read ? `Chart read: ${read.note} (stage ${read.stage}, entry quality ${read.entryQuality}, RSI ${read.rsi ?? '?'}, RVOL ${read.rvol ?? '?'}).` : 'No confident chart read.',
        `Active setups: ${setups.join(', ') || 'none'}. Typical 10-day swing capacity ±${capacity ?? '?'}%.`,
        `Market regime: ${regime}.`,
        boardEvidenceLine(boardBlob?.date ?? '', call),
        news.length ? `Recent headlines: ${news.slice(0, 4).map(n => n.title).join(' | ')}.` : 'No notable recent headlines.',
      ].join('\n- ')
      // The pinned block: when the v2 sheet sent its own hero-state context,
      // it is inserted WHOLE (never truncated — only `q` above is clamped) and
      // named explicitly as ground truth, so the model narrates it rather than
      // reasoning its way to a different verdict from the evidence lines below.
      const contextBlock = askContext
        ? `\n\nThe engine's verdict below is ground truth — narrate and answer within it; do not contradict it:\n${JSON.stringify(askContext)}\n`
        : ''
      const prompt = `You are the StreetSignal research desk — a seasoned, plain-spoken swing-trading analyst. A reader asks about ${symbol}: "${q}"
${contextBlock}
Ground your answer ONLY in this measured evidence (do not invent numbers):
- ${evidence}

Answer in 3-6 direct sentences: address the question specifically, cite the relevant numbers above, name the level or event that would change your read, and be honest where the evidence is thin or the question isn't answerable from charts. End with one short note that this is analysis, not advice.`
      const { callLlm } = await import('./lib/llm')
      const { text } = await callLlm(prompt, { ...llmEnv, maxTokens: 900 })
      return json(200, { ok: true, data: { answer: text.trim(), at: nowSec } })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  if (type === 'evaluate-note') {
    const text = url.searchParams.get('text')?.slice(0, 500)
    const kind = url.searchParams.get('kind') ?? 'observation'
    if (!text) return json(400, { ok: false, error: 'missing-text' })
    try {
      const llmEnv = await llmEnvForCaller()
      if (!llmEnv) return json(200, { ok: true, data: { take: 'Add your own AI key in Settings to get instant takes on your notes.' } })
      const { callLlm } = await import('./ai-insights.mts')
      const prompt = `A retail swing trader logged this personal ${kind}: "${text}"
As a seasoned, friendly-but-honest analyst, respond in 2-3 sentences: is this consistent with market evidence and research, partially true, or a common misconception? Be direct — the trader explicitly WANTS pushback when wrong. If it's testable, say what data would settle it. No flattery.`
      const { text: take } = await callLlm(prompt, llmEnv)
      return json(200, { ok: true, data: { take: take.trim() } })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  if (type === 'seasonality') {
    const symbol = url.searchParams.get('symbol')?.toUpperCase()
    if (!symbol) return json(400, { ok: false, error: 'missing-symbol' })
    const key = `seasonality:${symbol}`
    const hit = await getCached<unknown>(key)
    if (hit) return json(200, { ok: true, data: hit })
    try {
      const { seasonalitySummary } = await import('../../shared/seasonality')
      const { candles } = await deps.yahoo(symbol, '5y')
      const data = { sym: symbol, years: Math.round((candles.length / 252) * 10) / 10, ...seasonalitySummary(candles) }
      await setCached(key, data, 86_400)
      return json(200, { ok: true, data })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  if (type === 'sectors') {
    const hit = await getCached<unknown>('sector-rotation')
    if (hit) return json(200, { ok: true, data: hit })
    try {
      const { SECTORS, SECTOR_MEMBERS, computeSectorRows } = await import('./lib/sectors')
      const { cachedCandles } = await import('./lib/marketCache')
      const pairs = await Promise.all([...SECTORS.map(s => s.sym), 'SPY'].map(async sym => [sym, await cachedCandles(sym)] as const))
      const bySym = new Map(pairs.filter((p): p is [string, NonNullable<(typeof pairs)[0][1]>] => p[1] !== null))
      const spy = bySym.get('SPY')
      if (!spy) return json(502, { ok: false, error: 'no-spy-data' })
      const rows = computeSectorRows(bySym, spy)
      const data = {
        // CX-24: additive — every existing field rides unchanged (the legacy
        // app reads this same endpoint); `members` is the sector's real
        // constituent tickers, so the Sectors see-all page never invents any.
        rows: rows.map(r => ({ ...r, members: SECTOR_MEMBERS[r.sym] ?? [] })),
        rotatingIn: rows.filter(r => r.trend === 'in').map(r => r.name),
        rotatingOut: rows.filter(r => r.trend === 'out').map(r => r.name),
        at: Math.floor(Date.now() / 1000),
      }
      await setCached('sector-rotation', data, 14_400)
      return json(200, { ok: true, data })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  if (type === 'brief') {
    const symbol = url.searchParams.get('symbol')?.toUpperCase()
    if (!symbol) return json(400, { ok: false, error: 'missing-symbol' })
    const key = `brief:${symbol}`
    const hit = await getCached<unknown>(key)
    if (hit) return json(200, { ok: true, data: hit }) // cached briefs are free to every licensee
    const briefLlmEnv = await llmEnvForCaller()
    if (!briefLlmEnv) return json(200, { ok: true, data: { sym: symbol, brief: 'Add your own AI key in Settings to enable fresh ticker briefs.', at: 0 } })
    try {
      const { cachedQuote, cachedCandles } = await import('./lib/marketCache')
      const { detectSetups } = await import('../../shared/setups')
      const { fetchSymbolNews } = await import('./lib/news')
      const { callLlm } = await import('./ai-insights.mts')
      const nowSec = Math.floor(Date.now() / 1000)
      const [quote, candles, news] = await Promise.all([
        cachedQuote(symbol, env.FINNHUB_API_KEY ?? ''),
        cachedCandles(symbol),
        fetchSymbolNews(symbol, env.FINNHUB_API_KEY ?? '', nowSec).catch(() => []),
      ])
      const setups = candles && candles.length > 25 ? detectSetups(candles, null) : []
      const prompt = `You are a decisive, seasoned analyst. In 3-4 sentences, brief a swing trader on WHAT HAS CHANGED lately for ${symbol}${quote?.name ? ` (${quote.name})` : ''}: price ${quote?.price ?? '?'} (${quote?.changePct?.toFixed(1) ?? '?'}% today), active technical states: ${setups.join(', ') || 'none'}, latest headlines: ${news.slice(0, 3).map(n => n.title).join(' | ') || 'none notable'}. Give your read and the one thing to watch next. No hedging filler; end with one honesty note only if truly needed.`
      const { text } = await callLlm(prompt, briefLlmEnv)
      const data = { sym: symbol, brief: text.trim(), at: nowSec }
      await setCached(key, data, 21_600)
      return json(200, { ok: true, data })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  if (type === 'social') {
    const hit = await getCached<unknown>('social-pulse:v2')
    if (hit) return json(200, { ok: true, data: hit })
    try {
      const { fetchRedditTrends, fetchStocktwitsTrending, combineSocialPulse, pickDiscoveries, isMega } = await import('./lib/social')
      const { appStore: blobAppStore } = await import('./lib/storeProvider')
      const { computeConsensus } = await import('./lib/videoTrends')
      const [reddit, stocktwits, extracts, cfg] = await Promise.all([
        fetchRedditTrends(),
        fetchStocktwitsTrending(),
        blobAppStore.read<unknown[]>('video-extracts'),
        blobAppStore.read<{ watchlist: { symbol: string }[] }>('config'),
      ])
      const consensus = computeConsensus(((extracts ?? []) as Parameters<typeof computeConsensus>[0]), Math.floor(Date.now() / 1000))
      const pulse = combineSocialPulse(reddit, stocktwits, consensus.tickers.map(t => ({ sym: t.sym, net: t.net })), (cfg?.watchlist ?? []).map(w => w.symbol))

      // enrich the non-household candidates with market cap (Finnhub, 24h cached)
      const candidates = pulse.filter(p => !isMega(p.sym)).slice(0, 8)
      await Promise.all(
        candidates.map(async c => {
          const capKey = `cap:${c.sym}`
          let cap = await getCached<{ capUsdM: number | null; name?: string }>(capKey)
          if (!cap) {
            try {
              const res = await fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${c.sym}&token=${env.FINNHUB_API_KEY}`)
              const j = (await res.json()) as { marketCapitalization?: number; name?: string }
              cap = { capUsdM: j.marketCapitalization ?? null, name: j.name }
              await setCached(capKey, cap, 86_400)
            } catch {
              cap = { capUsdM: null }
            }
          }
          Object.assign(c, { capUsdM: cap.capUsdM, companyName: cap.name })
        }),
      )
      const discoveries = pickDiscoveries(candidates as never[])

      // the analyst's take on each up-and-comer: ONE model call, opinions not noise
      if (discoveries.length) {
        try {
          const { callLlm } = await import('./ai-insights.mts')
          const prompt = `You are a seasoned, decisive stock analyst. For each up-and-coming name below (small/mid caps with surging social chatter), give a 2-3 sentence take: what the company does, the most likely driver of the chatter, and YOUR opinion (worth a look / needs a catalyst / likely pump). End each with what would validate it. Respond ONLY with JSON: {"opinions":[{"sym":"X","take":"..."}]}\n${discoveries
            .map(d => `${d.sym} (${d.companyName ?? '?'}, cap ${d.capUsdM ? `$${(d.capUsdM / 1000).toFixed(1)}B` : 'unknown'}): reddit #${d.redditRank}, mentions ${d.redditMentions} (${d.surgeMultiple ?? '?'}x vs 24h ago), ${d.sources} platforms`)
            .join('\n')}`
          const { text } = await callLlm(prompt, { GEMINI_API_KEY: process.env.GEMINI_API_KEY, GOOGLE_GEMINI_BASE_URL: process.env.GOOGLE_GEMINI_BASE_URL, GROQ_API_KEY: process.env.GROQ_API_KEY })
          const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as { opinions?: { sym: string; take: string }[] }
          for (const o of parsed.opinions ?? []) {
            const d = discoveries.find(x => x.sym === o.sym.toUpperCase())
            if (d) d.opinion = o.take
          }
        } catch {
          /* opinions are best-effort; numbers still ship */
        }
      }

      const data = {
        discoveries,
        alsoLoud: pulse.filter(p => isMega(p.sym)).slice(0, 6).map(p => p.sym),
        pulse: pulse.filter(p => !discoveries.some(d => d.sym === p.sym)),
        at: Math.floor(Date.now() / 1000),
      }
      await setCached('social-pulse:v2', data, 3600)
      return json(200, { ok: true, data })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  if (type === 'econ') {
    const hit = await getCached<unknown>('econ-calendar')
    if (hit) return json(200, { ok: true, data: { events: hit } })
    try {
      const { fetchEconCalendar } = await import('./lib/econCalendar')
      const events = await fetchEconCalendar()
      await setCached('econ-calendar', events, 21_600)
      return json(200, { ok: true, data: { events } })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  if (type === 'ipos') {
    // the new-listings tape: names about to list (7 days ahead) and names that
    // just priced (90 days back). One cached Finnhub call, split into the two
    // windows the Desk rail + morning report show. Fail-soft to [].
    const hit = await getCached<unknown>('ipos')
    if (hit) return json(200, { ok: true, data: hit })
    try {
      const { fetchIpoCalendar, upcomingListings, recentListings } = await import('./lib/ipoCalendar')
      const now = new Date()
      const iso = (d: Date) => d.toISOString().slice(0, 10)
      const todayISO = iso(now)
      const from = iso(new Date(now.getTime() - 90 * 86_400_000))
      const to = iso(new Date(now.getTime() + 7 * 86_400_000))
      const rows = await fetchIpoCalendar(env.FINNHUB_API_KEY ?? '', from, to)
      const data = { upcoming: upcomingListings(rows, todayISO), recent: recentListings(rows, todayISO), at: Math.floor(Date.now() / 1000) }
      await setCached('ipos', data, 21_600)
      return json(200, { ok: true, data })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  if (type === 'pick-stats') {
    // `fresh=1` skips the cache. The morning run needs a REAL recompute: a cache
    // hit returns early, so warming through the cache silently skipped the
    // durable write and left Helm's scorecard null even on a 200.
    const fresh = url.searchParams.get('fresh') === '1'
    const hit = fresh ? null : await getCached<unknown>('pick-stats')
    if (hit) return json(200, { ok: true, data: hit })
    try {
      const { appStore: blobAppStore } = await import('./lib/storeProvider')
      const { scorePicks } = await import('./lib/picks')
      const { cachedCandles } = await import('./lib/marketCache')
      const history = ((await blobAppStore.read<unknown[]>('report-picks')) ?? []) as Parameters<typeof scorePicks>[0]
      const symbols = [...new Set(history.flatMap(d => d.picks.map(p => p.ticker)))].slice(0, 40)
      const pairs = await Promise.all(symbols.map(async s => [s, await cachedCandles(s)] as const))
      const candlesBySymbol = new Map(pairs.filter((p): p is [string, NonNullable<(typeof pairs)[0][1]>] => p[1] !== null))
      const data = { scores: scorePicks(history, candlesBySymbol), reports: history.length, at: Math.floor(Date.now() / 1000) }
      await setCached('pick-stats', data, 3600)
      // ALSO keep a durable copy in the app store. The cache lives in a different
      // blob store ('cache') from the one helm-export reads ('app'), so Helm's
      // scorecard was structurally always null — and the paper's prompt only saw
      // one if a reader happened to open the app within the last hour.
      await blobAppStore.write('pick-stats', data)
      return json(200, { ok: true, data })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  if (type === 'smart-money') {
    const hit = await getCached<unknown>('smart-money:v3') // v3: roster grew to 10 funds (v2 = entity-decoded issuer names)
    if (hit) return json(200, { ok: true, data: hit })
    try {
      const { FUNDS, fetchFundMoves } = await import('./lib/edgar')
      const funds = (await Promise.all(FUNDS.map(f => fetchFundMoves(f.cik, f.name)))).filter(Boolean)
      const data = { funds, lagNote: '13F holdings are filed up to 45 days after quarter end — context, not timing.' }
      await setCached('smart-money:v3', data, 86_400)
      return json(200, { ok: true, data })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  if (type === 'news') {
    const symbol = url.searchParams.get('symbol')
    if (!symbol) return json(400, { ok: false, error: 'missing-symbol' })
    const key = `news:${symbol}`
    const hit = await getCached<unknown>(key)
    if (hit) return json(200, { ok: true, data: hit })
    try {
      // For LSE ETPs / crypto, resolve the instrument's long name so the query
      // targets the underlying ("Tesla", "Bitcoin") instead of the raw symbol.
      let name: string | undefined
      if (isYahooSymbol(symbol)) {
        const cachedQ = await getCached<Quote>(`quote:${symbol}`)
        name = cachedQ?.name ?? (await deps.yahoo(symbol, '3mo').then(d => d.quote.name).catch(() => undefined))
      }
      const items = await (deps.news ?? fetchSymbolNews)(symbol, env.FINNHUB_API_KEY ?? '', Math.floor(Date.now() / 1000), fetch, name)
      const data = { items }
      await setCached(key, data, 240)
      return json(200, { ok: true, data })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  return json(400, { ok: false, error: 'bad-type' })
}

export default async (req: Request, _context: Context) =>
  routeRequest(
    new URL(req.url),
    req.headers,
    { APP_TOKEN: process.env.APP_TOKEN, FINNHUB_API_KEY: process.env.FINNHUB_API_KEY, QUIVER_API_KEY: process.env.QUIVER_API_KEY, FMP_API_KEY: process.env.FMP_API_KEY },
    { yahoo: fetchYahooChart, finnhub: fetchFinnhubQuote },
  )
