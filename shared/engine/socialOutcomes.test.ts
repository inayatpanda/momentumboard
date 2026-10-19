import { describe, expect, it } from 'vitest'
import { gradeSocialRecord, registerSocialClaims, socialGradingQueue, summarizeSocialOutcomes } from './socialOutcomes'
import { parseSocialClaims } from '../socialEvidence'
import type { Candle } from '../types'
const sec = (s: string) => Date.parse(s) / 1000
const at = sec('2026-10-16T21:00:00Z')
const quote = 'Tesla is bullish for the next year.'
const source = (url = 'first', time = at) => ({ url, channel: 'Channel', channelId: 'UC123', at: time, publishedAt: time - 86400, claims: parseSocialClaims([{ sym: 'TSLA', company: 'Tesla', stance: 'bull', evidenceQuote: quote, condition: null }], quote, [], url) })
const record = () => registerSocialClaims([], source())[0]
const bars = (growth = 1): Candle[] => Array.from({ length: 45 }, (_, i) => {
  const t = sec('2026-10-01T00:00:00Z') + i * 86400, c = 100 + i * growth
  return { t, o: c, h: c + 1, l: c - 1, c, v: 10000 }
}).filter(c => ![0, 6].includes(new Date(c.t * 1000).getUTCDay()))

describe('durable social outcome contracts', () => {
  it('registers once and excludes conditional, unsupported and non-US claims', () => {
    const first = registerSocialClaims([], source())
    expect(registerSocialClaims(first, source())).toHaveLength(1)
    const s = source('conditional'); s.claims[0].unconditional = false
    expect(registerSocialClaims(first, s)).toHaveLength(1)
    s.claims[0].unconditional = true; s.claims[0].sym = 'BTC-USD'
    expect(registerSocialClaims(first, s)).toHaveLength(1)
  })
  it('keeps old pending claims beyond rolling-feed limits and rotates retries', () => {
    const old = { ...record(), availableAt: at - 150 * 86400 }
    const newer = { ...record(), id: 'newer', availableAt: at - 40 * 86400, lastAttemptAt: at - 100 }
    expect(socialGradingQueue([newer, old], at, 1)[0].id).toBe(old.id)
    expect(socialGradingQueue([newer, { ...old, lastAttemptAt: at }], at, 1)[0].id).toBe('newer')
  })
  it('grades at the next open through the tenth aligned close, with explicit costs', () => {
    const got = gradeSocialRecord(record(), bars(1), bars(0), sec('2026-11-15T00:00:00Z'))
    expect(got.app?.entryAt).toBe(sec('2026-10-19T13:30:00Z'))
    expect(got.app?.exitAt).toBe(sec('2026-10-30T20:00:00Z'))
    expect(got.creator?.entryAt).toBe(sec('2026-10-16T13:30:00Z'))
    expect(got.app?.excessPct).toBeCloseTo((129 / 118 - 1) * 100 - 0.2)
  })
  it('does not use future closes, missing early history or misaligned dates', () => {
    expect(gradeSocialRecord(record(), bars(), bars(0), sec('2026-10-30T19:59:00Z')).app).toBeUndefined()
    expect(gradeSocialRecord(record(), bars().slice(20), bars(0), sec('2026-11-20T00:00:00Z')).app).toBeUndefined()
    expect(gradeSocialRecord(record(), bars().filter(c => c.t !== sec('2026-10-21')), bars(0), sec('2026-11-20')).app).toBeUndefined()
  })
  it('respects DST and an intraday publication cannot enter at the past open', () => {
    const r = { ...record(), availableAt: sec('2026-11-02T15:00:00Z') }
    const longer = bars().concat(Array.from({ length: 15 }, (_, i) => { const t = sec('2026-11-15') + i * 86400; return { t, o: 150, h: 152, l: 149, c: 151, v: 1 } }).filter(c => ![0, 6].includes(new Date(c.t * 1000).getUTCDay())))
    expect(gradeSocialRecord(r, longer, longer, sec('2026-11-30')).app?.entryAt).toBe(sec('2026-11-03T14:30:00Z'))
  })
  it('groups repeated opposite views in one campaign and never rewrites a measured result', () => {
    let records = registerSocialClaims([], source())
    const second = source('second', at + 2 * 86400); second.claims[0].stance = 'bear'
    records = registerSocialClaims(records, second)
    expect(records[1].campaignId).toBe(records[0].id)
    const graded = records.map(r => gradeSocialRecord(r, bars(), bars(0), sec('2026-11-20')))
    const summary = summarizeSocialOutcomes(graded)
    expect(summary).toMatchObject({ mode: 'shadow', completed: 2, independent: 1, repeats: 1 })
    expect(summary.channels[0].n).toBe(1)
    expect(gradeSocialRecord(graded[0], bars(-1), bars(0), sec('2026-11-21')).app).toEqual(graded[0].app)
  })
})
