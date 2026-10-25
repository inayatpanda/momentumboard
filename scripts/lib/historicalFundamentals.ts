import { parseQuarterlyFinancials } from '../../netlify/functions/lib/quarterlyFinancials'
import { parseBusinessHealthSnapshot, type CompanyFacts } from '../../netlify/functions/lib/businessHealth'
import { assessBusinessHealth, type BusinessHealthSnapshot } from '../../shared/businessHealth'
import { assessBusinessValuation } from '../../shared/businessValuation'

export const FINANCIAL_HISTORY_VERSION = 'sec-asof-quarterly-v2'
// Fixed before viewing the new results: five established names per sector.
export const HISTORY_SECTOR_GROUPS: Record<string, string[]> = {
  XLK: ['AAPL','MSFT','INTC','CSCO','ORCL'], XLF: ['JPM','BAC','WFC','C','GS'],
  XLV: ['JNJ','PFE','MRK','AMGN','GILD'], XLE: ['XOM','CVX','COP','EOG','SLB'],
  XLI: ['CAT','HON','UPS','GE','MMM'], XLP: ['PG','KO','PEP','WMT','CL'],
  XLY: ['HD','MCD','NKE','SBUX','TGT'], XLC: ['DIS','VZ','T','CMCSA','NFLX'],
  XLU: ['DUK','SO','AEP','EXC','XEL'], XLB: ['NEM','FCX','APD','SHW','NUE'],
  XLRE: ['AMT','SPG','O','PSA','WELL'],
}
// EA was considered but the free feed returns only its final acquisition-day
// bar. NFLX replaces it for data coverage before any new results are inspected.
// EQR and AVB likewise returned one bar; WELL had the required full history.
export const HISTORY_SECTORS: Record<string,string> = Object.fromEntries(Object.entries(HISTORY_SECTOR_GROUPS).flatMap(([sector, symbols]) => symbols.map(sym => [sym,sector])))

const DAY = 86400
export interface FinancialPoint {
  availableAt: number
  snapshot: BusinessHealthSnapshot
  shares: { value: number; periodEnd: string; availableAt: number; accession: string } | null
}
export interface FinancialPanel { sym: string; fetchedAt: number; points: FinancialPoint[] }
const seconds = (value?: string) => value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) / 1000 : NaN

/** Filing-anchored sparse-to-daily alignment adapted from Vibe-Trading's
 * _ffill_pit (MIT, pinned source and licence in docs/third-party). Unlike a
 * calendar-day forward fill, a date-only filing waits until next-day noon UTC.
 * No value is backfilled before its publication; expiry is checked separately. */
export function financialPointAt(panel: FinancialPanel | undefined, at: number): FinancialPoint | null {
  const rows = panel?.points ?? []
  let lo = 0, hi = rows.length - 1, found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (rows[mid].availableAt <= at) { found = mid; lo = mid + 1 } else hi = mid - 1
  }
  return found < 0 ? null : rows[found]
}

/** Keep dates and units, reject weighted-average shares as a market-cap proxy.
 * Later split-restated filings never overwrite the earlier as-of snapshot. */
export function buildFinancialPanel(body: CompanyFacts, sym: string, now: number): FinancialPanel {
  const dates = new Set<number>()
  for (const concepts of Object.values(body.facts ?? {})) for (const concept of Object.values(concepts)) {
    for (const facts of Object.values(concept.units ?? {})) for (const f of facts) {
      const at = seconds(f.filed) + 1.5 * DAY
      if (Number.isFinite(at) && at <= now && at >= Date.UTC(2015, 0, 1) / 1000) dates.add(at)
    }
  }
  const shareRows = [
    ...(body.facts?.dei?.EntityCommonStockSharesOutstanding?.units?.shares ?? []),
    ...(body.facts?.['us-gaap']?.CommonStockSharesOutstanding?.units?.shares ?? []),
  ].filter(f => f.start == null && f.accn && /^(10-[KQ]|20-F|40-F)(\/A)?$/.test(f.form ?? '') &&
    Number.isFinite(f.val) && f.val! > 0 && Number.isFinite(seconds(f.end)) && Number.isFinite(seconds(f.filed)) && f.end! <= f.filed!)
  const points = [...dates].sort((a, b) => a - b).map(at => {
    const rows = shareRows.filter(f => seconds(f.filed) + 1.5 * DAY <= at)
      .sort((a, b) => b.end!.localeCompare(a.end!) || b.filed!.localeCompare(a.filed!))
    const row = rows[0]
    // Ambiguous share classes/contexts on the same date cannot silently become
    // aggregate shares. Standard facts do not encode every issuer-specific case.
    const ambiguous = row && rows.some(f => f.end === row.end && f.filed === row.filed && f.val !== row.val)
    return { availableAt: at, snapshot: { ...parseBusinessHealthSnapshot(body, sym, at), quarterly: parseQuarterlyFinancials(body, at) },
      shares: row && !ambiguous ? { value: row.val!, periodEnd: row.end!, availableAt: seconds(row.filed) + 1.5 * DAY, accession: row.accn! } : null }
  })
  return { sym, fetchedAt: now, points }
}

export function historicalFinancialState(panel: FinancialPanel | undefined, sym: string, at: number, splitAdjustedPrice: number,
  splits: { at: number; ratio: number }[] | undefined) {
  const point = panel?.sym === sym ? financialPointAt(panel, at) : null
  const snapshot = point?.snapshot
  const sector = HISTORY_SECTORS[sym]
  const health = assessBusinessHealth(snapshot, at, sector)
  const shares = point?.shares
  // Yahoo OHLC is split-adjusted. Undo subsequent splits to match shares that
  // were actually disclosed then. This is a unit conversion, not a signal.
  const priceFactor = splits?.filter(s => s.at > at).reduce((n, s) => n * s.ratio, 1)
  // A split between the share observation and signal also changes that share
  // count. Missing/ambiguous split metadata makes valuation unavailable.
  const shareFactor = shares && splits?.filter(s => s.at > seconds(shares.periodEnd) + DAY && s.at <= at).reduce((n, s) => n * s.ratio, 1)
  const splitDuringDisclosure = shares && splits?.some(s => s.at > seconds(shares.periodEnd) + DAY && s.at <= shares.availableAt)
  const cap = shares && !splitDuringDisclosure && priceFactor != null && shareFactor != null && at - seconds(shares.periodEnd) <= 180 * DAY &&
    shares.availableAt <= at && splitAdjustedPrice > 0 && Number.isFinite(priceFactor * shareFactor)
    ? { sym, marketCapUsdM: shares.value * shareFactor * splitAdjustedPrice * priceFactor / 1e6, currency: 'USD' as const,
      observedAt: at, source: 'historical-sec-shares' as const } : null
  const valuation = assessBusinessValuation(snapshot, cap, sector, at)
  return { health, valuation, snapshot, point, sector }
}
