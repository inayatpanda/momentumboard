// INTRADAY ENTRY FLAGS: while the reader is watching the tape, an obvious entry
// should get surfaced at least once during the session — the morning's setup,
// re-checked live, at today's prices. These are NEVER new calls: no sizing, no
// new levels, just the board's own setups flagged when price reaches the level.
//
// PURE decision core only, mirroring callCross.ts: the 5-minute runner does the
// data-gathering (live quote, daily candles, the board's engine levels) and
// feeds fully-formed candidates in. `now` is always injected so the window gate
// and the scan are deterministic in tests. Fail-soft: a candidate that lacks the
// data a rule needs simply doesn't fire that rule.

// ---- flag kinds + shapes ----

export type FlagKind = 'entry-zone' | 'second-chance' | 'breakout'

export interface IntradayFlag {
  sym: string
  name?: string | null
  kind: FlagKind
  price: number // live print at the scan
  level: number // the level in play: engine entry (zone/second-chance) or the 20-session high (breakout)
  detail: string // one honest sentence — reads after the ticker
  at: number // unix seconds — when the scan fired (for "flagged HH:MM")
}

/** Everything a rule can read about one candidate. Board rows carry side/entry/
 * stage/watchOnly/published; a watchlist-only sym passes just the live + candle-
 * derived fields, so only `breakout` (which needs no engine levels) can fire. */
export interface FlagCandidate {
  sym: string
  name?: string | null
  price: number
  changePct?: number | null // day change % — the momentum direction for entry-zone
  rvol?: number | null // relative volume so far this session (shared/rvol)
  side?: 'long' | 'short'
  entry?: number | null // the engine entry/trigger level
  stage?: string | null // technicalStage read (breakout needs 'basing')
  watchOnly?: boolean // a watch/developing board row → entry-zone eligible
  published?: boolean // an A/B trade (not watch-only) → second-chance eligible
  sessionHigh?: number | null // today's high so far — how far it ranged (second-chance)
  sessionLow?: number | null // today's low so far
  high20?: number | null // 20-session high, TODAY EXCLUDED → the breakout level
}

// ---- thresholds (exported so the tests pin the exact rules) ----

export const ENTRY_PROXIMITY = 0.01 // within 1% of the engine entry = "at the door"
export const ENTRY_ZONE_MIN_RVOL = 1.2 // a watch row needs some conviction to flag
export const SECOND_CHANCE_RANGE = 0.02 // the session must have ranged ≥2% away first
export const BREAKOUT_MIN_RVOL = 2 // a base only triggers on real volume
export const MAX_FLAGS = 3 // at most three a day — a highlight, never a firehose

// penny names need the extra places or the level and the print read identical
const fmt = (x: number) => String(Math.abs(x) >= 1 ? Math.round(x * 100) / 100 : Math.round(x * 10_000) / 10_000)
const rvolStr = (r: number) => `${Math.round(r * 10) / 10}×`
const within = (price: number, level: number, frac: number) => level > 0 && Math.abs(price - level) / level <= frac

// a. the watch setup from this morning is at its entry, moving through it on volume
function detectEntryZone(c: FlagCandidate, at: number): IntradayFlag | null {
  if (!c.watchOnly || c.entry == null || !c.side) return null
  if (c.rvol == null || c.rvol < ENTRY_ZONE_MIN_RVOL) return null
  if (!within(c.price, c.entry, ENTRY_PROXIMITY)) return null
  // momentum must point the trade's way — the setup is at the door AND moving
  // through it, not drifting away. Null day-change can't confirm → blocks.
  const toward = c.side === 'long' ? (c.changePct ?? -1) >= 0 : (c.changePct ?? 1) <= 0
  if (!toward) return null
  return {
    sym: c.sym, name: c.name ?? null, kind: 'entry-zone', price: c.price, level: c.entry, at,
    detail: `at its ${c.side} entry ${fmt(c.entry)} (now ${fmt(c.price)}) on ${rvolStr(c.rvol)} volume — the setup from this morning is at the door.`,
  }
}

// b. a published A/B trade the reader may have missed at the open, back at entry
function detectSecondChance(c: FlagCandidate, at: number): IntradayFlag | null {
  if (!c.published || c.entry == null || !c.side) return null
  if (!within(c.price, c.entry, ENTRY_PROXIMITY)) return null
  if (c.sessionHigh == null || c.sessionLow == null) return null
  // it must have genuinely ranged away first — otherwise it just never left entry
  const away = Math.max(Math.abs(c.sessionHigh - c.entry), Math.abs(c.sessionLow - c.entry)) / c.entry
  if (away < SECOND_CHANCE_RANGE) return null
  return {
    sym: c.sym, name: c.name ?? null, kind: 'second-chance', price: c.price, level: c.entry, at,
    detail: `${c.side} back at entry ${fmt(c.entry)} (now ${fmt(c.price)}) after ranging away — the level you missed at the open, at today's prices. Same call, same levels.`,
  }
}

// c. a basing name breaking its 20-session high on heavy volume — triggering now
function detectBreakout(c: FlagCandidate, at: number): IntradayFlag | null {
  if (c.stage !== 'basing' || c.high20 == null) return null
  if (c.price <= c.high20) return null
  if (c.rvol == null || c.rvol < BREAKOUT_MIN_RVOL) return null
  return {
    sym: c.sym, name: c.name ?? null, kind: 'breakout', price: c.price, level: c.high20, at,
    detail: `breaking its 20-session high ${fmt(c.high20)} (now ${fmt(c.price)}) on ${rvolStr(c.rvol)} volume — the base is triggering now.`,
  }
}

// most-compelling first: a live breakout beats a returning level beats an approach
const KIND_RANK: Record<FlagKind, number> = { breakout: 3, 'second-chance': 2, 'entry-zone': 1 }
const proximity = (f: IntradayFlag) => (f.level > 0 ? Math.abs(f.price - f.level) / f.level : 1)

/** Run every rule over every candidate, keep the single best kind per symbol,
 * then the three most compelling. PURE — the runner persists what comes back. */
export function scanIntradayFlags(cands: readonly FlagCandidate[], atSec: number): IntradayFlag[] {
  const bySym = new Map<string, IntradayFlag>()
  for (const c of cands) {
    if (!Number.isFinite(c.price) || c.price <= 0) continue
    const flag = detectBreakout(c, atSec) ?? detectSecondChance(c, atSec) ?? detectEntryZone(c, atSec)
    if (!flag) continue
    const prev = bySym.get(flag.sym)
    if (!prev || KIND_RANK[flag.kind] > KIND_RANK[prev.kind]) bySym.set(flag.sym, flag)
  }
  return [...bySym.values()]
    .sort((a, b) => KIND_RANK[b.kind] - KIND_RANK[a.kind] || proximity(a) - proximity(b) || a.sym.localeCompare(b.sym))
    .slice(0, MAX_FLAGS)
}

// ---- when to scan: two 15-minute windows on the LONDON clock ----

export type ScanWindow = 'london-open' | 'power-hour'

// ~1h after the US open (the morning setup check) and ~1h before the US close
// (the power-hour re-check). Kept in London time because that's the reader's
// clock; Intl resolves DST correctly, so no hand-rolled offset maths.
const WINDOW_HOUR: Record<number, ScanWindow> = { 15: 'london-open', 19: 'power-hour' }

/** The scan window `nowMs` falls in, or null. Weekdays only; a 15-min slot at
 * :30–:45 (the 5-minute runner lands on :30/:35/:40 there). Deterministic. */
export function scanWindowAt(nowMs: number): ScanWindow | null {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(nowMs))
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  const weekday = get('weekday')
  if (weekday === 'Sat' || weekday === 'Sun') return null
  const hour = parseInt(get('hour'), 10) % 24 // some ICU builds render midnight as '24'
  const minute = parseInt(get('minute'), 10)
  if (minute < 30 || minute >= 45) return null
  return WINDOW_HOUR[hour] ?? null
}

// ---- the persisted blob: both windows' scans, newest first, one push/day ----

export interface IntradayScan {
  at: number
  window: ScanWindow
  flags: IntradayFlag[]
}

export interface IntradayFlagsBlob {
  date: string // London 'YYYY-MM-DD' the scans belong to
  scans: IntradayScan[] // newest scan first; both windows kept
  pushedAt?: number // unix seconds of the single daily notification, once set
}

/** Fold a fresh scan into today's blob: reset on a new date, REFUSE a second
 * scan from the same window (idempotent under the 5-minute cadence), keep BOTH
 * windows' scans newest-first. PURE — returns the blob to persist and whether
 * the scan was new (a rejected duplicate must not re-trigger the push). */
export function foldScan(prev: IntradayFlagsBlob | null | undefined, date: string, scan: IntradayScan): { blob: IntradayFlagsBlob; accepted: boolean } {
  const base: IntradayFlagsBlob = prev && prev.date === date ? prev : { date, scans: [] }
  if (base.scans.some(s => s.window === scan.window)) return { blob: base, accepted: false }
  return { blob: { ...base, scans: [scan, ...base.scans].slice(0, 2) }, accepted: true }
}
