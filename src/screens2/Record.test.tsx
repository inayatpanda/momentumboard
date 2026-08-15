// Record (plan Task 20) — Track record: scorecard, calibration, the ledger
// as cards, the regret surface. Same local-first pattern as Board.test.tsx/
// StockPage.test.tsx: fetchers mocked to never resolve, every case paints
// from a seeded Dexie slice.

import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Router } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import { db } from '../lib/db'
import type { JourneyCall, LearningSlice, LedgerDay, RegretGate } from '../lib/apiViews'
import type { MissExample } from '../../shared/engine/missLedger'
import Record from './Record'

vi.mock('../lib/apiViews', async () => {
  const actual = await vi.importActual<typeof import('../lib/apiViews')>('../lib/apiViews')
  return {
    ...actual,
    getLearning: () => new Promise<never>(() => {}),
    getLedgerDays: () => new Promise<never>(() => {}),
  }
})

const withRouter = () => render(<Router base="/app" hook={memoryLocation({ path: '/app/record' }).hook}>{<Record />}</Router>)

function mkLearning(overrides: Partial<LearningSlice> = {}): LearningSlice {
  return {
    gateState: { gates: [] },
    gateLines: null,
    regrets: null,
    weights: null,
    scorecard: null,
    roster: null,
    channelCred: {},
    calibration: null,
    ...overrides,
  }
}

function mkCall(overrides: Partial<JourneyCall> = {}): JourneyCall {
  return {
    id: 'c1',
    date: '2026-08-10',
    sym: 'NVDA',
    side: 'long',
    grade: 'A',
    probability: 0.61,
    provisional: false,
    shadow: false,
    composite: 61,
    entry: 118,
    stop: 111,
    target: 131,
    expectedMovePct: 4.1,
    stage: 'trending',
    regime: 'green',
    earningsRisk: false,
    instrument: null,
    paperOnly: false,
    note: 'ledger note',
    postMortem: null,
    outcome21: null,
    ...overrides,
  }
}

function mkExample(overrides: Partial<MissExample> = {}): MissExample {
  return { date: '2026-08-04', sym: 'PLTR', side: 'long', excessPct: 6.1, gate: 'dead-zone-core', ...overrides }
}

function mkRegretGate(overrides: Partial<RegretGate> = {}): RegretGate {
  return {
    gate: 'dead-zone-core',
    cost: 2,
    avgCostExcessPct: 7.7,
    saved: 1,
    avgSavedExcessPct: 2,
    unchecked: 3,
    examples: [mkExample()],
    ...overrides,
  }
}

function mkRegrets(overrides: Partial<NonNullable<LearningSlice['regrets']>> = {}): NonNullable<LearningSlice['regrets']> {
  return {
    days: 10,
    checked: 5,
    unchecked: 3,
    misses: 2,
    topGates: [mkRegretGate()],
    note: '3 of 8 refusals went unpriced — an unmeasured gate is not a costless one; excesses are stopless upper bounds.',
    ...overrides,
  }
}

async function seedLearning(learning: LearningSlice) {
  await db.slices.put({ key: 'learning', data: learning, fetchedAt: Date.now() })
}
async function seedLedger(key: 'ledger:7' | 'ledger:30', days: LedgerDay[]) {
  await db.slices.put({ key, data: { days }, fetchedAt: Date.now() })
}

beforeEach(async () => {
  await db.slices.clear()
  window.history.pushState(null, '', '/app/record')
})

describe('Record', () => {
  it('has a heading containing "Track record"', async () => {
    withRouter()
    expect(await screen.findByRole('heading', { name: /track record/i })).toBeInTheDocument()
  })

  describe('scorecard tiles', () => {
    it('labels shadow and wildcard tiles distinctly — never "Grade shadow"', async () => {
      await seedLearning(
        mkLearning({
          scorecard: {
            byGrade: {
              A: { n: 12, hits: 8, sumExcess: 30 },
              shadow: { n: 4, hits: 1, sumExcess: -2 },
              wildcard: { n: 3, hits: 2, sumExcess: 9 },
            },
            byRegime: {},
            overlays: {},
            brierTail: [],
            totalGraded: 19,
          },
        }),
      )
      withRouter()
      const sc = await screen.findByLabelText('Scorecard')
      // the TILES specifically — the per-grade table below them (owner
      // iteration 2) labels its rows from the same function, so an unscoped
      // query would match twice and prove nothing about either surface
      const tiles = sc.querySelector('.rec-tiles') as HTMLElement
      expect(within(tiles).getByText('Grade A')).toBeInTheDocument()
      expect(within(tiles).getByText('Shadow book')).toBeInTheDocument()
      expect(within(tiles).getByText(/🃏 Wildcard/)).toBeInTheDocument()
      // never invents a tier neither key has
      expect(within(sc).queryByText('Grade shadow')).not.toBeInTheDocument()
      expect(within(sc).queryByText('Grade wildcard')).not.toBeInTheDocument()
    })

    // THE SCORECARD IS THE EQUITY PARTITION'S (crypto-v2 wave, finding 4). Every
    // number in it is an excess against SPY over ten sessions, and the grading
    // pass keeps every cohort row out of it on purpose — so the header has to
    // say which population it is about, or a crypto reader reads it as the whole.
    it('names the scorecard as the EQUITY partition, and says what its numbers are', async () => {
      await seedLearning(mkLearning({ scorecard: { byGrade: { A: { n: 2, hits: 1, sumExcess: 3 } }, byRegime: {}, overlays: {}, brierTail: [], totalGraded: 2 } }))
      withRouter()
      const sc = await screen.findByLabelText('Scorecard')
      expect(within(sc).getByText(/equity/i)).toBeInTheDocument()
      expect(within(sc).getByText(/excess vs SPY/i)).toBeInTheDocument()
    })
  })

  // D8: the calibration plot is `engine-calibration`, the SAME equity partition
  // the tiles above are named for — and it carried no name at all, so it read as
  // the whole engine's. Its fallback sentence claimed "every graded call" too,
  // which stopped being true the day the cohort started grading its own.
  describe('calibration', () => {
    it('names the plot as the equity partition', async () => {
      await seedLearning(mkLearning({ calibration: { buckets: {}, brier: [], seeded: true, modelVersion: null, referenceBase: 0.41, evidence: null } }))
      withRouter()
      const cal = await screen.findByLabelText('Calibration')
      expect(within(cal).getByText(/Equity — excess vs SPY/)).toBeInTheDocument()
    })

    it('says the pooled rate is over equity calls, not "every graded call"', async () => {
      await seedLearning(mkLearning({ calibration: { buckets: {}, brier: [], seeded: false, modelVersion: null, referenceBase: null, evidence: null } }))
      withRouter()
      const cal = await screen.findByLabelText('Calibration')
      expect(within(cal).getByText(/every graded equity call/)).toBeInTheDocument()
      expect(within(cal).queryByText(/across every graded call/)).not.toBeInTheDocument()
    })
  })

  // THE COHORT'S OWN PANE (finding 4). Excluded from every equity aggregate and
  // given none of its own, the crypto cohort's hit rate, average raw return,
  // calibration and independently earned rung all disappear at cutover.
  describe('the crypto panel', () => {
    const cryptoLearning = () =>
      mkLearning({
        scorecard: { byGrade: { A: { n: 2, hits: 1, sumExcess: 3 } }, byRegime: {}, overlays: {}, brierTail: [], totalGraded: 2 },
        crypto: {
          gradedN: 12,
          coldStartN: 50,
          rung: 0,
          gradedAtRung: 12,
          sinceDate: '2026-08-01',
          calibration: { buckets: {}, brier: [0.24], seeded: false, modelVersion: null, referenceBase: null, evidence: null, basis: 'absolute' },
        },
      })

    it('renders a distinct raw/no-benchmark panel with the cohort’s own numbers', async () => {
      await seedLearning(cryptoLearning())
      await seedLedger('ledger:30', [
        {
          date: '2026-08-10',
          predictions: [
            mkCall({ id: 'k1', sym: 'BTC-USD', cohort: 'crypto', outcome10: { excessPct: 6.4, rawPct: 6.4, spyPct: 0, stopped: false, hit: true } }),
            mkCall({ id: 'k2', sym: 'ETH-USD', cohort: 'crypto', outcome10: { excessPct: -2.4, rawPct: -2.4, spyPct: 0, stopped: false, hit: false } }),
            // the equity row must not touch a single crypto number
            mkCall({ id: 'e1', sym: 'NVDA', outcome10: { excessPct: 20, rawPct: 21, spyPct: 1, stopped: false, hit: true } }),
          ],
        },
      ])
      withRouter()
      const panel = await screen.findByLabelText('Crypto scorecard')
      expect(within(panel).getByText(/raw, no benchmark/i)).toBeInTheDocument()
      expect(within(panel).getByText(/50%/)).toBeInTheDocument() // 1 of 2 graded — the cohort's own rows only
      expect(within(panel).getByText(/\+2.0%/)).toBeInTheDocument() // mean RAW move, (6.4 + −2.4) / 2
      expect(within(panel).getByText(/12/)).toBeInTheDocument() // its own graded outcomes, against the ~50 cold start
      expect(within(panel).getByText(/R0/)).toBeInTheDocument() // the rung it earned itself
      expect(within(panel).queryByText(/SPY/i)).not.toBeInTheDocument() // there is no benchmark in this partition
    })

    // codex #4: the cohort HAS a calibration — served right there on the slice,
    // struck on the absolute basis — and not a character of it rendered, so the
    // only calibration on this page was the equity one.
    it('renders the cohort’s own calibration compactly, named as the absolute basis', async () => {
      await seedLearning(
        mkLearning({
          crypto: {
            gradedN: 12,
            coldStartN: 50,
            rung: 0,
            gradedAtRung: 12,
            sinceDate: '2026-08-01',
            calibration: {
              buckets: { '0.4': { n: 6, hits: 3 }, '0.5': { n: 4, hits: 2 } },
              brier: [{ date: '2026-08-13', mean: 0.212, n: 10 }],
              seeded: false,
              modelVersion: null,
              referenceBase: null,
              evidence: null,
              basis: 'absolute',
            },
          },
        }),
      )
      withRouter()
      const panel = await screen.findByLabelText('Crypto scorecard')
      const line = within(panel).getByText(/absolute basis/i)
      expect(line).toHaveTextContent(/2 probability buckets filled/)
      expect(line).toHaveTextContent(/latest Brier/)
      expect(within(line).getByText('0.212')).toHaveClass('num')
      expect(within(panel).queryByText(/SPY/i)).not.toBeInTheDocument() // still no benchmark in this partition
    })

    // codex #11: the window was LedgerSection's private state, so the cards
    // could show thirty days while this panel still rolled seven. It is now
    // ONE window for the whole screen (owner iteration 2 dropped the widen
    // button), which is the same invariant with nothing left to desynchronise.
    it('rolls the SAME window the cards render', async () => {
      const coin = (id: string, date: string, hit: boolean) =>
        mkCall({ id, date, sym: 'BTC-USD', cohort: 'crypto', outcome10: { excessPct: hit ? 6 : -2, rawPct: hit ? 6 : -2, spyPct: 0, stopped: false, hit } })
      await seedLearning(cryptoLearning())
      await seedLedger('ledger:30', [
        { date: '2026-08-10', predictions: [coin('k1', '2026-08-10', true)] },
        { date: '2026-07-20', predictions: [coin('k2', '2026-07-20', true), coin('k3', '2026-07-20', false)] },
      ])
      withRouter()
      const panel = await screen.findByLabelText('Crypto scorecard')
      expect(await within(panel).findByText(/2 of 3 graded here/)).toBeInTheDocument()
    })

    it('renders no crypto panel at all when the partition has never moved', async () => {
      await seedLearning(mkLearning({ scorecard: { byGrade: { A: { n: 2, hits: 1, sumExcess: 3 } }, byRegime: {}, overlays: {}, brierTail: [], totalGraded: 2 } }))
      withRouter()
      await screen.findByLabelText('Scorecard')
      expect(screen.queryByLabelText('Crypto scorecard')).not.toBeInTheDocument()
    })
  })

  describe('ledger day cards', () => {
    it('shows NO grade pill on a watch-only row, and shows one on a sized row', async () => {
      const sizedCall = mkCall({ id: 'sized1', sym: 'NVDA', watchOnly: false, grade: 'A' })
      const watchCall = mkCall({ id: 'watch1', sym: 'AMD', watchOnly: true, grade: 'B' })
      await seedLedger('ledger:30', [{ date: '2026-08-10', predictions: [sizedCall, watchCall] }])
      withRouter()
      const ledger = await screen.findByLabelText('The ledger')
      expect(await within(ledger).findByText('NVDA')).toBeInTheDocument()
      expect(within(ledger).getByLabelText('Grade A')).toBeInTheDocument()
      expect(within(ledger).queryByLabelText('Grade B')).not.toBeInTheDocument()
      // the watch row still carries the shared law's honest reason line
      expect(within(ledger).getByText(/watch — no size yet/i)).toBeInTheDocument()
    })

    // THE RECEIPT'S OWN BASIS (crypto-v2 wave, finding 2). `10d … vs SPY` is
    // hard-coded on both v2 receipt surfaces. On a cohort row those digits are
    // an ABSOLUTE side-adjusted move over 14 / 29 CRYPTO BARS — weekends
    // included — and nothing was ever subtracted, so the equity label is a claim
    // the engine never made (src/components/LedgerCard.tsx made this branch).
    it('labels a cohort row’s outcomes as raw crypto bars, never as an excess over SPY', async () => {
      const coin = mkCall({
        id: 'k1',
        sym: 'BTC-USD',
        cohort: 'crypto',
        outcome10: { excessPct: 6.4, rawPct: 6.4, spyPct: 0, stopped: false, hit: true },
        outcome21: { excessPct: -1.2, rawPct: -1.2, spyPct: 0, stopped: false, hit: false },
      })
      const equity = mkCall({ id: 'e1', sym: 'NVDA', outcome10: { excessPct: 4.2, rawPct: 5, spyPct: 0.8, stopped: false, hit: true } })
      await seedLedger('ledger:30', [{ date: '2026-08-10', predictions: [coin, equity] }])
      withRouter()
      const ledger = await screen.findByLabelText('The ledger')
      const coinPill = await within(ledger).findByText(/14b/)
      expect(coinPill).toHaveTextContent('+6.4%')
      expect(coinPill).toHaveTextContent(/raw — no benchmark/)
      expect(coinPill).not.toHaveTextContent(/SPY/)
      expect(within(ledger).getByText(/29b/)).toHaveTextContent('−1.2%')
      // the equity row keeps its own sentence, unchanged
      expect(within(ledger).getByText(/10d/)).toHaveTextContent(/vs SPY/)
    })

    it('renders the post-mortem sentence on the row that carries one', async () => {
      const call = mkCall({
        id: 'pm1',
        sym: 'TSLA',
        postMortem: { cls: 'loss', detail: 'detail only', at: 1, sentence: 'Stopped out on a gap down.' },
      })
      await seedLedger('ledger:30', [{ date: '2026-08-10', predictions: [call] }])
      withRouter()
      const ledger = await screen.findByLabelText('The ledger')
      expect(await within(ledger).findByText('Stopped out on a gap down.')).toBeInTheDocument()
    })

    // OWNER ITERATION 2: the window is thirty days from the first paint, and
    // the widen button — whose only job was to enlarge a number the reader had
    // no reason to think was narrow — is gone.
    it('reads the 30-day slice from the first paint, with no widen button anywhere', async () => {
      await seedLedger('ledger:30', [
        { date: '2026-08-10', predictions: [mkCall({ id: 'a1', sym: 'NVDA' })] },
        { date: '2026-07-14', predictions: [mkCall({ id: 'b1', sym: 'OLDCO', date: '2026-07-14' })] },
      ])
      withRouter()
      const ledger = await screen.findByLabelText('The ledger')
      expect(await within(ledger).findByText('NVDA')).toBeInTheDocument()
      expect(await within(ledger).findByText('OLDCO')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /load 30 days/i })).not.toBeInTheDocument()
    })

    it('renders NO grade pill on a belowBase row, and shows one on a normal sized row', async () => {
      const sizedCall = mkCall({ id: 'sized2', sym: 'AAPL', belowBase: false, grade: 'A' })
      const belowBaseCall = mkCall({ id: 'below1', sym: 'MSFT', belowBase: true, grade: 'B' })
      await seedLedger('ledger:30', [{ date: '2026-08-10', predictions: [sizedCall, belowBaseCall] }])
      withRouter()
      const ledger = await screen.findByLabelText('The ledger')
      expect(await within(ledger).findByText('AAPL')).toBeInTheDocument()
      expect(within(ledger).getByLabelText('Grade A')).toBeInTheDocument()
      expect(within(ledger).queryByLabelText('Grade B')).not.toBeInTheDocument()
    })

    it('renders shadow label and no grade pill on a shadow row', async () => {
      const shadowCall = mkCall({ id: 'shadow1', sym: 'TSLA', shadow: true, grade: 'A' })
      await seedLedger('ledger:30', [{ date: '2026-08-10', predictions: [shadowCall] }])
      withRouter()
      const ledger = await screen.findByLabelText('The ledger')
      expect(await within(ledger).findByText('TSLA')).toBeInTheDocument()
      expect(within(ledger).getByText(/shadow — never a live size/)).toBeInTheDocument()
      expect(within(ledger).queryByLabelText('Grade A')).not.toBeInTheDocument()
    })
  })

  // OWNER ITERATION 2: "Track record is basically useless, the graph doesnt
  // mean anything. more information need to stay in track record."
  describe('the cumulative line', () => {
    const gradedCall = (id: string, date: string, excessPct: number, over: Partial<JourneyCall> = {}) =>
      mkCall({ id, date, outcome10: { excessPct, rawPct: excessPct, spyPct: 0, stopped: false, hit: excessPct > 0 }, ...over })

    it('names what it is measuring and prints the running total', async () => {
      await seedLedger('ledger:30', [
        { date: '2026-08-12', predictions: [gradedCall('b', '2026-08-12', -1.5, { sym: 'AMD' })] },
        { date: '2026-08-10', predictions: [gradedCall('a', '2026-08-10', 4)] },
      ])
      withRouter()
      const chart = await screen.findByLabelText('Cumulative excess')
      expect(within(chart).getByText(/if you.?d taken every sized call/i)).toBeInTheDocument()
      expect(within(chart).getByText(/cumulative excess vs SPY, last 30 days/i)).toBeInTheDocument()
      // the running total, read off the headline (the y-axis labels are pp too)
      expect(chart.querySelector('.rec-chart-total')).toHaveTextContent('+2.5pp') // 4 then −1.5
      expect(chart.querySelector('.rec-chart-total')).toHaveClass('num')
      expect(chart.querySelector('.rec-chart-path')).not.toBeNull()
    })

    it('says so plainly rather than drawing a line through one point', async () => {
      await seedLedger('ledger:30', [{ date: '2026-08-10', predictions: [gradedCall('a', '2026-08-10', 4)] }])
      withRouter()
      const chart = await screen.findByLabelText('Cumulative excess')
      expect(within(chart).getByText(/one graded day so far/i)).toBeInTheDocument()
      expect(chart.querySelector('.rec-chart-path')).toBeNull()
    })

    it('says nothing has graded yet on an empty window', async () => {
      await seedLedger('ledger:30', [])
      withRouter()
      const chart = await screen.findByLabelText('Cumulative excess')
      expect(within(chart).getByText(/nothing has graded in this window yet/i)).toBeInTheDocument()
    })

    // the chart is an EXCESS-vs-SPY line; the cohort grades absolute over
    // fourteen crypto bars, so one of its rows in here means the line is
    // measuring neither thing
    it('leaves crypto rows out of the line entirely', async () => {
      await seedLedger('ledger:30', [
        {
          date: '2026-08-10',
          predictions: [gradedCall('e', '2026-08-10', 2), gradedCall('k', '2026-08-10', 40, { sym: 'BTC-USD', cohort: 'crypto' })],
        },
        { date: '2026-08-11', predictions: [gradedCall('e2', '2026-08-11', 1)] },
      ])
      withRouter()
      const chart = await screen.findByLabelText('Cumulative excess')
      expect(chart.querySelector('.rec-chart-total')).toHaveTextContent('+3.0pp')
      expect(within(chart).queryByText(/\+43/)).not.toBeInTheDocument()
    })
  })

  describe('best and worst of the window', () => {
    const gradedCall = (id: string, sym: string, excessPct: number, over: Partial<JourneyCall> = {}) =>
      mkCall({ id, sym, outcome10: { excessPct, rawPct: excessPct, spyPct: 0, stopped: false, hit: excessPct > 0 }, ...over })

    it('names both ends, with the engine’s own sentence on the loser', async () => {
      await seedLedger('ledger:30', [
        {
          date: '2026-08-10',
          predictions: [
            gradedCall('a', 'NVDA', 9.1),
            gradedCall('b', 'TSLA', -6.3, { postMortem: { cls: 'loss', detail: 'd', at: 1, sentence: 'Stopped on a gap down.' } }),
          ],
        },
      ])
      withRouter()
      const ends = await screen.findByLabelText('Best and worst')
      expect(within(ends).getByText('NVDA')).toBeInTheDocument()
      expect(within(ends).getByText('+9.1pp')).toBeInTheDocument()
      expect(within(ends).getByText('TSLA')).toBeInTheDocument()
      expect(within(ends).getByText('−6.3pp')).toBeInTheDocument()
      expect(within(ends).getByText('Stopped on a gap down.')).toBeInTheDocument()
    })

    it('prints one graded row ONCE, not as both ends', async () => {
      await seedLedger('ledger:30', [{ date: '2026-08-10', predictions: [gradedCall('a', 'PLTR', 2.2)] }])
      withRouter()
      const ends = await screen.findByLabelText('Best and worst')
      expect(within(ends).getAllByText('PLTR')).toHaveLength(1)
      expect(within(ends).queryByText(/worst of the window/i)).not.toBeInTheDocument()
    })

    it('renders nothing at all with nothing graded', async () => {
      await seedLedger('ledger:30', [{ date: '2026-08-10', predictions: [mkCall({ id: 'open' })] }])
      withRouter()
      await screen.findByLabelText('The ledger')
      expect(screen.queryByLabelText('Best and worst')).not.toBeInTheDocument()
    })
  })

  describe('the per-grade table', () => {
    it('lines the tiers up as n / hit / avg excess so the reader can see them separate', async () => {
      await seedLearning(
        mkLearning({
          scorecard: {
            byGrade: { A: { n: 10, hits: 7, sumExcess: 30 }, C: { n: 4, hits: 1, sumExcess: -4 } },
            byRegime: {},
            overlays: {},
            brierTail: [],
            totalGraded: 14,
          },
        }),
      )
      withRouter()
      const table = await screen.findByLabelText('Per-grade record')
      const rows = [...table.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent))
      expect(rows).toEqual([
        ['Grade A', '10', '70%', '+3.0%'],
        ['Grade C', '4', '25%', '−1.0%'],
      ])
    })

    it('renders no table when there is only one populated tier — one row compares nothing', async () => {
      await seedLearning(mkLearning({ scorecard: { byGrade: { A: { n: 2, hits: 1, sumExcess: 3 } }, byRegime: {}, overlays: {}, brierTail: [], totalGraded: 2 } }))
      withRouter()
      await screen.findByLabelText('Scorecard')
      expect(screen.queryByLabelText('Per-grade record')).not.toBeInTheDocument()
    })
  })

  it('explains the calibration plot in plain words above it', async () => {
    await seedLearning(mkLearning({ calibration: { buckets: {}, brier: [], seeded: true, modelVersion: null, referenceBase: 0.41, evidence: null } }))
    withRouter()
    const cal = await screen.findByLabelText('Calibration')
    expect(within(cal).getByText(/what the engine predicted \(x\) vs what actually happened \(y\)/i)).toBeInTheDocument()
    expect(within(cal).getByText(/honest predictions sit on the diagonal/i)).toBeInTheDocument()
  })

  describe('regrets', () => {
    it('shows a count-labelled cost and a pp-labelled average, and the strings stay distinct', async () => {
      await seedLearning(mkLearning({ regrets: mkRegrets({ unchecked: 0 }) }))
      withRouter()
      const regrets = await screen.findByLabelText('Regrets')
      // the COUNT clause never carries "pp" — CX-15
      const costLine = await within(regrets).findByText(/^Refused 2 priced times/)
      expect(costLine.textContent!.split('·')[0]).not.toMatch(/pp/)
      const savedLine = within(regrets).getByText(/^Saved 1 priced times/)
      expect(savedLine.textContent!.split('·')[0]).not.toMatch(/pp/)
      // only the AVERAGES carry "pp"
      expect(within(regrets).getByText(/\+7\.7pp/)).toBeInTheDocument()
      expect(within(regrets).getByText(/\+2\.0pp/)).toBeInTheDocument()
    })

    it('renders the causal line when present', async () => {
      await seedLearning(mkLearning({ regrets: mkRegrets({ topGates: [mkRegretGate({ causal: { n: 4, hits: 1 } })], unchecked: 0 }) }))
      withRouter()
      const regrets = await screen.findByLabelText('Regrets')
      // findByText: the section label renders before the slice paints
      expect(await within(regrets).findByText(/wildcard tested it: 4 tries, 1 hits/i)).toBeInTheDocument()
    })

    it('renders regrets.note verbatim whenever unchecked > 0, and omits it when 0', async () => {
      const noteText = '3 of 8 refusals went unpriced — an unmeasured gate is not a costless one; excesses are stopless upper bounds.'
      await seedLearning(mkLearning({ regrets: mkRegrets({ unchecked: 3, note: noteText }) }))
      const { unmount: unmount1 } = withRouter()
      expect(await screen.findByText(noteText)).toBeInTheDocument()
      unmount1()

      await db.slices.clear()
      await seedLearning(mkLearning({ regrets: mkRegrets({ unchecked: 0, note: noteText }) }))
      const { unmount: unmount2 } = withRouter()
      const regrets = await screen.findByLabelText('Regrets')
      // give the seeded slice a tick to paint before asserting absence
      await within(regrets).findByText(/^Refused/)
      expect(screen.queryByText(noteText)).not.toBeInTheDocument()
      unmount2()
    })

    it('a named example links to its stock page with sym, date and pp', async () => {
      await seedLearning(mkLearning({ regrets: mkRegrets({ unchecked: 0, topGates: [mkRegretGate({ examples: [mkExample({ sym: 'PLTR', date: '2026-08-04', excessPct: 6.1 })] })] }) }))
      withRouter()
      const regrets = await screen.findByLabelText('Regrets')
      const link = (await within(regrets).findByText('PLTR')).closest('a') as HTMLAnchorElement
      expect(link).toBeInTheDocument()
      expect(link.getAttribute('href')).toBe('/app/stock/PLTR')
      expect(within(link).getByText(/04 Aug/)).toBeInTheDocument()
      expect(within(link).getByText(/ran \+6\.1pp/)).toBeInTheDocument()
    })

    it('renders the caveat note when unchecked > 0 even with empty topGates', async () => {
      const noteText = '3 of 8 refusals went unpriced — an unmeasured gate is not a costless one; excesses are stopless upper bounds.'
      await seedLearning(mkLearning({ regrets: mkRegrets({ unchecked: 3, topGates: [], note: noteText }) }))
      withRouter()
      const regrets = await screen.findByLabelText('Regrets')
      expect(await within(regrets).findByText(noteText)).toBeInTheDocument()
    })
  })
})
