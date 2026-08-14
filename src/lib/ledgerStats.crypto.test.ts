import { describe, expect, it } from 'vitest'
import type { LedgerPrediction } from './api'
import { capClassBreakdown, cryptoLedgerSummary, gradeBreakdown, isCryptoCohort, summariseLedger } from './ledgerStats'

// THE spyPct:0 BLAST RADIUS (Stage 1c Phase B, B1's binding 1).
//
// A crypto row's `excessPct` is the side-adjusted RAW move and its `spyPct` is a
// structural 0 — the partition grades absolute, because a 24/7 asset class has
// no SPY. Every mean on this pane means "excess over the benchmark", so a crypto
// row inside one silently answers a different question with the same digits.
// These pins are the proof that it cannot, and that the cohort still gets an
// honest number of its own rather than vanishing.

const row = (over: Partial<LedgerPrediction>): LedgerPrediction =>
  ({
    id: `2026-08-01:${over.sym ?? 'X'}:long`,
    date: '2026-08-01',
    sym: 'X',
    side: 'long',
    grade: 'B',
    probability: 0.55,
    provisional: false,
    shadow: false,
    composite: 40,
    capUsdM: 50_000,
    entry: 100,
    stop: 90,
    target: 120,
    expectedMovePct: 4,
    stage: 'trending',
    regime: 'amber',
    earningsRisk: false,
    instrument: null,
    paperOnly: false,
    note: '',
    ...over,
  }) as LedgerPrediction

const out = (excessPct: number, spyPct: number, hit = excessPct >= 1) => ({ excessPct, rawPct: excessPct + spyPct, spyPct, stopped: false, hit })

/** Two equity calls that between them averaged +2pp of real excess. */
const equity = [
  row({ sym: 'NVDA', outcome10: out(3, 1) }),
  row({ sym: 'AMD', outcome10: out(1, 1) }),
]
/** …and one bitcoin call whose +40 is a RAW move against a bull tape. Big
 * enough that if it ever entered an equity mean the mean would be unmissable. */
const coin = row({ sym: 'BTC-USD', cohort: 'crypto', capUsdM: null, outcome10: out(40, 0) })

describe('a crypto row never enters an equity mean', () => {
  it('reads the STAMP, not the symbol — a legacy crypto row was graded vs SPY and belongs in it', () => {
    expect(isCryptoCohort(coin)).toBe(true)
    expect(isCryptoCohort(row({ sym: 'BTC-USD', outcome10: out(3, 1) }))).toBe(false)
  })

  it('leaves the topline avgExcess10 exactly where it was — while the CENSUS tiles count what the table shows', () => {
    expect(summariseLedger(equity).avgExcess10).toBe(2)
    const withCoin = summariseLedger([...equity, coin])
    const alone = summariseLedger(equity)
    // every AVERAGE (and the graded/hits counts that caption them) is equity-
    // basis arithmetic and does not move by one crypto outcome…
    expect(withCoin.avgExcess10).toBe(alone.avgExcess10)
    expect(withCoin.hitRate).toBe(alone.hitRate)
    expect(withCoin.graded).toBe(alone.graded)
    expect(withCoin.hits).toBe(alone.hits)
    // …but total/open/stopped are a CENSUS of the table the tiles sit above,
    // and the table lists the coin — "12 calls" over 13 visible rows was the
    // review's M4
    expect(withCoin.total).toBe(alone.total + 1)
    expect(withCoin.open).toBe(alone.open)
  })

  it('leaves every by-grade bucket exactly where it was', () => {
    expect(gradeBreakdown([...equity, coin])).toEqual(gradeBreakdown(equity))
  })

  it('is not an "Unknown cap" either — a coin has no cap to look up, and that is not the same fact', () => {
    expect(capClassBreakdown([...equity, coin])).toEqual(capClassBreakdown(equity))
    expect(capClassBreakdown([coin])).toEqual([])
  })
})

describe('…and the cohort still gets an honest number of its own', () => {
  it('rolls the crypto rows alone, under a field name that cannot be pasted into an equity sentence', () => {
    const s = cryptoLedgerSummary([...equity, coin])
    expect(s).toEqual({ total: 1, open: 0, graded: 1, hits: 1, stopped: 0, hitRate: 1, avgRaw10: 40 })
    expect('avgExcess10' in s).toBe(false)
  })

  it('is an honest cold start rather than a zero when nothing has graded', () => {
    expect(cryptoLedgerSummary(equity)).toMatchObject({ total: 0, graded: 0, hitRate: null, avgRaw10: null })
  })
})
