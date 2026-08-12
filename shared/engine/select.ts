// Board diversification: top-N-by-conviction can fill the board with one
// sector trade wearing twelve tickers. Selection stays greedy by |composite|,
// but a candidate is skipped when its sector is already full or it moves in
// lockstep with a name already picked on the same side — twelve correlated
// bets are one bet with extra commission.

import { pearson } from './types'

export const MAX_PER_SECTOR = 3
export const CORR_CAP = 0.75
const CORR_DAYS = 60
const CORR_MIN_OVERLAP = 30

/** Pearson correlation of the last CORR_DAYS daily returns, paired by TAIL
 * POSITION — right for this job (two candle series pulled in the same batch, same
 * venue, same session count) and wrong for hypeCluster.ts, which pairs by date
 * because its series arrive from separate bounded fetches. The correlation kernel
 * itself is shared (types.ts); only the pairing differs.
 *
 * Null when the overlapping history is too short to mean anything. */
export function returnCorrelation(closesA: number[], closesB: number[]): number | null {
  const rets = (closes: number[]) => {
    const tail = closes.slice(-(CORR_DAYS + 1))
    const out: number[] = []
    for (let i = 1; i < tail.length; i++) {
      if (tail[i - 1]) out.push((tail[i] - tail[i - 1]) / tail[i - 1])
    }
    return out
  }
  const a = rets(closesA)
  const b = rets(closesB)
  const n = Math.min(a.length, b.length)
  if (n < CORR_MIN_OVERLAP) return null
  return pearson(a.slice(-n), b.slice(-n))
}

export interface DiverseCandidate {
  sym: string
  composite: number
}

/** Greedy pick by |composite| with two diversity gates: at most MAX_PER_SECTOR
 * names from one sector, and no candidate whose 60-day returns correlate above
 * CORR_CAP with an already-picked name. Unknown sector / missing candles pass
 * the respective gate (no data never blocks) — the gates prune redundancy,
 * they don't demand coverage. */
export function pickDiverse<T extends DiverseCandidate>(
  candidates: T[],
  cap: number,
  sectorOf: (sym: string) => string | null,
  closesOf: (sym: string) => number[] | null,
): { picked: T[]; skipped: { sym: string; why: string }[] } {
  const sorted = [...candidates].sort((a, b) => Math.abs(b.composite) - Math.abs(a.composite))
  const picked: T[] = []
  const skipped: { sym: string; why: string }[] = []
  const bySector: Record<string, number> = {}
  for (const cand of sorted) {
    if (picked.length >= cap) break
    const sector = sectorOf(cand.sym)
    if (sector && (bySector[sector] ?? 0) >= MAX_PER_SECTOR) {
      skipped.push({ sym: cand.sym, why: `sector ${sector} full` })
      continue
    }
    const closes = closesOf(cand.sym)
    let redundant: string | null = null
    if (closes) {
      for (const p of picked) {
        const pc = closesOf(p.sym)
        if (!pc) continue
        const r = returnCorrelation(closes, pc)
        if (r != null && r > CORR_CAP) {
          redundant = p.sym
          break
        }
      }
    }
    if (redundant) {
      skipped.push({ sym: cand.sym, why: `corr>${CORR_CAP} with ${redundant}` })
      continue
    }
    if (sector) bySector[sector] = (bySector[sector] ?? 0) + 1
    picked.push(cand)
  }
  return { picked, skipped }
}
