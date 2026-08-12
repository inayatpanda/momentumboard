import { describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import type { EngineData, EnginePrediction } from '../lib/api'

const mkCall = (o: Partial<EnginePrediction>): EnginePrediction => ({
  id: o.id!, sym: o.sym!, side: 'long', composite: 40, probability: 0.62, provisional: false,
  grade: 'B', expectedMovePct: 8, entry: 100, stop: 95, target: 112, capacityPct: 10,
  smallCap: false, earningsRisk: false, stage: 'trending', note: 'a note', riskRung: 1,
  riskPct: 1.25, instrument: null, paperOnly: false, factors: {}, ...o,
})

// One board, two rows, two very different kinds of `catalyst`.
const board: EnginePrediction[] = [
  mkCall({
    id: '2026-08-12:NVDA:short', sym: 'NVDA', side: 'short',
    catalyst: { kind: 'news', reason: 'guidance cut at the analyst day' },
  }),
  mkCall({
    id: '2026-08-12:VELO:long', sym: 'VELO', setup: 'velocity',
    catalyst: { kind: 'velocity', reason: 'broke the 20-session high on 3× volume' },
  }),
]

const engine: EngineData = {
  board: { date: '2026-08-12', generatedAt: 1_770_000_000, regime: 'green', board },
  ledger: [],
  scorecard: null,
  weights: null,
  calibration: null,
  riskState: null,
  roster: null,
  channelCred: {},
}

vi.mock('../lib/api', () => ({
  getEngine: () => Promise.resolve(engine),
  getMovers: () => Promise.resolve({ gainers: [], losers: [], actives: [], at: 0 }),
  getIpos: () => Promise.resolve({ upcoming: [], recent: [], at: 0 }),
  getCandles: () => Promise.resolve({ candles: [] }),
}))

import { Desk } from './Desk'

const newsCard = (c: HTMLElement) =>
  [...c.querySelectorAll('section.card')].find(el => el.querySelector('.section-title')?.textContent === 'In the news today') as HTMLElement

// "In the news today" is a NEWS panel. A lane tag (dip, velocity) rides in the same
// `catalyst` field, but its reason is a reading of the name's own chart — filing it
// here invented a catalyst the engine never claimed, and on a lane-only day it also
// hid the honest "quiet tape" line behind a headline nobody wrote.
describe('Desk — the news rail', () => {
  it('files a real news catalyst under the news heading, and a lane reason nowhere near it', async () => {
    const { container } = render(<Desk onStandard={() => {}} onQuant={() => {}} />)
    await waitFor(() => expect(newsCard(container)).toBeTruthy())
    const card = newsCard(container)
    expect(card.textContent).toContain('NVDA')
    expect(card.textContent).toContain('guidance cut at the analyst day')
    // …and the velocity row's chart reading is not news
    expect(card.textContent).not.toContain('VELO')
    expect(card.textContent).not.toContain('20-session high')
    // the comparison is not vacuous — the velocity row IS on the board, charted
    expect(container.textContent).toContain('VELO')
  })
})
