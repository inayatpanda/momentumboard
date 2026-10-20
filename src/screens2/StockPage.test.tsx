// StockPage — the journey page (plan Task 17). Same local-first pattern as
// Board.test.tsx/Stocks.test.tsx: every network fetcher is mocked to reject
// quickly (never "hangs forever" — store.ts's inflight map is module-level and
// a never-settling promise would poison the key for the next test), and every
// case paints from a seeded Dexie slice. PriceChart is mocked wholesale:
// lightweight-charts cannot run in jsdom, and the real module is only ever
// reached through React.lazy here.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Router } from 'wouter'
import { memoryLocation } from 'wouter/memory-location'
import { db } from '../lib/db'
import { writeSlice } from '../lib/store'
import type { EnginePrediction, OpenTraceEntry } from '../lib/api'
import type { JourneyCall, JourneySlice, VerdictRead } from '../lib/apiViews'
import StockPage from './StockPage'

vi.mock('../components/PriceChart', () => ({ PriceChart: () => <div data-testid="price-chart" /> }))
vi.mock('../components/RsiChart', () => ({ RsiChart: () => <div data-testid="rsi-chart" /> }))

vi.mock('../lib/apiViews', async () => {
  const actual = await vi.importActual<typeof import('../lib/apiViews')>('../lib/apiViews')
  const notMocked = () => Promise.reject(new Error('not mocked in this test'))
  return { ...actual, getJourney: vi.fn(notMocked), getVerdict: vi.fn(notMocked) }
})
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  const notMocked = () => Promise.reject(new Error('not mocked in this test'))
  return { ...actual, getCandles: vi.fn(notMocked), getNews: vi.fn(notMocked), getFilings: vi.fn(notMocked), getBusinessHealth: vi.fn(notMocked) }
})
vi.mock('../lib/configMirror', () => ({ mirrorConfig: vi.fn() }))

import { mirrorConfig } from '../lib/configMirror'

const FACTOR_NAMES = ['technical', 'momentum', 'sector', 'social', 'channels', 'insiders', 'news', 'seasonality', 'smartMoney', 'catalyst'] as const
const emptyFactors = () => Object.fromEntries(FACTOR_NAMES.map(n => [n, { score: null, detail: '', weight: 0 }])) as EnginePrediction['factors']

function mkRow(overrides: Partial<EnginePrediction> = {}): EnginePrediction {
  return {
    id: 'r1',
    sym: 'NVDA',
    name: 'NVIDIA',
    side: 'long',
    composite: 62,
    probability: 0.62,
    provisional: false,
    grade: 'A',
    expectedMovePct: 4.3,
    entry: 128.4,
    stop: 121.1,
    target: 141,
    capacityPct: 100,
    smallCap: false,
    earningsRisk: false,
    stage: 'trending',
    note: 'test note',
    riskRung: 3,
    riskPct: 1.25,
    instrument: null,
    paperOnly: false,
    factors: emptyFactors(),
    ...overrides,
  }
}

function mkCall(overrides: Partial<JourneyCall> = {}): JourneyCall {
  return {
    id: 'c1',
    date: '2026-07-28',
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

const mkJourney = (o: Partial<JourneySlice> = {}): JourneySlice => ({ sym: 'NVDA', boardRow: null, openTrace: null, funnel: [], calls: [], ...o })

const mkNearMiss = (sym = 'NVDA'): JourneySlice['funnel'][number]['nearMiss'] => ({
  sym,
  core: 41.2,
  capUsdM: 3100,
  lastClose: 128,
  atrNow: 4,
  capacityPct: 100,
  stage: 'basing',
  factors: { momentum: { score: 2 } },
})

const mkTrace = (o: Partial<OpenTraceEntry> = {}): OpenTraceEntry => ({
  id: 't1',
  sym: 'NVDA',
  side: 'long',
  callDate: '2026-08-11',
  grade: 'A',
  entry: 128.4,
  stop: 121.1,
  target: 141,
  status: 'in-play',
  crossedDate: null,
  last: 133.2,
  movePct: 3.7,
  progressPct: 38,
  day: 3,
  gradesInSessions: 10,
  stage: 'trending',
  requalified: false,
  verdict: 'still-on',
  note: 'trace note',
  ...o,
})

const candles = Array.from({ length: 30 }, (_, i) => ({ t: 1_700_000_000 + i * 86_400, o: 100, h: 102, l: 99, c: 100 + i, v: 1_000_000 }))

const seedCandles = (sym: string, range = '1mo') =>
  writeSlice(`candles:${sym}:${range}`, { candles, quote: { symbol: sym, price: 128.4, prevClose: 125.8, changePct: 2.07, currency: 'USD', todayVolume: 1e6, asOf: 0, source: 'finnhub' as const } })

const withRouter = (sym: string) => render(<Router base="/app" hook={memoryLocation({ path: `/app/stock/${sym}` }).hook}><StockPage sym={sym} /></Router>)

beforeEach(async () => {
  await Promise.all([db.slices.clear(), db.candles.clear(), db.quotes.clear(), db.watchlist.clear(), db.rules.clear()])
  localStorage.clear() // the chart range is remembered there — one test's choice is not the next's
  vi.clearAllMocks()
})

describe('StockPage', () => {
  it('names the symbol in an h1', async () => {
    await writeSlice('journey:NVDA', mkJourney())
    withRouter('NVDA')
    expect(await screen.findByRole('heading', { level: 1, name: /NVDA/ })).toBeInTheDocument()
    const sectionNav = screen.getByRole('navigation', { name: 'Company research sections' })
    expect(within(sectionNav).getByRole('link', { name: 'Report history' })).toHaveAttribute('href', '#NVDA-business')
    expect(document.getElementById('NVDA-business')).toBeInTheDocument()
  })

  it('renders the ratified sections in DOM order, with engine research before past calls', async () => {
    await seedCandles('NVDA')
    await writeSlice(
      'journey:NVDA',
      mkJourney({
        boardRow: mkRow(),
        funnel: [{ date: '2026-08-14', rows: [{ key: 'NVDA:long', gate: 'called-full', side: 'long', core: 62 }], nearMiss: null }],
        calls: [mkCall()],
      }),
    )
    const { container } = withRouter('NVDA')
    expect(await screen.findByTestId('price-chart')).toBeInTheDocument()
    await screen.findByLabelText('Past calls')
    const labels = [...container.querySelectorAll('section[aria-label]')].map(s => s.getAttribute('aria-label'))
    expect(labels.slice(0, 7)).toEqual(['Price chart', "The engine's verdict", 'Factor votes', 'The funnel path', 'NVDA research lab', 'Business health', 'Past calls'])
  })

  it('a sized board row shows the grade pill and the calibrated probability', async () => {
    await writeSlice('journey:NVDA', mkJourney({ boardRow: mkRow() }))
    withRouter('NVDA')
    const hero = await screen.findByLabelText("The engine's verdict")
    expect(within(hero).getByLabelText('Grade A')).toHaveTextContent('A')
    expect(within(hero).getByText(/62%/)).toHaveClass('num')
    expect(within(hero).getByText(/Long/)).toBeInTheDocument()
    expect(within(hero).getByText('121.1')).toHaveClass('num')
    expect(within(hero).getByText('141')).toHaveClass('num')
  })

  // THE ROUTE DISCLAIMER (crypto-v2 wave, finding 3) — the same shared sentence
  // CallCard prints, on the surface that leads with the levels.
  it('a GEARED routed hero warns on decay and points the exit at the underlying levels', async () => {
    await writeSlice('journey:NVDA', mkJourney({ boardRow: mkRow({ instrument: { ticker: '3LNV.L', leverage: 3 } }) }))
    withRouter('NVDA')
    const hero = await screen.findByLabelText("The engine's verdict")
    expect(within(hero).getByText(/decay daily/i)).toBeInTheDocument()
    expect(within(hero).getByText(/underlying/i)).toBeInTheDocument()
  })

  it('a 1× tracker hero says the exit is on the underlying and that it has NEITHER decay nor a hold clock', async () => {
    await writeSlice('journey:BTC-USD', mkJourney({ sym: 'BTC-USD', boardRow: mkRow({ sym: 'BTC-USD', cohort: 'crypto', instrument: { ticker: 'BTCE.L', leverage: 1 } }) }))
    withRouter('BTC-USD')
    const hero = await screen.findByLabelText("The engine's verdict")
    expect(within(hero).getByText(/tracker route/i)).toHaveTextContent(/no daily decay and no hold clock/i)
    expect(within(hero).queryByText(/decay daily/i)).not.toBeInTheDocument()
  })

  // FINDING 6: the server stamps the cohort's whole explanation into `note` —
  // the 14-bar calibration, the ~50-outcome cold start, the C/half-size designed
  // floor, the missing tracker — and the hero showed an unexplained C.
  it('a cohort hero is marked crypto and can explain why it is sized like this', async () => {
    const note = 'crypto cohort — its own calibration, its own 14-bar clock; graded 12 of the ~50 outcomes it needs, so C at half size is the designed floor · paper only — no BTC-USD tracker configured yet'
    await writeSlice('journey:BTC-USD', mkJourney({ sym: 'BTC-USD', boardRow: mkRow({ sym: 'BTC-USD', cohort: 'crypto', grade: 'C', paperOnly: true, note }) }))
    withRouter('BTC-USD')
    const hero = await screen.findByLabelText("The engine's verdict")
    expect(within(hero).getByText('crypto')).toBeInTheDocument()
    expect(within(hero).getByText(/why sized like this/i)).toBeInTheDocument()
    expect(within(hero).getByText(note)).toBeInTheDocument()
  })

  it('a watch-only row shows its own reason line and NEVER a grade or a probability', async () => {
    await writeSlice('journey:NVDA', mkJourney({ boardRow: mkRow({ watchOnly: true }) }))
    withRouter('NVDA')
    const hero = await screen.findByLabelText("The engine's verdict")
    expect(within(hero).getByText(/watch — no size yet/i)).toBeInTheDocument()
    expect(within(hero).queryByLabelText(/^Grade /)).not.toBeInTheDocument()
    expect(hero.textContent).not.toMatch(/\d+%/)
  })

  it('a near miss and an observation each carry their OWN distinct reason', async () => {
    await writeSlice('journey:NVDA', mkJourney({ boardRow: mkRow({ watchOnly: true, nearMiss: true }) }))
    const { unmount } = withRouter('NVDA')
    expect(await screen.findByText(/nearest miss/i)).toBeInTheDocument()
    unmount()
    await writeSlice('journey:AMD', mkJourney({ sym: 'AMD', boardRow: mkRow({ sym: 'AMD', watchOnly: true, observation: true }) }))
    withRouter('AMD')
    expect(await screen.findByText(/no ISA route/i)).toBeInTheDocument()
  })

  it('a refused symbol shows the gate label and the bare core — no grade, no probability', async () => {
    await writeSlice(
      'journey:NVDA',
      mkJourney({ funnel: [{ date: '2026-08-14', rows: [{ key: 'NVDA:long', gate: 'entry-chase', side: 'long', core: 58.4, detail: 'already ran three sessions' }], nearMiss: null }] }),
    )
    withRouter('NVDA')
    const hero = await screen.findByLabelText("The engine's verdict")
    expect(within(hero).getByText(/Not today/i)).toBeInTheDocument()
    expect(within(hero).getByText(/already ran — refused to chase/)).toBeInTheDocument()
    expect(within(hero).getByText(/already ran three sessions/)).toBeInTheDocument()
    expect(within(hero).getByText('58.4')).toHaveClass('num')
    expect(within(hero).getByText(/core/i)).toBeInTheDocument()
    expect(within(hero).queryByLabelText(/^Grade /)).not.toBeInTheDocument()
    expect(hero.textContent).not.toMatch(/\d+%/)
  })

  // the funnel carries a day ONLY when that day held a row or a near miss for
  // the name (netlify/functions/engine.mts:185) — so "in the ledger, absent
  // from every trace day" is the honest shape of a scanned-nothing page. The
  // old fixture here seeded an empty-rows/no-near-miss day the server never
  // emits, which is what let the stale-refusal bug hide (Task 17 review).
  it('a scanned name with no call and no refusal today says so, rather than sitting on a skeleton', async () => {
    await writeSlice('journey:NVDA', mkJourney({ calls: [mkCall()], funnel: [] }))
    withRouter('NVDA')
    const hero = await screen.findByLabelText("The engine's verdict")
    expect(within(hero).getByText(/no read today/i)).toBeInTheDocument()
    expect(hero.querySelector('.skeleton')).toBeNull()
  })

  // C1 — THE HERO SPEAKS FOR THE NEWEST DAY ONLY. The memo used to walk every
  // funnel day for the first non-publication row, so a Monday refusal outlived
  // a Tuesday call and the page said "Not today" about a name it had published.
  describe('the newest funnel day, and only that day, speaks for the hero', () => {
    it('a Monday refusal does NOT survive a Tuesday call — the hero names the call, with no grade', async () => {
      await writeSlice(
        'journey:NVDA',
        mkJourney({
          funnel: [
            { date: '2026-08-10', rows: [{ key: 'NVDA:long', gate: 'entry-chase', side: 'long', core: 58.4, detail: 'already ran three sessions' }], nearMiss: null },
            { date: '2026-08-11', rows: [{ key: 'NVDA:long', gate: 'called-full', side: 'long', core: 62 }], nearMiss: null },
          ],
        }),
      )
      withRouter('NVDA')
      const hero = await screen.findByLabelText("The engine's verdict")
      expect(within(hero).queryByText(/Not today/i)).not.toBeInTheDocument()
      expect(within(hero).queryByText(/already ran — refused to chase/)).not.toBeInTheDocument()
      expect(within(hero).getByText(/called at full size/i)).toBeInTheDocument()
      expect(within(hero).getByText(/2026-08-11/)).toBeInTheDocument()
      expect(within(hero).getByText(/not on today's board/i)).toBeInTheDocument()
      expect(within(hero).queryByLabelText(/^Grade /)).not.toBeInTheDocument()
      expect(hero.textContent).not.toMatch(/\d+%/)
    })

    it('a day that called one side and refused the other is a PUBLICATION day, not a refusal', async () => {
      await writeSlice(
        'journey:NVDA',
        mkJourney({
          funnel: [
            {
              date: '2026-08-14',
              rows: [
                { key: 'NVDA:long', gate: 'called-half', side: 'long', core: 55 },
                { key: 'NVDA:short', gate: 'dead-zone-core', side: 'short', core: -12 },
              ],
              nearMiss: null,
            },
          ],
        }),
      )
      withRouter('NVDA')
      const hero = await screen.findByLabelText("The engine's verdict")
      expect(within(hero).queryByText(/Not today/i)).not.toBeInTheDocument()
      expect(within(hero).queryByText(/below the conviction bar/)).not.toBeInTheDocument()
      expect(within(hero).getByText(/called at half size/i)).toBeInTheDocument()
    })

    it('the newest day being a near miss is a verdict of its own, not a no-read', async () => {
      await writeSlice('journey:NVDA', mkJourney({ funnel: [{ date: '2026-08-14', rows: [], nearMiss: mkNearMiss() }] }))
      withRouter('NVDA')
      const hero = await screen.findByLabelText("The engine's verdict")
      expect(within(hero).getByText(/nearest miss today/i)).toBeInTheDocument()
      expect(within(hero).queryByText(/no read today/i)).not.toBeInTheDocument()
      expect(within(hero).queryByLabelText(/^Grade /)).not.toBeInTheDocument()
    })
  })

  it('a wildcard row carries the label and the standing warning even when it was never sized', async () => {
    await writeSlice(
      'journey:NVDA',
      mkJourney({ boardRow: mkRow({ watchOnly: true, wildcard: { gate: 'entry-chase', priority: 1, hypothesis: 'chase is too strict', gateEvidenceN: 12 } }) }),
    )
    withRouter('NVDA')
    const hero = await screen.findByLabelText("The engine's verdict")
    // findByText: the section container mounts before its slice-painted
    // content — a sync getByText raced it under parallel suite load (flake
    // seen twice in full-suite runs, never standalone)
    expect(await within(hero).findByText(/🃏 Wildcard/)).toBeInTheDocument()
    expect(within(hero).getByText(/Experiments lose more often than the board does\./)).toBeInTheDocument()
    expect(within(hero).queryByLabelText(/^Grade /)).not.toBeInTheDocument()
  })

  it('names the position-size block for a screen reader', async () => {
    await writeSlice('journey:NVDA', mkJourney({ boardRow: mkRow() }))
    withRouter('NVDA')
    expect(await screen.findByLabelText('Position size')).toBeInTheDocument()
  })

  describe('an unscanned symbol falls through to the on-demand verdict', () => {
    const verdict: VerdictRead = {
      sym: 'TSLA',
      onDemand: true,
      at: '2026-08-14T09:00:00Z',
      lean: 'long',
      core: 41.2,
      stage: 'basing',
      computed: [
        { name: 'technical', score: 12, detail: 'above the 50d' },
        { name: 'momentum', score: -4, detail: 'faded' },
      ],
      // the SERVER's shape: raw engine keys (onDemandVerdict emits FactorName),
      // never the reader's words — the old fixture pre-labelled them and so
      // could never have caught the raw 'smartMoney' the page was printing.
      nulls: ['news', 'smartMoney', 'social'],
      lastClose: 214.5,
      atr: 6.2,
      note: 'This is an on-demand read on a name the engine never scanned today.',
    }

    beforeEach(async () => {
      await writeSlice('journey:TSLA', mkJourney({ sym: 'TSLA' }))
      await writeSlice('verdict:TSLA', verdict)
    })

    it('prints the verdict note verbatim, the lean, the factor count and the not-calibrated line', async () => {
      withRouter('TSLA')
      expect(await screen.findByText(verdict.note)).toBeInTheDocument()
      const hero = screen.getByLabelText("The engine's verdict")
      expect(within(hero).getByText(/Long/)).toBeInTheDocument()
      expect(within(hero).getByText(/2 factors computed/i)).toBeInTheDocument()
      expect(within(hero).getByText(/no calibrated grade — on-demand read/i)).toBeInTheDocument()
      expect(within(hero).queryByLabelText(/^Grade /)).not.toBeInTheDocument()
    })

    it("prints the server's null factors in the reader's words, never as engine keys", async () => {
      withRouter('TSLA')
      const votes = await screen.findByLabelText('Factor votes')
      const nullLine = within(votes).getByText(/^no data:/i)
      expect(nullLine).toHaveTextContent('news tone')
      expect(nullLine).toHaveTextContent('smart money')
      expect(nullLine).toHaveTextContent('social')
      expect(nullLine.textContent).not.toMatch(/smartMoney/)
    })

    it('counts one computed factor as "1 factor", not "1 factors"', async () => {
      await writeSlice('verdict:TSLA', { ...verdict, computed: [{ name: 'technical', score: 12, detail: 'above the 50d' }] })
      withRouter('TSLA')
      const hero = await screen.findByLabelText("The engine's verdict")
      await waitFor(() => expect(within(hero).getByText(/1 factor computed/i)).toBeInTheDocument())
      expect(hero.textContent).not.toMatch(/1 factors/)
    })

    it('replaces the funnel path with "not in today\'s scan universe"', async () => {
      withRouter('TSLA')
      expect(await screen.findByText(/not in today's scan universe/i)).toBeInTheDocument()
    })

    // THE CONTAINED READ (crypto-v2 wave, finding 1). The on-demand desk runs
    // the EQUITY factors — momentum against SPY, equity windows, equity weights,
    // the board's equity regime — so it now refuses a coin rather than printing
    // a lean nothing measured. The hero must show the refusal AS a refusal:
    // no lean, no core, no factor count, and never the "unavailable" sentence.
    it('a contained crypto pair shows the lane’s own sentence — no lean, no core, not "unavailable"', async () => {
      const contained: VerdictRead = {
        sym: 'BTC-USD',
        onDemand: true,
        at: '2026-08-14T09:00:00Z',
        contained: true,
        lean: 'none',
        core: null,
        stage: null,
        computed: [],
        nulls: [],
        lastClose: null,
        atr: null,
        note: 'The crypto lane reads this pair on its own clock — its own calibration, a 14-bar horizon and no benchmark at all. Ask the board, not the on-demand desk.',
      }
      await writeSlice('journey:BTC-USD', mkJourney({ sym: 'BTC-USD' }))
      await writeSlice('verdict:BTC-USD', contained)
      withRouter('BTC-USD')
      const hero = await screen.findByLabelText("The engine's verdict")
      expect(within(hero).getByText(contained.note)).toBeInTheDocument()
      expect(within(hero).getByText(/belongs to the crypto lane/i)).toBeInTheDocument()
      expect(within(hero).queryByText(/no lean/i)).not.toBeInTheDocument()
      expect(within(hero).queryByText(/leans/i)).not.toBeInTheDocument()
      expect(within(hero).queryByText(/factors? computed/i)).not.toBeInTheDocument()
      expect(within(hero).queryByText(/could not price this name/i)).not.toBeInTheDocument()
      expect(within(hero).queryByText(/^core$/)).not.toBeInTheDocument()
    })

    it('add to watchlist writes the Dexie row and mirrors the config', async () => {
      withRouter('TSLA')
      fireEvent.click(await screen.findByRole('button', { name: /add to watchlist/i }))
      await waitFor(async () => expect(await db.watchlist.get('TSLA')).toBeTruthy())
      expect(mirrorConfig).toHaveBeenCalled()
    })
  })

  describe('factor votes', () => {
    it('lists the factors with no data by name', async () => {
      const factors = emptyFactors()
      factors.technical = { score: 30, detail: 'above the 50d', weight: 1 }
      await writeSlice('journey:NVDA', mkJourney({ boardRow: mkRow({ factors }) }))
      withRouter('NVDA')
      const votes = await screen.findByLabelText('Factor votes')
      const nullLine = within(votes).getByText(/^no data:/i)
      expect(nullLine).toHaveTextContent('news tone')
      expect(nullLine).toHaveTextContent('social')
    })

    // D9: a cohort row's social/channels/seasonality are null by POLICY — the
    // owner's directive, quoted and dated, sits in each factor's own `detail` —
    // and this page listed them under "no data", telling a crypto reader the
    // engine's wiring had gaps where it had a decision.
    it('shows the engine’s own reason for a factor nulled by policy, instead of calling it no data', async () => {
      const directive = 'not read for crypto — owner directive 2026-08-14: chart parameters and a little major news — nothing else'
      const factors = emptyFactors()
      factors.technical = { score: 30, detail: 'above the 50d', weight: 1 }
      factors.social = { score: null, detail: directive, weight: 1 }
      factors.channels = { score: null, detail: directive, weight: 1 }
      factors.seasonality = { score: null, detail: 'not read for crypto — the seasonality library counts a year in 252 sessions', weight: 1 }
      await writeSlice('journey:BTC-USD', mkJourney({ sym: 'BTC-USD', boardRow: mkRow({ sym: 'BTC-USD', cohort: 'crypto', factors }) }))
      withRouter('BTC-USD')

      const votes = await screen.findByLabelText('Factor votes')
      const lines = within(within(votes).getByLabelText('Factors not read')).getAllByRole('listitem')
      expect(lines).toHaveLength(2) // one per DISTINCT reason — social and channels share theirs
      expect(lines[0]).toHaveTextContent('social, channels')
      expect(lines[0]).toHaveTextContent(/owner directive 2026-08-14/)
      expect(lines[1]).toHaveTextContent(/252 sessions/)

      // …and not one of them is reported as an absence as well
      const nullLine = within(votes).getByText(/^no data:/i)
      expect(nullLine).not.toHaveTextContent('social')
      expect(nullLine).not.toHaveTextContent('seasonality')
      expect(nullLine).toHaveTextContent('news tone') // the genuinely empty ones still say so
    })

    it('an equity row with no factor details is unchanged — one "no data" line, no reason list', async () => {
      const factors = emptyFactors()
      factors.technical = { score: 30, detail: 'above the 50d', weight: 1 }
      await writeSlice('journey:NVDA', mkJourney({ boardRow: mkRow({ factors }) }))
      withRouter('NVDA')
      const votes = await screen.findByLabelText('Factor votes')
      expect(within(votes).queryByLabelText('Factors not read')).not.toBeInTheDocument()
      expect(within(votes).getByText(/^no data:/i)).toHaveTextContent('social')
    })

    it('draws one bar per scored factor', async () => {
      const factors = emptyFactors()
      factors.technical = { score: 30, detail: '', weight: 1 }
      factors.momentum = { score: -20, detail: '', weight: 1 }
      await writeSlice('journey:NVDA', mkJourney({ boardRow: mkRow({ factors }) }))
      withRouter('NVDA')
      const votes = await screen.findByLabelText('Factor votes')
      await waitFor(() => expect(votes.querySelectorAll('.sp-fv-row')).toHaveLength(2))
    })
  })

  describe('the funnel path', () => {
    it('renders dated steps newest first, with gate labels and a prior gate', async () => {
      await writeSlice(
        'journey:NVDA',
        mkJourney({
          funnel: [
            { date: '2026-08-13', rows: [{ key: 'NVDA:long', gate: 'entry-chase', side: 'long' }], nearMiss: null },
            { date: '2026-08-14', rows: [{ key: 'NVDA:long', gate: 'called-full', side: 'long', priorGate: 'grade-watchonly' }], nearMiss: null },
          ],
        }),
      )
      withRouter('NVDA')
      const path = await screen.findByLabelText('The funnel path')
      const steps = [...path.querySelectorAll('.sp-step')]
      expect(steps).toHaveLength(2)
      expect(steps[0]).toHaveTextContent('2026-08-14')
      expect(steps[0]).toHaveTextContent('called at full size')
      expect(steps[0]).toHaveTextContent(/was: graded, sized to zero/)
      expect(steps[1]).toHaveTextContent('already ran — refused to chase')
    })
  })

  describe('past calls', () => {
    it('shows the outcome, the grade and the post-mortem sentence', async () => {
      await writeSlice(
        'journey:NVDA',
        mkJourney({
          calls: [mkCall({ outcome10: { excessPct: 9.2, rawPct: 10, spyPct: 0.8, stopped: false, hit: true }, postMortem: { cls: 'win', detail: 'detail line', at: 1, sentence: 'Ran to target on volume.' } })],
        }),
      )
      withRouter('NVDA')
      const past = await screen.findByLabelText('Past calls')
      expect(within(past).getByText(/\+9\.2%/)).toHaveClass('num')
      expect(within(past).getByLabelText('Grade A')).toBeInTheDocument()
      expect(within(past).getByText('Ran to target on volume.')).toBeInTheDocument()
    })

    // FINDING 2, on the second receipt surface: PastCalls hard-coded `10d … vs
    // SPY` too, and the two pills had already drifted apart in wording.
    it('labels a cohort call’s outcomes as raw crypto bars, never as an excess over SPY', async () => {
      await writeSlice(
        'journey:BTC-USD',
        mkJourney({
          sym: 'BTC-USD',
          calls: [
            mkCall({
              sym: 'BTC-USD',
              cohort: 'crypto',
              outcome10: { excessPct: 6.4, rawPct: 6.4, spyPct: 0, stopped: false, hit: true },
              outcome21: { excessPct: -1.2, rawPct: -1.2, spyPct: 0, stopped: false, hit: false },
            }),
          ],
        }),
      )
      withRouter('BTC-USD')
      const past = await screen.findByLabelText('Past calls')
      const pill = within(past).getByText(/14b/)
      expect(pill).toHaveTextContent('+6.4%')
      expect(pill).toHaveTextContent(/raw — no benchmark/)
      expect(pill).not.toHaveTextContent(/SPY/)
      expect(within(past).getByText(/29b/)).toBeInTheDocument()
      expect(within(past).queryByText(/10d/)).not.toBeInTheDocument()
    })

    it('a wildcard call carries the label and the standing warning', async () => {
      await writeSlice('journey:NVDA', mkJourney({ calls: [mkCall({ wildcard: { gate: 'entry-chase', priority: 1, hypothesis: 'chase is too strict', gateEvidenceN: 12 } })] }))
      withRouter('NVDA')
      const past = await screen.findByLabelText('Past calls')
      expect(await within(past).findByText(/🃏 Wildcard/)).toBeInTheDocument()
      expect(within(past).getByText(/Experiments lose more often than the board does\./)).toBeInTheDocument()
    })

    it('an unsized (shadow) call never shows a grade', async () => {
      await writeSlice('journey:NVDA', mkJourney({ calls: [mkCall({ shadow: true })] }))
      withRouter('NVDA')
      const past = await screen.findByLabelText('Past calls')
      await within(past).findByText('2026-07-28')
      expect(within(past).queryByLabelText(/^Grade /)).not.toBeInTheDocument()
    })

    // I4: the projection carries watchOnly/belowBase now, so the grade law
    // survives a row ageing off the board into this list.
    it('a watch-only past call never shows a grade either', async () => {
      await writeSlice('journey:NVDA', mkJourney({ calls: [mkCall({ watchOnly: true })] }))
      withRouter('NVDA')
      const past = await screen.findByLabelText('Past calls')
      expect(await within(past).findByText('2026-07-28')).toBeInTheDocument()
      expect(within(past).queryByLabelText(/^Grade /)).not.toBeInTheDocument()
    })

    it('a below-base past call never shows a grade either', async () => {
      await writeSlice('journey:NVDA', mkJourney({ calls: [mkCall({ belowBase: true })] }))
      withRouter('NVDA')
      const past = await screen.findByLabelText('Past calls')
      await within(past).findByText('2026-07-28')
      expect(within(past).queryByLabelText(/^Grade /)).not.toBeInTheDocument()
    })

    it('an old row carrying neither flag keeps its grade — the record cannot tell it apart', async () => {
      await writeSlice('journey:NVDA', mkJourney({ calls: [mkCall()] }))
      withRouter('NVDA')
      const past = await screen.findByLabelText('Past calls')
      // Past calls mounts before the local Dexie slice finishes its first
      // asynchronous read; wait for the populated state, not just its shell.
      expect(await within(past).findByLabelText('Grade A')).toBeInTheDocument()
    })

    // I5: the list only ever holds a WINDOW, and the way to widen it must be
    // offered exactly when the window looks empty.
    it('says which window is empty, and still offers the longer one', async () => {
      await writeSlice('journey:NVDA', mkJourney({ calls: [] }))
      withRouter('NVDA')
      const past = await screen.findByLabelText('Past calls')
      expect(within(past).getByText(/no calls on this name in the last 30 days/i)).toBeInTheDocument()
      expect(within(past).getByRole('button', { name: /load older calls/i })).toBeInTheDocument()
    })

    it('"load older calls" swaps to the deep journey slice', async () => {
      await writeSlice('journey:NVDA', mkJourney({ calls: [mkCall()] }))
      await writeSlice('journey:NVDA:deep', mkJourney({ calls: [mkCall(), mkCall({ id: 'c9', date: '2025-11-02', grade: 'B' })] }))
      withRouter('NVDA')
      fireEvent.click(await screen.findByRole('button', { name: /load older calls/i }))
      expect(await screen.findByText(/2025-11-02/)).toBeInTheDocument()
    })
  })

  describe('the open trace card', () => {
    const cases: { verdict: NonNullable<OpenTraceEntry['verdict']>; copy: RegExp }[] = [
      { verdict: 'still-on', copy: /would still take this trade/i },
      { verdict: 'intact', copy: /thesis is intact/i },
      { verdict: 'weakening', copy: /weakening/i },
    ]

    it('renders a distinct line for each of the three verdicts', async () => {
      const seen: string[] = []
      for (const c of cases) {
        await db.slices.clear()
        await writeSlice('journey:NVDA', mkJourney({ openTrace: mkTrace({ verdict: c.verdict }) }))
        const { unmount } = withRouter('NVDA')
        const card = await screen.findByLabelText('Open call')
        expect(within(card).getByText(c.copy)).toBeInTheDocument()
        seen.push(within(card).getByTestId('trace-line').textContent ?? '')
        unmount()
      }
      expect(new Set(seen).size).toBe(3)
    })

    it('shows the trail stop, the progress bar and a requalified badge', async () => {
      await writeSlice('journey:NVDA', mkJourney({ openTrace: mkTrace({ trailStop: 126.4, requalified: true }) }))
      withRouter('NVDA')
      const card = await screen.findByLabelText('Open call')
      expect(within(card).getByText('126.4')).toHaveClass('num')
      expect(card.querySelector('.convbar > i')).toHaveStyle({ width: '38%' })
      expect(within(card).getByText(/requalified/i)).toBeInTheDocument()
    })

    it('is absent when no call is live', async () => {
      await writeSlice('journey:NVDA', mkJourney({ boardRow: mkRow() }))
      withRouter('NVDA')
      await screen.findByLabelText("The engine's verdict")
      expect(screen.queryByLabelText('Open call')).not.toBeInTheDocument()
    })
  })

  describe('utilities', () => {
    it('offers the alert editor and a catalysts strip capped at three items', async () => {
      const { getNews } = await import('../lib/api')
      vi.mocked(getNews).mockResolvedValue([
        { title: 'One', url: 'https://a.example.com/1', publishedSec: 1 },
        { title: 'Two', url: 'https://b.example.com/2', publishedSec: 2 },
        { title: 'Three', url: 'https://c.example.com/3', publishedSec: 3 },
        { title: 'Four', url: 'https://d.example.com/4', publishedSec: 4 },
      ])
      await writeSlice('journey:NVDA', mkJourney({ boardRow: mkRow() }))
      withRouter('NVDA')
      expect(await screen.findByLabelText(/NVDA alert above/i)).toBeInTheDocument()
      const strip = await screen.findByLabelText('Catalysts')
      await waitFor(() => expect(within(strip).getAllByRole('link')).toHaveLength(3))
      expect(within(strip).getByText('a.example.com')).toBeInTheDocument()
      expect(within(strip).queryByText('Four')).not.toBeInTheDocument()
    })

    it('shows recent primary SEC filings and links to the original documents', async () => {
      const { getFilings } = await import('../lib/api')
      vi.mocked(getFilings).mockResolvedValue({
        company: 'NVIDIA Corp', cik: 1045810, asOf: 1,
        filings: [{ accession: 'a1', form: '8-K', filed: '2026-08-20', reportDate: '2026-08-20', description: 'Current report', items: '2.02', url: 'https://www.sec.gov/a1' }],
      })
      await writeSlice('journey:NVDA', mkJourney({ boardRow: mkRow() }))
      withRouter('NVDA')
      const section = await screen.findByLabelText('Company filings')
      expect(within(section).getByText(/NVIDIA Corp/)).toBeInTheDocument()
      expect(within(section).getByRole('link')).toHaveAttribute('href', 'https://www.sec.gov/a1')
      expect(within(section).getByText(/original filing/i)).toBeInTheDocument()
    })
  })

  describe('the chart', () => {
    it('offers 1D/1W/1M/3M/6M/1Y range pills and refetches candles on a range change', async () => {
      const { getCandles } = await import('../lib/api')
      await seedCandles('NVDA')
      await writeSlice('journey:NVDA', mkJourney({ boardRow: mkRow() }))
      withRouter('NVDA')
      expect(await screen.findByTestId('price-chart')).toBeInTheDocument()
      expect(await screen.findByTestId('rsi-chart')).toBeInTheDocument()
      const pills = screen.getByRole('group', { name: /chart range/i })
      expect([...pills.querySelectorAll('button')].map(b => b.textContent)).toEqual(['1D', '1W', '1M', '3M', '6M', '1Y'])
      fireEvent.click(within(pills).getByRole('button', { name: '1Y' }))
      await waitFor(() => expect(getCandles).toHaveBeenCalledWith('NVDA', '1y'))
    })

    // The owner's gripe, verbatim: "rather than starting with 3 months."
    it('opens on the month and reads its candles from that range’s own slice', async () => {
      const { getCandles } = await import('../lib/api')
      await seedCandles('NVDA', '1mo')
      await writeSlice('journey:NVDA', mkJourney({ boardRow: mkRow() }))
      withRouter('NVDA')
      expect(await screen.findByTestId('price-chart')).toBeInTheDocument()
      const pills = screen.getByRole('group', { name: /chart range/i })
      expect(within(pills).getByRole('button', { name: '1M' })).toHaveAttribute('aria-pressed', 'true')
      expect(getCandles).not.toHaveBeenCalled() // the seeded 1mo record served it
    })

    it('remembers the reader’s last range and applies it to the next stock page', async () => {
      const { getCandles } = await import('../lib/api')
      await seedCandles('NVDA', '1mo')
      await seedCandles('NVDA', '1d')
      await writeSlice('journey:NVDA', mkJourney({ boardRow: mkRow() }))
      const first = withRouter('NVDA')
      const pills = await screen.findByRole('group', { name: /chart range/i })
      fireEvent.click(within(pills).getByRole('button', { name: '1D' }))
      await waitFor(() => expect(localStorage.getItem('mb-chart-range')).toBe('1d'))
      first.unmount()

      await writeSlice('journey:AMD', mkJourney({ boardRow: mkRow({ sym: 'AMD' }) }))
      await seedCandles('AMD', '1d')
      withRouter('AMD')
      const next = await screen.findByRole('group', { name: /chart range/i })
      expect(within(next).getByRole('button', { name: '1D' })).toHaveAttribute('aria-pressed', 'true')
      expect(getCandles).not.toHaveBeenCalledWith('AMD', '1mo')
    })

    // A 1D chart out of hours is the LAST session's five-minute bars. Saying
    // nothing invites a dead tape to be read as a live one.
    it('names the session and the bar size on the intraday ranges, and neither on the daily ones', async () => {
      const threeDaysAgo = Math.floor(Date.now() / 1000) - 3 * 86_400
      const intraday = Array.from({ length: 40 }, (_, i) => ({ t: threeDaysAgo - (39 - i) * 300, o: 100, h: 101, l: 99, c: 100 + i * 0.1, v: 1000 }))
      await writeSlice('candles:NVDA:1d', { candles: intraday, quote: { symbol: 'NVDA', price: 104, prevClose: 100, changePct: 4, currency: 'USD', todayVolume: 1e6, asOf: 0, source: 'yahoo' as const } })
      await seedCandles('NVDA', '1mo')
      await writeSlice('journey:NVDA', mkJourney({ boardRow: mkRow() }))
      withRouter('NVDA')
      const pills = await screen.findByRole('group', { name: /chart range/i })
      expect(screen.queryByTestId('chart-when')).not.toBeInTheDocument() // 1M: daily bars, nothing to explain

      fireEvent.click(within(pills).getByRole('button', { name: '1D' }))
      const when = await screen.findByTestId('chart-when')
      expect(when).toHaveTextContent('5-minute bars')
      expect(when).toHaveTextContent(/session/)
      expect(when).not.toHaveTextContent("today's session") // three days old — say so
    })

    // B1: `candles:SYM:3mo` has TWO writers — this page's 3mo range and every
    // watchlist row's own sparkline slice. They used to disagree about the
    // shape (bare array vs the whole `{candles, quote}` payload), so whichever
    // cached first left the other rendering a skeleton for the full 15-minute
    // TTL. One record, seeded once, must now serve both.
    it('one seeded candles:NVDA:3mo record feeds BOTH a StockRow sparkline and the page’s 3mo chart', async () => {
      const { getCandles } = await import('../lib/api')
      const { StockRow } = await import('./parts/StockRow')
      await seedCandles('NVDA', '3mo')
      await writeSlice('journey:NVDA', mkJourney({ boardRow: mkRow() }))

      const row = render(
        <Router base="/app" hook={memoryLocation({ path: '/app/stocks' }).hook}>
          <StockRow symbol="NVDA" quote={null} />
        </Router>,
      )
      await waitFor(() => expect(row.container.querySelector('svg.spark')).toBeInTheDocument())
      expect(getCandles).not.toHaveBeenCalled() // the seeded record is fresh — no second trip
      row.unmount()

      withRouter('NVDA')
      const pills = await screen.findByRole('group', { name: /chart range/i })
      fireEvent.click(within(pills).getByRole('button', { name: '3M' }))
      expect(await screen.findByTestId('price-chart')).toBeInTheDocument()
      expect(getCandles).not.toHaveBeenCalledWith('NVDA', '3mo')
    })
  })
})
