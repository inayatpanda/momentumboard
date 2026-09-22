// The earnings calendar, without a key.
//
// The engine's calendar came from Finnhub, which is key-dependent — and the
// account this deployment holds refuses roughly 78% of its calls, so the single
// fact the whole earnings-risk rule stands on (does this name report inside the
// horizon?) was arriving intermittently and silently. `nasdaq.com`'s own
// calendar endpoint is free, key-less and cookie-less: a `User-Agent` and an
// `Accept` header are the whole contract (probed over 43 sessions,
// docs/superpowers/plans/2026-09-22-discovery-walk-forward-results.md, appendix
// — 4,361 rows, ~101/day, HTTP 200 throughout). Finnhub without a key is 401.
//
// ONE ENDPOINT, TWO DIFFERENT ANSWERS, AND THAT IS THE WHOLE DESIGN OF THIS FILE.
// The field a post-earnings lane actually needs is `time` — pre-market or
// after-hours decides WHICH bar carries the reaction — and it is populated only
// while the date is still in the FUTURE:
//
//   future date  →  time-pre-market / time-after-hours, lastYearRptDt, lastYearEPS
//                   …and no `eps`, no `surprise`: the print hasn't happened.
//   past date    →  eps, surprise, epsForecast …and `time-not-supplied` on every
//                   single row: the session timing is gone.
//
// Neither call alone gives both, so the calendar has to be SNAPSHOTTED FORWARD
// (to learn the timing) and the same date RE-READ afterwards (to learn the
// outcome). That is `snapshotEarningsCalendar`: a forward fortnight AND a short
// backward window, every run, merged into one durable blob that keeps the first
// `time` it ever saw for a date+sym and lets the numbers fill in later.
//
// THE BACKWARD WINDOW IS NOT OPTIONAL, and its absence is the bug this file
// shipped with. A snapshot that only ever asked for today+1…today+N never once
// asks Nasdaq for a date that has already printed, so `eps` and `surprisePct`
// were structurally unlearnable — and the earnings-fade lane
// (earningsFadeLane.ts), whose entire trigger is a SURPRISE on a past print,
// could not fire on any real run however the tape behaved. The forward pass
// still owns `time`; the backward pass is the only thing that can ever own a
// number.
//
// Nothing here decides anything. It is a feed: rows in, normalised rows out,
// fail-soft to [] at every step — a calendar outage must cost the engine its
// earnings colour and nothing else.

import type { AppStore } from './store'

/** When the company reported, relative to the session. `unknown` is the honest
 * answer for a row read only after the fact (`time-not-supplied`) — never
 * guessed into one of the other two, because the guess would move the reaction
 * bar by a whole session. */
export type EarningsTime = 'pre' | 'post' | 'unknown'

export interface NasdaqEarningsRow {
  /** Yahoo form — the shape every candle fetch in this repo uses. `BRK.B` → `BRK-B`. */
  sym: string
  /** YYYY-MM-DD, the date the row was filed under (the print's session). */
  date: string
  time: EarningsTime
  /** Reported EPS. Present only once the date is in the past. */
  epsActual: number | null
  /** Consensus. Present on both sides of the print. */
  epsForecast: number | null
  /** Nasdaq's own `% Surprise`, already a percent (9.52 = +9.52%). */
  surprisePct: number | null
  noOfEsts: number | null
  marketCapUsdM: number | null
}

/** The durable blob. `v1` is in the key rather than in the body so a future
 * shape change is a new blob and never a migration of a live one. */
export const EARNINGS_CALENDAR_KEY = 'earnings-calendar:v1'

/** How far forward each snapshot reaches. FOURTEEN, because fourteen is the
 * window the engine actually slices: `earningsRisk` is judged over
 * `upcomingEarnings(…, 14)` and the run log says "next 14d". Reaching only ten
 * quietly shrank that horizon by four days — the rule went on asking a
 * fortnight-shaped question of a ten-day calendar and read "no print known" for
 * the difference, which is the one answer a risk flag must never invent. The two
 * numbers are ONE fact and the suite pins the pair. ~101 rows a date is the whole
 * US calendar, and this is the window `time` is available in. */
export const SNAPSHOT_DAYS = 14

/** …and how far BACK it re-reads. `eps` / `surprise` exist only on a date that
 * has already printed, so this window is the only source of an outcome the blob
 * will ever have. Three days back, plus today, covers a Monday run re-reading
 * Friday's prints (a weekend date returns nothing and costs nothing), which is
 * the longest ordinary gap the US calendar produces. */
export const REREAD_DAYS = 3

/** Per-date cache TTL for a FORWARD date. Six hours means a run started any time
 * in a trading day re-reads the near dates at most four times, and the far dates
 * (whose rows barely move) are paid for once a morning. */
export const SNAPSHOT_TTL_SEC = 21_600

/** …and for a date inside the RE-READ window, where six hours would defeat the
 * point of re-reading at all. A print lands during the session; an entry written
 * before it would hand every run for the rest of the day the same eps-less body,
 * and a date that ages out of the window while still cached never fills in at
 * all. One hour is short enough that the run after the print reaches Nasdaq and
 * long enough that repeated runs in a morning are not a fetch storm.
 *
 * THE KEY IS ALSO DIFFERENT (`:past:`), and that is the load-bearing half: a date
 * in this window was almost certainly fetched as a FORWARD date on an earlier run
 * and cached for six hours under the plain key. Sharing the key would serve the
 * re-read that stale, pre-print body — the exact masking this window exists to
 * end — so the two readings of one date are cached as the two different answers
 * they are. */
export const REREAD_TTL_SEC = 3_600

/** The fan-out bound. The dates are independent, so they go out together — but
 * `Promise.all` over the whole window is eighteen simultaneous calls at one
 * anonymous, key-less endpoint, which is how a free feed stops being free. Four
 * at a time drains the window in five waves and keeps the request shape
 * unremarkable. */
export const SNAPSHOT_CONCURRENCY = 4

/** Bounded fan-out: `limit` at a time, results in input order. A local copy of
 * the engine's own helper rather than an import — engine.ts pulls in the whole
 * board and imports THIS file, so sharing four lines would buy a cycle for
 * nothing. */
const mapLimit = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = []
  for (let i = 0; i < items.length; i += limit) out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))))
  return out
}

/** How long a date stays in the blob after its print. 45 SESSIONS, converted at
 * the ordinary 5-in-7 weekday rate — the calendar is dated in calendar days and
 * a session count cannot be applied to it without a market calendar this module
 * has no business owning. 63 calendar days is the honest ceiling of 45 sessions
 * (it over-keeps across holidays, which costs a few hundred bytes and never
 * loses evidence; under-keeping would drop a row a 21-session horizon still
 * wants to read). */
export const PRUNE_SESSIONS = 45
export const PRUNE_CALENDAR_DAYS = Math.ceil((PRUNE_SESSIONS * 7) / 5)

const UA = 'Mozilla/5.0'

/** Nasdaq's money strings: `"$24.89"`, `"($8.75)"` for a negative, `""` / `"N/A"`
 * for absent. Parentheses are the accountancy minus sign and mean exactly that. */
export function parseMoney(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s || s.toUpperCase() === 'N/A') return null
  const negative = s.startsWith('(') && s.endsWith(')')
  const n = Number(s.replace(/[()$,\s]/g, ''))
  if (!Number.isFinite(n)) return null
  return negative ? -n : n
}

/** The plain numeric fields (`surprise`, `noOfEsts`) — same `N/A` sentinel, no
 * currency dressing.
 *
 * …AND THE SAME ACCOUNTANCY MINUS. One formatter renders these tables, and it
 * emits a negative `% Surprise` as `-57.58` on some rows and `(57.58)` on
 * others. Reading the second as +57.58 flips the sign of the exact field the
 * earnings-fade lane triggers on — a miss printed to the reader as a beat, and a
 * shadow short published on a pop that never happened. `parseMoney` has always
 * handled the convention; this is the same rule, written once per parser because
 * they are two entry points into one of Nasdaq's habits. */
export function parseNum(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s || s.toUpperCase() === 'N/A') return null
  const negative = s.startsWith('(') && s.endsWith(')')
  const n = Number(s.replace(/[(),%\s]/g, ''))
  if (!Number.isFinite(n)) return null
  return negative ? -n : n
}

/** THE SYMBOL, in the form the rest of the engine speaks. Nasdaq files share
 * classes with a dot (`BRK.B`); every candle source in this repo — and the
 * `levMap`, the roster and the ledger keys — uses Yahoo's dash. Normalising
 * here rather than at each reader is what stops a class-B name looking like two
 * different companies to two different lanes. */
export function normaliseSymbol(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim().toUpperCase().replace(/\./g, '-')
  return /^[A-Z0-9-]{1,12}$/.test(s) ? s : null
}

const timeOf = (raw: unknown): EarningsTime =>
  raw === 'time-pre-market' ? 'pre' : raw === 'time-after-hours' ? 'post' : 'unknown'

interface RawRow {
  symbol?: unknown
  time?: unknown
  eps?: unknown
  epsForecast?: unknown
  surprise?: unknown
  noOfEsts?: unknown
  marketCap?: unknown
}

/** GET api.nasdaq.com/api/calendar/earnings?date=YYYY-MM-DD → normalised rows.
 *
 * Rows without a usable symbol are dropped (nothing to trade, nothing to date).
 * Any failure — a non-200, a body that isn't JSON, a shape Nasdaq changed under
 * us — is fail-soft to []: the calendar is colour and supply, never a gate, and
 * an outage must read as "no prints known", not as a thrown run. */
export async function fetchNasdaqEarnings(dateISO: string, fetchFn: typeof fetch = fetch): Promise<NasdaqEarningsRow[]> {
  try {
    const res = await fetchFn(`https://api.nasdaq.com/api/calendar/earnings?date=${encodeURIComponent(dateISO)}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    })
    if (!res.ok) return []
    const j = (await res.json()) as { data?: { rows?: RawRow[] | null } | null }
    const rows = j?.data?.rows
    if (!Array.isArray(rows)) return []
    const out: NasdaqEarningsRow[] = []
    const seen = new Set<string>()
    for (const r of rows) {
      const sym = normaliseSymbol(r?.symbol)
      if (!sym || seen.has(sym)) continue
      seen.add(sym)
      out.push({
        sym,
        date: dateISO,
        time: timeOf(r?.time),
        epsActual: parseMoney(r?.eps),
        epsForecast: parseMoney(r?.epsForecast),
        surprisePct: parseNum(r?.surprise),
        noOfEsts: parseNum(r?.noOfEsts),
        marketCapUsdM: (() => {
          const usd = parseMoney(r?.marketCap)
          return usd == null ? null : Math.round(usd / 1_000_000)
        })(),
      })
    }
    return out
  } catch {
    return []
  }
}

export interface EarningsCalendarBlob {
  v: 1
  updatedAt: string
  /** Keyed `${date}:${sym}` — one entry per company per print. */
  rows: Record<string, NasdaqEarningsRow>
}

const entryKey = (date: string, sym: string) => `${date}:${sym}`

const addDays = (iso: string, days: number): string | null => {
  const t = Date.parse(`${iso}T00:00:00Z`)
  if (!Number.isFinite(t)) return null
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10)
}

/** MERGE, not replace — and the merge rule is the whole point of the blob.
 *
 *   · `time` KEEPS THE FIRST KNOWN VALUE. The forward read is the only one that
 *     carries it; re-reading the same date after the print returns
 *     `time-not-supplied` on every row, and letting that overwrite would erase
 *     the one field the lane cannot recover. An `unknown` already stored is
 *     replaced the moment a real value arrives (a first read that landed on a
 *     `time-not-supplied` row is not evidence of anything).
 *   · eps / surprise / forecast / ests / cap FILL IN. They are absent before the
 *     print and present after it, so a non-null incoming value always wins and a
 *     null one never clears what is already known.
 *
 * Exported because it is the rule, and the rule is what the tests are about. */
export function mergeEarningsRow(prev: NasdaqEarningsRow | undefined, next: NasdaqEarningsRow): NasdaqEarningsRow {
  if (!prev) return next
  return {
    sym: next.sym,
    date: next.date,
    time: prev.time !== 'unknown' ? prev.time : next.time,
    epsActual: next.epsActual ?? prev.epsActual,
    epsForecast: next.epsForecast ?? prev.epsForecast,
    surprisePct: next.surprisePct ?? prev.surprisePct,
    noOfEsts: next.noOfEsts ?? prev.noOfEsts,
    marketCapUsdM: next.marketCapUsdM ?? prev.marketCapUsdM,
  }
}

/** Drop everything whose print is older than the retention window. Pure, so the
 * bound can be tested without a clock. */
export function pruneEarningsRows(rows: Record<string, NasdaqEarningsRow>, todayISO: string): Record<string, NasdaqEarningsRow> {
  const cutoff = addDays(todayISO, -PRUNE_CALENDAR_DAYS)
  if (!cutoff) return rows
  const out: Record<string, NasdaqEarningsRow> = {}
  for (const [k, row] of Object.entries(rows)) if (row?.date && row.date >= cutoff) out[k] = row
  return out
}

/** THE DAILY SNAPSHOT — TWO WINDOWS, ONE BLOB.
 *
 *   FORWARD  today+1 … today+SNAPSHOT_DAYS, cached ~6h, the only source of
 *            `time`: which session carries the reaction.
 *   RE-READ  today−REREAD_DAYS … today, cached ~1h under their own key, the
 *            only source of `epsActual` / `surprisePct`: what the print did.
 *
 * Every row from both merges into the durable blob under `mergeEarningsRow` —
 * first-seen `time` kept, numbers filled in — then prunes, writes, and hands
 * back the whole calendar.
 *
 * The forward window deliberately still starts at +1, and today is now reached
 * by the OTHER window instead: today's date already reads as history for the
 * rows that printed pre-market, so it is worth an outcome and cannot be trusted
 * for `time`. That is exactly the split the two windows make.
 *
 * `snapshotDates` is exported and pure so the windows can be asserted without a
 * clock, a store or a fetch.
 *
 * Fail-soft at three levels: one date's fetch failing costs that date, the
 * store read failing starts from an empty calendar, and the store write failing
 * still returns the merged rows to this caller. */
export interface SnapshotDate {
  iso: string
  /** false = inside the re-read window (today or earlier). */
  forward: boolean
  cacheKey: string
  ttlSec: number
}

export function snapshotDates(todayISO: string): SnapshotDate[] {
  const out: SnapshotDate[] = []
  for (let d = -REREAD_DAYS; d <= SNAPSHOT_DAYS; d++) {
    const iso = addDays(todayISO, d)
    if (!iso) continue
    const forward = d > 0
    out.push({
      iso,
      forward,
      // …and the two windows never share a cache entry (see REREAD_TTL_SEC).
      cacheKey: forward ? `nasdaq-earnings:${iso}` : `nasdaq-earnings:past:${iso}`,
      ttlSec: forward ? SNAPSHOT_TTL_SEC : REREAD_TTL_SEC,
    })
  }
  return out
}

export async function snapshotEarningsCalendar(
  store: AppStore,
  todayISO: string,
  fetchFn: typeof fetch = fetch,
): Promise<NasdaqEarningsRow[]> {
  const { getCached, setCached } = await import('./cache')
  const dates = snapshotDates(todayISO)

  const fetched = await mapLimit(dates, SNAPSHOT_CONCURRENCY, async ({ iso, cacheKey, ttlSec }) => {
    try {
      const hit = await getCached<NasdaqEarningsRow[]>(cacheKey)
      if (hit) return hit
    } catch {
      /* a cache that cannot be read is a cache miss, never a failed snapshot */
    }
    const rows = await fetchNasdaqEarnings(iso, fetchFn)
    // Only a NON-EMPTY answer is worth caching: an empty list is either a
    // holiday or an outage, and caching an outage would hold the calendar dark
    // long after the endpoint came back.
    if (rows.length) await setCached(cacheKey, rows, ttlSec).catch(() => {})
    return rows
  })

  let existing: Record<string, NasdaqEarningsRow> = {}
  try {
    const blob = await store.read<EarningsCalendarBlob>(EARNINGS_CALENDAR_KEY)
    if (blob?.rows && typeof blob.rows === 'object') existing = { ...blob.rows }
  } catch {
    /* start from empty — a snapshot that cannot read yesterday still writes today */
  }

  for (const rows of fetched) {
    for (const row of rows) {
      const k = entryKey(row.date, row.sym)
      existing[k] = mergeEarningsRow(existing[k], row)
    }
  }
  const pruned = pruneEarningsRows(existing, todayISO)
  const blob: EarningsCalendarBlob = { v: 1, updatedAt: new Date().toISOString(), rows: pruned }
  await store.write(EARNINGS_CALENDAR_KEY, blob).catch(() => {})
  return Object.values(pruned)
}

/** The reader. Everything the snapshot has ever learned, newest print first —
 * fail-soft to [] so a missing or corrupt blob reads as an empty calendar. */
export async function earningsCalendarRows(store: AppStore): Promise<NasdaqEarningsRow[]> {
  try {
    const blob = await store.read<EarningsCalendarBlob>(EARNINGS_CALENDAR_KEY)
    if (!blob?.rows || typeof blob.rows !== 'object') return []
    return Object.values(blob.rows)
      .filter((r): r is NasdaqEarningsRow => !!r && typeof r.sym === 'string' && typeof r.date === 'string')
      .sort((a, b) => b.date.localeCompare(a.date))
  } catch {
    return []
  }
}

/** The forward slice the engine's `earningsRisk` rule asks for: every name
 * reporting between `todayISO` and `todayISO + days`, soonest first. Dates are
 * YYYY-MM-DD so a string compare orders them. */
export function upcomingEarnings(rows: NasdaqEarningsRow[], todayISO: string, days = 14): NasdaqEarningsRow[] {
  const to = addDays(todayISO, days)
  if (!to) return []
  return rows.filter(r => r.date >= todayISO && r.date <= to).sort((a, b) => a.date.localeCompare(b.date))
}
