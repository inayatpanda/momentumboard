import { describe, expect, it } from 'vitest'
import { MODERATE_GATES } from './catalyst'
import { FUNNEL_TRACE_INDEX_MAX, PUBLISHED_GATES, TRACE_DETAIL_MAX, funnelTraceKey, funnelTraceRecorder } from './funnelTrace'

const built = (r: ReturnType<typeof funnelTraceRecorder>) =>
  r.build({ date: '2026-08-13', gates: MODERATE_GATES, nearMisses: [], emptySides: {} })

describe('funnelTraceRecorder', () => {
  it('keys the blob by date and mirrors predictions-index bound', () => {
    expect(funnelTraceKey('2026-08-13')).toBe('funnel-trace:2026-08-13')
    expect(FUNNEL_TRACE_INDEX_MAX).toBe(250)
  })

  it('one row per name, whatever case the door spelled it in', () => {
    const r = funnelTraceRecorder()
    r.record('nvda', 'trimmed')
    r.record('NVDA', 'no-candles')
    expect(r.size()).toBe(1)
    expect(built(r).rows).toEqual({ NVDA: { gate: 'no-candles' } })
  })

  it('a later stage overwrites an earlier one — the trace names where a name FINALLY stopped', () => {
    const r = funnelTraceRecorder()
    r.record('AAA', 'trimmed', { detail: 'past the budget' })
    r.record('AAA', 'dead-zone-core', { side: 'long', detail: 'core 14, inside ±25' })
    expect(built(r).rows.AAA).toEqual({ gate: 'dead-zone-core', side: 'long', detail: 'core 14, inside ±25' })
  })

  it('…but a PUBLICATION is terminal against record: a later lane refusing its own attempt is not what happened to the name', () => {
    for (const gate of PUBLISHED_GATES) {
      const r = funnelTraceRecorder()
      r.revise('AAA', gate, { side: 'short' })
      r.record('AAA', 'dip-refused', { side: 'long' })
      expect(r.gateOf('AAA')).toBe(gate)
    }
  })

  it('…and revise writes over a publication, because that row’s fate really did change', () => {
    const r = funnelTraceRecorder()
    r.revise('AAA', 'called-full', { side: 'short' })
    r.revise('AAA', 'slot-cut', { side: 'short', detail: 'trade cut · 3 per side already filled' })
    expect(r.gateOf('AAA')).toBe('slot-cut')
  })

  it('detail is bounded at 120 characters, at the one choke point that cannot be bypassed', () => {
    const r = funnelTraceRecorder()
    r.record('AAA', 'diversity', { detail: 'x'.repeat(500) })
    expect(built(r).rows.AAA.detail).toHaveLength(TRACE_DETAIL_MAX)
    expect(TRACE_DETAIL_MAX).toBe(120)
  })

  it('empty side/source/detail are omitted rather than stored as nulls', () => {
    const r = funnelTraceRecorder()
    r.record('AAA', 'trimmed', { side: null, source: null, detail: null })
    expect(built(r).rows.AAA).toEqual({ gate: 'trimmed' })
  })

  it('not-candidate is a COUNT — never a list, because the universe is unbounded', () => {
    const r = funnelTraceRecorder()
    r.notCandidate(3)
    r.notCandidate(-5) // a negative population is nonsense and must not subtract
    const t = built(r)
    expect(t.counts).toEqual({ notCandidate: 3 })
    expect(t.rows).toEqual({})
  })

  it('build stamps the run’s own gate values, by value', () => {
    const r = funnelTraceRecorder()
    const t = built(r)
    expect(t.gates).toEqual(MODERATE_GATES)
    expect(t.gates).not.toBe(MODERATE_GATES) // never a live handle on the module constant
    expect(t.date).toBe('2026-08-13')
  })

  it('rows come out sorted, so two runs of one day diff cleanly', () => {
    const r = funnelTraceRecorder()
    r.record('ZZZ', 'trimmed')
    r.record('AAA', 'trimmed')
    r.record('MMM', 'trimmed')
    expect(Object.keys(built(r).rows)).toEqual(['AAA', 'MMM', 'ZZZ'])
  })
})
