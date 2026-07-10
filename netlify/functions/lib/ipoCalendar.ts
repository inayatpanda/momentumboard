// Finnhub IPO calendar — the new-listings tape. A company debuting on a US
// exchange (SK Hynix on NASDAQ, say) is INVISIBLE to a momentum scanner that
// hunts on price history the name does not yet have. This small lib surfaces two
// windows off one cached fetch: names about to list (upcoming) and names that
// just priced and now carry enough candles to trade (recent — a gated
// fresh-listing candidate source for the engine).

export type IpoStatus = 'expected' | 'priced' | 'filed' | 'withdrawn'

export interface IpoRow {
  sym: string
  name: string
  date: string // YYYY-MM-DD
  exchange: string
  priceRange: string // Finnhub's price string: a point ("158.14") or a range ("18.00-21.00"); '' when none
  status: IpoStatus
}

const STATUSES: IpoStatus[] = ['expected', 'priced', 'filed', 'withdrawn']

/** Finnhub GET /calendar/ipo?from&to → normalized rows. Rows without a symbol
 * are dropped (nothing to trade). Cached ~6h via the repo cache helper, keyed by
 * the window. Any failure (no key, HTTP error, bad JSON) is fail-soft to []. */
export async function fetchIpoCalendar(apiKey: string, fromISO: string, toISO: string, fetchFn: typeof fetch = fetch): Promise<IpoRow[]> {
  const cacheKey = `ipo-calendar:${fromISO}:${toISO}`
  const { getCached, setCached } = await import('./cache')
  const hit = await getCached<IpoRow[]>(cacheKey)
  if (hit) return hit
  try {
    const res = await fetchFn(`https://finnhub.io/api/v1/calendar/ipo?from=${fromISO}&to=${toISO}&token=${apiKey}`)
    if (!res.ok) return []
    const j = (await res.json()) as { ipoCalendar?: { date?: string; exchange?: string; name?: string; price?: string; status?: string; symbol?: string }[] }
    const rows = (j.ipoCalendar ?? [])
      .map((r): IpoRow | null => {
        const sym = (r.symbol ?? '').trim().toUpperCase()
        if (!sym) return null
        const status = (STATUSES as string[]).includes(r.status ?? '') ? (r.status as IpoStatus) : 'expected'
        return {
          sym,
          name: (r.name ?? '').trim(),
          date: (r.date ?? '').trim(),
          exchange: (r.exchange ?? '').trim(),
          priceRange: (r.price ?? '').trim(),
          status,
        }
      })
      .filter((r): r is IpoRow => r !== null)
    await setCached(cacheKey, rows, 21_600) // ~6h
    return rows
  } catch {
    return []
  }
}

/** Names about to list (or just priced) — status expected|priced with a date on
 * or after today, soonest first. The forward window is bounded by the fetch
 * range (the caller looks ~7 days ahead). Dates are YYYY-MM-DD, so a string
 * compare orders them correctly. */
export function upcomingListings(rows: IpoRow[], todayISO: string): IpoRow[] {
  return rows
    .filter(r => (r.status === 'expected' || r.status === 'priced') && !!r.date && r.date >= todayISO)
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** Names that recently priced and now have SOME price history — old enough to
 * chart (>= minDays ago), young enough to still be a fresh-listing trade
 * (<= maxDays ago), newest first. */
export function recentListings(rows: IpoRow[], todayISO: string, minDays = 5, maxDays = 90): IpoRow[] {
  const today = Date.parse(todayISO)
  if (!Number.isFinite(today)) return []
  return rows
    .filter(r => {
      if (r.status !== 'priced' || !r.date) return false
      const t = Date.parse(r.date)
      if (!Number.isFinite(t)) return false
      const ageDays = (today - t) / 86_400_000
      return ageDays >= minDays && ageDays <= maxDays
    })
    .sort((a, b) => b.date.localeCompare(a.date))
}
