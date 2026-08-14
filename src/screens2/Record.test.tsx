// Record (plan Task 20) — Track record: scorecard, calibration, the ledger
// as cards, the regret surface. Same local-first pattern as Board.test.tsx/
// StockPage.test.tsx: fetchers mocked to never resolve, every case paints
// from a seeded Dexie slice.

import { fireEvent, render, screen, within } from '@testing-library/react'
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
      expect(within(sc).getByText('Grade A')).toBeInTheDocument()
      expect(within(sc).getByText('Shadow book')).toBeInTheDocument()
      expect(within(sc).getByText(/🃏 Wildcard/)).toBeInTheDocument()
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
      await seedLedger('ledger:7', [
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
      await seedLedger('ledger:7', [{ date: '2026-08-10', predictions: [sizedCall, watchCall] }])
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
      await seedLedger('ledger:7', [{ date: '2026-08-10', predictions: [coin, equity] }])
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
      await seedLedger('ledger:7', [{ date: '2026-08-10', predictions: [call] }])
      withRouter()
      const ledger = await screen.findByLabelText('The ledger')
      expect(await within(ledger).findByText('Stopped out on a gap down.')).toBeInTheDocument()
    })

    it('"Load 30 days" swaps to the ledger:30 slice', async () => {
      await seedLedger('ledger:7', [{ date: '2026-08-10', predictions: [mkCall({ id: 'a1', sym: 'NVDA' })] }])
      await seedLedger('ledger:30', [
        { date: '2026-08-10', predictions: [mkCall({ id: 'a1', sym: 'NVDA' })] },
        { date: '2026-07-14', predictions: [mkCall({ id: 'b1', sym: 'OLDCO', date: '2026-07-14' })] },
      ])
      withRouter()
      const ledger = await screen.findByLabelText('The ledger')
      expect(await within(ledger).findByText('NVDA')).toBeInTheDocument()
      expect(within(ledger).queryByText('OLDCO')).not.toBeInTheDocument()
      fireEvent.click(within(ledger).getByRole('button', { name: /load 30 days/i }))
      expect(await within(ledger).findByText('OLDCO')).toBeInTheDocument()
    })

    it('renders NO grade pill on a belowBase row, and shows one on a normal sized row', async () => {
      const sizedCall = mkCall({ id: 'sized2', sym: 'AAPL', belowBase: false, grade: 'A' })
      const belowBaseCall = mkCall({ id: 'below1', sym: 'MSFT', belowBase: true, grade: 'B' })
      await seedLedger('ledger:7', [{ date: '2026-08-10', predictions: [sizedCall, belowBaseCall] }])
      withRouter()
      const ledger = await screen.findByLabelText('The ledger')
      expect(await within(ledger).findByText('AAPL')).toBeInTheDocument()
      expect(within(ledger).getByLabelText('Grade A')).toBeInTheDocument()
      expect(within(ledger).queryByLabelText('Grade B')).not.toBeInTheDocument()
    })

    it('renders shadow label and no grade pill on a shadow row', async () => {
      const shadowCall = mkCall({ id: 'shadow1', sym: 'TSLA', shadow: true, grade: 'A' })
      await seedLedger('ledger:7', [{ date: '2026-08-10', predictions: [shadowCall] }])
      withRouter()
      const ledger = await screen.findByLabelText('The ledger')
      expect(await within(ledger).findByText('TSLA')).toBeInTheDocument()
      expect(within(ledger).getByText(/shadow — never a live size/)).toBeInTheDocument()
      expect(within(ledger).queryByLabelText('Grade A')).not.toBeInTheDocument()
    })
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
