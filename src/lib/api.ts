import type { SocialClaim, SocialCoverage } from '../../shared/socialEvidence'
import type { SocialLearningSummary } from '../../shared/engine/socialOutcomes'
import type { ApiEnvelope, Candle, Quote } from '../../shared/types'
import type { AppConfig } from '../../shared/config'
import type { EmptySideReason } from '../../shared/engine/types'
import type { MissLedgerSummary } from '../../shared/engine/missLedger'
import type { GateStateSummary } from '../../shared/engine/gateState'
import type { EngineLabSnapshot, ForecastContract, StrategySleeve } from '../../shared/engine/strategyLab'
// TYPE-ONLY, and deliberately so: apiViews.ts imports this file for `apiGet`,
// and a value import back would close the cycle. `ChannelPick` is the client's
// one mirror of the server's TickerConsensus and belongs beside the board slice
// it has always ridden — The street's wire carries the same rows, uncapped.
import type { ChannelPick } from './apiViews'
import type { LlmKeySource } from '../../shared/llmKey'
import { deviceLlmHeader, hasDeviceGroqKey } from './deviceLlm'

export const getToken = () => localStorage.getItem('mb-token')

// --- THE DMG FREE TIER (owner decision, 2026-08-15) -------------------------
// The desktop build bakes a SHARED licence token (VITE_FREE_TOKEN, set only in
// .env.dmg — never in web builds) so the app opens with no gate. Revoking that
// one licence server-side flips every free DMG back to the licence door.

/** Seed the shared token on a tokenless device. An explicit personal unlock
 * (?key= link, typed key) always wins — this only fills silence. */
export function seedFreeTierToken(): void {
  const free = import.meta.env.VITE_FREE_TOKEN
  if (!free || localStorage.getItem('mb-token')) return
  localStorage.setItem('mb-token', free)
  localStorage.setItem('mb-token-at', String(Date.now()))
}

/** Is this device on the shared free token? Free devices are SYNC-ISOLATED:
 * they all share one server namespace, so config push/pull would cross-
 * pollinate watchlists between installs (sync.ts / configMirror.ts no-op). */
export function isSharedFreeToken(): boolean {
  const free = import.meta.env.VITE_FREE_TOKEN
  return !!free && getToken() === free
}
export const setToken = (t: string) => localStorage.setItem('mb-token', t)
export const clearToken = () => localStorage.removeItem('mb-token')

/* ─────────────────────────── the API origin ───────────────────────────
 * THE ONE PLACE the server's origin is decided.
 *
 * On the web this is empty and every call below stays relative — same-origin,
 * cookies and `_headers` behave exactly as they always have, and the built
 * bundle is unchanged. The desktop shell (Tauri) is the reason it exists: it
 * serves this SAME dist from `tauri://localhost`, an origin with no server
 * behind it, so a relative `/api/…` would resolve against the local asset
 * protocol and 404 forever. `npm run build:dmg` bakes the production origin in
 * via VITE_API_BASE, and `functions/_middleware.ts` answers the resulting
 * cross-origin requests with CORS for those two Tauri origins only.
 *
 * Everything that talks to the server — here, apiViews.ts, push.ts,
 * portfolioMirror.ts, SettingsAdmin.tsx — goes through `apiUrl`. Adding a
 * bare `fetch('/api/…')` anywhere else silently breaks the desktop build only.
 */
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? ''

/** Absolute-ise a server path against `API_BASE`. Identity on the web. */
export function apiUrl(path: string): string {
  if (!API_BASE) return path
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path
  return `${API_BASE.replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}`
}

/** Self-served 7-day reader pass (landing page). Mints a real, expiring trial
 * licence server-side, stores it as this device's token, and resolves with the
 * key. Throws a human-readable error when the rate limit says no. */
export async function startTrial(): Promise<{ key: string }> {
  const res = await fetch(apiUrl('/api/licences'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trial: true }) })
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
    const res = await fetch(apiUrl('/api/licences?check=1'), { headers: { 'x-app-token': getToken() ?? '' } })
    if (res.status === 401) return false
    return true
  } catch {
    return true
  }
}

async function requestEnvelope<T>(path: string, headers: Record<string, string>, timeoutMs: number): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(apiUrl(path), { headers, signal: controller.signal })
    const body = await res.json().catch(() => null) as ApiEnvelope<T> | null
    if (!res.ok || !body?.ok || body.data === undefined) {
      throw new Error(body?.error ?? `http-${res.status}`)
    }
    return body.data
  } catch (error) {
    if (controller.signal.aborted) throw new Error('The request timed out. Please try refreshing again.')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  return requestEnvelope(path, { 'x-app-token': getToken() ?? '' }, 30_000)
}

/** THE ONLY CALLER THAT ATTACHES THE BYOK CREDENTIAL. The device key is read
 * from IndexedDB for this one request, crosses TLS, and is never written to
 * server configuration — so it rides exactly the four endpoints below that
 * invoke an LLM (evaluate-note, ask, brief, /api/ai) and nothing else.
 *
 * `keyOverride` is Settings testing a candidate key BEFORE it is stored. */
export async function apiLlmGet<T>(path: string, keyOverride?: string): Promise<T> {
  return requestEnvelope(path, { 'x-app-token': getToken() ?? '', ...(await deviceLlmHeader(keyOverride)) }, 90_000)
}

export const getQuotes = (symbols: string[]) =>
  apiGet<{ quotes: (Quote | null)[] }>(`/api/market?type=quote&symbols=${symbols.join(',')}`).then(d => d.quotes)

export const getCandles = (symbol: string, range = '1y') =>
  apiGet<{ candles: Candle[]; quote: Quote }>(`/api/market?type=candles&symbol=${encodeURIComponent(symbol)}&range=${range}`)

export const getCalendar = (symbols: string[]) =>
  apiGet<{ earnings: { symbol: string; date: string; hour: string; epsEstimate: number | null }[] }>(`/api/market?type=calendar&symbols=${symbols.join(',')}`).then(d => d.earnings)

export interface SecFiling {
  accession: string
  form: string
  filed: string
  reportDate: string
  description: string
  items: string
  url: string
}

export const getFilings = (symbol: string) =>
  apiGet<{ company: string | null; cik: number | null; filings: SecFiling[]; asOf: number; unavailable?: boolean }>(`/api/market?type=filings&symbol=${encodeURIComponent(symbol)}`)

export const getBusinessHealth = (symbol: string) =>
  apiGet<import('../../shared/businessHealth').BusinessHealthSnapshot>(`/api/market?type=business-health&symbol=${encodeURIComponent(symbol)}`)

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

// The triaged news desk: every fresh headline analysed and importance-scored
// (0-100) by the news editor (LLM, heuristic fallback). Newest first.
export interface NewsDeskItem { title: string; url: string; syms: string[]; score: number; why: string; at: number; source?: string }
export const getNewsDesk = () => apiGet<{ items: NewsDeskItem[] }>('/api/market?type=news-desk').then(d => d.items)

export const getSignalStats = () =>
  apiGet<{ scores: { setup: string; n: number; scored: number; win5: number | null; avg5: number | null; scored10: number; avg10: number | null }[]; totalSignals: number }>('/api/market?type=signal-stats')

export const getSmartMoney = () =>
  apiGet<{ funds: { fund: string; filedAt: string; newPositions: { issuer: string }[]; increased: { issuer: string; pctChange: number }[]; exited: { issuer: string }[] }[]; lagNote: string }>('/api/market?type=smart-money')

export interface PulseRow {
  sym: string
  name?: string
  redditRank: number | null
  redditMentions: number | null
  redditUpvotes: number | null
  redditRankDelta: number | null
  redditEngagement: number | null
  surging: boolean
  surgeMultiple: number | null
  stocktwits: boolean
  channelNet: number | null
  channelMentions: number | null
  channelMentionsPrior: number | null
  channelVelocity: number | null
  channelBreadth: number | null
  channelHype: number
  channelEvidence: { channel: string; stance: 'bull' | 'bear' | 'neutral'; thesis?: string; levels: number[]; hype: boolean; at: number; url: string }[]
  evidenceScore?: number
  scanVelocity?: number | null
  sources: number
  onWatchlist: boolean
  firstSeenAt?: number
  observedDays?: number
}

export const getSocialPulse = () =>
  apiGet<{
    discoveries: (PulseRow & { capUsdM: number | null; companyName?: string; opinion?: string })[]
    alsoLoud: string[]
    pulse: PulseRow[]
    at: number
  }>('/api/market?type=social')

export interface SocialMemoryDay {
  date: string
  observedAt: number
  summary: string
  metrics: {
    sources: number
    redditRank: number | null
    redditMentions: number | null
    redditUpvotes: number | null
    surgeMultiple: number | null
    stocktwits: boolean
    channelNet: number | null
    channelMentions: number | null
    channelBreadth: number | null
    evidenceScore: number | null
  }
  youtube: {
    at: number
    title: string
    channel: string
    url: string
    stance: 'bull' | 'bear' | 'neutral'
    thesis?: string
    levels: number[]
    hype: boolean
  }[]
}

export const getSocialMemory = (symbol: string) =>
  apiGet<{ symbol: string; days: SocialMemoryDay[] }>(`/api/market?type=social-memory&symbol=${encodeURIComponent(symbol)}`).then(data => data.days)

// --- THE STREET (owner request) ---------------------------------------------
// "the summary of youtube video input deserve a section of their own, and there
//  should be a system where the youtube suggestions are also evaluated by our
//  engine and highlighted — all in a new page/tab altogether."
//
// Mirrors netlify/functions/market-data.mts's `type=street` 1:1. `levels` is
// deliberately absent from the ticker shape: the server strips it, because this
// wire's claim is what a channel SAID about a name, never the prices it drew.

/** One analysed video, as the wire renders it. */
export interface StreetVideo {
  nativeTranscript?: { model: string; characters: number; limitSeconds: number; reportedDurationSeconds: number | null; reportedComplete: boolean; excerpt: string }
  transcriptMethod?: 'captions' | 'speech'
  provenance?: 'first-party' | 'third-party' | 'manual'
  publishedAt?: number
  claims?: SocialClaim[]
  coverage?: SocialCoverage
  evidenceVersion?: string
  url: string
  title: string
  channel: string
  /** UNIX SECONDS, like the news desk's — `relativeStamp` reads the unit by
   * magnitude, so nothing downstream has to know which this is. */
  at: number
  tickers: { sym: string; stance: 'bull' | 'bear' | 'neutral'; company?: string; thesis?: string; evidenceQuote?: string; hype?: boolean }[]
  themes: string[]
  /** HOW THE FACTS WERE OBTAINED: 'gemini-video' means the model watched the
   * video, anything else means it read words. Absent on rows older than the
   * fallback, and the page then says nothing rather than guessing. */
  via?: 'local' | 'github' | 'free' | 'supadata' | 'gemini-video' | 'transcript'
}

/** One watch-tier narrative read — plain prose, already short by construction. */
export interface StreetRead {
  url: string
  title: string
  channel: string
  analysis: string
  at: number
  via?: string
}

export interface StreetWire {
  socialLearning?: SocialLearningSummary
  videos: StreetVideo[]
  reads: StreetRead[]
  /** The FULL cross-channel consensus — uncapped, unlike the board slice's
   * eight-name `channelPicks`, which is capped to fit a home screen. */
  consensus: ChannelPick[]
  at: number
  videoIngestion?: {
    channels?: { id: string; name: string; discovered: number; captured: number; analysed: number; awaitingCapture: number; latestPublishedAt: number | null }[]
    discoveryWindow?: { videos: number; since: number | null }
    localRunner?: { at: number; running: boolean; saved: number; unavailable: number; buffered: number; stale: boolean } | null
    githubRunner?: { at: number; running: boolean; status: string; saved: number; unavailable: number; attempted: number; captions: number; speech: number; reused?: number; blocked: number; stale: boolean } | null
    githubLastSavedAt?: number | null
    githubTranscriptCount?: number
    nativeRunner?: { at: number; running: boolean; published: number; attempted: number; failed: number; reused: number; capped: boolean; scheduled?: boolean; status: string; stale: boolean } | null
    provider?: { checkedAt: number; status: string; plan?: string; remainingCredits?: number } | null
    localLastSavedAt?: number | null
    localSpeechCount?: number
    workerLastSeenAt?: number | null
    workerStale?: boolean
    oldestPendingAt?: number | null
    jobs?: { id: string; title: string; url: string; mode: string; stage: string; at: number; attempts: number; nextAttemptAt: number; reason?: string }[]
    pendingTranscripts: number
    queued: number
    deferred: number
    failed: number
    lastTranscriptAt: number | null
    lastExtractAt: number | null
    nextRetryAt: number | null
    recentFailures: { title: string; reason: string; at: number }[]
  }
}

export const getStreetWire = () => apiGet<StreetWire>('/api/market?type=street')

export const evaluateNote = (text: string, kind: string) =>
  apiLlmGet<{ take: string }>(`/api/market?type=evaluate-note&text=${encodeURIComponent(text)}&kind=${kind}`).then(d => d.take)

// `context` (CX-20) is the v2 Ask sheet's own compact JSON of the journey
// page's hero state — sized/refused/on-demand, grade-or-not, core/lean, the
// gate label if refused, the open-trace verdict if a call is live. It rides
// as its own query param so the server's 400-char clamp on `q` never touches
// it. Optional: the legacy AskDesk card calls this with two args, unchanged.
export const askDesk = (symbol: string, q: string, context?: unknown) =>
  apiLlmGet<{ answer: string; at: number; llmKeySource?: LlmKeySource }>(
    `/api/market?type=ask&symbol=${encodeURIComponent(symbol)}&q=${encodeURIComponent(q)}${context !== undefined ? `&context=${encodeURIComponent(JSON.stringify(context))}` : ''}`,
  )

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

// members: the sector's real constituent tickers (server: SECTOR_MEMBERS,
// CX-24) — the Sectors see-all page expands a tile to these, never invented.
export const getSectors = () =>
  apiGet<{ rows: { sym: string; name: string; rs5: number | null; rs21: number | null; rs63: number | null; trend: 'in' | 'out' | 'flat'; members: string[] }[]; rotatingIn: string[]; rotatingOut: string[]; at: number }>('/api/market?type=sectors')

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

export const getTickerBrief = (symbol: string) =>
  apiLlmGet<{ sym: string; brief: string; at: number; llmKeySource?: LlmKeySource }>(`/api/market?type=brief&symbol=${encodeURIComponent(symbol)}`)

export const getLicences = () =>
  apiGet<{ key: string; label: string; createdAt: number; revoked?: boolean; unlockLink: string }[]>('/api/licences')

/** Does this reader have a working AI key, and WHERE does it live?
 *
 * Device first — that path is local and cannot fail — then the server's own
 * answer about the pre-device copy it still honours. Deliberately NOT
 * swallowed: a network failure must propagate so callers that fail open (the
 * Ask sheet) can tell "no key" apart from "could not ask". The server never
 * returns the key itself on this or any route. */
export async function getLlmKeyStatus(): Promise<{ hasKey: boolean; llmKeySource: LlmKeySource | null }> {
  if (await hasDeviceGroqKey()) return { hasKey: true, llmKeySource: 'device' }
  const s = await apiGet<{ hasKey: boolean; llmKeySource: LlmKeySource | null }>('/api/config?view=llm-key')
  return { hasKey: !!s.hasKey, llmKeySource: s.hasKey ? 'server' : null }
}

/** Drop the pre-device server copy. Called once a device key exists, so the
 * migration ends with the server holding no provider credential at all.
 * There is no matching read/PUT: the key only ever goes ON to a device now. */
export async function deleteServerLlmKey() {
  const res = await fetch(apiUrl('/api/config?view=llm-key'), {
    method: 'DELETE',
    headers: { 'x-app-token': getToken() ?? '' },
  })
  if (!res.ok) throw new Error('failed')
}

/** Round-trip a CANDIDATE key to Groq without storing it anywhere. */
export async function probeGroqKey(groqKey: string) {
  return apiLlmGet<{ provider: string; model: string }>('/api/market?type=llm-probe', groqKey)
}

export async function createLicence(label: string) {
  const res = await fetch(apiUrl('/api/licences'), {
    method: 'POST',
    headers: { 'x-app-token': getToken() ?? '', 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  })
  const body = (await res.json()) as ApiEnvelope<{ key: string; label: string; unlockLink: string }>
  if (!body.ok || !body.data) throw new Error(body.error ?? 'failed')
  return body.data
}

export async function revokeLicence(key: string) {
  await fetch(apiUrl('/api/licences'), {
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

export type BulletinKind = 'premarket' | 'evening'
export interface BulletinEdition {
  kind: BulletinKind
  date: string
  at: number
  subject: string
  text: string
  html: string
}

export const getBulletinJson = (date: string, kind: BulletinKind) =>
  apiGet<BulletinEdition>(`/report?format=json&bulletin=${encodeURIComponent(`${date}:${kind}`)}`)

// The paper, inline (CX-19): the same edition the download/print modes serve,
// as a JSON envelope carrying ready-to-render HTML — so the v2 Intel screen
// can drop it straight into a sandboxed srcDoc iframe instead of an
// X-Frame-Options-blocked navigation. No `date` = the latest edition.
export const getReportJson = (date?: string) =>
  apiGet<{ date: string; at: number; html: string }>(`/report?format=json${date ? `&date=${encodeURIComponent(date)}` : ''}`)

export const getMovers = () =>
  apiGet<{ gainers: MoverRow[]; losers: MoverRow[]; actives: MoverRow[]; at: number }>('/api/market?type=movers')

export const getTrending = () =>
  apiGet<{ current: { at: number; watchlist: { sym: string; changePct: number; rvol: number | null; setups: string[] }[]; market: { sym: string; changePct: number | null }[] } | null; timeline: unknown[] }>('/api/config?view=trending')

export const getOutcomes = () =>
  apiGet<{ date: string; regime?: string; picks: { ticker: string; side: string; strength?: string; conviction?: string; priceAtPick?: number; f5: number | null; f10: number | null }[] }[]>('/api/config?view=outcomes')

export const getPickStats = () =>
  apiGet<{ scores: { bucket: string; n: number; scored: number; win5: number | null; avg5: number | null; withStop: number; stopped5: number | null; scored10: number; avg10: number | null }[]; reports: number }>('/api/market?type=pick-stats')

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
  apiLlmGet<{ text?: string; provider?: string; at?: number; unconfigured?: boolean; empty?: boolean; llmKeySource?: LlmKeySource }>('/api/ai')

export const getNews = (symbol: string) =>
  apiGet<{ items: { title: string; url: string; publishedSec: number }[] }>(`/api/market?type=news&symbol=${encodeURIComponent(symbol)}`).then(d => d.items)

export async function putConfig(cfg: AppConfig): Promise<void> {
  // keepalive: the request survives the user switching away from the app mid-send
  const res = await fetch(apiUrl('/api/config'), {
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
  name?: string // company display name stamped by the engine at publication
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
  // What this call believes, in one plain-English sentence, and what would prove
  // it wrong (shared/engine/voice.ts). The card LEADS with the thesis; `note`
  // survives beneath it as the evidence line. Optional: a near miss has neither
  // (it cleared no gate, so there is no belief to state), and neither does any
  // row published before the engine had a voice.
  thesis?: string
  falsifier?: string
  riskRung: number
  riskPct: number
  instrument: { ticker: string; leverage: number } | null
  paperOnly: boolean
  // an observation, not a trade: grade C on thin evidence, a below-base read, or
  // an actionable row the diversity gates did not pick. A/B on the full contract
  // carry full size; C WITH the contract and A/B WITHOUT it carry half.
  watchOnly?: boolean
  // fully-evidenced watch row whose probability sits BELOW the grade bar — the
  // hit rate of an ordinary candidate (`calibration.referenceBase`, or the pooled
  // base until a seed sweeps one). No edge over doing nothing in particular, so it
  // is shown and tracked but never sized. [spec §9]
  belowBase?: boolean
  // the nearest thing to a call on a side where nothing cleared the gates at all:
  // named so the board is never blank, always watch-only, never in the ledger
  nearMiss?: boolean
  // the mirror image: a row that cleared EVERY gate and that an ISA cannot place,
  // shown (watch-only, zero size, no route) so its side is not nameless. A real
  // call — it stays in the ledger — but never a takeable one, so no surface may
  // offer its levels, count it as a live call, or read it as agreeing with a held
  // position.
  observation?: boolean
  // 'week' = a this-week trade/observation; 'developing' = a watch row whose shape is a
  // 2-4 week build (basing/pullback, below-base, or a thin-evidence reversal). Stamped by the engine.
  horizon?: 'week' | 'developing'
  // mirrors SetupFamily in shared/engine/types.ts — keep the two in step
  setup?: 'continuation' | 'reversal' | 'fade' | 'velocity' | null
  // WHICH PARTITION PUBLISHED THIS ROW (Stage 1c Phase B). The server has been
  // stamping it on board rows since the lane merged; without it here every board
  // consumer was typed blind to a cohort it renders — `LedgerPrediction` has
  // carried the same field, for the same reason, since the lane's own wave. It
  // changes NO row-kind law: a cohort row is sized or unsized exactly as an
  // equity row is. What it changes is what the numbers beside it MEAN — an
  // absolute move over crypto bars, not an excess over SPY across sessions —
  // and which explanation the row's `note` is carrying.
  cohort?: 'crypto'
  evidence?: { coverage: number; famAgree: number; contract: boolean; contextPts: number; detail: string }
  factors: Record<string, { score: number | null; detail: string; weight: number }>
  /** Visible provenance for the campaign-aware engine. Optional for rows
   * published before the research-lab migration. */
  campaignId?: string
  sleeve?: StrategySleeve
  forecast?: ForecastContract
  detectedAt?: number
  availableAt?: number
  overlay?: { flag: string; reason: string }
  themes?: string[]
  capUsdM?: number | null
  catalyst?: { kind: string; reason: string }
  // THE EXPERIMENT SLOT'S RECORD (Stage 3d, shared/engine/wildcardLane.ts) —
  // present on at most one row a day and absent on every other. This row is on
  // the board BECAUSE a gate refused it: it carries a quarter of the rung, a real
  // stop, and a hypothesis about the gate named here. Every surface that shows it
  // must show it AS an experiment — the thesis carries the label and the standing
  // warning, and this is what a card branches on.
  wildcard?: { gate: string; priority: number; hypothesis: string; gateEvidenceN: number }
}

// A prediction's realised outcome over one horizon: side-adjusted excess vs SPY,
// plus whether it hit / got stopped. Absent horizon = not yet matured.
//
// …EXCEPT on a row stamped `cohort: 'crypto'` (Stage 1c Phase B), where the
// basis is ABSOLUTE: `excessPct` is the side-adjusted raw move, `spyPct` is a
// structural 0 because nothing was subtracted, and the horizon is 14 crypto bars
// rather than 10 sessions. The fields are reused rather than renamed — renaming
// would rewrite every stored row in the ledger for a cosmetic gain — so every
// surface that AVERAGES or LABELS them has to read the cohort first.
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
  // a promoted route-blocked row: graded, real, and never placeable — the flag
  // rides the slim projection so a historical observation keeps its containment
  // (a near miss needs no equivalent: they never enter the ledger at all)
  observation?: boolean
  // the other two ways a row was never sized, carried on the same argument as
  // `observation` (Task 17 review, I4): a grade pill on a historical watch row
  // is the CX-13 rule breaking silently. OPTIONAL because rows published before
  // the projection carried them have neither — and nothing in the record can
  // tell one of those apart from a row that really was sized.
  watchOnly?: boolean
  belowBase?: boolean
  // …and the EXPERIMENT SLOT's record (stage 3d), carried for the same reason:
  // the accountability pane rolls these rows by grade, and a wildcard's letter is
  // not why it published. Without this the ledger's own breakdown files it under
  // the letter while `engine-scorecard` gives it its own key — two panes over one
  // trade, disagreeing. (Absent on every ordinary row and on every row published
  // before the slot existed.)
  wildcard?: { gate: string; priority: number; hypothesis: string; gateEvidenceN: number; booked?: boolean }
  // WHICH PARTITION MEASURED THIS ROW (Stage 1c Phase B). Carried for the same
  // reason as the two above and one more: it is the ONLY thing standing between
  // a crypto row's absolute return and the equity excess means on this pane. See
  // PredOutcome above for what the outcome fields mean on such a row.
  cohort?: 'crypto'
  note: string
  // the engine's two sentences, carried into the ledger so a historical card can
  // still be read against what price then did (optional — see EnginePrediction)
  thesis?: string
  falsifier?: string
}

export interface LedgerDay {
  date: string
  predictions: LedgerPrediction[]
}

// One held name as the engine reads it: the daily stage/quality opinion plus the
// live P&L% and size. Engine-side only — the broker integration that once fed
// the client was removed at cutover; this is written by the predict run.
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
  name?: string
  side: 'long' | 'short'
  callDate: string
  grade: 'A' | 'B' | 'C'
  entry: number
  stop: number // the PUBLISHED stop — the number the formal grade reads
  target: number
  // Velocity rows only: the live trail the open book actually enforced (never
  // below `stop`). Grading is unaffected — see openTrace.ts for the split.
  trailStop?: number
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
  trail?: 'velocity' // this position's stop is the lane's live trail, re-read daily
}

export interface PaperBookTrade extends PaperBookPosition {
  closedDate: string
  exit: number
  plGBP: number
  plPct: number
  reason: 'stop' | 'trail' | 'target' | 'horizon' | 'month-end'
}

export interface PaperBookData {
  month: string
  startGBP: number
  cash: number
  positions: PaperBookPosition[]
  closed: PaperBookTrade[]
  history: { date: string; equity: number }[]
}

// One dated earnings binary the engine already tracks, with the SHAPE going into
// the print. This is explicitly NOT a call — the engine refuses to bet a print
// (earningsRisk still shadows those trades). The radar exists so a 26%-overnight
// surprise is never a name the reader had never heard of.
export interface EventRadarEntry {
  sym: string
  name?: string | null
  date: string // ISO print date (Finnhub earnings calendar)
  hour?: string // 'bmo' | 'amc' | 'dmh' when known
  daysToPrint: number
  stage: string | null // technicalStage read going into the print
  entryQuality: string | null
  rs21: number | null // 21-day return minus SPY's, in pp
  note: string | null // one-line technical read
}

// One intraday entry flag: the morning's setup, re-checked live, at today's
// prices. NEVER a new call — `level` is the board's own entry (entry-zone /
// second-chance) or the 20-session high (breakout), no sizing, no new levels.
export type IntradayFlagKind = 'entry-zone' | 'second-chance' | 'breakout'
export interface IntradayFlag {
  sym: string
  name?: string | null
  kind: IntradayFlagKind
  price: number // live print at the scan
  level: number // the level in play
  detail: string // one honest sentence, reads after the ticker
  at: number // unix seconds the scan fired
}
// Today's live-scan blob: both session windows' scans, newest first; null before
// the first scan of the day. `pushedAt` marks the single daily notification.
export interface IntradayFlagsBlob {
  date: string
  scans: { at: number; window: 'london-open' | 'power-hour'; flags: IntradayFlag[] }[]
  pushedAt?: number
}

export interface EngineData {
  engineLab?: EngineLabSnapshot | null
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
    // why a side carries nothing tradeable today (shared/engine/types). Absent on
    // a board where both sides carry live rows — and on every board written
    // before 2026-08-12, which is why the renderers treat it as optional.
    emptySides?: { long?: EmptySideReason; short?: EmptySideReason }
    worldTape?: { tone: string; votes: { on: number; off: number }; detail: string }
    newsTone?: { score: number; label: string; hits: number }
    themes?: { key: string; name: string; hits: number }[]
  } | null
  ledger?: LedgerDay[]
  // the open book: every not-yet-graded live call, traced daily (null until the
  // first predict run writes it). Powers the Ledger's "where they stand" pane.
  openTrace?: { date: string; generatedAt: number; entries: OpenTraceEntry[] } | null
  // event radar: roster/candidate names reporting earnings in the next fortnight,
  // with the shape going in. Never a call — the engine won't bet a print (null
  // until the first predict run writes it).
  eventRadar?: { date: string; generatedAt: number; entries: EventRadarEntry[] } | null
  // today's intraday entry flags (null before the first scan of the session);
  // powers the board's "Intraday flags" strip and the Desk rail card
  intradayFlags?: IntradayFlagsBlob | null
  // the pattern scorecard: chart-wall badges logged and graded like calls —
  // the measured answer to "do the shapes pay?" (empty until sightings accrue)
  patternScore?: {
    kind: string
    status: 'forming' | 'confirmed'
    n: number
    graded5: number
    hitRate5: number | null
    avgExcess5: number | null
    graded10: number
    hitRate10: number | null
    avgExcess10: number | null
  }[]
  newsToneHistory?: { date: string; score: number; label: string }[]
  // the engine's daily read-only opinion on every held name (null until the first
  // predict run writes it). No client surface reads this since the Desk's
  // holdings pane went at cutover; the engine still writes it.
  holdingsReads?: HoldingRead[] | null
  scorecard: {
    byGrade: Record<string, { n: number; hits: number; sumExcess: number }>
    byRegime: Record<string, { n: number; hits: number }>
    // does this SHAPE of call work? Keyed by setup family (continuation /
    // reversal / fade / velocity), over the same last-30-dates window as byGrade,
    // shadows included — a shadow is exactly the shape being auditioned. The
    // engine has written this since the families existed and the client type
    // simply never named it (spec §4.3(d)); optional because a scorecard blob
    // written before it did carries none.
    bySetup?: Record<string, { n: number; hits: number; sumExcess: number }>
    // how the engine LOSES, keyed `${setup}:${regime}:${class}` (postMortem.ts) —
    // every graded loser of the last 30 dates, shadows included. Absent on a
    // scorecard written before Stage 3b.
    byPostMortem?: Record<string, number>
    overlays: Record<string, { n: number; hits: number }>
    brierTail: { date: string; mean: number; n: number }[]
    totalGraded: number
    lifetime?: { live: { graded: number; hits: number; sumExcess: number }; shadow: { graded: number; hits: number; sumExcess: number }; since: string }
  } | null
  // THE REGRET LEDGER, summarised (shared/engine/missLedger.ts): what the gates
  // refused and what it went on to do. Absent on any deployment whose engine has
  // not yet measured a matured trace day — the panel then says nothing at all,
  // which is the only honest reading of "not measured".
  missLedger?: MissLedgerSummary | null
  // …and what that ledger has MOVED (shared/engine/gateState.ts): one line per
  // gate notch, plus the gates that earned a notch and were held by the cadence
  // or the owner's pin. Absent until a gate has moved or been held — the panel
  // says nothing rather than announcing that nothing has happened.
  gateState?: GateStateSummary | null
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
    // THE GRADE BAR [spec §9]: the hit rate of an ordinary candidate — every name
    // the engine screened, graded by the same rule — swept once when the seed was
    // generated and fixed until the next regeneration. Grades measure a call's
    // probability against THIS; the probability itself is still the engine's own
    // measured hit rate for calls like it. null = no sweep has ever measured one,
    // in which case grades fall back to the pooled base and no surface may print a
    // bar (see gradeBaseRate).
    referenceBase?: number | null
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

export async function retrySocialJob(id: string): Promise<void> {
  const res = await fetch(apiUrl('/api/fn/video-jobs'), { method: 'POST', headers: { 'content-type': 'application/json', 'x-app-token': getToken() ?? '' }, body: JSON.stringify({ id }), signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(res.status === 401 ? 'Owner access is required to retry processing.' : 'Retry could not be queued. Try again later.')
}
