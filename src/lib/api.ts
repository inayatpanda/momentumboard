import type { ApiEnvelope, Candle, Quote } from '../../shared/types'
import type { AppConfig } from '../../shared/config'

export const getToken = () => localStorage.getItem('mb-token')
export const setToken = (t: string) => localStorage.setItem('mb-token', t)
export const clearToken = () => localStorage.removeItem('mb-token')

/** Self-served 7-day reader pass (landing page). Mints a real, expiring trial
 * licence server-side, stores it as this device's token, and resolves with the
 * key. Throws a human-readable error when the rate limit says no. */
export async function startTrial(): Promise<{ key: string }> {
  const res = await fetch('/api/licences', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trial: true }) })
  const body = (await res.json().catch(() => null)) as { ok?: boolean; data?: { key: string }; error?: string } | null
  if (!res.ok || !body?.ok || !body.data?.key) {
    throw new Error(
      body?.error === 'trial-limit'
        ? 'This network has used its free passes for the week. For a licence key, ask whoever shared StreetSignal with you — or try again next week.'
        : 'Could not start free access right now — try again shortly.',
    )
  }
  setToken(body.data.key)
  return { key: body.data.key }
}

/** Cheap boot-time token check: true = valid (admin or licensee), false = the
 * server rejected it (revoked or an expired trial). Network failures resolve
 * true — being offline must never lock a licensed reader out of cached data. */
export async function validateAccess(): Promise<boolean> {
  try {
    const res = await fetch('/api/licences?check=1', { headers: { 'x-app-token': getToken() ?? '' } })
    if (res.status === 401) return false
    return true
  } catch {
    return true
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { 'x-app-token': getToken() ?? '' } })
  const body = (await res.json()) as ApiEnvelope<T>
  if (!body.ok || body.data === undefined) throw new Error(body.error ?? `http-${res.status}`)
  return body.data
}

export const getQuotes = (symbols: string[]) =>
  apiGet<{ quotes: (Quote | null)[] }>(`/api/market?type=quote&symbols=${symbols.join(',')}`).then(d => d.quotes)

export const getCandles = (symbol: string, range = '1y') =>
  apiGet<{ candles: Candle[]; quote: Quote }>(`/api/market?type=candles&symbol=${encodeURIComponent(symbol)}&range=${range}`)

export const getCalendar = (symbols: string[]) =>
  apiGet<{ earnings: { symbol: string; date: string; hour: string; epsEstimate: number | null }[] }>(`/api/market?type=calendar&symbols=${symbols.join(',')}`).then(d => d.earnings)

export const getFeed = () =>
  apiGet<{ news: { title: string; url: string; symbols: string[] }[]; videos: { title: string; url: string; channel: string }[] }>('/api/market?type=feed')

export const resolveChannel = (handle: string) =>
  apiGet<{ id: string; name: string }>(`/api/market?type=resolve-channel&handle=${encodeURIComponent(handle)}`)

export const getInsiders = (symbols: string[]) =>
  apiGet<{ insiders: { symbol: string; buyers: string[]; totalValueUsd: number; isCluster: boolean; latest: { name: string; shares: number; date: string }[] }[] }>(`/api/market?type=insiders&symbols=${symbols.join(',')}`).then(d => d.insiders)

// One congressional (STOCK Act) trade disclosure, as reported. `party` is only
// present when the source provides it (QuiverQuant: 'D' | 'R' | 'I').
export interface CongressTrade {
  politician: string
  chamber: 'senate' | 'house'
  party?: string
  symbol: string
  side: 'buy' | 'sell'
  amountRange: string // as reported, e.g. "$15,001–$50,000"; may be '' when unreported
  traded: string // ISO date of the trade
  filed: string // ISO date of the disclosure
}

export type CongressSource = 'quiverquant' | 'fmp' | 'finnhub' | 'stock-watcher' | 'none'

/** Roll-ups over the server's rolling 90-day disclosure history; null until
 * enough sweeps have accumulated (~a week of collection). */
export interface CongressAggregates {
  topTickers: { symbol: string; buys: number; sells: number }[]
  topPoliticians: { politician: string; chamber: 'senate' | 'house'; trades: number; lastTraded: string }[]
  sectorBreakdown: { sector: string; buys: number; sells: number }[]
  historyCount: number
  since: string
}

// One politician's buys-vs-SPY grade. Excess = their symbol's return since the
// disclosed trade date minus SPY's over the same window; avgExcess/best are in
// percent (1dp), hitRate is a 0..1 share. Only sells-are-noise buys are scored.
export interface PoliticianScore {
  politician: string
  chamber: 'senate' | 'house'
  gradedBuys: number
  avgExcessPct: number
  hitRate: number
  bestCall: { symbol: string; excessPct: number }
}

/** Precomputed on the server clock as disclosures age; null until the first
 * grades land (buys must be ≥5 days old). rows: ≥2-buy politicians, best first. */
export interface CongressScorecard {
  rows: PoliticianScore[]
  gradedBuys: number
  skipped: number
  asOf: number
}

/** Congressional trades (most recent ~100 market-wide) plus the subset touching
 * the passed symbols. source === 'none' with no trades = every upstream is
 * dead/unkeyed — show the link-card fallback. `scorecard` is null until the warm
 * sweep has graded enough aged buys to mean anything. */
export const getCongress = (symbols?: string[]) =>
  apiGet<{ trades: CongressTrade[]; watchlistHits: CongressTrade[]; source: CongressSource; asOf: number; aggregates: CongressAggregates | null; scorecard: CongressScorecard | null }>(
    `/api/market?type=congress${symbols?.length ? `&symbols=${symbols.join(',')}` : ''}`,
  )

// One market-wide insider-buying cluster row: distinct open-market buyers over
// ~90 days, aggregated from the engine's roster coverage. `names` is the first
// few buyer names; `buyers` the full distinct count.
export interface InsiderCluster {
  symbol: string
  buyers: number
  totalValueUsd: number
  lastDate: string // ISO date of the most recent buy seen
  names: string[]
}

/** Top ~20 roster names by insider dollars bought. Empty list = the engine's
 * rotation hasn't accumulated coverage yet (fine — render an empty state). */
export const getInsiderClusters = () =>
  apiGet<{ clusters: InsiderCluster[]; asOf: number }>('/api/market?type=insider-clusters')

export const getSignalStats = () =>
  apiGet<{ scores: { setup: string; n: number; scored: number; win5: number | null; avg5: number | null; avg10: number | null }[]; totalSignals: number }>('/api/market?type=signal-stats')

export const getSmartMoney = () =>
  apiGet<{ funds: { fund: string; filedAt: string; newPositions: { issuer: string }[]; increased: { issuer: string; pctChange: number }[]; exited: { issuer: string }[] }[]; lagNote: string }>('/api/market?type=smart-money')

interface PulseRow {
  sym: string
  name?: string
  redditRank: number | null
  redditMentions: number | null
  surging: boolean
  surgeMultiple: number | null
  stocktwits: boolean
  channelNet: number | null
  sources: number
  onWatchlist: boolean
}

export const getSocialPulse = () =>
  apiGet<{
    discoveries: (PulseRow & { capUsdM: number | null; companyName?: string; opinion?: string })[]
    alsoLoud: string[]
    pulse: PulseRow[]
    at: number
  }>('/api/market?type=social')

export const evaluateNote = (text: string, kind: string) =>
  apiGet<{ take: string }>(`/api/market?type=evaluate-note&text=${encodeURIComponent(text)}&kind=${kind}`).then(d => d.take)

export const askDesk = (symbol: string, q: string) =>
  apiGet<{ answer: string; at: number }>(`/api/market?type=ask&symbol=${encodeURIComponent(symbol)}&q=${encodeURIComponent(q)}`)

export const getMonthMap = (month: string) =>
  apiGet<Record<string, { r?: boolean; p?: number; a?: number; e?: number }>>(`/api/config?view=month&month=${month}`)

export const getDayLedger = (date: string) =>
  apiGet<{
    date: string
    hasReport: boolean
    regime: string | null
    picks: { ticker: string; side: string; conviction?: string; strength?: string; priceAtPick?: number }[]
    alerts: { text: string; tier: string; at: number }[]
    events: { kind: string; name: string; assessment: string; at: number }[]
    videos: { title?: string; channel?: string; url: string }[]
  }>(`/api/config?view=day&date=${date}`)

export const getEventDossiers = () =>
  apiGet<{ kind: 'shock' | 'stretch'; sym: string; name: string; movePct?: number; zScore?: number; rsi?: number; dir: string; price: number; assessment: string; at: number; analogues?: { n: number; median5: number; p75_5: number; median20: number; maxExt5: number } | null }[]>('/api/config?view=events')

export const getSeasonality = (symbol: string) =>
  apiGet<{
    sym: string; years: number; reliable: boolean
    dow: { day: number; name: string; n: number; winRate: number | null; avgPct: number | null }[]
    months: { month: number; name: string; n: number; winRate: number | null; avgPct: number | null }[]
    bestMonth: { name: string; avgPct: number | null } | null
    worstMonth: { name: string; avgPct: number | null } | null
    strongestDay: { name: string; avgPct: number | null } | null
    weakestDay: { name: string; avgPct: number | null } | null
  }>(`/api/market?type=seasonality&symbol=${encodeURIComponent(symbol)}`)

export const getSectors = () =>
  apiGet<{ rows: { sym: string; name: string; rs5: number | null; rs21: number | null; rs63: number | null; trend: 'in' | 'out' | 'flat' }[]; rotatingIn: string[]; rotatingOut: string[]; at: number }>('/api/market?type=sectors')

export interface IpoRow {
  sym: string
  name: string
  date: string
  exchange: string
  priceRange: string
  status: 'expected' | 'priced' | 'filed' | 'withdrawn'
}

export const getIpos = () =>
  apiGet<{ upcoming: IpoRow[]; recent: IpoRow[]; at: number }>('/api/market?type=ipos')

export const getT212 = () =>
  apiGet<{ unconfigured?: boolean; positions?: { symbol: string; quantity: number; averagePrice: number; currentPrice: number; pplPct: number | null }[]; at?: number }>('/api/t212')

export const getTickerBrief = (symbol: string) =>
  apiGet<{ sym: string; brief: string; at: number }>(`/api/market?type=brief&symbol=${encodeURIComponent(symbol)}`)

export const getLicences = () =>
  apiGet<{ key: string; label: string; createdAt: number; revoked?: boolean; unlockLink: string }[]>('/api/licences')

export const getLlmKeyStatus = () => apiGet<{ hasKey: boolean }>('/api/config?view=llm-key')

export async function putLlmKey(groqKey: string) {
  const res = await fetch('/api/config?view=llm-key', {
    method: 'PUT',
    headers: { 'x-app-token': getToken() ?? '', 'content-type': 'application/json' },
    body: JSON.stringify({ groqKey }),
  })
  if (!res.ok) throw new Error('failed')
}

// BYO Trading 212: licensees connect their own read-only key pair; the owner's
// stays in server env. The server validates against T212 before storing.
export const getT212KeyStatus = () => apiGet<{ connected: boolean; source: 'env' | 'own' | null }>('/api/t212?view=key')

export async function putT212Key(apiKey: string, secret: string) {
  const res = await fetch('/api/t212', {
    method: 'PUT',
    headers: { 'x-app-token': getToken() ?? '', 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey, secret }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error === 't212-rejected' ? 'rejected' : 'failed')
  }
}

export async function deleteT212Key() {
  const res = await fetch('/api/t212', { method: 'DELETE', headers: { 'x-app-token': getToken() ?? '' } })
  if (!res.ok) throw new Error('failed')
}

export async function createLicence(label: string) {
  const res = await fetch('/api/licences', {
    method: 'POST',
    headers: { 'x-app-token': getToken() ?? '', 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  })
  const body = (await res.json()) as ApiEnvelope<{ key: string; label: string; unlockLink: string }>
  if (!body.ok || !body.data) throw new Error(body.error ?? 'failed')
  return body.data
}

export async function revokeLicence(key: string) {
  await fetch('/api/licences', {
    method: 'DELETE',
    headers: { 'x-app-token': getToken() ?? '', 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
  })
}

export const getEcon = () =>
  apiGet<{ events: { title: string; country: string; at: number; impact: string }[] }>('/api/market?type=econ').then(d => d.events)

export interface MoverRow {
  sym: string
  price: number | null
  capUsdM: number | null
  changePct: number | null
  name: string | null
  stage: string | null
}

export const getReportList = () => apiGet<string[]>('/report?list')

export const getBulletins = () => apiGet<{ date: string; kind: 'premarket' | 'evening' }[]>('/report?bulletins')

export const getMovers = () =>
  apiGet<{ gainers: MoverRow[]; losers: MoverRow[]; actives: MoverRow[]; at: number }>('/api/market?type=movers')

export const getTrending = () =>
  apiGet<{ current: { at: number; watchlist: { sym: string; changePct: number; rvol: number | null; setups: string[] }[]; market: { sym: string; changePct: number | null }[] } | null; timeline: unknown[] }>('/api/config?view=trending')

export const getOutcomes = () =>
  apiGet<{ date: string; regime?: string; picks: { ticker: string; side: string; strength?: string; conviction?: string; priceAtPick?: number; f5: number | null; f10: number | null }[] }[]>('/api/config?view=outcomes')

export const getPickStats = () =>
  apiGet<{ scores: { bucket: string; n: number; scored: number; win5: number | null; avg5: number | null; avg10: number | null }[]; reports: number }>('/api/market?type=pick-stats')

export const getPicks = () =>
  apiGet<{ persistence: { ticker: string; side: 'long' | 'short'; appearances: number; streak: number; latestConviction?: string; persistent: boolean }[]; reports: number; latest: { date: string; regime?: string } | null }>('/api/config?view=picks')

export const getConsensus = () =>
  apiGet<{ tickers: { sym: string; mentions7d: number; mentionsPrior7d: number; channels: number; bulls: number; bears: number; net: number; crowded: boolean; shifted: boolean }[]; themes: { theme: string; count7d: number }[] }>('/api/config?view=consensus')

export const getVideoAnalyses = () =>
  apiGet<{ url: string; title: string; channel: string; analysis: string; at: number }[]>('/api/config?view=videos')

export const getAlertHistory = () =>
  apiGet<{ text: string; tier: string; at: number }[]>('/api/config?view=history')

export const getRunlog = () =>
  apiGet<{ at: number; events: number; sent: number; errors: string[] }[]>('/api/config?view=runlog')

export const getAiRead = () =>
  apiGet<{ text?: string; provider?: string; at?: number; unconfigured?: boolean; empty?: boolean }>('/api/ai')

export const getNews = (symbol: string) =>
  apiGet<{ items: { title: string; url: string; publishedSec: number }[] }>(`/api/market?type=news&symbol=${encodeURIComponent(symbol)}`).then(d => d.items)

export async function putConfig(cfg: AppConfig): Promise<void> {
  // keepalive: the request survives the user switching away from the app mid-send
  const res = await fetch('/api/config', {
    method: 'PUT',
    headers: { 'x-app-token': getToken() ?? '', 'content-type': 'application/json' },
    body: JSON.stringify(cfg),
    keepalive: true,
  })
  const body = (await res.json()) as ApiEnvelope<AppConfig>
  if (!body.ok) throw new Error(body.error ?? `http-${res.status}`)
}

// ---- the prediction engine ----

export interface EnginePrediction {
  id: string
  sym: string
  side: 'long' | 'short'
  composite: number
  probability: number
  provisional: boolean
  grade: 'A' | 'B' | 'C'
  expectedMovePct: number
  entry: number
  stop: number
  target: number
  capacityPct: number
  smallCap: boolean
  earningsRisk: boolean
  stage: string | null
  note: string
  riskRung: number
  riskPct: number
  instrument: { ticker: string; leverage: number } | null
  paperOnly: boolean
  // grade C / thin evidence: published and graded, but an observation — no
  // size, no instrument. Only A/B contract-passing calls are trades.
  watchOnly?: boolean
  setup?: 'continuation' | 'reversal' | 'fade' | null
  evidence?: { coverage: number; famAgree: number; contract: boolean; contextPts: number; detail: string }
  factors: Record<string, { score: number | null; detail: string; weight: number }>
  overlay?: { flag: string; reason: string }
  themes?: string[]
  capUsdM?: number | null
  catalyst?: { kind: string; reason: string }
}

// A prediction's realised outcome over one horizon: side-adjusted excess vs SPY,
// plus whether it hit / got stopped. Absent horizon = not yet matured.
export interface PredOutcome {
  excessPct: number
  rawPct: number
  spyPct: number
  stopped: boolean
  hit: boolean
}

// The slimmed ledger prediction: everything the accountability pane shows for a
// card, minus the per-factor breakdown (that rides the live board's evidence).
export interface LedgerPrediction {
  id: string
  date: string
  sym: string
  side: 'long' | 'short'
  grade: 'A' | 'B' | 'C'
  probability: number
  provisional: boolean
  shadow: boolean
  composite: number
  capUsdM?: number | null
  entry: number
  stop: number
  target: number
  expectedMovePct: number
  stage: string | null
  regime: string
  worldTape?: { tone: string; mult: number }
  earningsRisk: boolean
  overlay?: { flag: 'boost' | 'caution' | 'veto'; reason: string }
  outcome5?: PredOutcome
  outcome10?: PredOutcome
  instrument: { ticker: string; leverage: number } | null
  paperOnly: boolean
  note: string
}

export interface LedgerDay {
  date: string
  predictions: LedgerPrediction[]
}

// One held name as the engine reads it: the daily stage/quality opinion plus the
// live P&L% and size. Read-only tracking — journalling for stop alerts stays the
// existing T212 import button.
export interface HoldingRead {
  sym: string
  stage: string | null
  entryQuality: string | null
  note: string | null
  capacityPct: number | null
  pplPct: number | null
  quantity: number
}

// One open (not-yet-graded) live call, re-checked each morning: the mechanical
// walk since entry (stop/target on daily closes) plus the engine's opinion on
// whether it would still take the trade. Display-only — grading never moves.
export interface OpenTraceEntry {
  id: string
  sym: string
  side: 'long' | 'short'
  callDate: string
  grade: 'A' | 'B' | 'C'
  entry: number
  stop: number
  target: number
  status: 'in-play' | 'stopped' | 'target'
  crossedDate: string | null
  last: number
  movePct: number // side-adjusted, from the published entry level
  progressPct: number | null // % of the entry→target span covered
  day: number // entry session = day 1
  gradesInSessions: number
  stage: string | null
  requalified: boolean // made today's live board again, same side
  verdict: 'still-on' | 'intact' | 'weakening' | null // in-play only
  note: string
}

export interface PaperBookPosition {
  sym: string
  side: 'long' | 'short'
  grade: string
  openedDate: string
  entry: number
  stop: number
  target: number
  qty: number
  costGBP: number
}

export interface PaperBookTrade extends PaperBookPosition {
  closedDate: string
  exit: number
  plGBP: number
  plPct: number
  reason: 'stop' | 'target' | 'horizon' | 'month-end'
}

export interface PaperBookData {
  month: string
  startGBP: number
  cash: number
  positions: PaperBookPosition[]
  closed: PaperBookTrade[]
  history: { date: string; equity: number }[]
}

export interface EngineData {
  runStatus?: {
    startedAt: number
    updatedAt: number
    phase: string
    completedAt?: number
    failedAt?: number
    error?: string
    graded?: number
    boardSize?: number
    rosterSize?: number
    holdingsCount?: number
    regime?: string
  } | null
  paperBook?: PaperBookData | null
  paperMonths?: { month: string; startGBP: number; endGBP: number; returnPct: number; trades: number; wins: number }[]
  board: {
    date: string
    generatedAt: number
    regime: string
    board: EnginePrediction[]
    worldTape?: { tone: string; votes: { on: number; off: number }; detail: string }
    newsTone?: { score: number; label: string; hits: number }
    themes?: { key: string; name: string; hits: number }[]
  } | null
  ledger?: LedgerDay[]
  // the open book: every not-yet-graded live call, traced daily (null until the
  // first predict run writes it). Powers the Ledger's "where they stand" pane.
  openTrace?: { date: string; generatedAt: number; entries: OpenTraceEntry[] } | null
  newsToneHistory?: { date: string; score: number; label: string }[]
  // the engine's daily read-only opinion on every REAL T212 holding (null until the
  // first predict run writes it). Powers the Desk's read-only holdings-tracking pane.
  holdingsReads?: HoldingRead[] | null
  scorecard: {
    byGrade: Record<string, { n: number; hits: number; sumExcess: number }>
    byRegime: Record<string, { n: number; hits: number }>
    overlays: Record<string, { n: number; hits: number }>
    brierTail: { date: string; mean: number; n: number }[]
    totalGraded: number
    lifetime?: { live: { graded: number; hits: number; sumExcess: number }; shadow: { graded: number; hits: number; sumExcess: number }; since: string }
  } | null
  weights: { base: Record<string, number>; current: Record<string, number>; history: { date: string; changes: Record<string, { from: number; to: number; ic: number }>; evidence: string }[] } | null
  // buckets are keyed EITHER `${cohort}:${side}:${regime}:${band}` (cohort =
  // large|small, Phase 2) or the legacy cohortless `${side}:${regime}:${band}`
  // (seed + unknown-cap grades). Consumers that split the key must parse from the
  // END (band last) — see CalibrationPlot. Filter by the `${cohort}:` prefix to
  // build a per-sleeve view.
  calibration: {
    buckets: Record<string, { n: number; hits: number }>
    brier: { date: string; mean: number; n: number }[]
    seeded: boolean
    modelVersion?: number | null
    evidence?: { seed: { n: number; hits: number }; live: { n: number; hits: number }; shadow: { n: number; hits: number } } | null
  } | null
  // top-level = the COMBINED rung (back-compat: every existing screen reads this);
  // `cohorts` = the per-cap-class rungs added in Phase 2 (the data a two-pane desk
  // view will read). Absent on a not-yet-migrated blob.
  riskState:
    | {
        rung: number
        sinceDate: string
        gradedAtRung: number
        history: { date: string; from: number; to: number; evidence: string }[]
        cohorts?: {
          large: { rung: number; sinceDate: string; gradedAtRung: number; history: { date: string; from: number; to: number; evidence: string }[] }
          small: { rung: number; sinceDate: string; gradedAtRung: number; history: { date: string; from: number; to: number; evidence: string }[] }
        }
      }
    | null
  roster: { entries: { sym: string; joined: string; source: string; capUsdM: number | null; lastCapacity: number | null }[]; changes: { date: string; joined: string[]; dropped: { sym: string; why: string }[] }[] } | null
  channelCred: Record<string, { graded: number; hits: number; avgExcess: number | null }>
}

export const getEngine = () => apiGet<EngineData>('/api/engine')
