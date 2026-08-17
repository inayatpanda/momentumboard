import { describe, it, expect } from 'vitest'
import { fetchEconCalendar, parseEconFeed, dueMacroWarnings } from './econCalendar'

const feed = [
  { title: 'FOMC Statement', country: 'USD', date: '2026-07-02T14:00:00-04:00', impact: 'High' },
  { title: 'BoE Gov Speaks', country: 'GBP', date: '2026-07-02T10:00:00-04:00', impact: 'Medium' },
  { title: 'RBA Minutes', country: 'AUD', date: '2026-07-02T21:30:00-04:00', impact: 'High' }, // wrong country
  { title: 'Nothing Burger', country: 'USD', date: '2026-07-02T09:00:00-04:00', impact: 'Low' }, // low impact
]

describe('parseEconFeed', () => {
  it('keeps USD/GBP medium+high only, sorted', () => {
    const events = parseEconFeed(feed)
    expect(events.map(e => e.title)).toEqual(['BoE Gov Speaks', 'FOMC Statement'])
  })
})

// A FAILED FETCH IS NOT A QUIET WEEK (verified live 2026-08-17: a pre-run empty
// array was cached at the full six hours and blinded the macro sentinel while
// the upstream served 96 events). The two states have to be TELLABLE APART by
// the caller, or a failure gets stored under the TTL that only real data earns.
describe('fetchEconCalendar', () => {
  const res = (body: unknown, ok = true) => new Response(JSON.stringify(body), { status: ok ? 200 : 503 })

  it('returns null when the upstream refuses', async () => {
    expect(await fetchEconCalendar((async () => res([], false)) as typeof fetch)).toBeNull()
  })

  it('returns null when the wire throws', async () => {
    expect(
      await fetchEconCalendar((() => {
        throw new Error('ECONNRESET')
      }) as unknown as typeof fetch),
    ).toBeNull()
  })

  it('returns null when the payload is not the feed at all', async () => {
    expect(await fetchEconCalendar((async () => res({ error: 'rate limited' })) as typeof fetch)).toBeNull()
    expect(await fetchEconCalendar((async () => new Response('<html>nope</html>')) as typeof fetch)).toBeNull()
  })

  it('returns an EMPTY ARRAY for a genuinely quiet week — a real answer', async () => {
    expect(await fetchEconCalendar((async () => res([])) as typeof fetch)).toEqual([])
    // …and for a week whose only events are the ones the filter drops
    expect(await fetchEconCalendar((async () => res([{ title: 'Nothing Burger', country: 'USD', date: '2026-07-02T09:00:00-04:00', impact: 'Low' }])) as typeof fetch)).toEqual([])
  })

  it('returns the parsed events when the feed answers', async () => {
    const events = await fetchEconCalendar((async () => res(feed)) as typeof fetch)
    expect(events?.map(e => e.title)).toEqual(['BoE Gov Speaks', 'FOMC Statement'])
  })
})

describe('dueMacroWarnings', () => {
  const events = parseEconFeed(feed)
  const fomcAt = Date.parse('2026-07-02T14:00:00-04:00') / 1000 // 18:00 UTC

  it('fires morning-of once, then the 1h warning once', () => {
    const morning = dueMacroWarnings(events, fomcAt - 10 * 3600, [])
    expect(morning).toHaveLength(1)
    expect(morning[0].text).toContain('Today: FOMC Statement')
    // 1h out: morning already fired
    const hour = dueMacroWarnings(events, fomcAt - 60 * 60, [morning[0].key])
    expect(hour).toHaveLength(1)
    expect(hour[0].text).toContain('in ~60 min')
    // both fired → silence
    expect(dueMacroWarnings(events, fomcAt - 30 * 60, [morning[0].key, hour[0].key])).toHaveLength(0)
  })

  it('holds the morning-of ping until 7am UK', () => {
    const midnight = Date.parse('2026-07-02T01:00:00+01:00') / 1000 // 1am UK, event day
    expect(dueMacroWarnings(events, midnight, []).filter(w => w.key.endsWith(':am'))).toHaveLength(0)
  })

  it('medium-impact events never ping', () => {
    const boeAt = Date.parse('2026-07-02T10:00:00-04:00') / 1000
    const warnings = dueMacroWarnings(events, boeAt - 3600, [])
    expect(warnings.some(w => w.text.includes('BoE'))).toBe(false) // FOMC (High) may fire; BoE (Medium) must not
  })
})
