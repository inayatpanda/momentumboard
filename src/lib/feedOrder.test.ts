import { describe, expect, it } from 'vitest'
import { bestDateMs, feedOrder, isNew, NEW_WINDOW_MS } from './feedOrder'

const NOW = Date.parse('2026-07-16T12:00:00Z')

describe('bestDateMs', () => {
  it('returns the most recent of the supplied dates', () => {
    expect(bestDateMs('2026-07-10', '2026-07-14', '2026-07-12')).toBe(Date.parse('2026-07-14'))
  })
  it('falls back through the ladder, skipping unparseable / empty entries', () => {
    expect(bestDateMs('', null, undefined, '2026-07-09')).toBe(Date.parse('2026-07-09'))
  })
  it('is -Infinity when nothing parses, so undated rows sink', () => {
    expect(bestDateMs('', null, 'not-a-date')).toBe(-Infinity)
  })
})

describe('isNew', () => {
  it('a filing dated today is new', () => {
    expect(isNew('2026-07-16', NOW)).toBe(true)
  })
  it('a filing from yesterday is still within the 48h window', () => {
    expect(isNew('2026-07-15', NOW)).toBe(true)
  })
  it('a filing three days old is no longer new', () => {
    expect(isNew('2026-07-13', NOW)).toBe(false)
  })
  it('a future-dated typo never counts as new', () => {
    expect(isNew('2026-07-18', NOW)).toBe(false)
  })
  it('missing / unparseable dates are not new', () => {
    expect(isNew(null, NOW)).toBe(false)
    expect(isNew('', NOW)).toBe(false)
    expect(isNew('nope', NOW)).toBe(false)
  })
  it('honours a caller-supplied window', () => {
    const twelveH = 12 * 60 * 60 * 1000
    expect(isNew('2026-07-15', NOW, twelveH)).toBe(false)
    expect(isNew('2026-07-16T06:00:00Z', NOW, twelveH)).toBe(true)
    expect(NEW_WINDOW_MS).toBe(48 * 60 * 60 * 1000)
  })
})

describe('feedOrder', () => {
  it('orders newest-first by the extractor', () => {
    const rows = [
      { id: 'a', d: '2026-07-10' },
      { id: 'b', d: '2026-07-15' },
      { id: 'c', d: '2026-07-12' },
    ]
    expect(feedOrder(rows, r => bestDateMs(r.d)).map(r => r.id)).toEqual(['b', 'c', 'a'])
  })
  it('is stable — equal dates keep input order', () => {
    const rows = [
      { id: 'x', d: '2026-07-12' },
      { id: 'y', d: '2026-07-12' },
      { id: 'z', d: '2026-07-12' },
    ]
    expect(feedOrder(rows, r => bestDateMs(r.d)).map(r => r.id)).toEqual(['x', 'y', 'z'])
  })
  it('sinks undated rows to the bottom without mutating the input', () => {
    const rows = [
      { id: 'a', d: '' },
      { id: 'b', d: '2026-07-14' },
    ]
    const out = feedOrder(rows, r => bestDateMs(r.d))
    expect(out.map(r => r.id)).toEqual(['b', 'a'])
    expect(rows.map(r => r.id)).toEqual(['a', 'b']) // original untouched
  })
})
