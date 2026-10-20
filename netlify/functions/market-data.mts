import type { Context } from '@netlify/functions'
import { CANDLE_RANGES, candleRange, fetchYahooChart } from './lib/yahoo'
import { fetchFinnhubQuote } from './lib/finnhub'
import { fetchSymbolNews } from './lib/news'
import { getCached, setCached } from './lib/cache'
import type { Quote } from '../../shared/types'
import { isYahooSymbol } from '../../shared/symbols'
import { DEVICE_LLM_HEADER, isGroqKeyShape, type LlmKeySource } from '../../shared/llmKey'

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
async function bumpAskCount(auth: { level: string; ns: string; house?: boolean }): Promise<Response | null> {
  // The owner's own devices ride free: the cap protects the server keys from a
  // runaway licensee, and admin/house ARE the keys' owner (final wave, T18).
  if (auth.level === 'admin' || auth.house) return null
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

/** How deep each mover rail is served. The Movers page pages FORTY rows and the
 * board served TWELVE, so "Show more" was furniture; Yahoo's predefined
 * screeners are asked for 25 (lib/screener's own default) and 25 is now what
 * rides out. */
export const MOVERS_DEPTH = 25

/** How many rows per rail get the engine's stage read. The stage costs a
 * per-symbol candle fetch, so it stays on the same upstream budget as the old
 * twelve-deep payload: the rows a reader sees before "Show more" are read, the
 * tail is served with `stage: null` rather than tripling the movers refresh. */
export const MOVERS_STAGE_DEPTH = 12

/** THE SIGN OF THE MOVE DECIDES THE RAIL — not which screener the row arrived in.
 *
 * Yahoo's `day_gainers` / `day_losers` membership is noisy: the live board on
 * 2026-08-17 opened its LOSERS rail with MAAS +5.6% and LB +4.5%, and carried
 * QNT −7.2% among the gainers. Those rows were not mislabelled by us — they came
 * that way, and were served raw. So membership is discarded here and every row
 * is re-partitioned by its OWN `changePct`: a row whose number contradicts the
 * list it arrived in is moved to the side its number puts it on, and a row with
 * no number at all (null, or a flat 0) is on neither side and is dropped.
 *
 * The two screeners overlap, so the pool is deduped by symbol first, keeping the
 * record with the larger absolute move — that also settles the case where the
 * two lists disagree about a symbol's sign, without it appearing on both rails. */
export function partitionMovers<T extends { sym: string; changePct: number | null }>(
  rows: T[],
  depth = MOVERS_DEPTH,
): { gainers: T[]; losers: T[] } {
  const best = new Map<string, T>()
  for (const r of rows) {
    if (r.changePct == null || !Number.isFinite(r.changePct) || r.changePct === 0) continue
    const prev = best.get(r.sym)
    if (!prev || Math.abs(r.changePct) > Math.abs(prev.changePct as number)) best.set(r.sym, r)
  }
  const all = [...best.values()]
  return {
    gainers: all.filter(r => (r.changePct as number) > 0).sort((a, b) => (b.changePct as number) - (a.changePct as number)).slice(0, depth),
    losers: all.filter(r => (r.changePct as number) < 0).sort((a, b) => (a.changePct as number) - (b.changePct as number)).slice(0, depth),
  }
}

/* ───────────────────────── the quote batch ─────────────────────────
 *
 * DEFECT 2, measured live: a 15-symbol batch returned 8–12 nulls. Three things
 * compounded. The batch fired every symbol at once, which is what tripped
 * Finnhub; every failure was swallowed by `catch { return null }`, so nothing
 * anywhere said so; and the hollow result then rode the client's 120s slice,
 * leaving the app's most-opened screen showing "—" on rows whose price we had
 * had minutes earlier. The three answers below are, in order: a bounded
 * fan-out, one retry, and a last-known-good tier.
 */

/** Upstream calls in flight per batch. Four, not fifteen. */
export const QUOTE_CONCURRENCY = 4

/** 72h — long enough that Friday's close is still there on Monday morning. */
export const QUOTE_LKG_TTL_SEC = 259_200

/* --- THE STREET (owner request) ---------------------------------------------
 * "the summary of youtube video input deserve a section of their own, and
 *  there should be a system where the youtube suggestions are also evaluated
 *  by our engine and highlighted — all in a new page/tab altogether."
 *
 * The engine has written three video blobs since the lane shipped and no
 * screen has rendered any of them whole: every analysed video, the deep
 * watch-tier narrative reads, and the transcripts that power both. This type
 * serves the first two plus the deterministic consensus computed off the
 * first — the transcripts stay server-side, because a page of raw transcripts
 * is not a reading surface. */

/** How many videos the wire carries. Thirty is roughly a fortnight of the
 * tracked channels at their current rate — enough that scrolling reaches
 * something older than the last two days, short enough to stay one payload. */
export const STREET_VIDEOS = 30

/** The deep reads are expensive (the Gemini watch tier's daily cap is three)
 * and long, so the page carries the newest handful and nothing more. */
export const STREET_READS = 5

/** Five minutes. The upstream blobs turn over when a video lands, which is a
 * handful of times a day — this cache exists to stop a page open on two
 * devices re-reading four hundred extracts a refresh, not to hide staleness. */
export const STREET_TTL_SEC = 300

/** The last-known-good row for a symbol. A SEPARATE key from `quote:{sym}` on
 * purpose: the 60s row means "this is the market now", and a stale price must
 * never be written into it. */
export const quoteLkgKey = (sym: string) => `quote-lkg:${sym}`

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}

/** ONE read for a whole set of cache keys.
 *
 * Deliberately private to this path: a general multi-get belongs in lib/cache.ts
 * and is being added there separately, and two of them landing at once would
 * collide. On D1 this is a single `key IN (…)` select — the failed set costs one
 * round trip however many symbols are in it — with the same envelope decoding
 * and the same expiry rule as getCached (`{ value, expires }`, epoch ms, and a
 * corrupt row reads as a miss). Off D1 there is no multi-get to reach for, so it
 * falls back to bounded per-key reads, which is exactly what the caller would
 * have done anyway. Fail-soft throughout: a batch read that throws degrades to
 * the per-key path rather than failing the request. */
export async function readCachedBatch<T>(keys: string[]): Promise<Map<string, T>> {
  const out = new Map<string, T>()
  if (!keys.length) return out
  const { currentCacheStore, currentD1 } = await import('./lib/storeProvider')
  const db = currentCacheStore() ? currentD1() : null
  if (db) {
    try {
      const at = Date.now()
      const slots = keys.map((_, i) => `?${i + 2}`).join(',')
      const res = await db
        .prepare(`SELECT key, value FROM blobs WHERE store = ?1 AND key IN (${slots}) AND (expires_at IS NULL OR expires_at >= ?${keys.length + 2})`)
        .bind('cache', ...keys, at)
        .all<{ key: string; value: string }>()
      for (const row of res.results ?? []) {
        try {
          const envelope = JSON.parse(row.value) as { value?: T; expires?: number }
          if (envelope && typeof envelope.expires === 'number' && envelope.expires >= at && envelope.value != null) out.set(row.key, envelope.value)
        } catch {
          /* a corrupt cache row is a miss, exactly as getCached treats it */
        }
      }
      return out
    } catch {
      /* fall through to the per-key path */
    }
  }
  await mapWithLimit(keys, QUOTE_CONCURRENCY, async key => {
    const v = await getCached<T>(key)
    if (v != null) out.set(key, v)
  })
  return out
}

/** The batch the Stocks screen lives on. Order in = order out; a row is null
 * only for a symbol this deployment has never successfully priced. */
export async function batchQuotes(
  symbols: string[],
  finnhubKey: string,
  deps: { yahoo: typeof fetchYahooChart; finnhub: typeof fetchFinnhubQuote },
): Promise<(Quote | null)[]> {
  const out = new Array<Quote | null>(symbols.length).fill(null)
  const failed: number[] = []

  const fetchOne = async (sym: string): Promise<Quote> =>
    isYahooSymbol(sym) ? (await deps.yahoo(sym, '3mo')).quote : await deps.finnhub(sym, finnhubKey)

  /** A landed quote is written twice: the 60s row the next request reads, and
   * the 72h row the next FAILURE reads. Nothing is written on a failure — the
   * fresh row must never be overwritten by one.
   *
   * AND THE WRITE NEVER COSTS THE ROW. The old batch had both cache write and
   * upstream fetch inside one `try { … } catch { return null }`, so a store that
   * refused a write discarded a quote we were holding in our hand. Keeping the
   * copy is best-effort; serving the price is not. */
  const land = async (sym: string, quote: Quote): Promise<void> => {
    try {
      await setCached(`quote:${sym}`, quote, 60)
      await setCached(quoteLkgKey(sym), quote, QUOTE_LKG_TTL_SEC)
    } catch {
      /* the reader still gets the price */
    }
  }

  // pass 1 — the 60s cache, else one upstream call, at most four at a time
  await mapWithLimit(symbols, QUOTE_CONCURRENCY, async (sym, i) => {
    const hit = await getCached<Quote>(`quote:${sym}`)
    if (hit) {
      out[i] = hit
      return
    }
    try {
      const quote = await fetchOne(sym)
      await land(sym, quote)
      out[i] = quote
    } catch {
      failed.push(i)
    }
  })

  // pass 2 — ONE retry each. Most of these failures are the fan-out's own doing,
  // and a second ask a moment later, four at a time, simply works.
  const stillFailed: number[] = []
  await mapWithLimit(failed, QUOTE_CONCURRENCY, async i => {
    try {
      const quote = await fetchOne(symbols[i])
      await land(symbols[i], quote)
      out[i] = quote
    } catch {
      stillFailed.push(i)
    }
  })

  // pass 3 — the last-known-good tier, in ONE read. A price from this morning
  // labelled `stale` (its own `asOf` carried through, so the UI can say how old
  // it is) beats a dash. A symbol with no lkg at all is the only null left.
  if (stillFailed.length) {
    const lkg = await readCachedBatch<Quote>(stillFailed.map(i => quoteLkgKey(symbols[i])))
    for (const i of stillFailed) {
      const row = lkg.get(quoteLkgKey(symbols[i]))
      if (row) out[i] = { ...row, stale: true }
    }
  }
  return out
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

  // WHOSE KEY ANSWERS THIS REQUEST — a THREE-tier ladder, in this order.
  //
  //   1. the device header (`x-groq-api-key`). The preferred path and the only
  //      one new keys take: it is held in the reader's own IndexedDB, exists
  //      only for the life of this request, and wins for EVERY caller — admin
  //      and house included, so the owner can test a licensee's key as one.
  //   2. the server env, for admin + house licences (the owner's own devices).
  //   3. THE OLD SERVER-STORED BLOB, still read. This is a transition, not a
  //      cutover: a licensee who saved their key before the device path existed
  //      keeps a working app on every device they already use. The response
  //      then carries `llmKeySource: 'server'` so Settings can ask them, once,
  //      to re-enter it on-device — the key itself is never handed back.
  //
  // BYOK stays STRICT in tiers 1 and 3 (lib/llm.ts): a licensee's request may
  // use ONLY the licensee's key, never a fall-through to the owner's.
  let llmKeySource: LlmKeySource | null = null
  const llmEnvForCaller = async (): Promise<{ [k: string]: unknown } | null> => {
    llmKeySource = null
    const deviceGroqKey = headers.get(DEVICE_LLM_HEADER)?.trim() ?? ''
    if (deviceGroqKey) {
      if (!isGroqKeyShape(deviceGroqKey)) return null
      llmKeySource = 'device'
      return { GROQ_API_KEY: deviceGroqKey, strict: true }
    }
    // house licences are the owner's own devices — they ride the server's keys
    // like the admin token does. Ordinary licensees still bring their own key
    // (Helm: /house <label> flips a licence either way).
    if (auth.level === 'admin' || auth.house)
      return { GEMINI_API_KEY: process.env.GEMINI_API_KEY, GOOGLE_GEMINI_BASE_URL: process.env.GOOGLE_GEMINI_BASE_URL, GROQ_API_KEY: process.env.GROQ_API_KEY }
    const creds = await blobAppStore.read<{ groqKey?: string }>(`${auth.ns}llm`)
    if (!creds?.groqKey) return null
    llmKeySource = 'server'
    return { GROQ_API_KEY: creds.groqKey, strict: true }
  }

  /** The migration tell, merged into an LLM answer's payload. Only ever set
   * when the OLD server copy served the request — a device key says nothing. */
  const keyHint = () => (llmKeySource === 'server' ? { llmKeySource: 'server' as const } : {})

  // Does this candidate key actually work? Round-trips the header to Groq
  // WITHOUT storing anything anywhere, so Settings can say "connected" on
  // evidence rather than on hope. Header-only by design: with no header there
  // is nothing to test, and an admin must not be told their env key is "their"
  // key. The key never touches the store on this path or any other.
  if (type === 'llm-probe') {
    if (!headers.get(DEVICE_LLM_HEADER)) return json(400, { ok: false, error: 'no-key' })
    const llmEnv = await llmEnvForCaller()
    if (!llmEnv) return json(400, { ok: false, error: 'invalid-key' })
    try {
      const { callLlm, modelFor } = await import('./lib/llm')
      const result = await callLlm('Reply with exactly OK.', { ...llmEnv, maxTokens: 96 })
      return json(200, { ok: true, data: { provider: result.provider, model: modelFor('groq', llmEnv) } })
    } catch (e) {
      return json(400, { ok: false, error: String(e).slice(0, 240) })
    }
  }

  if (type === 'movers') {
    // market-wide movers for the Movers tab: gainers, losers, most active.
    // Same Yahoo predefined screeners the engine's roster hunts with; 10-min
    // cache keeps every licensee off Yahoo's rate limits.
    const hit = await getCached<unknown>('movers')
    if (hit) return json(200, { ok: true, data: hit })
    const { fetchScreen } = await import('./lib/screener')
    const [gainersAll, losersAll, activesAll] = await Promise.all([fetchScreen('day_gainers'), fetchScreen('day_losers'), fetchScreen('most_actives')])
    // BOTH mover screeners are pooled and re-partitioned by the sign of each
    // row's own move (see partitionMovers): the lists' membership is noisy and
    // serving it raw put risers at the top of the Losers rail. `most_actives`
    // is a different question — the day's volume, whichever way it went — so it
    // rides through unpartitioned, just deeper.
    const { gainers, losers } = partitionMovers([...gainersAll, ...losersAll])
    const actives = activesAll.slice(0, MOVERS_DEPTH)
    // the engine's stage read per name — a big loser that's a falling knife and
    // one basing for a turn are different trades. Candle cache is shared with
    // the engine, per-symbol fail-soft, and the whole payload caches 10 min.
    const { cachedCandles } = await import('./lib/marketCache')
    const { technicalStage } = await import('../../shared/technicals')
    const uniq = [...new Set([...gainers.slice(0, MOVERS_STAGE_DEPTH), ...losers.slice(0, MOVERS_STAGE_DEPTH), ...actives.slice(0, MOVERS_STAGE_DEPTH)].map(r => r.sym))]
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
    const quotes = await batchQuotes(symbols, env.FINNHUB_API_KEY ?? '', deps)
    return json(200, { ok: true, data: { quotes } })
  }

  if (type === 'candles') {
    const symbol = url.searchParams.get('symbol')
    // WHITELISTED, not passed through (the range switcher's wave): this string
    // is interpolated into the upstream Yahoo URL, and each range keeps its own
    // cache key so a 1D read never overwrites the 3M one. Its TTL rides with
    // it — five minutes for a day of tape, fifteen for a quarter of it.
    const range = candleRange(url.searchParams.get('range'))
    if (!symbol) return json(400, { ok: false, error: 'missing-symbol' })
    const key = `candles:${symbol}:${range}`
    const hit = await getCached<unknown>(key)
    if (hit) return json(200, { ok: true, data: hit })
    try {
      const data = await deps.yahoo(symbol, range)
      await setCached(key, data, CANDLE_RANGES[range].ttlSec)
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

  if (type === 'business-health') {
    const symbol = (url.searchParams.get('symbol') ?? '').trim().toUpperCase()
    if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(symbol)) return json(400, { ok: false, error: 'invalid-symbol' })
    const { cachedBusinessHealth } = await import('./lib/businessHealth')
    const data = await cachedBusinessHealth(symbol)
    return json(200, { ok: true, data })
  }

  if (type === 'filings') {
    const symbol = (url.searchParams.get('symbol') ?? '').trim().toUpperCase()
    if (!symbol) return json(400, { ok: false, error: 'missing-symbol' })
    const key = `sec-filings:${symbol}`
    const hit = await getCached<unknown>(key)
    if (hit) return json(200, { ok: true, data: hit })
    try {
      const { fetchRecentFilings } = await import('./lib/secFilings')
      const data = await fetchRecentFilings(symbol)
      await setCached(key, data, 3600)
      return json(200, { ok: true, data })
    } catch (e) {
      // A primary-source outage is not the same thing as a company with no
      // filings; surface an explicit degraded state and keep the page alive.
      return json(200, { ok: true, data: { company: null, cik: null, filings: [], asOf: Math.floor(Date.now() / 1000), unavailable: true, error: String(e) } })
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
      // an EMPTY aggregate must not stick for six hours: pre-run mornings it
      // would pin "no coverage yet" long after the engine had filled in
      await setCached('insider-clusters:v1', data, data.clusters.length ? 21_600 : 900)
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
      return json(200, { ok: true, data: { answer: text.trim(), at: nowSec, ...keyHint() } })
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
      return json(200, { ok: true, data: { take: take.trim(), ...keyHint() } })
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
      // the hint stays OUT of the cached record: cached briefs are served to
      // every licensee, and whose key paid for this one is not a fact about
      // the brief. It is a fact about THIS request.
      await setCached(key, data, 21_600)
      return json(200, { ok: true, data: { ...data, ...keyHint() } })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  if (type === 'social-memory') {
    const symbol = url.searchParams.get('symbol')?.toUpperCase().trim() ?? ''
    if (!/^[A-Z0-9.-]{1,12}$/.test(symbol)) return json(400, { ok: false, error: 'invalid-symbol' })
    const [{ buildSocialMemory }, history, extracts] = await Promise.all([
      import('./lib/socialMemory'),
      blobAppStore.read<import('../../shared/engine/strategyLab').SocialHistoryPoint[]>('engine-lab-social-history'),
      blobAppStore.read<import('./lib/videoTrends').VideoExtract[]>('video-extracts'),
    ])
    return json(200, { ok: true, data: { symbol, days: buildSocialMemory(symbol, history ?? [], extracts ?? []) } })
  }

  if (type === 'social') {
    const hit = await getCached<unknown>('social-pulse:v3')
    if (hit) return json(200, { ok: true, data: hit })
    try {
      const { fetchRedditTrends, fetchStocktwitsTrending, combineSocialPulse, pickDiscoveries, isMega, plausibleCapUsdM } = await import('./lib/social')
      const { appStore: blobAppStore } = await import('./lib/storeProvider')
      const { computeConsensus } = await import('./lib/videoTrends')
      const [reddit, stocktwits, extracts, cfg, socialHistory] = await Promise.all([
        fetchRedditTrends(),
        fetchStocktwitsTrending(),
        blobAppStore.read<unknown[]>('video-extracts'),
        blobAppStore.read<{ watchlist: { symbol: string }[] }>('config'),
        blobAppStore.read<import('../../shared/engine/strategyLab').SocialHistoryPoint[]>('engine-lab-social-history'),
      ])
      const nowSec = Math.floor(Date.now() / 1000)
      const consensus = computeConsensus(((extracts ?? []) as Parameters<typeof computeConsensus>[0]), nowSec)
      const pulse = combineSocialPulse(reddit, stocktwits, consensus.tickers, (cfg?.watchlist ?? []).map(w => w.symbol))
      for (const row of pulse) {
        const seen = (socialHistory ?? []).filter(point => point.rows.some(hist => hist.sym === row.sym))
        const previous = [...seen].sort((a, b) => b.observedAt - a.observedAt)[0]?.rows.find(hist => hist.sym === row.sym)
        Object.assign(row, {
          firstSeenAt: seen.length ? Math.min(...seen.map(point => point.observedAt)) : nowSec,
          observedDays: Math.max(1, new Set(seen.map(point => new Date(point.observedAt * 1000).toISOString().slice(0, 10))).size),
          scanVelocity: row.redditMentions != null && previous?.redditMentions != null && previous.redditMentions > 0
            ? Math.round((row.redditMentions / previous.redditMentions) * 10) / 10
            : null,
        })
      }
      if (pulse.length) {
        const { appendSocialHistory } = await import('../../shared/engine/strategyLab')
        await blobAppStore.write('engine-lab-social-history', appendSocialHistory(socialHistory ?? [], pulse, nowSec))
      }

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
              // guarded BEFORE the cache: an unbelievable cap ($1072.7B beside
              // MU) must not be stored, let alone typeset (lib/social)
              cap = { capUsdM: plausibleCapUsdM(j.marketCapitalization, c.sym), name: j.name }
              await setCached(capKey, cap, 86_400)
            } catch {
              cap = { capUsdM: null }
            }
          }
          // …and again on the way out, because a cache entry written before the
          // guard existed is still out there for its 24h
          Object.assign(c, { capUsdM: plausibleCapUsdM(cap.capUsdM, c.sym), companyName: cap.name })
        }),
      )
      const discoveries = pickDiscoveries(candidates as never[])

      // the analyst's take on each up-and-comer: ONE model call, opinions not noise
      if (discoveries.length) {
        try {
          const { callLlm } = await import('./ai-insights.mts')
          const prompt = `You are a seasoned, sceptical stock analyst. For each up-and-coming name below, give a 2-3 sentence take: what the company does, what the EVIDENCE says is driving attention, and YOUR opinion (worth investigating / needs a catalyst / likely promotion risk). Distinguish creator stance from audience engagement; neither is price confirmation. End with what would validate or invalidate the attention. Respond ONLY with JSON: {"opinions":[{"sym":"X","take":"..."}]}\n${discoveries
            .map(d => `${d.sym} (${d.companyName ?? '?'}, cap ${d.capUsdM ? `$${(d.capUsdM / 1000).toFixed(1)}B` : 'unknown'}): Reddit #${d.redditRank}, ${d.redditMentions} mentions (${d.surgeMultiple ?? '?'}x vs 24h), rank move ${d.redditRankDelta ?? '?'}, ${d.redditUpvotes ?? '?'} upvotes; ${d.sources} platforms; YouTube ${d.channelBreadth ?? 0} channels, stance net ${d.channelNet ?? 0}, hype flags ${d.channelHype}; evidence ${d.evidenceScore}/100`)
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
        at: nowSec,
      }
      await setCached('social-pulse:v3', data, 3600)
      return json(200, { ok: true, data })
    } catch (e) {
      return json(502, { ok: false, error: String(e) })
    }
  }

  if (type === 'street') {
    // THE WIRE (owner request). Aggregation only — this endpoint fetches
    // nothing upstream, so a cold engine simply means a short (or empty) wire.
    const hit = await getCached<unknown>('street-wire:v3')
    if (hit) return json(200, { ok: true, data: hit })
    try {
      const { computeConsensus } = await import('./lib/videoTrends')
      const { videoIngestionHealth } = await import('./lib/videoIngestion')
      const { summarizeSocialOutcomes } = await import('../../shared/engine/socialOutcomes')
      const { SOCIAL_LEDGER_KEY } = await import('./lib/socialLedger')
      type Extract = Parameters<typeof computeConsensus>[0][number]
      type Analysis = { url: string; title: string; channel: string; analysis: string; at: number; via?: string }
      const [rawExtracts, rawAnalyses] = await Promise.all([
        blobAppStore.read<unknown[]>('video-extracts'),
        blobAppStore.read<Analysis[]>('video-analyses'),
      ])
      // A BLOB IS NOT A TYPE (D6, the same argument engine.mts's channelPicks
      // makes): a truncated write or an older schema puts a row on here with
      // no tickers array at all, and one bad row must not take the page down.
      const extracts = ((rawExtracts ?? []) as Extract[]).filter(e => e && typeof e.at === 'number' && Array.isArray(e.tickers) && Array.isArray(e.themes))
      const newestFirst = <T extends { at: number }>(rows: T[]) => [...rows].sort((a, b) => b.at - a.at)
      const videoIngestion = await videoIngestionHealth(blobAppStore, extracts, Math.floor(Date.now() / 1000), rawAnalyses ?? [])
      const data = {
        videoIngestion,
        socialLearning: summarizeSocialOutcomes(await blobAppStore.read<import('../../shared/engine/socialOutcomes').SocialOutcomeRecord[]>(SOCIAL_LEDGER_KEY) ?? []),
        // NEWEST FIRST off the STAMP, not off the blob's own order — the
        // extracts accumulate in write order, and a re-analysed video is
        // appended rather than moved.
        videos: newestFirst(extracts)
          .slice(0, STREET_VIDEOS)
          .map(e => ({
            url: e.url,
            title: e.title,
            channel: e.channel,
            at: e.at,
            ...(e.provenance ? { provenance: e.provenance } : {}),
            ...(e.publishedAt ? { publishedAt: e.publishedAt } : {}),
            ...(e.claims ? { claims: e.claims.slice(0, 40), coverage: e.coverage, evidenceVersion: e.evidenceVersion } : {}),
            // `levels` is dropped: it is the one unbounded field on an extract
            // and the wire prints what a channel SAID about a name, never the
            // prices it drew on a chart
            tickers: e.tickers.map(t => ({
              sym: t.sym, stance: t.stance,
              ...(typeof t.thesis === 'string' && t.thesis.trim() ? { thesis: t.thesis.slice(0, 240) } : {}),
              ...(typeof t.evidenceQuote === 'string' && t.evidenceQuote.trim() ? { evidenceQuote: t.evidenceQuote.slice(0, 400) } : {}),
              ...(typeof t.company === 'string' && t.company.trim() ? { company: t.company.slice(0, 120) } : {}),
              ...(t.hype === true ? { hype: true } : {}),
            })),
            themes: e.themes,
            // absent on rows older than the fallback — and absent here too,
            // rather than defaulted into a claim about how the video was read
            ...(e.via ? { via: e.via } : {}),
            ...(e.transcriptMethod ? { transcriptMethod: e.transcriptMethod } : {}),
            ...(e.nativeTranscript ? { nativeTranscript: {
              model: e.nativeTranscript.model, characters: e.nativeTranscript.characters,
              limitSeconds: e.nativeTranscript.limitSeconds, reportedDurationSeconds: e.nativeTranscript.reportedDurationSeconds,
              reportedComplete: e.nativeTranscript.reportedComplete, excerpt: e.nativeTranscript.excerpt.slice(0, 2000),
              ...(e.nativeTranscript.progress ? { progress: e.nativeTranscript.progress } : {}),
            } } : {}),
          })),
        reads: newestFirst((rawAnalyses ?? []).filter(a => a && typeof a.at === 'number' && typeof a.analysis === 'string')).slice(0, STREET_READS),
        // the WHOLE consensus, uncapped: the board slice's channelPicks caps at
        // eight because it rides a home screen — this page is the full board
        consensus: computeConsensus(extracts, Math.floor(Date.now() / 1000)).tickers,
        at: Math.floor(Date.now() / 1000),
      }
      await setCached('street-wire:v3', data, STREET_TTL_SEC)
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
