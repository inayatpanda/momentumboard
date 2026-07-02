import { describe, it, expect } from 'vitest'
import { evaluateAlerts, flushBatch, emptyAlertState } from './alerts'
import type { AlertsConfig, AlertsInput, TickerSnapshot } from './alerts'

const snap = (over: Partial<TickerSnapshot> = {}): TickerSnapshot => ({
  symbol: 'AAPL', price: 100, rvol: 1, rsi: 50, setups: [], marketOpen: true, ...over,
})

const cfg = (over: Partial<AlertsConfig> = {}): AlertsConfig => ({
  rules: [], watchlist: ['AAPL', 'NVDA'], ...over,
})

const input = (over: Partial<AlertsInput> = {}): AlertsInput => ({
  tickers: [snap()], regime: 'green', news: [], videos: [], nowSec: 1_800_000_000, ...over,
})

describe('price rules', () => {
  const rule = { id: 'r1', symbol: 'AAPL', kind: 'priceAbove' as const, level: 105 }

  it('fires instantly on cross, once, and re-arms after a 0.5% retreat', () => {
    let state = emptyAlertState()
    // below level: nothing
    let out = evaluateAlerts(cfg({ rules: [rule] }), input({ tickers: [snap({ price: 104 })] }), state)
    expect(out.events).toHaveLength(0)
    // crosses: fires instant
    out = evaluateAlerts(cfg({ rules: [rule] }), input({ tickers: [snap({ price: 105.5 })] }), out.state)
    expect(out.events).toHaveLength(1)
    expect(out.events[0].tier).toBe('instant')
    // still above: no refire
    out = evaluateAlerts(cfg({ rules: [rule] }), input({ tickers: [snap({ price: 106 })] }), out.state)
    expect(out.events).toHaveLength(0)
    // shallow dip (not 0.5% past level): still disarmed
    out = evaluateAlerts(cfg({ rules: [rule] }), input({ tickers: [snap({ price: 104.9 })] }), out.state)
    expect(out.events).toHaveLength(0)
    // deep retreat re-arms, next cross fires again
    out = evaluateAlerts(cfg({ rules: [rule] }), input({ tickers: [snap({ price: 104 })] }), out.state)
    out = evaluateAlerts(cfg({ rules: [rule] }), input({ tickers: [snap({ price: 105.2 })] }), out.state)
    expect(out.events).toHaveLength(1)
  })

  it('does not fire while the market is closed', () => {
    const out = evaluateAlerts(cfg({ rules: [rule] }), input({ tickers: [snap({ price: 110, marketOpen: false })] }), emptyAlertState())
    expect(out.events).toHaveLength(0)
  })

  it('priceBelow fires on downward cross', () => {
    const below = { id: 'r2', symbol: 'AAPL', kind: 'priceBelow' as const, level: 95 }
    const out = evaluateAlerts(cfg({ rules: [below] }), input({ tickers: [snap({ price: 94 })] }), emptyAlertState())
    expect(out.events).toHaveLength(1)
  })
})

describe('built-in ticker rules', () => {
  it('RVOL crossing 2 queues a batched event with hysteresis re-arm at 1.5', () => {
    let out = evaluateAlerts(cfg(), input({ tickers: [snap({ rvol: 2.4 })] }), emptyAlertState())
    expect(out.events[0].tier).toBe('batched')
    expect(out.state.queue).toHaveLength(1)
    out = evaluateAlerts(cfg(), input({ tickers: [snap({ rvol: 2.6 })] }), out.state)
    expect(out.events).toHaveLength(0) // still hot, no refire
    out = evaluateAlerts(cfg(), input({ tickers: [snap({ rvol: 1.2 })] }), out.state) // re-arms
    out = evaluateAlerts(cfg(), input({ tickers: [snap({ rvol: 2.1 })] }), out.state)
    expect(out.events).toHaveLength(1)
  })

  it('RSI fires batched on entering extreme zones only', () => {
    let out = evaluateAlerts(cfg(), input({ tickers: [snap({ rsi: 50 })] }), emptyAlertState())
    out = evaluateAlerts(cfg(), input({ tickers: [snap({ rsi: 72 })] }), out.state)
    expect(out.events).toHaveLength(1)
    out = evaluateAlerts(cfg(), input({ tickers: [snap({ rsi: 74 })] }), out.state)
    expect(out.events).toHaveLength(0)
  })

  it('setup additions: reclaim/breakoutLive instant, knife→basing instant, others batched', () => {
    let out = evaluateAlerts(cfg(), input({ tickers: [snap({ setups: [] })] }), emptyAlertState())
    out = evaluateAlerts(cfg(), input({ tickers: [snap({ setups: ['reclaim'] })] }), out.state)
    expect(out.events[0].tier).toBe('instant')
    out = evaluateAlerts(cfg(), input({ tickers: [snap({ setups: ['reclaim', 'breakoutWatch'] })] }), out.state)
    expect(out.events[0].tier).toBe('batched') // breakoutWatch addition
    // knife → basing is the reversal trigger: instant
    let s2 = evaluateAlerts(cfg(), input({ tickers: [snap({ setups: ['fallingKnife'] })] }), emptyAlertState())
    s2 = evaluateAlerts(cfg(), input({ tickers: [snap({ setups: ['basing'] })] }), s2.state)
    expect(s2.events.find(e => e.text.includes('Basing'))?.tier).toBe('instant')
  })
})

describe('journaled stop breaches', () => {
  const position = { symbol: 'AAPL', entryPrice: 100, stop: 95 }

  it('fires instantly once when price crosses the stop, never refires', () => {
    let out = evaluateAlerts(cfg(), input({ tickers: [snap({ price: 96 })], positions: [position] }), emptyAlertState())
    expect(out.events).toHaveLength(0)
    out = evaluateAlerts(cfg(), input({ tickers: [snap({ price: 94.8 })], positions: [position] }), out.state)
    expect(out.events).toHaveLength(1)
    expect(out.events[0].tier).toBe('instant')
    expect(out.events[0].text).toContain('stop')
    out = evaluateAlerts(cfg(), input({ tickers: [snap({ price: 93 })], positions: [position] }), out.state)
    expect(out.events).toHaveLength(0)
  })

  it('handles inverse-style stops above entry and closed markets', () => {
    const inverse = { symbol: 'AAPL', entryPrice: 100, stop: 108 }
    let out = evaluateAlerts(cfg(), input({ tickers: [snap({ price: 109, marketOpen: false })], positions: [inverse] }), emptyAlertState())
    expect(out.events).toHaveLength(0) // closed market: quotes are stale
    out = evaluateAlerts(cfg(), input({ tickers: [snap({ price: 109 })], positions: [inverse] }), out.state)
    expect(out.events).toHaveLength(1)
  })

  it('tolerates old persisted states without the stopFired field', () => {
    const legacy = emptyAlertState() as Partial<ReturnType<typeof emptyAlertState>>
    delete legacy.stopFired
    const out = evaluateAlerts(cfg(), input({ tickers: [snap({ price: 94 })], positions: [position] }), legacy as ReturnType<typeof emptyAlertState>)
    expect(out.events).toHaveLength(1)
  })
})

describe('setup event metadata', () => {
  it('carries structured setup info for signal logging', () => {
    let out = evaluateAlerts(cfg(), input({ tickers: [snap({ setups: [] })] }), emptyAlertState())
    out = evaluateAlerts(cfg(), input({ tickers: [snap({ setups: ['reclaim'], price: 101 })] }), out.state)
    expect(out.events[0].meta).toEqual({ kind: 'setup', setup: 'reclaim', price: 101 })
  })
})

describe('regime, news, videos', () => {
  it('regime change is instant; first observation is not', () => {
    let out = evaluateAlerts(cfg(), input({ regime: 'green' }), emptyAlertState())
    expect(out.events).toHaveLength(0)
    out = evaluateAlerts(cfg(), input({ regime: 'red' }), out.state)
    expect(out.events).toHaveLength(1)
    expect(out.events[0].tier).toBe('instant')
  })

  it('news naming a watchlist ticker is instant, general news batched, urls deduped', () => {
    const news = [
      { title: 'NVDA smashes earnings', url: 'https://x/1', symbols: ['NVDA'] },
      { title: 'Markets open mixed', url: 'https://x/2', symbols: [] },
    ]
    let out = evaluateAlerts(cfg(), input({ news }), emptyAlertState())
    expect(out.events.map(e => e.tier).sort()).toEqual(['batched', 'instant'])
    out = evaluateAlerts(cfg(), input({ news }), out.state)
    expect(out.events).toHaveLength(0) // seen
  })

  it('videos mentioning a watchlist ticker are instant, others batched', () => {
    const videos = [
      { title: 'Why I bought NVDA today', url: 'https://y/1', channel: 'Stocks with Josh' },
      { title: 'Market update', url: 'https://y/2', channel: 'Meet Kevin' },
    ]
    const out = evaluateAlerts(cfg(), input({ videos }), emptyAlertState())
    const tiers = Object.fromEntries(out.events.map(e => [e.text.includes('NVDA') ? 'nvda' : 'other', e.tier]))
    expect(tiers.nvda).toBe('instant')
    expect(tiers.other).toBe('batched')
  })
})

describe('flushBatch (Europe/London boundaries 07:00 / 14:30 / 21:00)', () => {
  // 2026-07-02 is BST (UTC+1): 07:02 London == 06:02 UTC
  const at = (hUtc: number, mUtc: number) => Date.UTC(2026, 6, 2, hUtc, mUtc) / 1000

  it('flushes a non-empty queue once a boundary passes', () => {
    const state = emptyAlertState()
    state.queue = [{ id: 'q1', tier: 'batched' as const, text: 'hello', at: 0 }]
    state.lastBatchAt = at(5, 0) // 06:00 London — before the 07:00 boundary
    const { digest, state: s2 } = flushBatch(state, at(6, 2)) // 07:02 London
    expect(digest).toContain('hello')
    expect(s2.queue).toHaveLength(0)
    // immediately after: nothing more to flush
    expect(flushBatch(s2, at(6, 5)).digest).toBeNull()
  })

  it('does not flush when the last flush already covered the boundary', () => {
    const state = emptyAlertState()
    state.queue = [{ id: 'q1', tier: 'batched' as const, text: 'x', at: 0 }]
    state.lastBatchAt = at(7, 0) // 08:00 London — after the 07:00 boundary
    expect(flushBatch(state, at(9, 0)).digest).toBeNull() // 10:00 London, next boundary is 14:30
  })
})
