import { describe, expect, it } from 'vitest'
import { validateConfig } from './config'

const minimal = { watchlist: [], rules: [], ytChannels: [] }

describe('validateConfig engine fields', () => {
  it('round-trips levMap, override and favourites; sanitises junk', () => {
    const cfg = validateConfig({
      ...minimal,
      levMap: { nvda: { short3x: '3snv', bogus: 'X', long2x: 42 }, junk: null },
      riskRungOverride: 2,
      favouriteChannels: ['Stocks with Josh', 7],
    })!
    expect(cfg.levMap).toEqual({ NVDA: { short3x: '3SNV' } })
    expect(cfg.riskRungOverride).toBe(2)
    expect(cfg.favouriteChannels).toEqual(['Stocks with Josh'])
  })
  it('carries the 1× tracker fields through — the crypto route the owner configures (Stage 1c-R)', () => {
    // an entry made of nothing but 1x fields must SURVIVE: it is the whole
    // configuration of a crypto row's route, and a validator that dropped it
    // would leave the lane permanently paper-only with no error anywhere
    const cfg = validateConfig({ ...minimal, levMap: { 'btc-usd': { long1x: 'btce.de', short1x: 'xbts.l' } } })!
    expect(cfg.levMap).toEqual({ 'BTC-USD': { long1x: 'BTCE.DE', short1x: 'XBTS.L' } })
  })

  it('a real-book-sized levMap survives whole — the truncation cliff sits far above it [codex 1c-R]', () => {
    // ~40 real routes + the crypto pairs sat ON the old cap of 40: whichever
    // entry sorted last was dropped with no error anywhere. 45 must round-trip.
    const big = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`SYM${i}`, { long2x: `T${i}` }]))
    expect(Object.keys(validateConfig({ ...minimal, levMap: big })!.levMap!)).toHaveLength(45)
  })

  it('an EXPLICIT empty levMap means "clear my routes" — presence, not emptiness, decides [codex 1c-R]', () => {
    // {} must survive as {} so the sync merge REPLACES the stored map: collapsing
    // it to undefined made a withdrawn tracker uncorrectable (absence preserves).
    expect(validateConfig({ ...minimal, levMap: {} })!.levMap).toEqual({})
    // …an entry-that-validates-to-nothing is still a SENT map, so it clears too
    expect(validateConfig({ ...minimal, levMap: { junk: null } })!.levMap).toEqual({})
    // …and ABSENCE still reads as undefined, so a phone sync preserves
    expect(validateConfig(minimal)!.levMap).toBeUndefined()
  })

  it('rejects out-of-range override; absent fields stay absent', () => {
    const cfg = validateConfig({ ...minimal, riskRungOverride: 5 })!
    expect(cfg.riskRungOverride).toBeNull()
    expect(cfg.levMap).toBeUndefined()
    expect(validateConfig(minimal)!.favouriteChannels).toBeUndefined()
  })
  it('distinguishes an ABSENT override (undefined → caller may preserve) from an explicit null (→ clear)', () => {
    // absent: the phone mirror never sends this field — must stay undefined so the
    // server merge can preserve a stored pin
    expect(validateConfig(minimal)!.riskRungOverride).toBeUndefined()
    // explicit null: the user cleared the pin — a real "engine decides" instruction
    expect(validateConfig({ ...minimal, riskRungOverride: null })!.riskRungOverride).toBeNull()
  })
  it('gateOverride: keeps the known gates clamped to their hard bounds, drops the rest, mirrors absent-vs-null', () => {
    const cfg = validateConfig({
      ...minimal,
      gateOverride: { deadZone: 5, minExpectedMovePct: 1.25, contextCap: 99, roster: 3, deadZoneX: 1, minExpectedMovePctBad: '1.2' },
    })!
    expect(cfg.gateOverride).toEqual({ deadZone: 20, minExpectedMovePct: 1.25, contextCap: 16 })
    // absent → undefined (a merge may preserve a stored pin); nothing valid → null
    expect(validateConfig(minimal)!.gateOverride).toBeUndefined()
    expect(validateConfig({ ...minimal, gateOverride: null })!.gateOverride).toBeNull()
    expect(validateConfig({ ...minimal, gateOverride: { junk: 1 } })!.gateOverride).toBeNull()
  })
  it('coreSleeve: upper-cases entries, drops junk (bad chars/overlong), absent/empty stays undefined', () => {
    const cfg = validateConfig({ ...minimal, coreSleeve: ['spy', 'qqq.l', 'bad symbol!', 'toolongsymbolname12'] })!
    expect(cfg.coreSleeve).toEqual(['SPY', 'QQQ.L'])
    expect(validateConfig(minimal)!.coreSleeve).toBeUndefined()
    expect(validateConfig({ ...minimal, coreSleeve: [] })!.coreSleeve).toBeUndefined()
  })
  it('coreSleeve: caps at 200 entries', () => {
    const many = Array.from({ length: 250 }, (_, i) => `T${i}`)
    expect(validateConfig({ ...minimal, coreSleeve: many })!.coreSleeve).toHaveLength(200)
  })
  it('riskAppetite: accepts aggressive/moderate, ignores junk, absent stays undefined', () => {
    expect(validateConfig({ ...minimal, riskAppetite: 'aggressive' })!.riskAppetite).toBe('aggressive')
    expect(validateConfig({ ...minimal, riskAppetite: 'moderate' })!.riskAppetite).toBe('moderate')
    expect(validateConfig({ ...minimal, riskAppetite: 'reckless' })!.riskAppetite).toBeUndefined()
    expect(validateConfig(minimal)!.riskAppetite).toBeUndefined()
  })
  it('reportRecipients: keeps valid addresses lowercased/deduped — legacy strings migrate to all three editions', () => {
    const cfg = validateConfig({ ...minimal, reportRecipients: ['A@B.com', 'a@b.com', ' c@D.com ', 'c@d.com'] })!
    expect(cfg.reportRecipients).toEqual([
      { email: 'a@b.com', editions: ['morning', 'premarket', 'evening'] },
      { email: 'c@d.com', editions: ['morning', 'premarket', 'evening'] },
    ])
  })
  it('reportRecipients: object entries keep only valid editions; junk drops', () => {
    const cfg = validateConfig({
      ...minimal,
      reportRecipients: ['nope', '@bad', 'no-tld@x', { email: 'ok@x.com', editions: ['morning', 'lunchtime'] }, { email: 'paused@x.com', editions: [] }, 42, null],
    })!
    expect(cfg.reportRecipients).toEqual([
      { email: 'ok@x.com', editions: ['morning'] },
      { email: 'paused@x.com', editions: [] }, // paused: on the list, sent nothing
    ])
  })
  it('reportRecipients: absent stays undefined; caps at 50', () => {
    expect(validateConfig(minimal)!.reportRecipients).toBeUndefined()
    const many = Array.from({ length: 60 }, (_, i) => `u${i}@x.com`)
    expect(validateConfig({ ...minimal, reportRecipients: many })!.reportRecipients).toHaveLength(50)
  })
})
