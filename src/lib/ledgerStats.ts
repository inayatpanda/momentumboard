import type { LedgerDay, LedgerPrediction } from './api'
import { capCohort } from './format'

// The ledger table's row model + honest topline: flatten days newest-first,
// and summarise ONLY what has actually been graded — open calls are counted,
// never scored.

export type LedgerStatus = 'open' | 'hit' | 'miss' | 'stopped'

export function statusOf(p: LedgerPrediction): LedgerStatus {
  if (!p.outcome5) return 'open'
  if (p.outcome5.stopped) return 'stopped'
  return p.outcome5.hit ? 'hit' : 'miss'
}

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
  avgExcess5: number | null // mean excess vs SPY @5d across graded
}

export interface GradeBucket {
  key: string // 'A' | 'B' | 'C' | 'shadow'
  n: number
  graded: number
  hits: number
  hitRate: number | null
  avgExcess5: number | null
}

/** Per-grade breakdown: do the tiers actually separate? Shadows are their own
 * bucket regardless of stored grade — they were suppressed calls, and mixing
 * them into A/B/C would flatter or damn the wrong tier. */
export function gradeBreakdown(rows: LedgerPrediction[]): GradeBucket[] {
  const keys = ['A', 'B', 'C', 'shadow'] as const
  return keys
    .map(key => {
      const bucket = rows.filter(r => (key === 'shadow' ? r.shadow : !r.shadow && r.grade === key))
      const graded = bucket.filter(r => r.outcome5)
      const hits = graded.filter(r => r.outcome5!.hit).length
      const sum = graded.reduce((s, r) => s + r.outcome5!.excessPct, 0)
      return {
        key,
        n: bucket.length,
        graded: graded.length,
        hits,
        hitRate: graded.length ? Math.round((hits / graded.length) * 100) / 100 : null,
        avgExcess5: graded.length ? Math.round((sum / graded.length) * 10) / 10 : null,
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
  avgExcess5: number | null
}

/** Per-cap-class breakdown: does the engine's edge hold up in large-caps, or
 * is it a small-cap-only effect? Display-only sleeve split — calibration stays
 * pooled across cohorts. */
export function capClassBreakdown(rows: LedgerPrediction[]): CapClassBucket[] {
  const keys = ['Large-cap', 'Small-cap', 'Unknown'] as const
  return keys
    .map(key => {
      const bucket = rows.filter(r => capCohort(r.capUsdM) === key)
      const graded = bucket.filter(r => r.outcome5)
      const hits = graded.filter(r => r.outcome5!.hit).length
      const sum = graded.reduce((s, r) => s + r.outcome5!.excessPct, 0)
      return {
        key,
        n: bucket.length,
        graded: graded.length,
        hits,
        hitRate: graded.length ? Math.round((hits / graded.length) * 100) / 100 : null,
        avgExcess5: graded.length ? Math.round((sum / graded.length) * 10) / 10 : null,
      }
    })
    .filter(b => b.n > 0)
}

export function summariseLedger(rows: LedgerPrediction[]): LedgerSummary {
  const graded = rows.filter(r => r.outcome5)
  const hits = graded.filter(r => r.outcome5!.hit).length
  const stopped = graded.filter(r => r.outcome5!.stopped).length
  const sumExcess = graded.reduce((s, r) => s + r.outcome5!.excessPct, 0)
  return {
    total: rows.length,
    open: rows.length - graded.length,
    graded: graded.length,
    hits,
    stopped,
    hitRate: graded.length ? Math.round((hits / graded.length) * 100) / 100 : null,
    avgExcess5: graded.length ? Math.round((sumExcess / graded.length) * 10) / 10 : null,
  }
}
