import { afterEach, describe, expect, it } from 'vitest'
import type { Candle } from '../types'
import { swingCapacity } from '../indicators'
import { technicalStage, EQUITY_TECH_WINDOWS } from '../technicals'
import { momentumFactor } from './factors'
import { EQUITY_SETUP_WINDOWS } from '../setups'
import { CRYPTO_GRADE_HORIZON, CRYPTO_LOOKBACKS, CRYPTO_UNIVERSE } from './cryptoCalibration'
import { CONTEXT_MAX_PTS, DEFAULT_WEIGHTS } from './composite'
import type { FactorName } from './types'
import {
  CRYPTO_CAPACITY_LOOKBACK,
  CRYPTO_CAPACITY_WINDOW,
  CRYPTO_CHART_ONLY_DIRECTIVE,
  CRYPTO_COLD_START_N,
  CRYPTO_NEWS_ALIASES,
  CRYPTO_NEWS_WEIGHT_MULT,
  CRYPTO_WEIGHTS,
  CRYPTO_INDEX_MIN_BARS,
  CRYPTO_INDEX_WINDOWS,
  CRYPTO_MOMENTUM_SATURATION,
  CRYPTO_MOMENTUM_WINDOW,
  CRYPTO_RISK_KEY,
  CRYPTO_SETUP_WINDOWS,
  CRYPTO_SIZE_CAP,
  CRYPTO_TECH_WINDOWS,
  cryptoCapacity,
  cryptoCombinedFor,
  cryptoDisabled,
  cryptoLaneOwns,
  cryptoMomentumFactor,
  cryptoRegimeFrom,
  cryptoSizeCap,
  cryptoTitleMatches,
  cryptoUniverseFor,
  cryptoVoice,
  initCryptoRisk,
  loadCryptoRisk,
} from './cryptoLane'
import { COHORT_STANDALONE_N, computeCohortRung, type CohortRung, type OutcomeLite } from './riskLadder'

// THE CRYPTO LANE'S PURE HALF (Stage 1c Phase B, Task B2) — the clock profiles,
// the BTC regime, the absolute momentum factor, the cap and its earn-out, the
// rung blob, the voice and the CRYPTO=off lever. Everything the engine wires in
// is decided here, so everything the engine wires in can be pinned here.

const T0 = Date.parse('2024-01-01') / 1000
const tape = (fn: (i: number) => number, n = 400, vol: (i: number) => number = () => 1_000_000): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const c = fn(i)
    return { t: T0 + i * 86_400, o: c, h: c * 1.03, l: c * 0.97, c, v: vol(i) }
  })

// ------------------------------------------------------------- the lever ----

describe('CRYPTO=off — the house lever, and the lane is the only thing it touches', () => {
  afterEach(() => {
    delete process.env.CRYPTO
  })

  it('is off only for the exact string, and defaults to on', () => {
    expect(cryptoDisabled()).toBe(false)
    process.env.CRYPTO = 'off'
    expect(cryptoDisabled()).toBe(true)
    process.env.CRYPTO = 'on'
    expect(cryptoDisabled()).toBe(false)
    process.env.CRYPTO = 'OFF'
    expect(cryptoDisabled()).toBe(false) // the house pattern is exact-match, like REGRET/GATES/WILDCARD
  })

  it('is read per call, so a run that sets it late is still off', () => {
    expect(cryptoDisabled()).toBe(false)
    process.env.CRYPTO = 'off'
    expect(cryptoDisabled()).toBe(true)
  })

  it('takes the lane’s ownership of a name with it — the containment guard is the off state', () => {
    expect(cryptoLaneOwns('BTC-USD', ['BTC-USD'])).toBe(true)
    process.env.CRYPTO = 'off'
    expect(cryptoLaneOwns('BTC-USD', ['BTC-USD'])).toBe(false)
  })
})

// ---------------------------------------------------------- the profiles ----

describe('the clock profiles are READ off B1’s table, never multiplied here', () => {
  it('every scaled window is the table’s own crypto number', () => {
    expect(CRYPTO_TECH_WINDOWS).toMatchObject({
      sma20: 28, sma50: 70, atr: 20, range: 84, rvolBaseline: 28,
      ema8: 11, ema21: 29, ema50: 70, thrustRecent: 7, thrustBase: 28, minHistory: 42,
    })
    expect(CRYPTO_SETUP_WINDOWS).toMatchObject({
      sma20: 28, sma50: 70, sma200: 280, atr: 20,
      baseSessions: 14, basePrior: 42, knifeWindow: 28, pullbackHigh: 28, breakoutWatch: 21,
      rvolBaseline: 28, minHistory: 35,
    })
    expect(CRYPTO_INDEX_WINDOWS).toEqual({ sma20: 28, sma50: 70, slopeLag: 7 })
    for (const [key, row] of Object.entries(CRYPTO_LOOKBACKS)) {
      if (row.rule !== 'scaled') continue
      expect([key, row.crypto]).toEqual([key, Math.round((row.equity * 7) / 5)])
    }
  })

  it('does NOT scale the RSI period — the one exception, in both profiles', () => {
    expect(CRYPTO_TECH_WINDOWS.rsi).toBe(EQUITY_TECH_WINDOWS.rsi)
    expect(CRYPTO_SETUP_WINDOWS.rsi).toBe(EQUITY_SETUP_WINDOWS.rsi)
    expect(CRYPTO_LOOKBACKS.rsi14.rule).toBe('fixed')
  })

  it('derives the two windows the table does not name, and says how', () => {
    // isBasing's minimum history IS its two windows added — the equity 40 is 30 + 10
    expect(EQUITY_SETUP_WINDOWS.basingMinHistory).toBe(EQUITY_SETUP_WINDOWS.basePrior + EQUITY_SETUP_WINDOWS.baseSessions)
    expect(CRYPTO_SETUP_WINDOWS.basingMinHistory).toBe(CRYPTO_SETUP_WINDOWS.basePrior + CRYPTO_SETUP_WINDOWS.baseSessions)
    expect(CRYPTO_SETUP_WINDOWS.divergenceLookback).toBe(56) // 40 × 7/5
  })

  it('capacity is the HOLDING PERIOD over a CALENDAR year — not the bar ratio', () => {
    expect(CRYPTO_CAPACITY_WINDOW).toBe(CRYPTO_GRADE_HORIZON)
    expect(CRYPTO_CAPACITY_LOOKBACK).toBe(365)
    const t = tape(i => 100 + Math.sin(i / 9) * 12 + i * 0.05)
    expect(cryptoCapacity(t.map(c => c.c))).toBe(swingCapacity(t.map(c => c.c), 14, 365))
  })

  it('reads a crypto tape differently from the equity profile — the threading is real', () => {
    const t = tape(i => 100 + Math.sin(i / 11) * 20 + i * 0.08)
    const equityRead = technicalStage('BTC-USD', t)!
    const cryptoRead = technicalStage('BTC-USD', t, CRYPTO_TECH_WINDOWS)!
    expect(cryptoRead.pctFrom20d).not.toBe(equityRead.pctFrom20d)
    expect(cryptoRead.emaStack.e50).not.toBe(equityRead.emaStack.e50)
    expect(cryptoRead.rsi).toBe(equityRead.rsi) // the fixed exception, end to end
  })
})

// ------------------------------------------------------------ the regime ----

describe('the BTC regime — one tape, the existing machinery, never relabelled', () => {
  it('reads a rising BTC as green and a rolled-over one as red', () => {
    expect(cryptoRegimeFrom(tape(i => 100 + i * 0.5, 200))).toBe('green')
    expect(cryptoRegimeFrom(tape(i => (i < 120 ? 100 + i * 0.5 : 160 - (i - 120) * 0.8), 200))).toBe('red')
  })

  it('is UNKNOWN on a tape too short to answer — an unknown never passes a gate', () => {
    expect(cryptoRegimeFrom(null)).toBe('unknown')
    expect(cryptoRegimeFrom([])).toBe('unknown')
    expect(cryptoRegimeFrom(tape(i => 100 + i, CRYPTO_INDEX_MIN_BARS - 1))).toBe('unknown')
    expect(cryptoRegimeFrom(tape(i => 100 + i, CRYPTO_INDEX_MIN_BARS))).not.toBe('unknown')
  })

  it('needs the 50-SMA and the slope it is read against — the floor is derived, not guessed', () => {
    expect(CRYPTO_INDEX_MIN_BARS).toBe(CRYPTO_INDEX_WINDOWS.sma50 + CRYPTO_INDEX_WINDOWS.slopeLag + 1)
    expect(CRYPTO_INDEX_MIN_BARS).toBe(78)
  })

  it('answers only in the three labels the calibration key already uses', () => {
    for (const t of [tape(i => 100 + i * 0.5, 200), tape(() => 100, 200), tape(i => 300 - i, 200)]) {
      expect(['green', 'amber', 'red']).toContain(cryptoRegimeFrom(t))
    }
  })
})

// ---------------------------------------------------------- the momentum ----

describe('crypto momentum — absolute, 29 bars, denominated in the pair’s own travel', () => {
  it('is the ×7/5 image of the equity month', () => {
    expect(CRYPTO_MOMENTUM_WINDOW).toBe(29)
    expect(CRYPTO_MOMENTUM_WINDOW).toBe(CRYPTO_LOOKBACKS.momentumRet21.crypto)
  })

  it('scores a real number for a coin — the contract leg is REACHABLE (recon §2.4’s trap)', () => {
    const rising = tape(i => 100 * 1.004 ** i, 200).map(c => c.c)
    const f = cryptoMomentumFactor(rising)
    expect(f.score).not.toBeNull()
    expect(f.score!).toBeGreaterThan(0)
    expect(f.detail).toContain('29-bar move')
    expect(f.detail).not.toContain('SPY')
  })

  it('takes NO benchmark argument at all — there is nothing to subtract', () => {
    // one REQUIRED argument (the pair's own closes) against the equity factor's
    // two: the second one over there is `spyCloses`, and the crypto partition
    // grades absolute, so a benchmark leg here would argue about a different
    // question from the one the outcome will be measured on.
    expect(cryptoMomentumFactor.length).toBe(1)
    expect(momentumFactor.length).toBe(2)
  })

  it('signs with the move, both ways', () => {
    const up = cryptoMomentumFactor(tape(i => 100 * 1.004 ** i, 200).map(c => c.c)).score!
    const down = cryptoMomentumFactor(tape(i => 100 * 0.996 ** i, 200).map(c => c.c)).score!
    expect(up).toBeGreaterThan(0)
    expect(down).toBeLessThan(0)
  })

  it('is the move in units of the pair’s own typical travel, saturating at twice it', () => {
    const closes = tape(i => 100 + Math.sin(i / 13) * 9 + i * 0.06, 400).map(c => c.c)
    const from = closes[closes.length - 1 - CRYPTO_MOMENTUM_WINDOW]
    const ret = ((closes[closes.length - 1] - from) / from) * 100
    const typical = swingCapacity(closes, CRYPTO_MOMENTUM_WINDOW, CRYPTO_CAPACITY_LOOKBACK)!
    const expected = Math.round(((ret / typical / CRYPTO_MOMENTUM_SATURATION) * 80) * 10) / 10
    expect(cryptoMomentumFactor(closes).score).toBe(expected)
    expect(CRYPTO_MOMENTUM_SATURATION).toBe(2)
  })

  it('scores the SAME +30% month differently on a calm tape and a violent one — not on a fixed percentage', () => {
    // Identical final ramp, two histories. The calm pair has never travelled
    // like this, so +30% pins it; for the violent pair +30% is an ordinary
    // month and scores as one. This is the whole reason the denominator is the
    // pair's own travel rather than a constant chosen for equities.
    const ramp = (i: number, n: number) => (i >= n - CRYPTO_MOMENTUM_WINDOW ? 1 + (0.3 * (i - (n - 1 - CRYPTO_MOMENTUM_WINDOW))) / CRYPTO_MOMENTUM_WINDOW : 1)
    const calm = tape(i => (100 + Math.sin(i / 7) * 1) * ramp(i, 400), 400).map(c => c.c)
    const violent = tape(i => (100 + Math.sin(i / 5) * 40) * ramp(i, 400), 400).map(c => c.c)
    expect(cryptoMomentumFactor(calm).score).toBe(80)
    expect(cryptoMomentumFactor(violent).score!).toBeLessThan(cryptoMomentumFactor(calm).score!)
  })

  it('is null when the tape cannot say what a typical move is — no score off an unmeasurable scale', () => {
    expect(cryptoMomentumFactor(null).score).toBeNull()
    expect(cryptoMomentumFactor(tape(i => 100 + i, 20).map(c => c.c)).score).toBeNull()
    expect(cryptoMomentumFactor(tape(() => 100, 200).map(c => c.c)).score).toBeNull() // a flat tape travels nowhere
  })
})

// ------------------------------------------------- the cap and the earn-out --

describe('the half-size cap, and the record that releases it', () => {
  it('is a hard half until the crypto rung’s own record clears the promote bar', () => {
    expect(CRYPTO_SIZE_CAP).toBe(0.5)
    expect(cryptoSizeCap(0)).toBe(0.5)
    expect(cryptoSizeCap(1)).toBe(1)
    expect(cryptoSizeCap(3)).toBe(1)
  })

  it('puts the cap BACK when a cold cohort steps down to rung 0', () => {
    expect(cryptoSizeCap(2)).toBe(1)
    expect(cryptoSizeCap(0)).toBe(0.5)
  })

  it('mirrors ITSELF while thin — never the equity book’s earned rung', () => {
    const cold = initCryptoRisk('2026-08-14')
    const equityBook: CohortRung = { rung: 3, sinceDate: '2026-01-01', gradedAtRung: 400, history: [] }
    const thin: OutcomeLite[] = Array.from({ length: 5 }, () => ({ hit: true, stopped: false, leveraged: false }))
    const next = computeCohortRung(cold, thin, 5, cryptoCombinedFor(cold), true, null, '2026-08-14')
    expect(next.rung).toBe(0) // …and NOT the 3 the equity book earned
    expect(computeCohortRung(cold, thin, 5, equityBook, true, null, '2026-08-14').rung).toBe(3) // the contamination, shown
    expect(cryptoSizeCap(next.rung)).toBe(0.5)
  })

  it('stands on its own stream once it has twenty of its own, and can then earn the full rung', () => {
    const cold = initCryptoRisk('2026-08-14')
    const won: OutcomeLite[] = Array.from({ length: COHORT_STANDALONE_N + 5 }, () => ({ hit: true, stopped: false, leveraged: false }))
    const primed: CohortRung = { ...cold, gradedAtRung: 25 }
    const next = computeCohortRung(primed, won, 25, cryptoCombinedFor(primed), true, null, '2026-08-14')
    expect(next.rung).toBe(1)
    expect(cryptoSizeCap(next.rung)).toBe(1)
    expect(next.history[0].evidence).toContain('earned')
  })
})

// ----------------------------------------------------------- the rung blob --

describe('the crypto rung blob — a sibling of risk-state, never a field inside it', () => {
  it('has its own key', () => {
    expect(CRYPTO_RISK_KEY).toBe('crypto-risk')
    expect(CRYPTO_RISK_KEY).not.toBe('risk-state')
  })

  it('starts cold and carries no cohorts map of its own', () => {
    const r = initCryptoRisk('2026-08-14')
    expect(r).toEqual({ rung: 0, sinceDate: '2026-08-14', gradedAtRung: 0, history: [] })
    expect('cohorts' in r).toBe(false)
  })

  it('reads a malformed blob as COLD — permission to size is never recovered from a broken record', () => {
    for (const bad of [null, undefined, {}, { rung: 9 }, { rung: -1 }, { rung: 'two' }] as unknown as (CohortRung | null)[]) {
      expect(loadCryptoRisk(bad, '2026-08-14').rung).toBe(0)
    }
    const good: CohortRung = { rung: 2, sinceDate: '2026-05-01', gradedAtRung: 31, history: [] }
    expect(loadCryptoRisk(good, '2026-08-14')).toEqual(good)
  })
})

// ------------------------------------------------------------ the universe --

describe('the universe is the reader’s watchlist, narrowed to the three pairs', () => {
  it('is opt-in: no crypto on the watchlist, no crypto lane', () => {
    expect(cryptoUniverseFor([])).toEqual([])
    expect(cryptoUniverseFor(['NVDA', 'AAPL'])).toEqual([])
  })

  it('admits only the three, in the partition’s own order', () => {
    expect(cryptoUniverseFor(['sol-usd', 'BTC-USD'])).toEqual(['BTC-USD', 'SOL-USD'])
    expect(cryptoUniverseFor(['DOGE-EUR', 'ETH-BTC', 'ETH-USD'])).toEqual(['ETH-USD'])
  })

  it('owns only what it will actually evaluate', () => {
    const u = cryptoUniverseFor(['BTC-USD'])
    expect(cryptoLaneOwns('BTC-USD', u)).toBe(true)
    expect(cryptoLaneOwns('btc-usd', u)).toBe(true)
    expect(cryptoLaneOwns('ETH-USD', u)).toBe(false)
    expect(cryptoLaneOwns('DOGE-EUR', u)).toBe(false)
  })
})

// ------------------------------------------------- the chart-only policy ----

describe('the chart-only factor policy — the owner’s sentence, encoded (Stage 1c-R)', () => {
  it('prices a coin off a FROZEN vector: the chart cores at their defaults, news at half, the rest untouched', () => {
    expect(CRYPTO_NEWS_WEIGHT_MULT).toBe(0.5)
    expect(CRYPTO_WEIGHTS.news).toBe(DEFAULT_WEIGHTS.news * CRYPTO_NEWS_WEIGHT_MULT)
    // every other factor keeps its default. Their scores are null on a crypto
    // row and renormalise away — the vector's only job is the RELATIVE weight of
    // the three factors that can score at all.
    for (const n of Object.keys(DEFAULT_WEIGHTS) as FactorName[]) {
      if (n !== 'news') expect(CRYPTO_WEIGHTS[n]).toBe(DEFAULT_WEIGHTS[n])
    }
    // frozen: the equity IC loop nudges `weights.current`, and nothing may nudge this
    expect(Object.isFrozen(CRYPTO_WEIGHTS)).toBe(true)
  })

  it('bounds what “a little” can do — the halved weight over the core’s, inside the context cap', () => {
    // composite.ts: ctxPts = ctxNum / coreDen, capped at gates.contextMaxPts. On
    // a crypto row technical+momentum ARE the whole core denominator and news is
    // the whole context numerator, so the tightest of the two bounds is this one.
    const bound = (50 * CRYPTO_WEIGHTS.news) / (CRYPTO_WEIGHTS.technical + CRYPTO_WEIGHTS.momentum)
    expect(bound).toBeCloseTo(6.58, 2)
    expect(bound).toBeLessThan(CONTEXT_MAX_PTS)
  })

  it('carries the directive itself at every site it nulls — dated, so a null cannot read as missing wiring', () => {
    expect(CRYPTO_CHART_ONLY_DIRECTIVE).toContain('owner directive 2026-08-14')
    expect(CRYPTO_CHART_ONLY_DIRECTIVE).toContain('chart parameters and a little major news')
  })
})

// ----------------------------------------------------------- the aliases ----

describe('the name alias — what makes the crypto news factor real at all', () => {
  /** engine.ts's `titleMatches`, verbatim over `baseSym('BTC-USD')` — the rule
   * the equity book uses, quoted here so "the alias reaches what the equity
   * matcher misses" is a measured claim rather than an assertion about it. */
  const equityMatcher = (sym: string) => new RegExp(`\\b${sym.split('-')[0]}\\b`, 'i')

  it('reaches the headline the base-ticker matcher misses — the near-dead factor’s whole cause', () => {
    const titles = ['Bitcoin surges past $100,000 as ETF inflows accelerate']
    expect(cryptoTitleMatches('BTC-USD', titles)).toEqual(titles)
    expect(titles.filter(t => equityMatcher('BTC-USD').test(t))).toEqual([])
  })

  it('keeps the base ticker, reads any case, and stays exactly as word-bounded as it was', () => {
    expect(cryptoTitleMatches('BTC-USD', ['BTC breaks out', 'btc drifts'])).toHaveLength(2)
    expect(cryptoTitleMatches('ETH-USD', ['Ethereum upgrade ships', 'Ether ETF approved', 'ETH gas fees fall'])).toHaveLength(3)
    expect(cryptoTitleMatches('SOL-USD', ['Solana outage resolved', 'SOL rallies'])).toHaveLength(2)
    // `sol`/`eth` are short, which is why the boundary matters most here
    expect(cryptoTitleMatches('SOL-USD', ['Retailer SOLD out', 'Solvay lifts guidance'])).toEqual([])
    expect(cryptoTitleMatches('ETH-USD', ['Bethesda ships a patch', 'Ethanol prices slide'])).toEqual([])
  })

  it('is exhaustive over the universe — a fourth pair cannot be added without an alias', () => {
    expect(Object.keys(CRYPTO_NEWS_ALIASES).sort()).toEqual([...CRYPTO_UNIVERSE].sort())
    for (const sym of CRYPTO_UNIVERSE) expect(CRYPTO_NEWS_ALIASES[sym].length).toBeGreaterThan(0)
  })

  it('a pair with no alias reads a quiet tape rather than guessing at one', () => {
    expect(cryptoTitleMatches('DOGE-USD', ['Dogecoin moons', 'DOGE rallies'])).toEqual([])
  })
})

// --------------------------------------------------------------- the voice --

describe('the voice — cohort-labelled, and the cold start explained rather than left to look like a verdict', () => {
  it('quotes the cliff the code actually uses, and names the count so far', () => {
    expect(CRYPTO_COLD_START_N).toBe(50)
    const v = cryptoVoice({ sym: 'BTC-USD', gradedN: 7, routed: false, sizeCap: 0.5 })
    expect(v.note).toContain('crypto cohort')
    expect(v.note).toContain('7 of the ~50 outcomes it needs')
    expect(v.note).toContain('designed floor, not a verdict')
  })

  it('the route sentence has THREE states — unmapped, mapped-but-capped, and earning the label off', () => {
    // no tracker: the plain sentence
    expect(cryptoVoice({ sym: 'BTC-USD', gradedN: 7, routed: false, sizeCap: 0.5 }).note).toContain('paper only — no BTC-USD tracker configured yet')
    // tracker configured, cap still 0.5: STILL paper only — an instrument only
    // mints on a full-size row, so a configured route is a promise, not a route
    // this row carries, and dropping the label here published a placeable-
    // looking row with no instrument on it
    const capped = cryptoVoice({ sym: 'BTC-USD', gradedN: 7, routed: true, sizeCap: 0.5 }).note
    expect(capped).toContain('paper only — BTC-USD tracker configured; it routes when the cohort\'s record earns the full rung')
    // only the earned full rung drops the sentence
    expect(cryptoVoice({ sym: 'BTC-USD', gradedN: 64, routed: true, sizeCap: 1 }).note).not.toContain('paper only')
  })

  it('drops the cold-start explanation once the cohort has its own record', () => {
    const warm = cryptoVoice({ sym: 'ETH-USD', gradedN: 64, routed: true, sizeCap: 1 })
    expect(warm.note).toContain('64 graded outcomes of its own')
    expect(warm.note).not.toContain('designed floor')
    expect(warm.note).not.toContain('capped at')
  })
})
