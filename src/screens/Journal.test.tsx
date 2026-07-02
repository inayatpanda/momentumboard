import { describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import type { Trade } from '../../shared/journal'
import type { EngineData, EnginePrediction } from '../lib/api'
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
]

const mkCall = (o: Partial<EnginePrediction>): EnginePrediction => ({
  id: o.id!, sym: o.sym!, side: o.side ?? 'long', composite: 40, probability: 0.6, provisional: false,
  grade: o.grade ?? 'B', expectedMovePct: 8, entry: 100, stop: 95, target: 112, capacityPct: 10,
  smallCap: false, earningsRisk: false, stage: o.stage ?? null, note: '', riskRung: 1, riskPct: 1.25,
  instrument: null, paperOnly: false, factors: {}, ...o,
})

const engine: EngineData = {
  board: {
    date: '2026-07-02', generatedAt: 0, regime: 'green',
    board: [
      mkCall({ id: 'c1', sym: 'AAPL', side: 'long', grade: 'A' }),
      mkCall({ id: 'c2', sym: 'TSLA', side: 'short', grade: 'B', stage: 'extended' }),
    ],
  },
  ledger: [],
  scorecard: null, weights: null, calibration: null,
  riskState: { rung: 1, sinceDate: '2026-06-01', gradedAtRung: 8, history: [] },
  roster: null, channelCred: {},
}

const quoteMap: Record<string, Quote> = {
  AAPL: { symbol: 'AAPL', price: 104, prevClose: 100, changePct: 4, currency: 'USD', todayVolume: 1, asOf: 0, source: 'yahoo' },
  TSLA: { symbol: 'TSLA', price: 102, prevClose: 100, changePct: 2, currency: 'USD', todayVolume: 1, asOf: 0, source: 'yahoo' },
  XYZ: { symbol: 'XYZ', price: 101, prevClose: 100, changePct: 1, currency: 'USD', todayVolume: 1, asOf: 0, source: 'yahoo' },
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

  it('renders a muted "no engine read" when the engine has no view of the name', async () => {
    const { container } = render(<Journal />)
    await waitFor(() => expect(cardFor(container, 'XYZ')).toBeTruthy())
    const card = cardFor(container, 'XYZ')
    expect(card.querySelector('.engine-read.no-read')?.textContent).toBe('no engine read')
    expect(card.querySelector('.grade-chip')).toBeNull()
  })
})
