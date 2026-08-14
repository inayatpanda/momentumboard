import type { LedgerDay, LedgerPrediction } from './api'
import { capCohort } from './format'
import { isCryptoSymbol } from '../../shared/symbols'

// The ledger table's row model + honest topline: flatten days newest-first,
// and summarise ONLY what has actually been graded — open calls are counted,
// never scored.

export type LedgerStatus = 'open' | 'hit' | 'miss' | 'stopped'

// Resolution is judged at the CALIBRATED horizon (10 sessions): a row is "open"
// until its 10d grade lands, then hit/miss/stopped. The per-row table still shows
// both the 5d and 10d excess columns — this is only the headline status.
export function statusOf(p: LedgerPrediction): LedgerStatus {
  if (!p.outcome10) return 'open'
  if (p.outcome10.stopped) return 'stopped'
  return p.outcome10.hit ? 'hit' : 'miss'
}

/** THE ROWS THIS PANE'S ARITHMETIC IS ABOUT (Stage 1c Phase B).
 *
 * Every mean below adds up `outcome10.excessPct`, and on an equity row that
 * number is "the call's move minus SPY's". On a row stamped `cohort: 'crypto'`
 * it is the side-adjusted RAW move — the crypto partition grades absolute, and
 * `spyPct` is a structural 0 because nothing was subtracted. Adding the two
 * together produces a number that is neither: in a bull crypto tape it flatters
 * the engine's measured excess, in a bear one it damns it, and in both cases the
 * headline the reader trusts is answering a question nobody asked.
 *
 * So crypto is EXCLUDED from every equity aggregate and given its own
 * (`cryptoLedgerSummary`), which is exactly the treatment `engine-scorecard`
 * gives it server-side — the two panes roll the same rows and must not disagree
 * about one trade. The per-row table still SHOWS crypto rows; showing a row and
 * averaging it into a differently-defined mean are different acts.
 *
 * STAMP OR SYMBOL, because the server says stamp-or-symbol (D7). The stamp is
 * the honest key and a legacy crypto row published before the lane existed was
 * genuinely graded against SPY — but `engine.ts`'s scorecard pass excludes those
 * legacy rows BY SYMBOL (`if (isCryptoSymbol(p.sym)) continue`), so keying this
 * pane on the stamp alone made the two halves of one number disagree about one
 * trade: the server's scorecard tile dropped the row and the client's topline
 * kept it, and a reader comparing the two panes was reading two different
 * populations under one heading. Whether legacy rows SHOULD count is a real
 * question; whether the two sides should answer it differently is not. */
export const isCryptoCohort = (p: LedgerPrediction): boolean => p.cohort === 'crypto' || isCryptoSymbol(p.sym)
const equityRows = (rows: LedgerPrediction[]) => rows.filter(r => !isCryptoCohort(r))

export function flattenLedger(days: LedgerDay[], cap = 100): LedgerPrediction[] {
  const rows: LedgerPrediction[] = []
  for (const d of days) {
    for (const p of d.predictions) {
      rows.push(p)
      if (rows.length >= cap) return rows
    }
  }
  return rows
}

export interface LedgerSummary {
  total: number
  open: number
  graded: number
  hits: number
  stopped: number
  hitRate: number | null // hits / graded
  avgExcess10: number | null // mean excess vs SPY @10d (calibrated horizon) across graded
}

export interface GradeBucket {
  key: string // 'A' | 'B' | 'C' | 'shadow' | 'wildcard'
  n: number
  graded: number
  hits: number
  hitRate: number | null
  avgExcess10: number | null
}

/** Per-grade breakdown: do the tiers actually separate? Shadows are their own
 * bucket regardless of stored grade — they were suppressed calls, and mixing
 * them into A/B/C would flatter or damn the wrong tier.
 *
 * …and so is the EXPERIMENT SLOT (stage 3d), on the same argument and the same
 * precedence: a wildcard published BECAUSE the engine's own gates said no, so its
 * letter (stamped `grade ?? 'C'`) is not why it is on the board, and folding it
 * into C makes C mean two things. `engine-scorecard` settled this once for the
 * server-side pane; this is the client-side roll of the same rows, and the two
 * must not disagree about the same trade. Shadow still wins the tie — "the reader
 * was never offered this" is the stronger statement, and a shadowed wildcard was
 * declined rather than seated (engine.ts). */
export function gradeBreakdown(all: LedgerPrediction[]): GradeBucket[] {
  const rows = equityRows(all)
  const keys = ['A', 'B', 'C', 'shadow', 'wildcard'] as const
  return keys
    .map(key => {
      const bucket = rows.filter(r => (key === 'shadow' ? r.shadow : key === 'wildcard' ? !r.shadow && !!r.wildcard : !r.shadow && !r.wildcard && r.grade === key))
      const graded = bucket.filter(r => r.outcome10)
      const hits = graded.filter(r => r.outcome10!.hit).length
      const sum = graded.reduce((s, r) => s + r.outcome10!.excessPct, 0)
      return {
        key,
        n: bucket.length,
        graded: graded.length,
        hits,
        hitRate: graded.length ? Math.round((hits / graded.length) * 100) / 100 : null,
        avgExcess10: graded.length ? Math.round((sum / graded.length) * 10) / 10 : null,
      }
    })
    .filter(b => b.n > 0)
}

export interface CapClassBucket {
  key: 'Large-cap' | 'Small-cap' | 'Unknown'
  n: number
  graded: number
  hits: number
  hitRate: number | null
  avgExcess10: number | null
}

/** Per-cap-class breakdown: does the engine's edge hold up in large-caps, or
 * is it a small-cap-only effect? Display-only sleeve split — calibration stays
 * pooled across cohorts. */
export function capClassBreakdown(all: LedgerPrediction[]): CapClassBucket[] {
  // …and crypto is not an 'Unknown' cap, it is a different partition. A coin has
  // no market cap to look up, so unfiltered it would land in the Unknown sleeve
  // and mix an absolute return into that sleeve's excess mean.
  const rows = equityRows(all)
  const keys = ['Large-cap', 'Small-cap', 'Unknown'] as const
  return keys
    .map(key => {
      const bucket = rows.filter(r => capCohort(r.capUsdM) === key)
      const graded = bucket.filter(r => r.outcome10)
      const hits = graded.filter(r => r.outcome10!.hit).length
      const sum = graded.reduce((s, r) => s + r.outcome10!.excessPct, 0)
      return {
        key,
        n: bucket.length,
        graded: graded.length,
        hits,
        hitRate: graded.length ? Math.round((hits / graded.length) * 100) / 100 : null,
        avgExcess10: graded.length ? Math.round((sum / graded.length) * 10) / 10 : null,
      }
    })
    .filter(b => b.n > 0)
}

export function summariseLedger(all: LedgerPrediction[]): LedgerSummary {
  // CENSUS vs AVERAGE, split on purpose (1c Phase B). total/open/stopped are
  // counts of the table the tiles sit above, and the table lists crypto rows —
  // a census that excluded them would show "12 calls" over 13 visible rows.
  // A count of rows and a count of stop close-throughs mean the same thing in
  // both partitions. hitRate and avgExcess10 do NOT: they are computed on the
  // equity basis (excess vs SPY), so they stay equity-only — which is exactly
  // what the footnote below the tiles promises about "every average".
  const allGraded = all.filter(r => r.outcome10)
  const rows = equityRows(all)
  const graded = rows.filter(r => r.outcome10)
  const hits = graded.filter(r => r.outcome10!.hit).length
  const sumExcess = graded.reduce((s, r) => s + r.outcome10!.excessPct, 0)
  return {
    total: all.length,
    open: all.length - allGraded.length,
    graded: graded.length,
    hits,
    stopped: allGraded.filter(r => r.outcome10!.stopped).length,
    hitRate: graded.length ? Math.round((hits / graded.length) * 100) / 100 : null,
    avgExcess10: graded.length ? Math.round((sumExcess / graded.length) * 10) / 10 : null,
  }
}

/** THE CRYPTO COHORT'S OWN NUMBERS (Stage 1c Phase B) — the other half of the
 * exclusion above, because a population removed from every pane and given none
 * of its own is a population nobody can audit.
 *
 * `avgRaw10` rather than `avgExcess10`, and the rename is the point: this is the
 * mean SIDE-ADJUSTED MOVE over fourteen crypto bars, with no benchmark
 * subtracted, and a field sharing the equity name would be pasted into an equity
 * sentence the first time somebody rendered it. `n` counts the cohort's graded
 * outcomes — the same number the row's own voice quotes against the ~50 the
 * partition needs before its base rate stops reading a flat 0.5.
 *
 * Null when the cohort has graded nothing, which is the honest cold start rather
 * than a zero. */
export interface CryptoLedgerSummary {
  total: number
  open: number
  graded: number
  hits: number
  stopped: number
  hitRate: number | null
  /** Mean side-adjusted RAW move @14 crypto bars — no benchmark, nothing subtracted. */
  avgRaw10: number | null
}

export function cryptoLedgerSummary(all: LedgerPrediction[]): CryptoLedgerSummary {
  const rows = all.filter(isCryptoCohort)
  const graded = rows.filter(r => r.outcome10)
  const hits = graded.filter(r => r.outcome10!.hit).length
  const sum = graded.reduce((s, r) => s + r.outcome10!.excessPct, 0)
  return {
    total: rows.length,
    open: rows.length - graded.length,
    graded: graded.length,
    hits,
    stopped: graded.filter(r => r.outcome10!.stopped).length,
    hitRate: graded.length ? Math.round((hits / graded.length) * 100) / 100 : null,
    avgRaw10: graded.length ? Math.round((sum / graded.length) * 10) / 10 : null,
  }
}
