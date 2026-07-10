import { describe, expect, it } from 'vitest'
import { checkCallCrossings, FIRED_RETENTION_SEC, type OpenCallLevels } from './callCross'

const NOW = Date.parse('2026-07-10T15:00:00Z') / 1000

const call = (over: Partial<OpenCallLevels> = {}): OpenCallLevels => ({
  id: '2026-07-08:SOFI:long',
  sym: 'SOFI',
  side: 'long',
  stop: 14.2,
  target: 16.5,
  ...over,
})

const prices = (m: Record<string, number>) => new Map(Object.entries(m))

describe('checkCallCrossings — crossings', () => {
  it('long through the stop: execution wording, no grade claim, key recorded now', () => {
    const { alerts, fired } = checkCallCrossings([call()], prices({ SOFI: 14.15 }), {}, NOW)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].kind).toBe('stop')
    expect(alerts[0].text).toBe(
      '⛔ SOFI long — stop 14.2 touched (now 14.15). Execution says exit; the formal close-based grade lands with the morning paper.',
    )
    expect(fired['2026-07-08:SOFI:long:stop']).toBe(NOW)
  })

  it('long through the target reads as target reached', () => {
    const { alerts } = checkCallCrossings([call()], prices({ SOFI: 16.8 }), {}, NOW)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].kind).toBe('target')
    expect(alerts[0].text).toBe('🎯 SOFI long — target 16.5 reached (now 16.8).')
  })

  it('shorts are mirrored: price ABOVE the stop stops, BELOW the target wins', () => {
    const short = call({ id: '2026-07-08:NVDA:short', sym: 'NVDA', side: 'short', stop: 170, target: 162 })
    const stopped = checkCallCrossings([short], prices({ NVDA: 170.5 }), {}, NOW)
    expect(stopped.alerts[0].kind).toBe('stop')
    const won = checkCallCrossings([short], prices({ NVDA: 161.4 }), {}, NOW)
    expect(won.alerts[0].kind).toBe('target')
    expect(won.alerts[0].text).toBe('🎯 NVDA short — target 162 reached (now 161.4).')
  })

  it('a price between the levels fires nothing', () => {
    const { alerts, fired } = checkCallCrossings([call()], prices({ SOFI: 15.0 }), {}, NOW)
    expect(alerts).toHaveLength(0)
    expect(fired).toEqual({})
  })

  it('the touch IS the trigger: exactly at the level fires', () => {
    expect(checkCallCrossings([call()], prices({ SOFI: 14.2 }), {}, NOW).alerts[0]?.kind).toBe('stop')
    expect(checkCallCrossings([call()], prices({ SOFI: 16.5 }), {}, NOW).alerts[0]?.kind).toBe('target')
  })

  it('no price for the symbol → silent, never a throw', () => {
    expect(checkCallCrossings([call()], prices({ NVDA: 1 }), {}, NOW).alerts).toHaveLength(0)
    expect(checkCallCrossings([call()], prices({ SOFI: NaN }), {}, NOW).alerts).toHaveLength(0)
  })

  it('stop beats target when pathological levels make both read crossed', () => {
    const weird = call({ stop: 20, target: 10 }) // long with stop above price above target
    const { alerts } = checkCallCrossings([weird], prices({ SOFI: 15 }), {}, NOW)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].kind).toBe('stop')
  })
})

describe('checkCallCrossings — dedupe and pruning', () => {
  it('an already-fired (call, level) stays silent and keeps its original timestamp', () => {
    const before = { '2026-07-08:SOFI:long:stop': NOW - 3_600 }
    const { alerts, fired } = checkCallCrossings([call()], prices({ SOFI: 14.0 }), before, NOW)
    expect(alerts).toHaveLength(0)
    expect(fired['2026-07-08:SOFI:long:stop']).toBe(NOW - 3_600)
  })

  it('the stop firing does not gag a later target hit on the same call', () => {
    const before = { '2026-07-08:SOFI:long:stop': NOW - 86_400 }
    const { alerts, fired } = checkCallCrossings([call()], prices({ SOFI: 16.6 }), before, NOW)
    expect(alerts).toHaveLength(1)
    expect(alerts[0].kind).toBe('target')
    expect(Object.keys(fired)).toHaveLength(2)
  })

  it('keys older than the retention window are pruned; fresh ones survive', () => {
    const before = {
      'old:stop': NOW - FIRED_RETENTION_SEC - 1,
      'fresh:target': NOW - 86_400,
    }
    const { fired } = checkCallCrossings([], prices({}), before, NOW)
    expect(fired).toEqual({ 'fresh:target': NOW - 86_400 })
  })

  it('a malformed persisted map heals: non-numeric entries are dropped', () => {
    const before = { junk: 'yesterday', alsoJunk: null, keep: NOW - 60 } as unknown as Record<string, number>
    const { fired } = checkCallCrossings([call()], prices({ SOFI: 14.0 }), before, NOW)
    expect(fired.keep).toBe(NOW - 60)
    expect(fired['2026-07-08:SOFI:long:stop']).toBe(NOW)
    expect('junk' in fired).toBe(false)
    expect('alsoJunk' in fired).toBe(false)
  })
})
