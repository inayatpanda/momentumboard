import { getCached, setCached } from './cache'

// Congressional (STOCK Act) trade disclosures via a source ladder. Checked
// 2026-07-10: every keyless source is DEAD today — both Stock Watcher S3
// buckets return 403 AccessDenied (the community project closed public access)
// and Finnhub's /stock/congressional-trading is premium-gated (403 on our key).
// FMP's endpoints exist (verified: they 401 "Invalid API KEY", not 404) but we
// hold no key. The ladder therefore usually resolves to { trades: [],
// source: 'none' } and the UI keeps its link-card fallback — but every adapter
// below is live code: adding QUIVER_API_KEY or FMP_API_KEY (or a Finnhub plan
// upgrade, or the buckets reopening) lights the feature up with zero changes.

export type CongressTrade = {
  politician: string
  chamber: 'senate' | 'house'
  party?: string
  symbol: string
  side: 'buy' | 'sell'
  amountRange: string // e.g. "$15,001–$50,000" as reported
  traded: string // ISO date of the trade
  filed: string // ISO date of the disclosure
}

export type CongressSource = 'quiverquant' | 'fmp' | 'finnhub' | 'stock-watcher' | 'none'

export interface CongressEnv {
  QUIVER_API_KEY?: string
  FMP_API_KEY?: string
  FINNHUB_API_KEY?: string
}

export interface CongressOpts {
  fetchFn?: typeof fetch
  cacheGet?: <T>(key: string) => Promise<T | null>
  cacheSet?: (key: string, value: unknown, ttlSec: number) => Promise<void>
}

const FETCH_TIMEOUT_MS = 5000 // no upstream may hold the response hostage
const MAX_TRADES = 500 // most recent N kept; plenty for a screen + watchlist filter

// ---- rolling history + aggregates (the Unusual-Whales-style roll-ups) ----
// Each successful sweep is merged into a persistent 90-day store, so over
// weeks the app can compute its OWN "most traded by Congress" / "most active
// politicians" from first-party disclosure data — no scraping anyone.

const HISTORY_KEY = 'congress-history'
const HISTORY_CAP = 4000
const WINDOW_DAYS = 90

interface HistoryStore {
  read: <T>(key: string) => Promise<T | null>
  write: (key: string, value: unknown) => Promise<void>
}

/** Merge a sweep into the rolling history (deduped, windowed, capped). Returns the merged window. */
export async function accumulateCongressHistory(store: HistoryStore, trades: CongressTrade[]): Promise<CongressTrade[]> {
  const prior = (await store.read<CongressTrade[]>(HISTORY_KEY)) ?? []
  if (!trades.length) return prior
  const key = (t: CongressTrade) => `${t.politician}|${t.symbol}|${t.side}|${t.traded}`
  const seen = new Map(prior.map(t => [key(t), t]))
  for (const t of trades) seen.set(key(t), t)
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10)
  const merged = [...seen.values()].filter(t => t.traded >= cutoff).sort(byTradedDesc).slice(0, HISTORY_CAP)
  await store.write(HISTORY_KEY, merged)
  return merged
}

export interface CongressAggregates {
  topTickers: { symbol: string; buys: number; sells: number }[]
  topPoliticians: { politician: string; chamber: 'senate' | 'house'; trades: number; lastTraded: string }[]
  historyCount: number
  since: string // oldest traded date in the window
}

/** Roll-ups over the history window; null until enough records accumulate to mean anything. */
export function congressAggregates(history: CongressTrade[]): CongressAggregates | null {
  if (history.length < 30) return null
  const bySym = new Map<string, { buys: number; sells: number }>()
  const byPol = new Map<string, { chamber: 'senate' | 'house'; trades: number; lastTraded: string }>()
  for (const t of history) {
    const s = bySym.get(t.symbol) ?? { buys: 0, sells: 0 }
    s[t.side === 'buy' ? 'buys' : 'sells']++
    bySym.set(t.symbol, s)
    const p = byPol.get(t.politician) ?? { chamber: t.chamber, trades: 0, lastTraded: t.traded }
    p.trades++
    if (t.traded > p.lastTraded) p.lastTraded = t.traded
    byPol.set(t.politician, p)
  }
  return {
    topTickers: [...bySym]
      .map(([symbol, v]) => ({ symbol, ...v }))
      .sort((a, b) => b.buys + b.sells - (a.buys + a.sells))
      .slice(0, 12),
    topPoliticians: [...byPol]
      .map(([politician, v]) => ({ politician, ...v }))
      .sort((a, b) => b.trades - a.trades)
      .slice(0, 8),
    historyCount: history.length,
    since: history[history.length - 1]?.traded ?? '',
  }
}
const STALE_DAYS = 180 // community datasets that stopped updating are treated as dead
const FINNHUB_DOWN_KEY = 'congress:finnhub-unavailable' // premium-gate marker, 24h
const SW_DOWN_KEY = 'congress:stockwatcher-unavailable' // dead-bucket marker, 24h
const DAY_SEC = 86_400

const tfetch = (fetchFn: typeof fetch, url: string, init: RequestInit = {}) =>
  fetchFn(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })

// ---- shared field normalisers ----

/** '09/06/2022' (Senate Stock Watcher), '2022-09-06', '2022-09-06 00:00:00' → ISO date; '' when unparseable. */
function isoDate(raw: unknown): string {
  const s = String(raw ?? '').trim()
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/)
  if (iso) return iso[1]
  const t = Date.parse(s)
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : ''
}

/** 'Purchase' → buy, 'Sale (Full)' / 'sale_partial' → sell, 'Exchange' → null (no directional signal). */
function sideOf(raw: unknown): 'buy' | 'sell' | null {
  const s = String(raw ?? '').toLowerCase()
  if (s.includes('purchase') || s.includes('buy')) return 'buy'
  if (s.includes('sale') || s.includes('sell')) return 'sell'
  return null
}

/** Disclosures are full of '--', 'N/A' and prose where a ticker should be — keep only plausible symbols. */
function cleanTicker(raw: unknown): string | null {
  const s = String(raw ?? '')
    .trim()
    .toUpperCase()
  return /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s) ? s : null
}

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`

/** Numeric bounds (Finnhub amountFrom/amountTo, Quiver Amount) → "$15,001–$50,000". */
function fmtRange(from?: unknown, to?: unknown): string {
  const f = Number(from)
  const t = Number(to)
  if (Number.isFinite(f) && f > 0 && Number.isFinite(t) && t > 0) return `${usd(f)}–${usd(t)}`
  if (Number.isFinite(f) && f > 0) return `${usd(f)}+`
  return ''
}

/** As-reported ranges arrive as "$1,001 - $15,000" — tighten the dash, keep the wording. */
const normRange = (raw: unknown): string =>
  String(raw ?? '')
    .trim()
    .replace(/\s*-\s*/, '–')

const byTradedDesc = (a: CongressTrade, b: CongressTrade) => b.traded.localeCompare(a.traded)

/** Disclosures occasionally carry typo'd future dates — drop anything >2 days ahead. */
const plausible = (t: CongressTrade) => t.traded !== '' && Date.parse(t.traded) < Date.now() + 2 * DAY_SEC * 1000

// ---- rung 1: QuiverQuant (needs QUIVER_API_KEY) ----

interface QuiverRow {
  Representative?: string
  Name?: string
  House?: string // 'Representatives' | 'Senate'
  Chamber?: string
  Transaction?: string // 'Purchase' | 'Sale' | 'Sale (Full)' | 'Sale (Partial)' | 'Exchange'
  Range?: string // '$15,001 - $50,000'
  Amount?: number | string // lower bound when Range is absent
  TransactionDate?: string
  ReportDate?: string
  Ticker?: string
  Party?: string // 'D' | 'R' | 'I'
}

function mapQuiverRow(r: QuiverRow): CongressTrade | null {
  const symbol = cleanTicker(r.Ticker)
  const side = sideOf(r.Transaction)
  const politician = String(r.Representative ?? r.Name ?? '').trim()
  const traded = isoDate(r.TransactionDate)
  if (!symbol || !side || !politician || !traded) return null
  const party = String(r.Party ?? '').trim() || undefined
  return {
    politician,
    chamber: /senat/i.test(String(r.House ?? r.Chamber ?? '')) ? 'senate' : 'house',
    ...(party ? { party } : {}),
    symbol,
    side,
    amountRange: normRange(r.Range) || fmtRange(r.Amount),
    traded,
    filed: isoDate(r.ReportDate) || traded,
  }
}

async function fromQuiver(key: string, fetchFn: typeof fetch): Promise<CongressTrade[] | null> {
  // Their docs have used both auth schemes over time; a bad token today comes
  // back as a Cloudflare-wrapped 500 HTML page (observed), not a clean 401 —
  // so anything that isn't ok-with-a-JSON-array means "try the other scheme".
  for (const scheme of ['Bearer', 'Token']) {
    try {
      const res = await tfetch(fetchFn, 'https://api.quiverquant.com/beta/live/congresstrading', {
        headers: { Authorization: `${scheme} ${key}`, Accept: 'application/json' },
      })
      if (!res.ok) continue
      const j = (await res.json().catch(() => null)) as QuiverRow[] | null
      if (!Array.isArray(j)) continue
      const trades = j.map(mapQuiverRow).filter((t): t is CongressTrade => t !== null && plausible(t))
      if (trades.length) return trades.sort(byTradedDesc).slice(0, MAX_TRADES)
    } catch {
      /* timeout / network — try the next scheme, then fall through the ladder */
    }
  }
  return null
}

// ---- rung 2: Financial Modeling Prep (needs FMP_API_KEY; free tier 250 calls/day) ----

const FMP_DOWN_KEY = 'congress:fmp-unavailable' // bad/gated key marker, 24h

// Defensive row type across FMP field namings: the stable latest lists use
// symbol/disclosureDate/firstName+lastName; the alternates (ticker,
// representative/office, dateRecieved — their long-standing typo) are kept
// in case FMP shuffles schemas again.
interface FmpRow {
  symbol?: string
  ticker?: string
  firstName?: string
  lastName?: string
  office?: string
  representative?: string
  type?: string // 'Purchase' | 'Sale (Full)' | 'purchase' | 'sale_partial' | ...
  amount?: string // '$1,001 - $15,000'
  transactionDate?: string
  disclosureDate?: string
  dateRecieved?: string
}

function mapFmpRow(chamber: 'senate' | 'house', r: FmpRow): CongressTrade | null {
  const symbol = cleanTicker(r.symbol ?? r.ticker)
  const side = sideOf(r.type)
  const fromParts = `${String(r.firstName ?? '').trim()} ${String(r.lastName ?? '').trim()}`.trim()
  const politician = (fromParts || String(r.representative ?? r.office ?? ''))
    .replace(/^Hon\.?\s+/i, '')
    .trim()
  const traded = isoDate(r.transactionDate)
  if (!symbol || !side || !politician || !traded) return null
  return { politician, chamber, symbol, side, amountRange: normRange(r.amount), traded, filed: isoDate(r.disclosureDate ?? r.dateRecieved) || traded }
}

async function fromFmp(
  fmpKey: string,
  fetchFn: typeof fetch,
  cacheGet: NonNullable<CongressOpts['cacheGet']>,
  cacheSet: NonNullable<CongressOpts['cacheSet']>,
): Promise<CongressTrade[] | null> {
  if (!fmpKey) return null
  if (await cacheGet<boolean>(FMP_DOWN_KEY)) return null
  const out: CongressTrade[] = []
  let gated = false
  const pull = async (url: string, chamber: 'senate' | 'house') => {
    try {
      const res = await tfetch(fetchFn, url)
      if (res.status === 401 || res.status === 403) {
        gated = true // invalid key / gated endpoint — remembered below
        return
      }
      if (!res.ok) return
      const j = (await res.json().catch(() => null)) as FmpRow[] | null
      if (!Array.isArray(j)) return
      for (const row of j) {
        const m = mapFmpRow(chamber, row)
        if (m && plausible(m)) out.push(m)
      }
    } catch {
      /* timeout / network — the other endpoint may still deliver */
    }
  }
  // Market-wide latest-disclosure lists: two calls cover both chambers.
  // Free-tier limits (verified live 2026-07-10 against a real free key):
  // limit must be ≤25 and only page=0 is allowed — anything bigger/deeper
  // returns 402 Payment Required. The legacy v4 per-symbol endpoints
  // (senate-trading / senate-disclosure) 403 for every key created after
  // Aug 2025, so they are gone from this rung — calling them would trip
  // `gated` and wrongly mark the WORKING stable channel down for 24h.
  await Promise.all([
    pull(`https://financialmodelingprep.com/stable/senate-latest?page=0&limit=25&apikey=${fmpKey}`, 'senate'),
    pull(`https://financialmodelingprep.com/stable/house-latest?page=0&limit=25&apikey=${fmpKey}`, 'house'),
  ])
  if (gated && !out.length) {
    await cacheSet(FMP_DOWN_KEY, true, 24 * 3600)
    return null
  }
  return out.length ? out.sort(byTradedDesc).slice(0, MAX_TRADES) : null
}

// ---- rung 3: Finnhub congressional-trading (premium-gated as of 2026-07) ----

interface FinnhubCongressTx {
  name?: string
  position?: string // where present, distinguishes Senate from House
  ownerType?: string
  transactionType?: string
  transactionDate?: string
  filingDate?: string
  amountFrom?: number
  amountTo?: number
  symbol?: string
}

function mapFinnhubRow(t: FinnhubCongressTx, sym: string): CongressTrade | null {
  const side = sideOf(t.transactionType)
  const politician = String(t.name ?? '').trim()
  const traded = isoDate(t.transactionDate)
  if (!side || !politician || !traded) return null
  return {
    politician,
    chamber: /senat/i.test(String(t.position ?? '')) ? 'senate' : 'house',
    symbol: cleanTicker(t.symbol) ?? sym,
    side,
    amountRange: fmtRange(t.amountFrom, t.amountTo),
    traded,
    filed: isoDate(t.filingDate) || traded,
  }
}

async function fromFinnhub(
  finnhubKey: string,
  symbols: string[],
  fetchFn: typeof fetch,
  cacheGet: NonNullable<CongressOpts['cacheGet']>,
  cacheSet: NonNullable<CongressOpts['cacheSet']>,
): Promise<CongressTrade[] | null> {
  if (!finnhubKey || !symbols.length) return null
  if (await cacheGet<boolean>(FINNHUB_DOWN_KEY)) return null // gated — don't hammer for 24h
  const out: CongressTrade[] = []
  const syms = [...new Set(symbols.map(s => s.toUpperCase()))].slice(0, 15)
  const started = Date.now()
  for (let i = 0; i < syms.length; i++) {
    if (Date.now() - started > 8000) break // total budget: ship what we have, cache does the rest
    try {
      const res = await tfetch(fetchFn, `https://finnhub.io/api/v1/stock/congressional-trading?symbol=${encodeURIComponent(syms[i])}&token=${finnhubKey}`)
      if (res.status === 401 || res.status === 403) {
        await cacheSet(FINNHUB_DOWN_KEY, true, 24 * 3600) // premium-gated: remember for a day
        return null
      }
      if (res.ok) {
        const j = (await res.json()) as { data?: FinnhubCongressTx[] }
        for (const t of j.data ?? []) {
          const m = mapFinnhubRow(t, syms[i])
          if (m && plausible(m)) out.push(m)
        }
      }
    } catch {
      /* one symbol failing must not kill the sweep */
    }
    if (i < syms.length - 1) await new Promise(r => setTimeout(r, 200)) // stay polite, like insiders.ts
  }
  return out.length ? out.sort(byTradedDesc).slice(0, MAX_TRADES) : null
}

// ---- rung 4: Senate/House Stock Watcher S3 datasets (keyless; dead as of 2026-07) ----

interface SenateWatcherRow {
  senator?: string
  transaction_date?: string // 'MM/DD/YYYY'
  disclosure_date?: string
  ticker?: string
  type?: string // 'Purchase' | 'Sale (Full)' | 'Sale (Partial)' | 'Exchange'
  amount?: string // '$1,001 - $15,000'
}

interface HouseWatcherRow {
  representative?: string // 'Hon. Jane Doe'
  transaction_date?: string // 'YYYY-MM-DD'
  disclosure_date?: string
  ticker?: string
  type?: string // 'purchase' | 'sale_full' | 'sale_partial' | 'exchange'
  amount?: string
}

function mapWatcherRow(chamber: 'senate' | 'house', r: SenateWatcherRow & HouseWatcherRow): CongressTrade | null {
  const symbol = cleanTicker(r.ticker)
  const side = sideOf(r.type)
  const politician = String(r.senator ?? r.representative ?? '')
    .replace(/^Hon\.?\s+/i, '')
    .trim()
  const traded = isoDate(r.transaction_date)
  if (!symbol || !side || !politician || !traded) return null
  return { politician, chamber, symbol, side, amountRange: normRange(r.amount), traded, filed: isoDate(r.disclosure_date) || traded }
}

async function fromStockWatcher(
  fetchFn: typeof fetch,
  cacheGet: NonNullable<CongressOpts['cacheGet']>,
  cacheSet: NonNullable<CongressOpts['cacheSet']>,
): Promise<CongressTrade[] | null> {
  if (await cacheGet<boolean>(SW_DOWN_KEY)) return null
  const sources = [
    { chamber: 'senate' as const, url: 'https://senate-stock-watcher-data.s3-us-west-2.amazonaws.com/aggregate/all_transactions.json' },
    { chamber: 'house' as const, url: 'https://house-stock-watcher-data.s3-us-west-2.amazonaws.com/data/all_transactions.json' },
  ]
  const all: CongressTrade[] = []
  await Promise.all(
    sources.map(async src => {
      try {
        const res = await tfetch(fetchFn, src.url)
        if (!res.ok) return // 403 AccessDenied today — bucket closed
        const j = (await res.json()) as (SenateWatcherRow & HouseWatcherRow)[]
        if (!Array.isArray(j)) return
        for (const row of j) {
          const m = mapWatcherRow(src.chamber, row)
          if (m && plausible(m)) all.push(m)
        }
      } catch {
        /* dead bucket / timeout on the huge file — the other chamber may still work */
      }
    }),
  )
  all.sort(byTradedDesc)
  // The community project may have stopped updating: a dataset whose newest
  // trade is ancient is worse than none (it would look like Congress went quiet).
  const fresh = all.length > 0 && Date.parse(all[0].traded) > Date.now() - STALE_DAYS * DAY_SEC * 1000
  if (!fresh) {
    await cacheSet(SW_DOWN_KEY, true, 24 * 3600)
    return null
  }
  return all.slice(0, MAX_TRADES)
}

// ---- the ladder ----

/** Congressional trades from the first live source: QuiverQuant (if keyed) →
 * FMP (if keyed; market-wide lists, then per-symbol) → Finnhub per-symbol
 * (premium-gated; `symbols` drives it, cap 15) → Stock Watcher S3. Fail-soft:
 * every rung swallows its own errors, dead rungs are remembered for 24h, and
 * the floor is { trades: [], source: 'none' }. */
export async function fetchCongressTrades(
  env: CongressEnv,
  symbols: string[] = [],
  opts: CongressOpts = {},
): Promise<{ trades: CongressTrade[]; source: CongressSource }> {
  const fetchFn = opts.fetchFn ?? fetch
  const cacheGet = opts.cacheGet ?? getCached
  const cacheSet = opts.cacheSet ?? setCached
  try {
    if (env.QUIVER_API_KEY) {
      const trades = await fromQuiver(env.QUIVER_API_KEY, fetchFn)
      if (trades?.length) return { trades, source: 'quiverquant' }
    }
    if (env.FMP_API_KEY) {
      const trades = await fromFmp(env.FMP_API_KEY, fetchFn, cacheGet, cacheSet)
      if (trades?.length) return { trades, source: 'fmp' }
    }
    const finnhub = await fromFinnhub(env.FINNHUB_API_KEY ?? '', symbols, fetchFn, cacheGet, cacheSet)
    if (finnhub?.length) return { trades: finnhub, source: 'finnhub' }
    const watcher = await fromStockWatcher(fetchFn, cacheGet, cacheSet)
    if (watcher?.length) return { trades: watcher, source: 'stock-watcher' }
  } catch {
    /* even a bug in the ladder must not 500 the Intel screen */
  }
  return { trades: [], source: 'none' }
}
