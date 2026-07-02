import { describe, it, expect } from 'vitest'
import { parseEconFeed, dueMacroWarnings } from './econCalendar'

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
