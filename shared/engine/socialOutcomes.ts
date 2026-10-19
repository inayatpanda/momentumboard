import type { Candle } from '../types'
import type { SocialClaim } from '../socialEvidence'
import { exchangeFor } from '../symbols'
import { sessionUtcHours } from '../rvol'

export const SOCIAL_OUTCOME_VERSION = 'social-next-open-10-v1'
export interface SocialTrackOutcome {
  entryAt: number; exitAt: number; measuredAt: number; rawPct: number; benchmarkPct: number; excessPct: number; costPct: number
}
export interface SocialOutcomeRecord {
  id: string; version: typeof SOCIAL_OUTCOME_VERSION; channel: string; channelId?: string; sourceUrl: string
  sym: string; stance: 'bull' | 'bear'; availableAt: number; publishedAt?: number; campaignId: string
  horizonSessions: 10; benchmark: 'SPY'; app?: SocialTrackOutcome; creator?: SocialTrackOutcome; lastAttemptAt?: number
}
export interface SocialLearningSummary {
  version: string; mode: 'shadow'; pending: number; completed: number; independent: number; repeats: number
  channels: { channel: string; n: number; hits: number; averageExcessPct: number }[]
  recent: { id: string; channel: string; sym: string; sourceUrl: string; availableAt: number; publishedAt?: number; repeated: boolean; app?: SocialTrackOutcome; creator?: SocialTrackOutcome }[]
}

export function registerSocialClaims(records: SocialOutcomeRecord[], source: { url: string; channel: string; channelId?: string; at: number; publishedAt?: number; claims?: SocialClaim[] }): SocialOutcomeRecord[] {
  const next = [...records], seen = new Set(records.map(r => r.id))
  for (const claim of source.claims ?? []) {
    if (seen.has(claim.id) || claim.sourceMatch !== 'matched' || !claim.identityMatched || !claim.unconditional || claim.stance === 'neutral' || exchangeFor(claim.sym) !== 'US') continue
    const previous = [...next].reverse().find(r => (source.channelId && r.channelId ? r.channelId === source.channelId : r.channel === source.channel) && r.sym === claim.sym && r.availableAt <= source.at
      && (!r.app || r.app.exitAt >= source.at || source.at - r.availableAt < 21 * 86400))
    next.push({ id: claim.id, version: SOCIAL_OUTCOME_VERSION, channel: source.channel, ...(source.channelId ? { channelId: source.channelId } : {}), sourceUrl: source.url,
      sym: claim.sym, stance: claim.stance, availableAt: source.at,
      ...(source.publishedAt && source.publishedAt <= source.at ? { publishedAt: source.publishedAt } : {}), campaignId: previous?.campaignId ?? claim.id, horizonSessions: 10, benchmark: 'SPY' })
    seen.add(claim.id)
  }
  return next
}

const DAY = 86400
const bounds = (t: number) => { const day = Math.floor(t / DAY) * DAY; const h = sessionUtcHours('US', day); return { day, open: day + h.open * 3600, close: day + h.close * 3600 } }
function sessions(rows: Candle[], nowSec: number): Candle[] {
  const days = new Map<number, Candle>()
  for (const c of rows) {
    if (!Number.isFinite(c.t) || bounds(c.t).close > nowSec || ![c.o, c.h, c.l, c.c].every(v => Number.isFinite(v) && v > 0) || c.h < Math.max(c.o, c.c) || c.l > Math.min(c.o, c.c)) continue
    const day = bounds(c.t).day
    if (days.has(day)) return [] // ambiguous duplicates need feed repair
    days.set(day, c)
  }
  return [...days.values()].sort((a, b) => a.t - b.t)
}
function gradeTrack(at: number, stance: 'bull' | 'bear', candles: Candle[], spy: Candle[], nowSec: number): SocialTrackOutcome | undefined {
  const market = sessions(spy, nowSec), prices = sessions(candles, nowSec)
  // Missing early history must never silently move an entry months forward.
  if (!market.some(c => bounds(c.t).close <= at) || !prices.some(c => bounds(c.t).close <= at)) return
  const future = market.filter(c => bounds(c.t).open > at)
  if (future.length < 10 || bounds(future[0].t).open - at > 7 * DAY) return
  const window = future.slice(0, 10)
  const byDay = new Map(prices.map(c => [bounds(c.t).day, c]))
  const matching = window.map(c => byDay.get(bounds(c.t).day))
  if (matching.some(c => !c)) return // align every session, including suspensions/gaps
  const first = matching[0]!, last = matching[9]!
  const rawPct = (last.c / first.o - 1) * 100, benchmarkPct = (window[9].c / window[0].o - 1) * 100
  const costPct = 0.2 // declared round-trip estimate; borrow/dividends excluded
  const excessPct = (stance === 'bull' ? 1 : -1) * (rawPct - benchmarkPct) - costPct
  return { entryAt: bounds(first.t).open, exitAt: bounds(last.t).close, measuredAt: nowSec, rawPct, benchmarkPct, excessPct, costPct }
}
export function socialGradingQueue(records: SocialOutcomeRecord[], nowSec: number, limit = 25): SocialOutcomeRecord[] {
  return records.filter(r => (!r.app || (r.publishedAt && !r.creator)) && nowSec - r.availableAt >= 9 * DAY)
    .sort((a, b) => (a.lastAttemptAt ?? 0) - (b.lastAttemptAt ?? 0) || a.availableAt - b.availableAt).slice(0, limit)
}
export function gradeSocialRecord(record: SocialOutcomeRecord, candles: Candle[], spy: Candle[], nowSec: number): SocialOutcomeRecord {
  return { ...record, lastAttemptAt: nowSec, app: record.app ?? gradeTrack(record.availableAt, record.stance, candles, spy, nowSec),
    creator: record.creator ?? (record.publishedAt ? gradeTrack(record.publishedAt, record.stance, candles, spy, nowSec) : undefined) }
}
export function summarizeSocialOutcomes(records: SocialOutcomeRecord[]): SocialLearningSummary {
  const channels = new Map<string, { channel: string; n: number; hits: number; total: number }>()
  const independent = records.filter(r => r.id === r.campaignId && r.app)
  for (const r of independent) {
    const key = r.channelId ?? r.channel, c = channels.get(key) ?? { channel: r.channel, n: 0, hits: 0, total: 0 }
    c.n++; c.hits += Number(r.app!.excessPct > 0); c.total += r.app!.excessPct; channels.set(key, c)
  }
  return { version: SOCIAL_OUTCOME_VERSION, mode: 'shadow', pending: records.filter(r => !r.app).length, completed: records.filter(r => r.app).length,
    independent: independent.length, repeats: records.filter(r => r.id !== r.campaignId).length,
    channels: [...channels.values()].map(c => ({ channel: c.channel, n: c.n, hits: c.hits, averageExcessPct: c.total / c.n })).sort((a, b) => b.n - a.n).slice(0, 20),
    recent: [...records].sort((a, b) => b.availableAt - a.availableAt).slice(0, 12).map(r => ({ id: r.id, channel: r.channel, sym: r.sym, sourceUrl: r.sourceUrl, availableAt: r.availableAt, publishedAt: r.publishedAt, repeated: r.id !== r.campaignId, app: r.app, creator: r.creator })) }
}
