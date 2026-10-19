import { describe, expect, it } from 'vitest'
import { exchangeFor, isCryptoSymbol, isYahooSymbol, type Exchange } from './symbols'
import { isMarketOpen, sessionElapsedFraction } from './rvol'
import { DEFAULT_CORE_SLEEVE } from './engine/coreSleeve'
import { CATEGORY_UNIVERSE } from '../src/lib/universe'
import { REPLAY_UNIVERSE } from '../scripts/replay-window'

/** The rule as it stood before the fix: the dash was tested BEFORE the dot, with
 * no `else`, so any `<letters>-<letter>.<suffix>` short-circuited to CRYPTO. Kept
 * here as the comparator for the blast-radius test below — the fix is allowed to
 * disagree with it on exactly two shipped names and no others. */
const legacyExchangeFor = (s: string): Exchange => (s.includes('-') ? 'CRYPTO' : s.includes('.') ? 'LSE' : 'US')

/** Every symbol the app actually ships in a list: the daily-scanned sleeve, the
 * replay harness universe, and the browsable category chips. */
const SHIPPED_UNIVERSE = [
  ...new Set([
    ...DEFAULT_CORE_SLEEVE,
    ...REPLAY_UNIVERSE,
    ...Object.values(CATEGORY_UNIVERSE).flatMap(u => [...u.big, ...u.small]),
  ]),
]

describe('exchangeFor — the suffix is read before the dash', () => {
  it('the trio: an exchange suffix outranks a dash, a quote currency after one is a pair, a share class is not', () => {
    expect(exchangeFor('BT-A.L')).toBe('LSE') // BT Group, LSE — a share-class dash AND a venue suffix
    expect(exchangeFor('ETH-USD')).toBe('CRYPTO') // a Yahoo pair: the dash is followed by a quote currency
    expect(exchangeFor('BRK-B')).toBe('US') // Berkshire class B — the dash means a share class
  })

  it('pins a hand list of every dash/dot shape the feeds produce (golden table)', () => {
    const GOLDEN: Record<string, Exchange> = {
      // plain US
      AAPL: 'US',
      NVDA: 'US',
      // dashed US share classes — a dash alone is not a coin
      'BRK-B': 'US',
      'BF-B': 'US',
      'BRK-A': 'US',
      // venue suffix wins first, dash or no dash
      'RR.L': 'LSE',
      'BP.L': 'LSE',
      '3LAL.L': 'LSE',
      'BT-A.L': 'LSE',
      // Yahoo crypto pairs: quote currency after the dash
      'BTC-USD': 'CRYPTO',
      'ETH-USD': 'CRYPTO',
      'BTC-GBP': 'CRYPTO',
      'SOL-USDT': 'CRYPTO',
      'DOGE-EUR': 'CRYPTO',
      'ETH-BTC': 'CRYPTO',
      // index / futures series carry neither, and stay US as they always did
      '^FTSE': 'US',
      '^VIX': 'US',
      'ES=F': 'US',
    }
    for (const [sym, exch] of Object.entries(GOLDEN)) expect([sym, exchangeFor(sym)]).toEqual([sym, exch])
  })

  it('changes the answer for EXACTLY two shipped names — BT-A.L and BRK-B — and no others', () => {
    const changed = SHIPPED_UNIVERSE.filter(s => exchangeFor(s) !== legacyExchangeFor(s)).sort()
    expect(changed).toEqual(['BRK-B', 'BT-A.L'])
    // and the two that changed landed where the venue says they live
    expect(exchangeFor('BT-A.L')).toBe('LSE')
    expect(exchangeFor('BRK-B')).toBe('US')
  })

  it('leaves the ETH-USD pair in the replay universe classified as crypto', () => {
    expect(REPLAY_UNIVERSE).toContain('ETH-USD')
    expect(exchangeFor('ETH-USD')).toBe('CRYPTO')
  })
})

describe('isCryptoSymbol — THE CONTAINMENT PREDICATE (stage 1c phase A)', () => {
  it('answers true for the three majors and every quote-currency pair the classifier knows', () => {
    for (const s of ['BTC-USD', 'ETH-USD', 'SOL-USD', 'BTC-GBP', 'SOL-USDT', 'DOGE-EUR', 'ETH-BTC']) expect([s, isCryptoSymbol(s)]).toEqual([s, true])
  })

  it('answers false for every symbol this app actually ships — no equity is ever contained by accident', () => {
    const wrongly = SHIPPED_UNIVERSE.filter(s => isCryptoSymbol(s) !== (exchangeFor(s) === 'CRYPTO')).sort()
    expect(wrongly).toEqual([])
    // …and the two shapes that made the naive predicate wrong, named
    expect(isCryptoSymbol('BT-A.L')).toBe(false) // a venue suffix outranks the dash
    expect(isCryptoSymbol('BRK-B')).toBe(false) // a share class is not a coin
    expect(isCryptoSymbol('3LAL.L')).toBe(false) // a route ETP is not a coin either
    expect(isCryptoSymbol('AAPL')).toBe(false)
  })

  it('is case-insensitive the way every key in this engine is upper-cased', () => {
    expect(isCryptoSymbol('btc-usd')).toBe(true)
    expect(isCryptoSymbol('bt-a.l')).toBe(false)
  })

  it('is the SAME function the replay harness exports — one predicate, not two', async () => {
    const { isCryptoSymbol: replayCopy } = await import('../scripts/replay-window')
    expect(replayCopy).toBe(isCryptoSymbol)
  })
})

describe('isYahooSymbol — data routing is UNCHANGED by the classification fix', () => {
  // Finnhub spells a share class with a dot (BRK.B); these symbols are written
  // Yahoo-style (BRK-B), so a dashed US name is still a Yahoo read. Routing must
  // therefore stay exactly "a dash or a dot" — byte-identical to before the fix,
  // which is what keeps marketCache.ts and market-data.mts out of the blast radius.
  const legacyRouting = (s: string) => s.includes('-') || s.includes('.')

  it('routes every shipped symbol exactly where it routed before', () => {
    for (const s of SHIPPED_UNIVERSE) expect([s, isYahooSymbol(s)]).toEqual([s, legacyRouting(s)])
  })

  it('keeps the dashed US share classes on Yahoo, where their spelling belongs', () => {
    expect(isYahooSymbol('BRK-B')).toBe(true)
    expect(isYahooSymbol('BF-B')).toBe(true)
    expect(isYahooSymbol('BT-A.L')).toBe(true)
    expect(isYahooSymbol('ETH-USD')).toBe(true)
    expect(isYahooSymbol('AAPL')).toBe(false)
  })
})

describe('the consumers that read a clock through exchangeFor', () => {
  // useAlerts.ts:36 and alert-check.mts:287 both compute isMarketOpen(exchangeFor(sym), now).
  const SATURDAY = Date.parse('2026-08-15T12:00:00Z') / 1000
  const WED_1000 = Date.parse('2026-08-12T10:00:00Z') / 1000 // inside LSE 08:00–16:30, outside US
  const WED_1800 = Date.parse('2026-08-12T18:00:00Z') / 1000 // after the LSE close, inside the US session
  const WED_0030 = Date.parse('2026-08-12T00:30:00Z') / 1000 // nobody is open

  it('the fixture days are the days they claim to be', () => {
    expect(new Date(SATURDAY * 1000).getUTCDay()).toBe(6)
    expect(new Date(WED_1000 * 1000).getUTCDay()).toBe(3)
  })

  it('BT-A.L keeps LSE hours — no Saturday alerts for a stock that does not trade on Saturday', () => {
    expect(isMarketOpen(exchangeFor('BT-A.L'), SATURDAY)).toBe(false)
    expect(isMarketOpen(exchangeFor('BT-A.L'), WED_1000)).toBe(true)
    expect(isMarketOpen(exchangeFor('BT-A.L'), WED_1800)).toBe(false)
    // the same clock its dotted sleeve-mates already got
    expect(isMarketOpen(exchangeFor('BT-A.L'), WED_1000)).toBe(isMarketOpen(exchangeFor('RR.L'), WED_1000))
  })

  it('BRK-B keeps US hours instead of trading through the weekend', () => {
    expect(isMarketOpen(exchangeFor('BRK-B'), SATURDAY)).toBe(false)
    expect(isMarketOpen(exchangeFor('BRK-B'), WED_1800)).toBe(true)
    expect(isMarketOpen(exchangeFor('BRK-B'), WED_1000)).toBe(false)
  })

  it('a real pair still trades around the clock', () => {
    expect(isMarketOpen(exchangeFor('ETH-USD'), SATURDAY)).toBe(true)
  })

  // useMarketData.ts:71 and TickerDetail.tsx:126 both compute
  // relativeVolume(vol, avg, sessionElapsedFraction(exchangeFor(sym), now)).
  it('RVOL for BT-A.L is measured against the LSE session, not a 24h crypto day', () => {
    // outside the session the last bar is a COMPLETE day → fraction 1. The crypto
    // branch returned 0.0208→clamped 0.05 at 00:30 UTC, inflating RVOL 20×.
    expect(sessionElapsedFraction(exchangeFor('BT-A.L'), WED_0030)).toBe(1)
    expect(sessionElapsedFraction(exchangeFor('BT-A.L'), WED_1000)).toBeCloseTo((10 - 7) / (15.5 - 7), 6)
    expect(sessionElapsedFraction(exchangeFor('ETH-USD'), WED_0030)).toBe(0.05) // a pair really is on a 24h clock
  })
})
