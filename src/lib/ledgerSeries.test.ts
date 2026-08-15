// The cumulative-excess series (owner iteration 2). The rules under test are
// the ones the chart's honesty rests on: equity only, graded only, oldest
// first, and no invented points.

import { describe, expect, it } from 'vitest'
import { bestAndWorst, cumulativeExcessSeries } from './ledgerSeries'
import type { JourneyCall, LedgerDay } from './apiViews'

function mkCall(overrides: Partial<JourneyCall> = {}): JourneyCall {
  return {
    id: 'c1',
    date: '2026-08-10',
    sym: 'NVDA',
    side: 'long',
    grade: 'A',
    probability: 0.6,
    provisional: false,
    shadow: false,
    composite: 60,
    entry: 100,
    stop: 94,
    target: 112,
    expectedMovePct: 4,
    stage: 'trending',
    regime: 'green',
    earningsRisk: false,
    instrument: null,
    paperOnly: false,
    note: '',
    postMortem: null,
    outcome21: null,
    ...overrides,
  } as JourneyCall
}

const graded = (excessPct: number) => ({ excessPct, rawPct: excessPct, spyPct: 0, stopped: false, hit: excessPct > 0 })
const day = (date: string, predictions: JourneyCall[]): LedgerDay => ({ date, predictions })

describe('cumulativeExcessSeries', () => {
  it('returns nothing for an empty ledger', () => {
    expect(cumulativeExcessSeries([])).toEqual([])
    expect(cumulativeExcessSeries([day('2026-08-10', [])])).toEqual([])
  })

  it('returns a single point for a single graded day', () => {
    const s = cumulativeExcessSeries([day('2026-08-10', [mkCall({ outcome10: graded(3.5) })])])
    expect(s).toEqual([{ date: '2026-08-10', daily: 3.5, cumulative: 3.5, n: 1 }])
  })

  it('sums within a day and cumulates forward, OLDEST first', () => {
    // the slice arrives newest-first; the line reads left to right
    const s = cumulativeExcessSeries([
      day('2026-08-12', [mkCall({ id: 'c', date: '2026-08-12', outcome10: graded(-1) })]),
      day('2026-08-10', [
        mkCall({ id: 'a', date: '2026-08-10', outcome10: graded(2) }),
        mkCall({ id: 'b', date: '2026-08-10', outcome10: graded(3) }),
      ]),
    ])
    expect(s.map(p => [p.date, p.daily, p.cumulative, p.n])).toEqual([
      ['2026-08-10', 5, 5, 2],
      ['2026-08-12', -1, 4, 1],
    ])
  })

  // The cohort grades ABSOLUTE over fourteen crypto bars and `spyPct` is a
  // structural 0 — cumulating it into an excess-vs-SPY line makes the line
  // mean neither thing.
  it('excludes crypto rows, by stamp AND by symbol', () => {
    const s = cumulativeExcessSeries([
      day('2026-08-10', [
        mkCall({ id: 'e', outcome10: graded(2) }),
        mkCall({ id: 'k1', sym: 'BTC-USD', cohort: 'crypto', outcome10: graded(40) }),
        mkCall({ id: 'k2', sym: 'ETH-USD', outcome10: graded(40) }), // legacy row, no stamp
      ]),
    ])
    expect(s).toEqual([{ date: '2026-08-10', daily: 2, cumulative: 2, n: 1 }])
  })

  it('skips ungraded rows entirely — a day with none contributes NO point', () => {
    const s = cumulativeExcessSeries([
      day('2026-08-11', [mkCall({ id: 'open', date: '2026-08-11' })]), // no outcome10
      day('2026-08-10', [mkCall({ id: 'done', date: '2026-08-10', outcome10: graded(1.5) })]),
    ])
    expect(s.map(p => p.date)).toEqual(['2026-08-10'])
  })

  it('ignores a non-finite excess rather than poisoning the running total', () => {
    const s = cumulativeExcessSeries([
      day('2026-08-10', [
        mkCall({ id: 'bad', outcome10: { excessPct: Number.NaN, rawPct: 0, spyPct: 0, stopped: false, hit: false } }),
        mkCall({ id: 'ok', outcome10: graded(2) }),
      ]),
    ])
    expect(s).toEqual([{ date: '2026-08-10', daily: 2, cumulative: 2, n: 1 }])
  })

  it('buckets by the ROW’s date, not the day key it arrived under', () => {
    const s = cumulativeExcessSeries([day('2026-08-12', [mkCall({ date: '2026-08-09', outcome10: graded(4) })])])
    expect(s[0].date).toBe('2026-08-09')
  })
})

describe('bestAndWorst', () => {
  it('finds both ends of the window and carries the post-mortem sentence', () => {
    const { best, worst } = bestAndWorst([
      day('2026-08-10', [
        mkCall({ id: 'a', sym: 'NVDA', outcome10: graded(9.1) }),
        mkCall({ id: 'b', sym: 'TSLA', outcome10: graded(-6.3), postMortem: { cls: 'loss', detail: 'd', at: 1, sentence: 'Stopped on a gap down.' } }),
        mkCall({ id: 'c', sym: 'AMD', outcome10: graded(1) }),
      ]),
    ])
    expect(best).toMatchObject({ sym: 'NVDA', excessPct: 9.1, postMortem: null })
    expect(worst).toMatchObject({ sym: 'TSLA', excessPct: -6.3, postMortem: 'Stopped on a gap down.' })
  })

  it('is null on both ends with nothing graded, and excludes crypto like the line does', () => {
    expect(bestAndWorst([])).toEqual({ best: null, worst: null })
    expect(bestAndWorst([day('2026-08-10', [mkCall({ sym: 'BTC-USD', cohort: 'crypto', outcome10: graded(50) })])])).toEqual({ best: null, worst: null })
  })

  it('names the same row on both ends when only one graded', () => {
    const { best, worst } = bestAndWorst([day('2026-08-10', [mkCall({ sym: 'PLTR', outcome10: graded(2.2) })])])
    expect(best?.sym).toBe('PLTR')
    expect(worst?.sym).toBe('PLTR')
  })
})
