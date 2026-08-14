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

vi.mock('../lib/apiViews', async () => {
  const actual = await vi.importActual<typeof import('../lib/apiViews')>('../lib/apiViews')
  const notMocked = () => Promise.reject(new Error('not mocked in this test'))
  return { ...actual, getJourney: vi.fn(notMocked), getVerdict: vi.fn(notMocked) }
})
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  const notMocked = () => Promise.reject(new Error('not mocked in this test'))
  return { ...actual, getCandles: vi.fn(notMocked), getNews: vi.fn(notMocked) }
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

const seedCandles = (sym: string, range = '6mo') =>
  writeSlice(`candles:${sym}:${range}`, { candles, quote: { symbol: sym, price: 128.4, prevClose: 125.8, changePct: 2.07, currency: 'USD', todayVolume: 1e6, asOf: 0, source: 'finnhub' as const } })

const withRouter = (sym: string) => render(<Router base="/app" hook={memoryLocation({ path: `/app/stock/${sym}` }).hook}><StockPage sym={sym} /></Router>)

beforeEach(async () => {
  await Promise.all([db.slices.clear(), db.candles.clear(), db.quotes.clear(), db.watchlist.clear(), db.rules.clear()])
  vi.clearAllMocks()
})

describe('StockPage', () => {
  it('names the symbol in an h1', async () => {
    await writeSlice('journey:NVDA', mkJourney())
    withRouter('NVDA')
    expect(await screen.findByRole('heading', { level: 1, name: /NVDA/ })).toBeInTheDocument()
  })

  it('renders the five ratified sections in DOM order: chart, verdict, factors, funnel, past calls', async () => {
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
    expect(labels.slice(0, 5)).toEqual(['Price chart', "The engine's verdict", 'Factor votes', 'The funnel path', 'Past calls'])
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

  it('a scanned name with no call and no refusal today says so, rather than sitting on a skeleton', async () => {
    await writeSlice('journey:NVDA', mkJourney({ calls: [mkCall()], funnel: [{ date: '2026-08-14', rows: [], nearMiss: null }] }))
    withRouter('NVDA')
    const hero = await screen.findByLabelText("The engine's verdict")
    expect(within(hero).getByText(/no read today/i)).toBeInTheDocument()
    expect(hero.querySelector('.skeleton')).toBeNull()
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
      nulls: ['news tone', 'social'],
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

    it('replaces the funnel path with "not in today\'s scan universe"', async () => {
      withRouter('TSLA')
      expect(await screen.findByText(/not in today's scan universe/i)).toBeInTheDocument()
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

    it('a wildcard call carries the label and the standing warning', async () => {
      await writeSlice('journey:NVDA', mkJourney({ calls: [mkCall({ wildcard: { gate: 'entry-chase', priority: 1, hypothesis: 'chase is too strict', gateEvidenceN: 12 } })] }))
      withRouter('NVDA')
      const past = await screen.findByLabelText('Past calls')
      expect(within(past).getByText(/🃏 Wildcard/)).toBeInTheDocument()
      expect(within(past).getByText(/Experiments lose more often than the board does\./)).toBeInTheDocument()
    })

    it('an unsized (shadow) call never shows a grade', async () => {
      await writeSlice('journey:NVDA', mkJourney({ calls: [mkCall({ shadow: true })] }))
      withRouter('NVDA')
      const past = await screen.findByLabelText('Past calls')
      expect(within(past).queryByLabelText(/^Grade /)).not.toBeInTheDocument()
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
  })

  describe('the chart', () => {
    it('offers 3mo/6mo/1y range pills and refetches candles on a range change', async () => {
      const { getCandles } = await import('../lib/api')
      await seedCandles('NVDA')
      await writeSlice('journey:NVDA', mkJourney({ boardRow: mkRow() }))
      withRouter('NVDA')
      expect(await screen.findByTestId('price-chart')).toBeInTheDocument()
      const pills = screen.getByRole('group', { name: /chart range/i })
      expect([...pills.querySelectorAll('button')].map(b => b.textContent)).toEqual(['3mo', '6mo', '1y'])
      fireEvent.click(within(pills).getByRole('button', { name: '1y' }))
      await waitFor(() => expect(getCandles).toHaveBeenCalledWith('NVDA', '1y'))
    })
  })
})
