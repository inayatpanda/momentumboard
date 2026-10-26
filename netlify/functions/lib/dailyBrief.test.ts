import { describe, expect, it, vi } from 'vitest'
import { buildDailyBrief, loadDailyBrief, type BriefInputs } from './dailyBrief'
import type { StrategyChoicesSnapshot } from '../../../shared/engine/strategyChoices'
import type { VideoExtract } from './videoTrends'
import type { StockContext } from '../../../shared/engine/stockContext'

const now = Date.parse('2026-10-26T17:00:00Z') / 1000
const strategy = (over: Partial<StrategyChoicesSnapshot> = {}): StrategyChoicesSnapshot => ({
  version: 'current-strategy-choices-v1', rulesVersion: 'independent-screens-v1', generatedAt: now - 600, scope: 'shared scan', symbols: ['TEST'], unavailableSymbols: [],
  strategies: [{ key: 'healthy-drop', label: 'Recovery', description: '', horizon: 20, status: 'ready', counts: { evaluated: 1, missing: 0, noMatch: 0, matched: 1, blocked: 0 }, gaps: [], matches: [{ symbol: 'TEST', sector: 'Technology', lastPrice: 42, asOf: now - 3 * 86400, side: 'long', status: 'matches', reasons: [], risks: [] }] }], ...over,
})
const video = (over: Partial<VideoExtract> = {}): VideoExtract => ({ url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'A creator view', channel: 'Channel', at: now - 60, tickers: [{ sym: 'TEST', stance: 'bull', levels: [], thesis: 'Sales are growing' }], themes: [], ...over })

describe('daily evidence brief', () => {
  it('keeps research separate from sell warnings and does not turn matches into orders', () => {
    const result = buildDailyBrief('morning', now, { strategies: strategy() })
    expect(result.text).toContain('Healthy businesses after a fall: TEST (Technology)')
    expect(result.text).toContain('Examples are alphabetical, not ranked')
    expect(result.text).toContain('Research, not personal advice')
    expect(result.text).toContain('selling review needs fresh data')
  })
  it.each([now - 3 * 86400, now + 60, NaN])('does not promote stale/future/invalid scans (%s)', generatedAt => {
    expect(buildDailyBrief('morning', now, { strategies: strategy({ generatedAt }) }).text).not.toContain('TEST')
  })
  it('excludes blocked, short, stale and future matches, and groups not ready', () => {
    for (const patch of [{ status: 'blocked' }, { side: 'short' }, { asOf: now + 1 }, { asOf: now - 8 * 86400 }]) {
      const s = strategy(); Object.assign(s.strategies[0].matches[0], patch)
      expect(buildDailyBrief('morning', now, { strategies: s }).text).not.toContain('TEST')
    }
    const s = strategy(); s.strategies[0].status = 'missing-data'
    expect(buildDailyBrief('morning', now, { strategies: s }).text).toContain('not enough data')
    expect(buildDailyBrief('morning', now, { strategies: s }).text).not.toContain('TEST')
  })
  it('labels a saved comparison with its actual date, not yesterday', () => {
    const c = { symbol: 'TEST', generatedAt: now, changes: { baselineAt: now - 3 * 86400, lines: ['The market view changed.'] } } as StockContext
    const input = { contexts: { generatedAt: now, items: { TEST: c } } }
    expect(buildDailyBrief('morning', now, input).text).toContain('TEST (since 2026-10-23)')
    c.changes!.baselineAt = now + 60
    expect(buildDailyBrief('morning', now, input).text).not.toContain('TEST (since')
  })
  it('uses company names and one short footer instead of repeated video caveats', () => {
    const r = buildDailyBrief('morning', now, { videos: [video({ tickers: [{ sym: 'PLTR', stance: 'bull', levels: [], thesis: 'Sales are growing' }] }), video({ url: 'second', tickers: [{ sym: 'SOUN', stance: 'bull', levels: [], thesis: 'Demand is growing' }] })] })
    expect(r.text).toContain('Palantir Technologies (PLTR)')
    expect(r.text).toContain('SoundHound AI (SOUN)')
    expect(r.text).not.toContain('visuals not checked')
    expect(r.text).not.toContain('Full transcript')
    expect(r.text.match(/Video summaries may be incomplete/g)).toHaveLength(1)
  })
  it('deduplicates video URLs and excludes old and future processing dates', () => {
    const result = buildDailyBrief('morning', now, { videos: [video(), video(), video({ at: now + 1, channel: 'Future' }), video({ at: now - 3 * 86400, channel: 'Old' })] })
    expect(result.sections.find(s => s.title === 'Newly processed videos')!.lines).toHaveLength(1)
    expect(result.text).toContain('Sales are growing')
    expect(result.text).not.toMatch(/Future:|Old:/)
  })
  it('escapes untrusted text and only supplies fixed first-party links', () => {
    const r = buildDailyBrief('morning', now, { videos: [video({ channel: '<script>alert(1)</script> & "Channel"', url: 'javascript:alert(1)' })] })
    expect(r.html).not.toContain('<script>')
    expect(r.html).not.toContain('javascript:')
    expect(r.html).toContain('&amp; &quot;Channel&quot;')
  })
  it('uses UK time in summer and does not call an afternoon snapshot a closing result', () => {
    const summer = Date.parse('2026-07-01T16:00:00Z') / 1000
    const r = buildDailyBrief('evening', summer, { market: [{ name: 'US shares', changePct: 1.2, asOf: summer }] })
    expect(r.text).toContain('17:00 UK')
    expect(r.text).toContain('versus its previous close; quoted')
    expect(r.title).toBe('Your afternoon update')
  })
  it('never presents stale, undated or future quotes as current', () => {
    const r = buildDailyBrief('premarket', now, { market: [{ name: 'OLD', changePct: 7, asOf: now, stale: true }, { name: 'FUTURE', changePct: 7, asOf: now + 1 }, { name: 'UNDATED', changePct: 7, asOf: NaN }] })
    expect(r.text).toContain('Fresh market quotes are unavailable')
    expect(r.text).not.toContain('+7.0%')
  })
  it('does not read private account data or call a provider', async () => {
    const read = vi.fn(async () => null), fetchSpy = vi.spyOn(globalThis, 'fetch')
    await loadDailyBrief({ read, write: vi.fn() }, 'morning', now)
    expect(read.mock.calls.map(c => (c as unknown as string[])[0])).toEqual(['engine-strategy-choices', 'engine-stock-contexts', 'video-extracts'])
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
  it('keeps worst-case messages below Telegram limits with caveats and links intact', () => {
    const long = 'Long text & '.repeat(100), s = strategy()
    s.strategies = ['healthy-drop', 'quarterly-recovery', 'sector-leader'].map(key => ({ ...s.strategies[0], key, matches: [{ ...s.strategies[0].matches[0], symbol: long, sector: long }] })) as typeof s.strategies
    s.sellReview = { version: 'sell-review-v1', generatedAt: now, coverage: { scanned: 2, review: 2, noWarning: 0, dataGap: 0, incomplete: 0 }, caveats: [], rows: ['A', 'B'].map(symbol => ({ symbol, sector: '', status: 'review', asOf: now, checks: { price: 'checked', business: 'checked', valuation: 'checked' }, signals: [{ kind: 'business', label: long, summary: long, reasons: [], evidenceAt: now }], gaps: [] })) }
    const contexts = Object.fromEntries(['A', 'B'].map(symbol => [symbol, { symbol, generatedAt: now, changes: { baselineAt: now - 86400, lines: [long] } }])) as Record<string, StockContext>
    const input: BriefInputs = { strategies: s, contexts: { generatedAt: now, items: contexts }, videos: [video({ channel: long }), video({ url: 'different', channel: long })], calendar: [1, 2].map(i => ({ title: long, country: long, at: now + i * 3600, impact: 'High' })), market: [1, 2].map(() => ({ name: long, changePct: 2, asOf: now })) }
    const r = buildDailyBrief('evening', now, input)
    expect(r.text.length).toBeLessThanOrEqual(4096)
    expect(r.text).toContain('Research, not personal advice')
    expect(r.text).toContain('Video summaries may be incomplete or contain errors')
    expect(r.text).toContain('Full report: https://thestreetsignal.rqai.co.uk/report?date=2026-10-26')
  })
})
