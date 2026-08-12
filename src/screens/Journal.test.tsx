import { describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import type { Trade } from '../../shared/journal'
import type { EngineData, EnginePrediction, LedgerPrediction } from '../lib/api'
import type { Quote } from '../../shared/types'

const mkTrade = (o: Partial<Trade>): Trade => ({
  id: o.id!, symbol: o.symbol!, direction: o.direction ?? 'long', instrument: 'stock', leverage: 1,
  riskClass: 'normal', playbook: 'B', fromSuggestion: false, units: 5, entryPrice: 100, stop: 95,
  positionValue: 500, thesis: '', openedAt: o.openedAt ?? 0, ...o,
})

const trades: Trade[] = [
  mkTrade({ id: 't1', symbol: 'AAPL', direction: 'long', openedAt: 300 }),
  mkTrade({ id: 't2', symbol: 'TSLA', direction: 'long', openedAt: 200 }),
  mkTrade({ id: 't3', symbol: 'XYZ', direction: 'long', openedAt: 100 }),
  // held long, while the board's only row for the name is a nearest miss on the
  // short side — the engine declined it, and said so
  mkTrade({ id: 't4', symbol: 'NMS', direction: 'long', openedAt: 50 }),
  // held long, while the board's only row for the name is a promoted OBSERVATION
  // on the short side: fully graded, and a row an ISA could never have placed
  mkTrade({ id: 't5', symbol: 'OBS', direction: 'long', openedAt: 40 }),
  // the same thing one day later: nothing on TODAY'S board, and the most recent
  // live ledger row for the name is that observation, now history
  mkTrade({ id: 't6', symbol: 'OLD', direction: 'long', openedAt: 30 }),
  // the control beside it: an ordinary historical short, which DOES disagree
  mkTrade({ id: 't7', symbol: 'LDG', direction: 'long', openedAt: 20 }),
]

const mkCall = (o: Partial<EnginePrediction>): EnginePrediction => ({
  id: o.id!, sym: o.sym!, side: o.side ?? 'long', composite: 40, probability: 0.6, provisional: false,
  grade: o.grade ?? 'B', expectedMovePct: 8, entry: 100, stop: 95, target: 112, capacityPct: 10,
  smallCap: false, earningsRisk: false, stage: o.stage ?? null, note: '', riskRung: 1, riskPct: 1.25,
  instrument: null, paperOnly: false, factors: {}, ...o,
})

const mkLedgerRow = (o: Partial<LedgerPrediction>): LedgerPrediction => ({
  id: o.id!, date: '2026-07-01', sym: o.sym!, side: o.side ?? 'long', grade: 'B', probability: 0.6,
  provisional: false, shadow: false, composite: -40, entry: 100, stop: 95, target: 112,
  expectedMovePct: 8, stage: 'extended', regime: 'green', earningsRisk: false, instrument: null,
  paperOnly: false, note: '', ...o,
})

const engine: EngineData = {
  board: {
    date: '2026-07-02', generatedAt: 0, regime: 'green',
    board: [
      mkCall({ id: 'c1', sym: 'AAPL', side: 'long', grade: 'A' }),
      mkCall({ id: 'c2', sym: 'TSLA', side: 'short', grade: 'B', stage: 'extended' }),
      // the last-resort row: no gate cleared, placeholder grade C, base-rate odds
      mkCall({ id: 'c3', sym: 'NMS', side: 'short', grade: 'C', provisional: true, probability: 0.5, watchOnly: true, nearMiss: true }),
      // cleared every gate, no ISA route: a real graded read, never a takeable trade
      mkCall({ id: 'c4', sym: 'OBS', side: 'short', grade: 'B', stage: 'extended', watchOnly: true, riskPct: 0, observation: true }),
    ],
  },
  ledger: [
    {
      date: '2026-07-01',
      predictions: [
        // yesterday's promoted observation, seen through the SLIM ledger projection
        mkLedgerRow({ id: 'l1', sym: 'OLD', side: 'short', observation: true, note: 'weak · no ISA route — observation only' }),
        mkLedgerRow({ id: 'l2', sym: 'LDG', side: 'short' }), // an ordinary historical call
      ],
    },
  ],
  holdingsReads: [
    { sym: 'TSLA', stage: 'extended', entryQuality: 'chase', note: 'Extended above the 20-day', capacityPct: 12, pplPct: 24.5, quantity: 3 },
    { sym: 'AAPL', stage: 'pullback', entryQuality: 'early', note: 'Healthy dip', capacityPct: 6, pplPct: -8.1, quantity: 10 },
    { sym: 'ZZZ', stage: null, entryQuality: null, note: null, capacityPct: null, pplPct: null, quantity: 1 },
  ],
  scorecard: null, weights: null, calibration: null,
  riskState: { rung: 1, sinceDate: '2026-06-01', gradedAtRung: 8, history: [] },
  roster: null, channelCred: {},
}

const quoteMap: Record<string, Quote> = {
  AAPL: { symbol: 'AAPL', price: 104, prevClose: 100, changePct: 4, currency: 'USD', todayVolume: 1, asOf: 0, source: 'yahoo' },
  TSLA: { symbol: 'TSLA', price: 102, prevClose: 100, changePct: 2, currency: 'USD', todayVolume: 1, asOf: 0, source: 'yahoo' },
  XYZ: { symbol: 'XYZ', price: 101, prevClose: 100, changePct: 1, currency: 'USD', todayVolume: 1, asOf: 0, source: 'yahoo' },
  NMS: { symbol: 'NMS', price: 100, prevClose: 100, changePct: 0, currency: 'USD', todayVolume: 1, asOf: 0, source: 'yahoo' },
  OBS: { symbol: 'OBS', price: 100, prevClose: 100, changePct: 0, currency: 'USD', todayVolume: 1, asOf: 0, source: 'yahoo' },
  OLD: { symbol: 'OLD', price: 100, prevClose: 100, changePct: 0, currency: 'USD', todayVolume: 1, asOf: 0, source: 'yahoo' },
  LDG: { symbol: 'LDG', price: 100, prevClose: 100, changePct: 0, currency: 'USD', todayVolume: 1, asOf: 0, source: 'yahoo' },
}

vi.mock('../lib/api', () => ({
  getEngine: () => Promise.resolve(engine),
  getQuotes: (syms: string[]) => Promise.resolve(syms.map(s => quoteMap[s] ?? null)),
  getT212: () => Promise.resolve({ unconfigured: true }),
  evaluateNote: () => Promise.resolve(''),
}))
vi.mock('../lib/db', () => ({
  db: {
    trades: { toArray: () => Promise.resolve(trades), put: vi.fn(), delete: vi.fn(), bulkPut: vi.fn() },
    notes: { orderBy: () => ({ reverse: () => ({ toArray: () => Promise.resolve([]) }) }), put: vi.fn(), update: vi.fn(), delete: vi.fn() },
  },
  getCapital: () => Promise.resolve(5000),
}))
vi.mock('../lib/configMirror', () => ({ mirrorConfig: vi.fn() }))
vi.mock('../lib/portfolioMirror', () => ({ mirrorPortfolio: vi.fn(), restoreBackup: vi.fn() }))

import { Journal } from './Journal'

const cardFor = (c: HTMLElement, sym: string) =>
  [...c.querySelectorAll('.card')].find(el => el.querySelector('.sym')?.textContent?.includes(sym)) as HTMLElement

describe('Journal — positions joined to the ledger', () => {
  it('shows the engine stop/target and distances-from-current when the board has the sym', async () => {
    const { container } = render(<Journal />)
    // current 104 → stop is −8.65% away, target +7.69% away (waits for the live quote)
    await waitFor(() => expect(cardFor(container, 'AAPL')?.querySelector('.engine-read')?.textContent).toContain('−8.65%'))
    const card = cardFor(container, 'AAPL')
    const read = card.querySelector('.engine-read')!.textContent!
    expect(card.querySelector('.grade-chip')).toBeTruthy()
    expect(read).toContain('stop 95')
    expect(read).toContain('tgt 112')
    expect(read).toContain('+7.69%')
    expect(card.querySelector('.engine-conflict')).toBeNull()
  })

  it('flags a conflict when the engine takes the opposite side, with the stage note', async () => {
    const { container } = render(<Journal />)
    await waitFor(() => expect(cardFor(container, 'TSLA')).toBeTruthy())
    const conflict = cardFor(container, 'TSLA').querySelector('.engine-conflict')!
    expect(conflict.textContent).toBe('engine disagrees — extended')
  })

  // The board row for a held name can be the engine's NO. Wearing a letter grade
  // beside a position reads as the engine backing it, which is the opposite of
  // what a near miss says — it cleared no gate and was never scored.
  it('labels a near-miss board row as one instead of grading it', async () => {
    const { container } = render(<Journal />)
    await waitFor(() => expect(cardFor(container, 'NMS')?.querySelector('.engine-read')).toBeTruthy())
    const card = cardFor(container, 'NMS')
    const read = card.querySelector('.engine-read')!
    expect(read.textContent).toContain('nearest miss — not a call')
    expect(card.querySelector('.grade-chip')).toBeNull()
    expect(read.textContent).not.toContain('engine ▼ short')
    // levels still shown as orientation, but the row cannot "disagree" — it is not a call
    expect(read.textContent).toContain('stop 95')
    expect(card.querySelector('.engine-conflict')).toBeNull()
  })

  // The mirror case: the board row IS a call, fully graded — and one the reader
  // could never have placed. "engine disagrees" would frame an unplaceable
  // observation as a verdict on a position the reader actually holds.
  it('an observation row keeps its grade but never reads as disagreeing with a held position', async () => {
    const { container } = render(<Journal />)
    await waitFor(() => expect(cardFor(container, 'OBS')?.querySelector('.engine-read')).toBeTruthy())
    const card = cardFor(container, 'OBS')
    const read = card.querySelector('.engine-read')!
    expect(card.querySelector('.grade-chip')).toBeTruthy() // it earned its grade — unlike a near miss
    expect(read.textContent).toContain('engine ▼ short')
    expect(read.textContent).toContain('stop 95') // the levels still orient the reader
    expect(card.querySelector('.engine-conflict')).toBeNull() // …but it is no conflict with the position
    // the control lives one card over: TSLA is the same opposite-side read on a
    // takeable row, and it DOES flag
    expect(cardFor(container, 'TSLA').querySelector('.engine-conflict')).toBeTruthy()
  })

  // Ageing is not a promotion. Once the observation drops off today's board the
  // fallback reads it from the slim ledger projection — which used to carry no row
  // kind at all, so the row silently regained the conflict authority it never had.
  it('a HISTORICAL observation from the ledger still cannot disagree with a held position', async () => {
    const { container } = render(<Journal />)
    await waitFor(() => expect(cardFor(container, 'OLD')?.querySelector('.engine-read')).toBeTruthy())
    const card = cardFor(container, 'OLD')
    expect(card.querySelector('.engine-read')!.textContent).toContain('engine ▼ short') // the read is still shown
    expect(card.querySelector('.engine-conflict')).toBeNull()
    // the control one card over: the same ledger day, the same opposite side, an
    // ordinary call — and it DOES flag
    expect(cardFor(container, 'LDG').querySelector('.engine-conflict')?.textContent).toBe('engine disagrees — extended')
  })

  it('renders a muted "no engine read" when the engine has no view of the name', async () => {
    const { container } = render(<Journal />)
    await waitFor(() => expect(cardFor(container, 'XYZ')).toBeTruthy())
    const card = cardFor(container, 'XYZ')
    expect(card.querySelector('.engine-read.no-read')?.textContent).toBe('no engine read')
    expect(card.querySelector('.grade-chip')).toBeNull()
  })
})

describe('Journal — T212 holdings tracking pane', () => {
  it('lists holdings sorted by |P&L%|, colours the P&L, shows the engine stage, and reads null names gracefully', async () => {
    const { container } = render(<Journal />)
    await waitFor(() => expect(container.querySelector('.t212-holdings')).toBeTruthy())
    const section = container.querySelector('.t212-holdings')!
    expect(section.querySelector('summary')!.textContent).toContain('T212 holdings (3)')

    const rows = [...section.querySelectorAll('.t212-holding-row')]
    // sorted by |pplPct|: TSLA 24.5, AAPL 8.1, ZZZ null(0)
    expect(rows.map(r => r.querySelector('.t212-h-sym')!.textContent)).toEqual(['TSLA', 'AAPL', 'ZZZ'])

    const tsla = rows[0]
    expect(tsla.querySelector('.t212-h-ppl')!.textContent).toContain('+24.50%')
    expect(tsla.querySelector('.t212-h-ppl')!.classList.contains('up-text')).toBe(true)
    expect(tsla.querySelector('.t212-h-stage')!.textContent).toContain('extended')
    expect(tsla.querySelector('.t212-h-stage')!.textContent).toContain('chase')

    const aapl = rows[1]
    expect(aapl.querySelector('.t212-h-ppl')!.classList.contains('down-text')).toBe(true)

    // a name the engine couldn't read still tracks, just with a dash + "no read"
    const zzz = rows[2]
    expect(zzz.querySelector('.t212-h-ppl')!.textContent).toBe('—')
    expect(zzz.querySelector('.t212-h-stage')!.textContent).toContain('no read')
  })
})
