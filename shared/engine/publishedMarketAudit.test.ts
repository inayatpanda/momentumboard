import { describe, expect, it } from 'vitest'
import { publishedAuditRecord, BOARD_AUDIT_EXECUTION } from './publishedMarketAudit'
import type { Prediction } from './types'
import type { Candle } from '../types'
const at = (s: string) => Date.parse(s) / 1000
const now = at('2026-10-10T12:00:00Z')
const candles: Candle[] = [100, 100, 94, 110].map((c, i) => ({ t: at(`2026-10-0${5+i}T13:30:00Z`), o: c, c, h: c + 10, l: c - 10, v: 100 }))
const prediction = (over: Partial<Prediction> = {}) => ({ id: 'p', campaignId: 'p', sym: 'AAPL', side: 'long', riskPct: .5,
  modelVersion: 4, entry: 100, stop: 95, target: 120, availableAt: at('2026-10-05T22:00:00Z'),
  forecast: { definition: 'benchmark-excess-no-close-stop-v1', horizonSessions: 3 }, ...over }) as Prediction
describe('original published board audit', () => {
  it('uses the next open, saved horizon and close-stop, including losses and costs', () => {
    const r = publishedAuditRecord(prediction(), candles, now)!
    expect(r.forecast.modelVersion).toBe('published-board-4-audit-v1')
    expect(r.outcome).toMatchObject({ executionVersion: BOARD_AUDIT_EXECUTION, firstBarrier: 'stop', sessions: 2 })
    expect(r.outcome!.returnPct).toBeCloseTo((94 * .999 / 100.1 - 1) * 100)
    // Day-one intraday low crosses the level, but this board contract is close-only.
    expect(r.outcome!.horizonEndAt).toBe(at('2026-10-08T20:00:00Z'))
  })
  it('rejects missing timestamps, watch calls, repeated campaign publications and non-US instruments', () => {
    for (const over of [{ availableAt: undefined }, { watchOnly: true }, { shadow: true }, { riskPct: 0 }, { campaignId: 'earlier' }, { sym: 'HSBA.L' }, { sym: 'BTC-USD' }]) {
      expect(publishedAuditRecord(prediction(over), candles, now)).toBeNull()
    }
  })
  it('waits for the whole horizon and refuses a feed that lost the publication reference', () => {
    expect(publishedAuditRecord(prediction(), candles.slice(0, 3), now)?.outcome).toBeUndefined()
    expect(publishedAuditRecord(prediction(), candles.slice(1), now)?.outcome).toBeUndefined()
    const missingSession = [candles[0], candles[1], candles[3], { ...candles[3], t: at('2026-10-09T13:30:00Z') }]
    expect(publishedAuditRecord(prediction(), missingSession, now, candles)?.outcome).toBeUndefined()
  })
  it('cancels invalid opening gaps and calculates short profit on entry capital', () => {
    expect(publishedAuditRecord(prediction({ stop: 101 }), candles, now)?.outcome?.executionStatus).toBe('cancelled-gap')
    const p = prediction({ side: 'short', stop: 120 })
    const r = publishedAuditRecord(p, candles, now)!
    expect(r.outcome!.returnPct).toBeCloseTo((99.9 - 110 * 1.001) / 99.9 * 100)
  })
})
