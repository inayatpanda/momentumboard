import { describe, expect, it } from 'vitest'
import { labEvidenceCount, labGradingQueue, retainLabRecords } from './labLifecycle'
import { SHORT_HORIZON_MODEL_VERSION, type StrategyLabRecord } from './strategyLab'

const now = 100 * 86_400
const record = (id: string, days: number, horizon = 3): StrategyLabRecord => ({
  id, sym: id, sleeve: 'short-horizon', side: 'neutral', state: 'watch', score: 0,
  entry: 10, stop: null, target: null, reasons: [], risks: [], dataGaps: [], metrics: {},
  availableAt: now - days * 86_400, detectedAt: now - days * 86_400,
  forecast: { definition: 'three-session-direction-v1', modelVersion: SHORT_HORIZON_MODEL_VERSION,
    label: 'test', horizonSessions: horizon, calibratedN: 0, provisional: true },
})
const outcome = { entry: 10, exit: 11, firstBarrier: 'none' as const, targetHit: false, stopHit: false, returnPct: 10, sessions: 3, finishedHigher: true, horizonEndAt: now - 86_400 }

describe('lab campaign lifecycle', () => {
  it('keeps a mature short forecast ahead of immature 63-session recoveries', () => {
    const rows = Array.from({ length: 70 }, (_, i) => record(`recovery${i}`, 20, 63))
    rows.push(record('ready', 5))
    expect(labGradingQueue(rows, now).map(row => row.id)).toEqual(['ready'])
  })
  it('rotates repeatedly unavailable price feeds out of the next grading budget', () => {
    const failed = { ...record('unavailable', 80), lastGradeAttemptAt: now - 100 }
    expect(labGradingQueue([failed, record('ready', 5)], now, 1)[0].id).toBe('ready')
  })
  it('never evicts open recovery campaigns when trimming completed history', () => {
    const pending = record('recovery', 50, 63)
    const closed = Array.from({ length: 600 }, (_, i) => ({ ...record(`done${i}`, 4), outcome }))
    const retained = retainLabRecords([pending, ...closed])
    expect(retained).toHaveLength(501)
    expect(retained).toContain(pending)
  })
  it('counts independent current-model outcomes, excluding legacy and duplicate campaigns', () => {
    const first = { ...record('A', 5), outcome }
    const duplicate = { ...first, id: 'duplicate' }
    const legacy = { ...record('old', 5), forecast: { ...first.forecast, modelVersion: 'old' }, outcome }
    expect(labEvidenceCount([first, duplicate, legacy], 'short-horizon', now)).toBe(1)
  })
})
