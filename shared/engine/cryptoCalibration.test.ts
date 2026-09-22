import { describe, expect, it } from 'vitest'
import {
  CRYPTO_BARS_PER_WEEK,
  CRYPTO_CALIB_DEF_VERSION,
  CRYPTO_CALIB_KEY,
  CRYPTO_GRADE_HORIZON,
  CRYPTO_HIT_MIN_PCT,
  CRYPTO_HORIZONS,
  CRYPTO_LOOKBACKS,
  CRYPTO_NOT_A_CLOCK,
  CRYPTO_UNIVERSE,
  EQUITY_BARS_PER_WEEK,
  completedCryptoBars,
  cryptoBaseHitRate,
  cryptoCandleMap,
  cryptoCandlesVia,
  cryptoGradeBaseRate,
  cryptoLookback,
  cryptoProbabilityFor,
  emptyCryptoCalibration,
  gradeCryptoPrediction,
  loadCryptoCalibration,
  updateCryptoCalibration,
  type CryptoCalibrationState,
  type LookbackScaling,
} from './cryptoCalibration'
import { CALIB_DEF_VERSION, gradeFor, gradePrediction, updateCalibration, type CalibrationState } from './calibration'
import type { Candle } from '../types'

const DAY = 86_400
const utc = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000

/** One 24/7 daily series, one bar per CALENDAR day from `startISO` — weekends
 * included, which is the whole point. `o` is deliberately settable, because a
 * real continuous tape opens where it closed and a test that claims "the base
 * is the ENTRY BAR's open" must be able to prove which field it read. */
const bars = (startISO: string, closes: number[], o?: (c: number, i: number) => number): Candle[] =>
  closes.map((c, i) => ({ t: utc(startISO) + i * DAY, o: o ? o(c, i) : c, h: c * 1.01, l: c * 0.99, c, v: 1_000 }))

/** A Saturday call. Entry is the SUNDAY bar — the first bar that OPENS after
 * the call was published — so the outcome bar is 14 bars later: 2026-08-30. */
const SAT = '2026-08-15'
const call = (over: Partial<{ side: 'long' | 'short'; stop: number; date: string }> = {}) => ({
  date: over.date ?? SAT,
  side: over.side ?? ('long' as const),
  priceAtPrediction: 100,
  stop: over.stop ?? 1, // unreachable unless a test wants it reached
})

/** 17 bars, 2026-08-14 (Fri) → 2026-08-30 (Sun): index 2 is the entry bar,
 * index 16 the outcome bar. Flat at 100 apart from the outcome. */
const maturedSeries = (outcomeClose: number, entryOpen = 100) =>
  bars('2026-08-14', [...Array(16).fill(100), outcomeClose], (c, i) => (i === 2 ? entryOpen : c))

describe('the crypto partition — its own blob, its own state', () => {
  it('has its own blob key, and it is not the equity one', () => {
    expect(CRYPTO_CALIB_KEY).toBe('crypto-calibration')
    expect(CRYPTO_CALIB_KEY).not.toBe('engine-calibration')
  })

  it('starts EMPTY and cold — no seed, no referenceBase, its own def version', () => {
    const s = emptyCryptoCalibration()
    expect(s.buckets).toEqual({})
    expect(s.setupBuckets).toEqual({})
    expect(s.brier).toEqual([])
    expect(s.seeded).toBe(false)
    expect(s.referenceBase).toBeUndefined() // no crypto sweep exists yet — the legacy pattern
    expect(s.defVersion).toBe(CRYPTO_CALIB_DEF_VERSION)
    // generation 0 = "no crypto seed artefact has ever installed here", so a
    // future generation-1 crypto seed can land exactly once (the equity rule).
    expect(s.seedGeneration).toBe(0)
  })

  it('carries the equity def version NUMBER under its own constant — one may move without the other', () => {
    expect(CRYPTO_CALIB_DEF_VERSION).toBe(3)
    // …AND THEY HAVE NOW MOVED APART, which is the whole reason there are two
    // constants. The equity hit went from 10 sessions to 21 (CALIB_DEF_VERSION v4,
    // owner ruling 2026-09-22); the crypto hit is still 14 crypto bars against no
    // benchmark, because that ruling was about the equity holding period and this
    // partition was deliberately left alone. A single shared constant would have
    // silently reseeded the crypto blob on an equity decision.
    expect(CRYPTO_CALIB_DEF_VERSION).not.toBe(CALIB_DEF_VERSION)
    expect(CALIB_DEF_VERSION).toBe(4)
  })

  it('loads: absent → cold, current definition → kept and migrated, stale definition → discarded', () => {
    expect(loadCryptoCalibration(null).buckets).toEqual({})
    expect(loadCryptoCalibration(undefined).buckets).toEqual({})

    const stored: CryptoCalibrationState = { basis: 'absolute', buckets: { 'long:green:55-70': { n: 4, hits: 3 } }, brier: [], defVersion: CRYPTO_CALIB_DEF_VERSION }
    const kept = loadCryptoCalibration(stored)
    expect(kept.buckets['long:green:55-70']).toEqual({ n: 4, hits: 3 })
    expect(kept.setupBuckets).toEqual({}) // migrateCalibration ran
    expect(kept.evidence).toBeTruthy()
    // absent seedGeneration means 0 HERE — the equity "absent means 1" is for
    // blobs that predate generations, and this namespace has none. Were the
    // migration's ??= 1 to win, a generation-1 crypto seed could never land.
    expect(kept.seedGeneration).toBe(0)

    const stale = loadCryptoCalibration({ buckets: { 'long:green:55-70': { n: 9, hits: 9 } }, brier: [], defVersion: 2 })
    expect(stale.buckets).toEqual({}) // a different hit definition is not evidence — and there is no seed to fall back to
  })

  it('REFUSES the equity blob: same defVersion, no basis brand — cold, never adopted', () => {
    // the exact state a wrong-key write would hand this loader: defVersion 3,
    // cohort-prefixed keys, the equity anchor
    const equityShaped: CalibrationState = {
      buckets: { 'large:long:green:55-70': { n: 8526, hits: 3545 } },
      brier: [],
      defVersion: CALIB_DEF_VERSION,
      referenceBase: 0.4158,
    }
    const loaded = loadCryptoCalibration(equityShaped)
    expect(loaded.buckets).toEqual({}) // not one equity row crosses
    expect(loaded.referenceBase).toBeUndefined() // 0.4158 must never appear here
    expect(loaded.basis).toBe('absolute')
  })

  it('is branded at birth, and the brand survives an update and a store round-trip', () => {
    const s = emptyCryptoCalibration()
    expect(s.basis).toBe('absolute')
    const updated = updateCryptoCalibration(s, { side: 'long', regime: 'green', composite: 60, accrual: 'sized' }, { excessPct: 3, rawPct: 3, spyPct: 0, stopped: false, hit: true })
    expect(updated.basis).toBe('absolute')
    // serialise → parse → load: what the D1 blob path will actually do
    const reloaded = loadCryptoCalibration(JSON.parse(JSON.stringify(updated)))
    expect(reloaded.buckets['long:green:55-70']).toEqual({ n: 1, hits: 1, shadowN: 0, shadowHits: 0 })
  })
})

describe('cold start — the empty crypto store reads honestly', () => {
  it('base rate is the hard 0.5 under fifty of its OWN outcomes', () => {
    expect(cryptoBaseHitRate(emptyCryptoCalibration())).toEqual({ rate: 0.5, n: 0 })
    expect(cryptoGradeBaseRate(emptyCryptoCalibration())).toBe(0.5)
  })

  it('a read on an empty store is the base rate, provisional, with no evidence under it', () => {
    expect(cryptoProbabilityFor(emptyCryptoCalibration(), 'long', 'green', 75)).toEqual({ p: 0.5, provisional: true, nEff: 0, belowEvidence: false })
  })

  it('EVERY crypto row grades C on a cold store — A is unreachable by construction', () => {
    const s = emptyCryptoCalibration()
    for (const side of ['long', 'short'] as const) {
      for (const composite of [30, 45, 60, 90]) {
        const r = cryptoProbabilityFor(s, side, 'green', composite)
        expect(gradeFor(r.p, r.nEff, cryptoGradeBaseRate(s), r.belowEvidence)).toBe('C')
      }
    }
  })

  it('belowEvidence still caps at C once the store holds one band and the call sits under it', () => {
    const s = emptyCryptoCalibration()
    const won = { excessPct: 5, rawPct: 5, spyPct: 0, stopped: false, hit: true }
    for (let i = 0; i < 40; i++) updateCryptoCalibration(s, { side: 'long', regime: 'green', composite: 80, accrual: 'sized' }, won)
    // a high-conviction band with real evidence under it
    const high = cryptoProbabilityFor(s, 'long', 'green', 80, 'sized')
    expect(high.belowEvidence).toBe(false)
    expect(gradeFor(high.p, high.nEff, cryptoGradeBaseRate(s), high.belowEvidence)).toBe('A')
    // …and a 30-composite call, handed the same number DOWNWARD, may claim nothing from it
    const low = cryptoProbabilityFor(s, 'long', 'green', 30, 'sized')
    expect(low.p).toBeCloseTo(high.p, 10)
    expect(low.belowEvidence).toBe(true)
    expect(gradeFor(low.p, low.nEff, cryptoGradeBaseRate(s), low.belowEvidence)).toBe('C')
  })

  it('the base moves off 0.5 only once the crypto cohort has fifty of its own', () => {
    const s = emptyCryptoCalibration()
    const book = (hit: boolean) => updateCryptoCalibration(s, { side: 'long', regime: 'green', composite: 60, accrual: 'sized' }, { excessPct: 0, rawPct: 0, spyPct: 0, stopped: false, hit })
    for (let i = 0; i < 49; i++) book(i < 30)
    expect(cryptoBaseHitRate(s)).toEqual({ rate: 0.5, n: 49 })
    book(true)
    expect(cryptoBaseHitRate(s).n).toBe(50)
    expect(cryptoBaseHitRate(s).rate).toBeCloseTo((31 + 2) / (50 + 4), 6)
  })
})

describe('the absolute basis — no benchmark, on either side', () => {
  it('grades a long on its own raw return: +2% over the horizon is a hit, and spyPct is a structural zero', () => {
    expect(gradeCryptoPrediction(call(), maturedSeries(102))).toEqual({ excessPct: 2, rawPct: 2, spyPct: 0, stopped: false, hit: true })
  })

  it('a +2pp long in a −5% market is STILL a hit — there is no benchmark to subtract', () => {
    const closes = [...Array(16).fill(100), 102]
    closes[12] = 102 // the equity 10-bar lens's outcome bar, same +2%
    const candles = bars('2026-08-14', closes)
    const spy = bars('2026-08-14', closes.map((_, i) => (i === 12 ? 95 : 100)))
    // the equity definition on the same tape: +2 raw − (−5) SPY = +7pp excess
    const equity = gradePrediction({ ...call(), date: '2026-08-16' }, candles, spy, 10)!
    expect(equity).toMatchObject({ rawPct: 2, spyPct: -5, excessPct: 7 })
    // the crypto definition answers +2 — and cannot even be ASKED the other
    // question: no benchmark parameter exists on it.
    expect(gradeCryptoPrediction(call(), candles)).toMatchObject({ rawPct: 2, spyPct: 0, excessPct: 2, hit: true })
    expect(gradeCryptoPrediction.length).toBeLessThan(gradePrediction.length)
  })

  it('side-adjusts: a short is a hit when the coin FALLS, and a miss when it rises', () => {
    expect(gradeCryptoPrediction(call({ side: 'short', stop: 1e9 }), maturedSeries(98))).toMatchObject({ rawPct: -2, excessPct: 2, hit: true })
    expect(gradeCryptoPrediction(call({ side: 'short', stop: 1e9 }), maturedSeries(102))).toMatchObject({ rawPct: 2, excessPct: -2, hit: false })
  })

  it('the bar is +1pp ABSOLUTE, and it is the crypto partition’s own constant', () => {
    expect(CRYPTO_HIT_MIN_PCT).toBe(1)
    expect(gradeCryptoPrediction(call(), maturedSeries(101))!.hit).toBe(true)
    expect(gradeCryptoPrediction(call(), maturedSeries(100.9))!.hit).toBe(false)
  })

  it('a stop CLOSE-through is a miss forever; a wick through it is not a stop at all', () => {
    const closes = [100, 100, 100, 94, ...Array(12).fill(100), 105]
    const stopped = gradeCryptoPrediction(call({ stop: 95 }), bars('2026-08-14', closes))!
    expect(stopped).toMatchObject({ stopped: true, rawPct: 5, hit: false }) // recoveries after a stop do not count

    const wicked = gradeCryptoPrediction(call({ stop: 95 }), maturedSeries(105).map(c => ({ ...c, l: 90 })))!
    expect(wicked).toMatchObject({ stopped: false, hit: true })
  })

  it('a close through the stop ON PUBLICATION DAY is a stop — the reader was holding from 06:00', () => {
    // D (2026-08-15, index 1) closes at 80, straight through the 90 stop; the
    // tape then recovers to 105 by the outcome bar. The return leg never sees
    // bar D; the stop leg must, or this grades a −20% close-through a hit.
    const breachD = [100, 80, ...Array(14).fill(100), 105]
    expect(gradeCryptoPrediction(call({ stop: 90 }), bars('2026-08-14', breachD))!).toMatchObject({ stopped: true, hit: false })
    // …and symmetrically for a short: D spikes through the buy-stop
    const spikeD = [100, 120, ...Array(14).fill(100), 95]
    expect(gradeCryptoPrediction(call({ side: 'short', stop: 110 }), bars('2026-08-14', spikeD))!).toMatchObject({ stopped: true, hit: false })
  })

  it('…while the publication bar still never sets the BASE, and a gap over it degrades to the entry bar', () => {
    // same shape, stop below D's close: the return bases at D+1's open (100),
    // not D's 80 — the two legs read different first bars off one tape
    const dipD = [100, 80, ...Array(14).fill(100), 105]
    expect(gradeCryptoPrediction(call({ stop: 70 }), bars('2026-08-14', dipD))!).toMatchObject({ stopped: false, rawPct: 5, hit: true })
    // a tape with no bar on D at all: the stop scan starts where the tape does
    const gapped = bars('2026-08-14', [100, ...Array(15).fill(100), 105]).filter(c => c.t !== utc('2026-08-15'))
    expect(gradeCryptoPrediction(call({ stop: 90 }), gapped)!).toMatchObject({ stopped: false, hit: true })
  })
})

describe('the crypto clock — fourteen bars, and the entry bar is the one after the call', () => {
  it('the horizon is 14 crypto bars, and the three lenses are the ×7/5 images of 5/10/21', () => {
    expect(CRYPTO_GRADE_HORIZON).toBe(14)
    expect(CRYPTO_HORIZONS).toEqual([7, 14, 29])
    expect(CRYPTO_HORIZONS).toEqual([5, 10, 21].map(cryptoLookback))
  })

  it('the base is the OPEN of the first bar that opens AFTER the call — never the publication day’s own bar', () => {
    // the entry bar (2026-08-16) opens at 50 and closes at 100: reading the
    // open is the only way to get +104% here
    expect(gradeCryptoPrediction(call(), maturedSeries(102, 50))!.rawPct).toBe(104)
    // …and the publication day's own bar (2026-08-15, index 1) is never the base
    const sameDayOpen = bars('2026-08-14', [...Array(16).fill(100), 102], (c, i) => (i === 1 ? 50 : c))
    expect(gradeCryptoPrediction(call(), sameDayOpen)!.rawPct).toBe(2)
  })

  it('a Saturday call matures fourteen bars after its entry bar — calendar days, weekends included', () => {
    const full = maturedSeries(102)
    expect(full[full.length - 1].t).toBe(utc('2026-08-30')) // 14 bars past the 08-16 entry
    expect(gradeCryptoPrediction(call(), full)).not.toBeNull()
    expect(gradeCryptoPrediction(call(), full.slice(0, -1))).toBeNull() // one bar short: no grade, not a partial one
    // and every one of those bars is a calendar day — the entry-to-outcome
    // window (08-16 … 08-30, 15 bars) holds three Sundays and two Saturdays,
    // and no session calendar is consulted anywhere in the grade
    expect(full.slice(2).filter(c => [0, 6].includes(new Date(c.t * 1000).getUTCDay())).length).toBe(5)
  })

  it('refuses a call it cannot place: no bar after the call date at all', () => {
    expect(gradeCryptoPrediction(call({ date: '2027-01-01' }), maturedSeries(102))).toBeNull()
  })

  it('grades the shorter and longer lenses off the same entry bar', () => {
    const closes = [...Array(16).fill(100), 102]
    closes[2 + 7] = 110 // the 7-bar lens's outcome bar
    const series = bars('2026-08-14', closes)
    expect(gradeCryptoPrediction(call(), series, 7)!.rawPct).toBe(10)
    expect(gradeCryptoPrediction(call(), series, 14)!.rawPct).toBe(2)
    expect(gradeCryptoPrediction(call(), series, 29)).toBeNull() // 29 bars have not passed
  })
})

describe('the candle seam — completed bars only, whatever the hour', () => {
  const series = bars('2026-08-10', [1, 2, 3, 4, 5]) // 08-10 … 08-14

  it('drops today’s in-progress UTC bar at 06:00 and STILL drops it at 23:59', () => {
    const at0600 = completedCryptoBars(series, utc('2026-08-14') + 6 * 3600)
    const at2359 = completedCryptoBars(series, utc('2026-08-14') + 23 * 3600 + 59 * 60)
    expect(at0600.map(c => c.t)).toEqual(at2359.map(c => c.t))
    expect(at0600.length).toBe(4)
    expect(at0600[at0600.length - 1].t).toBe(utc('2026-08-13'))
  })

  it('is idempotent, and drops nothing from a series that already ends yesterday', () => {
    const now = utc('2026-08-14') + 6 * 3600
    const once = completedCryptoBars(series, now)
    expect(completedCryptoBars(once, now)).toEqual(once)
    expect(completedCryptoBars(series.slice(0, -1), now).length).toBe(4)
  })

  it('throws on a millisecond clock rather than failing soft to an empty tape', () => {
    expect(() => completedCryptoBars(series, (utc('2026-08-14') + 6 * 3600) * 1000)).toThrow(/milliseconds/)
  })

  it('the wrapper cuts on the way out — and REFUSES a non-crypto symbol rather than re-cutting it', async () => {
    const fetched: string[] = []
    const now = utc('2026-08-14') + 6 * 3600
    const cryptoCandles = cryptoCandlesVia(async sym => {
      fetched.push(sym)
      return series
    }, now)
    expect((await cryptoCandles('BTC-USD'))!.length).toBe(4)
    expect(await cryptoCandles('SPY')).toBeNull() // an equity bar that closed today is COMPLETE — the crypto cut would delete it
    expect(fetched).toEqual(['BTC-USD']) // and it never even asks
    expect(await cryptoCandlesVia(async () => null, now)('ETH-USD')).toBeNull() // fail-soft
  })

  it('fetches exactly the three pairs through the existing candle path', async () => {
    expect(CRYPTO_UNIVERSE).toEqual(['BTC-USD', 'ETH-USD', 'SOL-USD'])
    const asked: string[] = []
    const map = await cryptoCandleMap(async sym => {
      asked.push(sym)
      return sym === 'SOL-USD' ? null : series
    }, utc('2026-08-14') + 6 * 3600)
    expect([...asked].sort()).toEqual([...CRYPTO_UNIVERSE].sort())
    expect(map.get('BTC-USD')!.length).toBe(4)
    expect(map.get('SOL-USD')).toBeNull() // one dead pair must not cost the others
  })

  it('a grade taken through the seam can never read the partial bar', () => {
    const live = maturedSeries(102)
    // the outcome bar (2026-08-30) is TODAY and therefore in progress
    expect(gradeCryptoPrediction(call(), completedCryptoBars(live, utc('2026-08-30') + 6 * 3600))).toBeNull()
    // …and it grades the next day, off the completed bar
    expect(gradeCryptoPrediction(call(), completedCryptoBars(live, utc('2026-08-31') + 6 * 3600))!.rawPct).toBe(2)
  })
})

describe('a crypto grade never touches equity state', () => {
  const equityRow = { side: 'long' as const, regime: 'green', composite: 60, capUsdM: 50_000, accrual: 'sized' as const }
  const cryptoRow = { side: 'long' as const, regime: 'green', composite: 60, accrual: 'sized' as const }
  const outcome = { excessPct: 3, rawPct: 3, spyPct: 0, stopped: false, hit: true }

  it('drives both paths and byte-compares the other blob each time', () => {
    const equity: CalibrationState = { buckets: { 'long:green:55-70': { n: 10, hits: 4 } }, setupBuckets: {}, brier: [], defVersion: CALIB_DEF_VERSION, referenceBase: 0.4158 }
    const crypto = emptyCryptoCalibration()

    const equityBefore = JSON.stringify(equity)
    updateCryptoCalibration(crypto, cryptoRow, outcome)
    expect(JSON.stringify(equity)).toBe(equityBefore) // not one byte

    const cryptoAfterCrypto = JSON.stringify(crypto)
    updateCalibration(equity, equityRow, outcome)
    expect(JSON.stringify(crypto)).toBe(cryptoAfterCrypto) // and not one byte back

    expect(JSON.stringify(equity)).not.toBe(equityBefore) // both paths really did run
    expect(crypto.buckets['long:green:55-70']).toEqual({ n: 1, hits: 1, shadowN: 0, shadowHits: 0 })
    expect(equity.buckets['large:long:green:55-70']).toBeTruthy()
    expect(equity.referenceBase).toBe(0.4158) // the equity anchor is untouched by anything crypto
  })

  it('books cohortless keys inside its own blob — a cap on the row can never mint a cap-cohort key there', () => {
    const crypto = emptyCryptoCalibration()
    updateCryptoCalibration(crypto, { ...cryptoRow, capUsdM: 50_000 }, outcome)
    expect(Object.keys(crypto.buckets)).toEqual(['long:green:55-70'])
  })

  it('accrues setup families inside the crypto blob only', () => {
    const crypto = emptyCryptoCalibration()
    updateCryptoCalibration(crypto, { ...cryptoRow, setup: 'continuation' }, outcome)
    expect(crypto.setupBuckets!['continuation:long:55-70']).toEqual({ n: 1, hits: 1, shadowN: 0, shadowHits: 0 })
  })

  it('the equity ladder cannot see crypto evidence — the partition is the STATE, not a filter', () => {
    const crypto = emptyCryptoCalibration()
    for (let i = 0; i < 60; i++) updateCryptoCalibration(crypto, cryptoRow, outcome)
    const equity: CalibrationState = { buckets: {}, setupBuckets: {}, brier: [] }
    expect(cryptoBaseHitRate(crypto).n).toBe(60)
    // …and the equity state cannot even be ASKED: the basis brand makes the
    // wrong-state call a compile error, not a runtime discovery
    // @ts-expect-error — CalibrationState lacks the crypto basis brand
    expect(cryptoBaseHitRate(equity).n).toBe(0)
  })
})

describe('the indicator scaling table', () => {
  const rows: [string, LookbackScaling][] = Object.entries(CRYPTO_LOOKBACKS)

  it('the ratio is seven crypto bars per five equity sessions', () => {
    expect(CRYPTO_BARS_PER_WEEK / EQUITY_BARS_PER_WEEK).toBe(1.4)
    expect([8, 21, 50, 14, 20, 60, 5, 10, 15, 25, 30, 63, 200].map(cryptoLookback)).toEqual([11, 29, 70, 20, 28, 84, 7, 14, 21, 35, 42, 88, 280])
  })

  it('every SCALED row is exactly its equity window times the ratio', () => {
    for (const [name, row] of rows) {
      if (row.rule !== 'scaled') continue
      expect([name, row.crypto]).toEqual([name, cryptoLookback(row.equity)])
    }
  })

  it('names the windows the plan named', () => {
    expect(CRYPTO_LOOKBACKS.ema8.crypto).toBe(11)
    expect(CRYPTO_LOOKBACKS.ema21.crypto).toBe(29)
    expect(CRYPTO_LOOKBACKS.ema50.crypto).toBe(70)
    expect(CRYPTO_LOOKBACKS.atr14.crypto).toBe(20)
    expect(CRYPTO_LOOKBACKS.rvolBaseline20.crypto).toBe(28)
    expect(CRYPTO_LOOKBACKS.momentumRet21.crypto).toBe(29)
  })

  it('every EXCEPTION says why, and no exception is silently the ratio', () => {
    const exceptions = rows.filter(([, r]) => r.rule !== 'scaled')
    expect(exceptions.length).toBeGreaterThan(0)
    for (const [name, row] of exceptions) {
      expect([name, (row.why ?? '').length > 40]).toEqual([name, true])
      if (row.rule === 'fixed') expect([name, row.crypto]).toEqual([name, row.equity])
      if (row.rule === 'calendar') expect([name, row.crypto]).not.toEqual([name, cryptoLookback(row.equity)])
    }
  })

  it('RSI keeps its 14 — the period is the constant its fixed thresholds were calibrated against', () => {
    expect(CRYPTO_LOOKBACKS.rsi14).toMatchObject({ equity: 14, crypto: 14, rule: 'fixed' })
    expect(cryptoLookback(14)).toBe(20) // the ratio WOULD say 20, and that is the trap
  })

  it('an implicit calendar YEAR is re-expressed in the calendar, not multiplied', () => {
    expect(CRYPTO_LOOKBACKS.swingCapacityLookback250).toMatchObject({ equity: 250, crypto: 365, rule: 'calendar' })
    expect(cryptoLookback(250)).toBe(350) // 50 weeks — the ratio quietly loses the exchange holidays
    expect(CRYPTO_LOOKBACKS.seasonalityYear252).toMatchObject({ equity: 252, crypto: 365, rule: 'calendar' })
  })

  it('the capacity WINDOW is the grading horizon, not a scaled lookback', () => {
    expect(CRYPTO_LOOKBACKS.swingCapacityWindow10).toMatchObject({ equity: 10, crypto: CRYPTO_GRADE_HORIZON, rule: 'horizon' })
  })

  it('every window is a positive whole number of bars, and no ratio, count or percentage is in the table at all', () => {
    for (const [name, row] of rows) expect([name, Number.isInteger(row.crypto) && row.crypto > 0]).toEqual([name, true])
    expect(CRYPTO_NOT_A_CLOCK.length).toBeGreaterThan(4)
    for (const c of CRYPTO_NOT_A_CLOCK) {
      expect([c.name, Object.keys(CRYPTO_LOOKBACKS).includes(c.name)]).toEqual([c.name, false])
      expect([c.name, c.why.length > 40]).toEqual([c.name, true])
    }
  })
})
