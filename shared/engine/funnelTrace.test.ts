import { describe, expect, it } from 'vitest'
import { MODERATE_GATES } from './catalyst'
import { FUNNEL_TRACE_INDEX_MAX, PUBLISHED_GATES, TRACE_DETAIL_MAX, funnelTraceKey, funnelTraceRecorder, traceRowKey } from './funnelTrace'

const built = (r: ReturnType<typeof funnelTraceRecorder>) =>
  r.build({ date: '2026-08-13', gates: MODERATE_GATES, nearMisses: [], emptySides: {} })

describe('funnelTraceRecorder', () => {
  it('keys the blob by date and mirrors predictions-index bound', () => {
    expect(funnelTraceKey('2026-08-13')).toBe('funnel-trace:2026-08-13')
    expect(FUNNEL_TRACE_INDEX_MAX).toBe(250)
  })

  it('keys a row by SYM:side once a side exists, and by the bare name before there is one', () => {
    expect(traceRowKey('nvda', 'long')).toBe('NVDA:long')
    expect(traceRowKey('nvda', 'short')).toBe('NVDA:short')
    expect(traceRowKey('nvda')).toBe('NVDA')
    expect(traceRowKey('nvda', null)).toBe('NVDA')
  })

  it('one row per name for the SIDE-FREE gates, whatever case the door spelled it in', () => {
    const r = funnelTraceRecorder()
    r.record('nvda', 'trimmed')
    r.record('NVDA', 'no-candles')
    expect(r.size()).toBe(1)
    expect(built(r).rows).toEqual({ NVDA: { gate: 'no-candles' } })
  })

  it('…but a long publication and a short rejection on one name are TWO rows — a chart can die one way and pay the other', () => {
    const r = funnelTraceRecorder()
    r.revise('GLW', 'called-half', { side: 'long', detail: 'grade C' })
    r.revise('GLW', 'called-shadow', { side: 'short', detail: 'the dip lane outranked it' })
    expect(r.size()).toBe(2)
    expect(built(r).rows).toEqual({
      'GLW:long': { gate: 'called-half', side: 'long', detail: 'grade C' },
      'GLW:short': { gate: 'called-shadow', side: 'short', detail: 'the dip lane outranked it' },
    })
  })

  it('a later stage overwrites an earlier one ON THE SAME KEY — the trace names where a name FINALLY stopped', () => {
    const r = funnelTraceRecorder()
    r.record('AAA', 'dead-zone-core', { side: 'long', detail: 'core 14, inside ±25' })
    r.record('AAA', 'expected-move', { side: 'long', detail: 'expected move 2.1% under the floor' })
    expect(built(r).rows['AAA:long']).toEqual({ gate: 'expected-move', side: 'long', detail: 'expected move 2.1% under the floor' })
  })

  it('…but a PUBLICATION is terminal against record ON ITS OWN KEY: a later lane refusing its own attempt is not what happened to the name', () => {
    for (const gate of PUBLISHED_GATES) {
      const r = funnelTraceRecorder()
      r.revise('AAA', gate, { side: 'short' })
      r.record('AAA', 'evidence-fail', { side: 'short' })
      expect(r.gateOf('AAA', 'short')).toBe(gate)
    }
  })

  it('…and precedence is PER KEY: a publication on one side never silences the other side’s refusal', () => {
    const r = funnelTraceRecorder()
    r.revise('AAA', 'called-full', { side: 'short' })
    r.record('AAA', 'dip-refused', { side: 'long', detail: 'dip lane declined to build' })
    expect(r.gateOf('AAA', 'short')).toBe('called-full')
    expect(r.gateOf('AAA', 'long')).toBe('dip-refused')
  })

  it('…and revise writes over a publication, because that row’s fate really did change', () => {
    const r = funnelTraceRecorder()
    r.revise('AAA', 'called-full', { side: 'short' })
    r.revise('AAA', 'slot-cut', { side: 'short', detail: 'trade cut · 3 per side already filled' })
    expect(r.gateOf('AAA', 'short')).toBe('slot-cut')
  })

  it('rowAt hands back a COPY of the standing row, so a caller re-labelling it cannot mutate the record in place', () => {
    const r = funnelTraceRecorder()
    r.revise('AAA', 'slot-cut', { side: 'long', source: 'screener:gainers', detail: 'trade cut · 3 per side already filled' })
    const row = r.rowAt('aaa', 'long')!
    expect(row).toEqual({ gate: 'slot-cut', side: 'long', source: 'screener:gainers', detail: 'trade cut · 3 per side already filled' })
    row.gate = 'called-watch'
    expect(r.gateOf('AAA', 'long')).toBe('slot-cut')
    expect(r.rowAt('AAA', 'short')).toBeNull()
    expect(r.rowAt('AAA')).toBeNull()
  })

  it('hasRow asks about the NAME, not the key — the not-candidate count must not book a name that already has a row on either side', () => {
    const r = funnelTraceRecorder()
    r.record('AAA', 'called-full', { side: 'short' })
    r.record('BBB', 'trimmed')
    expect(r.hasRow('aaa')).toBe(true)
    expect(r.hasRow('BBB')).toBe(true)
    expect(r.hasRow('CCC')).toBe(false)
    expect(r.gateOf('AAA')).toBeNull() // the bare key genuinely holds nothing
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
    r.record('AAA', 'called-full', { side: 'short' })
    r.record('AAA', 'dip-refused', { side: 'long' })
    r.record('MMM', 'trimmed')
    expect(Object.keys(built(r).rows)).toEqual(['AAA:long', 'AAA:short', 'MMM', 'ZZZ'])
  })

  it('the called-* family — including the split zero-size codes — is the set a publication is terminal against', () => {
    expect([...PUBLISHED_GATES].sort()).toEqual([
      'called-below-base',
      'called-full',
      'called-half',
      'called-observation',
      'called-shadow',
      'called-watch',
      'route-blocked',
    ])
  })
})
