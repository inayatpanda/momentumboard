import type { LedgerDay, LedgerPrediction } from './api'

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
