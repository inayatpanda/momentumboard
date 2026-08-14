import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildBoard, gradeOutstanding, type EngineDeps } from './engine'
import { memoryStore } from './store'
import type { Candle } from '../../../shared/types'
import { CALIB_DEF_VERSION, type CalibrationState, type WeightsState } from '../../../shared/engine/calibration'
import { WILDCARD_CATALYST_KIND } from '../../../shared/engine/catalyst'
import { WILDCARD_SIZE_CAP } from '../../../shared/engine/wildcardLane'
import { WILDCARD_LABEL, WILDCARD_WARNING } from '../../../shared/engine/voice'
import { MISS_LEDGER_KEY, type MissLedger } from '../../../shared/engine/missLedger'
import { funnelTraceKey, type FunnelTrace } from '../../../shared/engine/funnelTrace'
import { RUNG_RISK_PCT, type RiskState } from '../../../shared/engine/riskLadder'
import type { Prediction } from '../../../shared/engine/types'

// THE EXPERIMENT SLOT, IN THE ENGINE (Stage 3d Task 2).
//
// wildcardLane.ts chooses; this file is about everything that happens to what it
// chose. The choice is pure and pinned there — what has to be pinned HERE is that
// the row it hands back is published as a real, sized, stopped call the reader
// carries at a quarter of the rung; that it is invisible to every mechanism it
// must not teach (the 3-a-side cut, the risk ladder's rungs, factor IC); that it
// is post-mortemed whichever way it goes; and that ten sessions later its outcome
// reaches the miss ledger as CAUSAL evidence against the gate it overrode.
//
// And, underneath all of it, the one guarantee the rest of the engine depends on:
// on a day the slot goes unspent — which is most days, by design — nothing about
// the run is different from the day before this lane existed.

/** THE REGRESSED-LANE SEAM (fix wave, F-3).
 *
 * `selectWildcard` is pure and the engine trusts what it hands back, so every
 * BELT the publish path holds against a bad candidate — the earnings shadow in
 * particular — is unreachable for as long as the lane itself is correct. That is
 * the definition of a defensive branch, and a defensive branch nothing can reach
 * is a defensive branch nothing has ever tested.
 *
 * This wrapper lets one test hand the engine a candidate the real lane would
 * never choose. With `fn` null — every other test in this file — it is the real
 * function called with the real arguments, byte for byte. */
const wildcardOverride = vi.hoisted(() => ({ fn: null as null | ((inputs: unknown, real: (i: unknown) => unknown) => unknown) }))
vi.mock('../../../shared/engine/wildcardLane', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../shared/engine/wildcardLane')>()
  return {
    ...actual,
    selectWildcard: (inputs: Parameters<typeof actual.selectWildcard>[0]) =>
      wildcardOverride.fn ? wildcardOverride.fn(inputs, i => actual.selectWildcard(i as typeof inputs)) : actual.selectWildcard(inputs),
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
  wildcardOverride.fn = null
})

// ---- fixtures: the same tapes engine.test.ts uses, for the same reasons ----

const T0 = Date.parse('2025-06-02') / 1000
const mk = (fn: (i: number) => number, days = 260): Candle[] =>
  Array.from({ length: days }, (_, i) => {
    const c = fn(i)
    return { t: T0 + i * 86_400, o: c, h: c * 1.015, l: c * 0.985, c, v: 1_000_000 }
  })

/** A rolled-over name: ran 80→280, now bleeding −2/day. Composites a live short. */
const shorty = mk(i => (i < 200 ? 80 + i * 1.0 : 280 - (i - 200) * 2.0))
/** The same skeleton at its own frequency — five of them are five different bets
 * (60-day return correlation under 0.1), so the 3-a-side cut does the culling
 * rather than the correlation gate. */
const shortyVariant = (k: number) => mk(i => (i < 200 ? 80 + i : 280 - (i - 200) * 2) * (1 + 0.04 * Math.sin(i * k)))
const flat = mk(() => 500)
const NOW = Math.floor(shorty[shorty.length - 1].t + 86_400)
const TODAY = new Date(NOW * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })

/** DEAD MONEY, both ways: a real core read the expected-move floor still refuses.
 * `deadClimb` +0.40%/day → amber core +25.9, expects 1.1% (floor 1.5); `deadSlide`
 * −0.30%/day → amber core −31.8, expects 1.0%. Exactly the population the slot
 * exists to buy one of: cleared the dead zone, blocked by ONE named gate. */
const deadClimb = mk(i => 100 * Math.pow(1.004, i))
const deadSlide = mk(i => 100 * Math.pow(0.997, i))

const deps = (over: Partial<EngineDeps> = {}): EngineDeps =>
  ({
    candles: async (sym: string) => (sym === 'SPY' || sym === 'QQQ' ? flat : null),
    candles5y: async () => null,
    capUsdM: async () => null,
    companyName: async () => null,
    screens: async () => [],
    social: async () => [],
    sparkCloses: async () => new Map<string, number[]>(),
    insiderCoverage: async () => new Map(),
    smartMoney: async () => [],
    mediaTitles: async () => [],
    newsCatalysts: async () => [],
    dipNewsCached: async () => null,
    dipNews: async () => ({ verdict: 'unclear', reason: 'stub' }),
    recentIpos: async () => [],
    earningsSyms: async () => new Set<string>(),
    earningsCalendar: async () => [],
    worldReads: async () => [],
    holdings: async () => null,
    ...over,
  }) as unknown as EngineDeps

const emptyCalibration = (): CalibrationState => ({ buckets: {}, brier: [], defVersion: CALIB_DEF_VERSION, seedGeneration: 4 })

/** THE DAY EVERY CANDIDATE DIES AT A GATE — engine.test.ts's near-miss fixture,
 * verbatim, because the adjudication between the two mechanisms is only worth
 * pinning on the day they actually collide. CALM and DROP slide, RISE climbs;
 * all three clear the dead zone and all three die at the expected-move floor. */
const gatesOnlyStore = async () => {
  const store = memoryStore()
  await store.write('config', {
    watchlist: [{ symbol: 'CALM' }, { symbol: 'RISE' }, { symbol: 'DROP' }],
    rules: [],
    ytChannels: [],
    levMap: { CALM: { short2x: 'ICLM' } }, // DROP deliberately has no short route
  })
  await store.write('engine-calibration', emptyCalibration())
  return store
}
const gatesOnlyDeps = () =>
  deps({
    candles: async sym =>
      sym === 'CALM' || sym === 'DROP' ? deadSlide : sym === 'RISE' ? deadClimb : sym === 'SPY' || sym === 'QQQ' ? flat : null,
  })

const boardOf = (b: { board: Prediction[] }) => b.board
const wildcardIn = (rows: Prediction[]) => rows.find(r => r.wildcard)

describe('the wildcard publishes — quarter size, real stop, no leverage', () => {
  it('takes one blocked trade at a quarter of the rung and says so in the reader’s language', async () => {
    const store = await gatesOnlyStore()
    const board = boardOf(await buildBoard(store, gatesOnlyDeps(), NOW))
    const w = wildcardIn(board)!
    expect(w, 'the slot went unspent on a day made of nothing but blocked trades').toBeDefined()

    // SIZED — this is the reader's money, which is the entire point: a shadow
    // produces no causal evidence at all (wildcardLane.ts refuses one).
    expect(w.riskPct).toBeGreaterThan(0)
    expect(w.riskPct).toBeCloseTo(RUNG_RISK_PCT[w.riskRung] * WILDCARD_SIZE_CAP, 10)
    expect(w.shadow).toBeUndefined()
    expect(w.watchOnly).toBeUndefined()
    expect(w.nearMiss).toBeUndefined()
    // …and it accrues into the SIZED population, like every other row the reader
    // could act on (Stage 3c's stamp)
    expect(w.accrual).toBe('sized')

    // NO LEVERAGE, structurally: mapInstrument is only reached at a full rung,
    // and a quarter can never be one. The inequality is what is pinned, not the
    // number — someone raising the cap to 1 would have to face this line.
    expect(WILDCARD_SIZE_CAP).toBeLessThan(1)
    expect(w.instrument).toBeNull()

    // A STOP, ALWAYS — and a real one, on the right side of the entry.
    expect(Number.isFinite(w.stop)).toBe(true)
    expect(w.side === 'long' ? w.stop < w.entry : w.stop > w.entry).toBe(true)
    expect(w.side === 'long' ? w.target > w.entry : w.target < w.entry).toBe(true)

    // THE VOICE: the label, the hypothesis the choice was made on, the standing
    // warning, and the falsifier — in the row's own sentence.
    expect(w.thesis).toContain(WILDCARD_LABEL)
    expect(w.thesis).toContain(w.wildcard!.hypothesis)
    expect(w.thesis).toContain(WILDCARD_WARNING)
    expect(w.thesis!.endsWith(w.falsifier!)).toBe(true)
    expect(w.falsifier).toContain(String(w.stop))
    expect(w.note).toContain('wildcard experiment')
    expect(w.note).toContain(w.wildcard!.gate)

    // THE SEPARABLE RECORD, and the tag both the ladder and factor IC key off.
    expect(w.catalyst).toEqual({ kind: WILDCARD_CATALYST_KIND, reason: w.wildcard!.hypothesis })
    expect(w.wildcard!.priority).toBe(1)
    expect(w.wildcard!.gate).toBe('expected-move')
    expect(w.wildcard!.gateEvidenceN).toBe(0) // no miss ledger yet — the thinnest gate there is
    // NO EVIDENCE CONTRACT, stated rather than invented: this row never got far
    // enough to have one assessed.
    expect(w.evidence.contract).toBe(false)
    expect(w.evidence.detail).toContain('no evidence contract was ever assessed')
  })

  it('the side it seated on stops claiming to be empty — and the funnel’s own record keeps the reason', async () => {
    const store = await gatesOnlyStore()
    const board = boardOf(await buildBoard(store, gatesOnlyDeps(), NOW))
    const w = wildcardIn(board)!
    const blob = (await store.read<{ emptySides?: Record<string, string> }>('engine-board'))!
    // every empty-side sentence opens "nothing tradeable on the X side today",
    // and this side has a sized row on it
    expect(blob.emptySides?.[w.side]).toBeUndefined()
    // …but the FUNNEL still knows why the ordinary run emptied it: the record is
    // not the copy, and the walk reads the record
    const trace = (await store.read<FunnelTrace>(funnelTraceKey(TODAY)))!
    expect(trace.emptySides[w.side]).toBe('gates')
    // and the other side is untouched
    expect(blob.emptySides?.[w.side === 'long' ? 'short' : 'long']).toBe(trace.emptySides[w.side === 'long' ? 'short' : 'long'])
  })

  it('is in the LEDGER as well as on the board — an experiment nobody grades buys nothing', async () => {
    const store = await gatesOnlyStore()
    const board = boardOf(await buildBoard(store, gatesOnlyDeps(), NOW))
    const w = wildcardIn(board)!
    const ledger = (await store.read<Prediction[]>(`predictions:${TODAY}`))!
    const booked = ledger.find(p => p.id === w.id)
    expect(booked).toBeDefined()
    expect(booked!.wildcard).toEqual(w.wildcard)
    // …and exactly one of it, on either surface: no id is published twice
    expect(board.filter(p => p.id === w.id)).toHaveLength(1)
    expect(ledger.filter(p => p.id === w.id)).toHaveLength(1)
  })

  it('the trace calls it called-wildcard and keeps the gate it overrode as priorGate', async () => {
    const store = await gatesOnlyStore()
    const board = boardOf(await buildBoard(store, gatesOnlyDeps(), NOW))
    const w = wildcardIn(board)!
    const trace = (await store.read<FunnelTrace>(funnelTraceKey(TODAY)))!
    const row = trace.rows[`${w.sym}:${w.side}`]
    // its own code — none of the three size classes could carry it honestly
    expect(row.gate).toBe('called-wildcard')
    expect(row.detail).toContain('quarter size')
    // …and the whole biography survives: the gate under test is exactly what the
    // key held a moment before the publication overwrote it
    expect(row.priorGate).toBe(w.wildcard!.gate)
  })

  it('a near miss on the SAME chart yields to it — and every other near miss is untouched', async () => {
    const store = await gatesOnlyStore()
    const board = boardOf(await buildBoard(store, gatesOnlyDeps(), NOW))
    const w = wildcardIn(board)!
    // the wildcard was CHOSEN from the near-miss list, so the two would otherwise
    // publish the same id; the sized call with a falsifier wins over the printed
    // comparison that has neither
    expect(board.some(p => p.nearMiss && p.sym === w.sym)).toBe(false)
    // …and the mechanism is not switched off wholesale: the side the wildcard did
    // not take still names what came closest
    expect(board.some(p => p.nearMiss)).toBe(true)
    // no duplicate ids anywhere on the board
    expect(new Set(board.map(p => p.id)).size).toBe(board.length)
  })

  it('a FULL board still publishes it — the 3-a-side cut cannot see it', async () => {
    const store = memoryStore()
    const variants: [string, number][] = [
      ['AAA', 0.7],
      ['BBB', 1.1],
      ['CCC', 1.9],
      ['DDD', 2.5],
      ['EEE', 1.5],
    ]
    const tapes = new Map(variants.map(([sym, k]) => [sym, shortyVariant(k)]))
    const syms = variants.map(([s]) => s)
    // …with the six filler names the same fixture carries in engine.funnelTrace:
    // breadth has to be KNOWN or the evidence contract fails and all five land
    // watch-only, and then there is no full board to test against.
    const fillers = ['FIL1', 'FIL2', 'FIL3', 'FIL4', 'FIL5', 'FIL6']
    await store.write('config', {
      watchlist: [...syms, 'CALM'].map(symbol => ({ symbol })),
      rules: [],
      ytChannels: [],
      levMap: Object.fromEntries([...syms, 'CALM'].map(s => [s, { short2x: `I${s}` }])),
    })
    await store.write('engine-calibration', emptyCalibration())
    const board = boardOf(
      await buildBoard(
        store,
        deps({
          screens: async () =>
            [...syms, ...fillers].map(sym => ({ row: { sym, price: 150, capUsdM: 50_000, changePct: null, name: null }, source: 'screener:losers' })),
          candles: async sym =>
            tapes.get(sym) ?? (sym === 'CALM' ? deadSlide : fillers.includes(sym) || sym === 'SPY' || sym === 'QQQ' ? flat : null),
        }),
        NOW,
      ),
    )
    // the cut did its ordinary work: three sized shorts, no more
    const sizedShorts = board.filter(b => b.side === 'short' && !b.watchOnly && !b.shadow && !b.wildcard)
    expect(sizedShorts).toHaveLength(3)
    // …and the experiment sits beside them as a FOURTH sized short, because it is
    // seated after both cuts have run and neither can see it
    const w = wildcardIn(board)!
    expect(w.sym).toBe('CALM')
    expect(w.side).toBe('short')
    expect(w.riskPct).toBeGreaterThan(0)
    expect(board.filter(b => b.side === 'short' && !b.watchOnly && !b.shadow)).toHaveLength(4)
  })

  it('ONE SLOT ACROSS DAYS: an ungraded wildcard on a recent date blocks today’s', async () => {
    const store = await gatesOnlyStore()
    const priorDate = '2000-01-03'
    await store.write('predictions-index', [priorDate])
    await store.write(`predictions:${priorDate}`, [
      {
        id: `${priorDate}:OLD:long`,
        date: priorDate,
        sym: 'OLD',
        side: 'long',
        riskPct: 0.25,
        catalyst: { kind: WILDCARD_CATALYST_KIND, reason: 'still open' },
        wildcard: { gate: 'dead-zone-core', priority: 1, hypothesis: 'still open', gateEvidenceN: 0 },
      } as unknown as Prediction,
    ])
    const board = boardOf(await buildBoard(store, gatesOnlyDeps(), NOW))
    expect(wildcardIn(board)).toBeUndefined()
    // …and the near-miss mechanism has its name back, because nothing took it
    expect(board.some(p => p.nearMiss && p.sym === 'RISE')).toBe(true)
  })

  it('a GRADED prior wildcard releases the slot', async () => {
    const store = await gatesOnlyStore()
    const priorDate = '2000-01-03'
    await store.write('predictions-index', [priorDate])
    await store.write(`predictions:${priorDate}`, [
      {
        id: `${priorDate}:OLD:long`,
        date: priorDate,
        sym: 'OLD',
        side: 'long',
        riskPct: 0.25,
        catalyst: { kind: WILDCARD_CATALYST_KIND, reason: 'closed' },
        wildcard: { gate: 'dead-zone-core', priority: 1, hypothesis: 'closed', gateEvidenceN: 0 },
        outcome10: { excessPct: 3, rawPct: 3, spyPct: 0, stopped: false, hit: true },
      } as unknown as Prediction,
    ])
    const board = boardOf(await buildBoard(store, gatesOnlyDeps(), NOW))
    expect(wildcardIn(board)).toBeDefined()
  })
})

describe('the seams: a day the slot goes unspent is the day before this lane existed', () => {
  it('WILDCARD=off publishes no experiment, and hands the name back to the near-miss list', async () => {
    vi.stubEnv('WILDCARD', 'off')
    const store = await gatesOnlyStore()
    const board = boardOf(await buildBoard(store, gatesOnlyDeps(), NOW))
    expect(wildcardIn(board)).toBeUndefined()
    expect(board.every(p => p.catalyst?.kind !== WILDCARD_CATALYST_KIND)).toBe(true)
    expect(board.some(p => p.nearMiss && p.sym === 'RISE')).toBe(true)
    const trace = (await store.read<FunnelTrace>(funnelTraceKey(TODAY)))!
    expect(Object.values(trace.rows).some(r => r.gate === 'called-wildcard')).toBe(false)
  })

  it('REGRET=off silences it too — an experiment whose causal write-back is dead has no readout', async () => {
    vi.stubEnv('REGRET', 'off')
    const store = await gatesOnlyStore()
    const board = boardOf(await buildBoard(store, gatesOnlyDeps(), NOW))
    expect(wildcardIn(board)).toBeUndefined()
  })

  it('the board is BYTE-IDENTICAL with the lane on and off, once the experiment is taken out of both', async () => {
    // The controlled diff: the lane must not perturb one ordinary row. Everything
    // the wildcard displaces is itself (its own row, and the near miss on its own
    // chart that yielded to it) — nothing else may move.
    const on = boardOf(await buildBoard(await gatesOnlyStore(), gatesOnlyDeps(), NOW))
    vi.stubEnv('WILDCARD', 'off')
    const off = boardOf(await buildBoard(await gatesOnlyStore(), gatesOnlyDeps(), NOW))
    const w = wildcardIn(on)!
    const strip = (rows: Prediction[]) => JSON.stringify(rows.filter(r => r.sym !== w.sym).map(r => ({ ...r, id: r.id })))
    expect(strip(on)).toBe(strip(off))
  })
})

// ---- the belts under the lane's braces (fix wave, F-3) ----
//
// The lane refuses earnings names outright, so the publish path's earnings arm
// can only ever fire on a lane that has regressed. That is precisely what it is
// for — and until the real flag reached `publishCall` it could not have fired at
// all, because the call site handed it a hardcoded `false`.
describe('the earnings belt — the engine does not experiment on a coin flip, twice over', () => {
  /** A candidate the real lane would never return: a name with an earnings print
   * inside the horizon. Everything else about it is the day's own arithmetic.
   *
   * A LONG, deliberately: `preGradeShadow` has three arms, and a short with no
   * inverse ETP would shadow on the ROUTE arm — which would pass this test
   * without the earnings flag ever being read. A long is always routable, so the
   * print is the only thing left that can stop it. */
  const earningsCandidate = (sym: string) => ({
    candidate: {
      sym,
      side: 'long' as const,
      cohort: 'large' as const,
      gate: 'expected-move' as const,
      gateEvidenceN: 0,
      miss: {
        sym,
        core: 26,
        capUsdM: 40_000,
        lastClose: 100,
        atrNow: 2,
        capacityPct: 8,
        stage: 'trending',
        factors: { technical: { score: 30, detail: '' } },
      },
    },
    hypothesis: 'a regressed lane offered a coin flip',
    priority: 1 as const,
  })

  const withEarnings = (syms: string[]) => deps({ ...gatesOnlyDeps(), earningsSyms: async () => new Set(syms) } as Partial<EngineDeps>)

  it('an earnings name that reaches the publish path shadows there — and the slot is NOT spent on it', async () => {
    const store = await gatesOnlyStore()
    // CALM is short-routable (the fixture maps it) and ERNS is the print, so the
    // ONLY thing between this row and the board is the earnings flag itself.
    wildcardOverride.fn = () => earningsCandidate('ERNS')
    const board = boardOf(await buildBoard(store, withEarnings(['ERNS']), NOW))
    expect(board.some(p => p.sym === 'ERNS')).toBe(false)
    // …and NOTHING wildcard-shaped reached the LEDGER, which is the only record
    // the outstanding scan reads. THE ADJUDICATION: a shadowed wildcard bought no
    // causal evidence at all — a shadow is exactly what wildcardLane.ts refuses as
    // worthless — so it must not hold the one slot shut for the ten sessions it
    // would take to grade. The slot is spent on EVIDENCE, never on an attempt.
    const stored = (await store.read<Prediction[]>(`predictions:${TODAY}`))!
    expect(stored.some(p => p.catalyst?.kind === WILDCARD_CATALYST_KIND)).toBe(false)
    // …and the trace does not leave a `called-wildcard` code stranded on a row
    // nobody ever gets — the gate that refused the name is what stands
    const trace = (await store.read<FunnelTrace>(funnelTraceKey(TODAY)))!
    expect(Object.values(trace.rows).some(r => r.gate === 'called-wildcard')).toBe(false)
  })

  it('…and the SAME candidate with no print seats normally — the belt is what stopped it, not the synthesis', async () => {
    const store = await gatesOnlyStore()
    wildcardOverride.fn = () => earningsCandidate('CALM')
    const board = boardOf(await buildBoard(store, withEarnings([]), NOW))
    const w = board.find(p => p.sym === 'CALM' && p.wildcard)
    expect(w, 'the hand-built candidate publishes when nothing is wrong with it').toBeDefined()
    expect(w!.earningsRisk).toBe(false)
    expect(w!.shadow).toBeUndefined()
  })

  it('THE OUTSTANDING-SCAN IMPLICATION: the day after, the slot is open — a refusal never consumed it', async () => {
    // day one: the regressed lane offers a print, the belt refuses it, and the
    // day's ledger is written with whatever it legitimately held
    const day1 = await gatesOnlyStore()
    wildcardOverride.fn = () => earningsCandidate('ERNS')
    await buildBoard(day1, withEarnings(['ERNS']), NOW)
    const day1Rows = (await day1.read<Prediction[]>(`predictions:${TODAY}`))!

    // day two reads day one's ledger exactly as the scan does — and finds no
    // wildcard holding the slot, so the real lane may spend it
    wildcardOverride.fn = null
    const day2 = await gatesOnlyStore()
    await day2.write('predictions-index', ['2000-01-03'])
    await day2.write('predictions:2000-01-03', day1Rows)
    expect(wildcardIn(boardOf(await buildBoard(day2, gatesOnlyDeps(), NOW)))).toBeDefined()
  })
})

// ================= the grading half =================

const G0 = Date.parse('2026-01-05') / 1000
const DAY = 86_400
const BARS = 60
const ENTRY_IDX = 30
const gDate = (i: number) => new Date((G0 + i * DAY) * 1000).toISOString().slice(0, 10)
const ENTRY = gDate(ENTRY_IDX)
const GNOW = Math.floor(G0 + BARS * DAY)

const gTape = (closeAt: (i: number) => number): Candle[] =>
  Array.from({ length: BARS }, (_, i) => {
    const c = closeAt(i)
    return { t: G0 + i * DAY, o: c, h: c * 1.01, l: c * 0.99, c, v: 1_000_000 }
  })
const gFlat = gTape(() => 100)
/** +10% and never near its stop — the experiment that PAID */
const gWinner = gTape(i => (i <= ENTRY_IDX ? 100 : 110))
/** bleeds with no level to break — the experiment that did not */
const gLoser = gTape(i => (i <= ENTRY_IDX ? 100 : 100 - (i - ENTRY_IDX) * 0.4))

const gDeps = (): EngineDeps =>
  deps({
    candles: async (sym: string) => (sym === 'SPY' ? gFlat : sym === 'WON' ? gWinner : sym === 'LOST' ? gLoser : sym === 'PLAIN' ? gWinner : null),
  })

const gRow = (sym: string, over: Partial<Prediction> = {}): Prediction =>
  ({
    id: `${ENTRY}:${sym}:long`,
    date: ENTRY,
    sym,
    side: 'long',
    composite: 26,
    regime: 'amber',
    probability: 0.5,
    provisional: true,
    grade: 'C',
    riskRung: 0,
    riskPct: RUNG_RISK_PCT[0] * WILDCARD_SIZE_CAP,
    priceAtPrediction: 100,
    entry: 100,
    stop: 90,
    target: 120,
    instrument: null,
    setup: 'continuation',
    accrual: 'sized',
    capUsdM: 40_000,
    factors: { technical: { score: 30, detail: '', weight: 1 } },
    catalyst: { kind: WILDCARD_CATALYST_KIND, reason: 'testing the gate' },
    wildcard: { gate: 'expected-move', priority: 1, hypothesis: 'testing the gate', gateEvidenceN: 0 },
    ...over,
  }) as unknown as Prediction

const gradedStore = async (rows: Prediction[]) => {
  const store = memoryStore()
  await store.write(`predictions:${ENTRY}`, rows)
  await store.write('predictions-index', [ENTRY])
  return store
}

describe('the causal write-back — the one measurement in this engine that is not an upper bound', () => {
  it('a wildcard that PAID charges its gate a sided cost, and tags the example', async () => {
    const store = await gradedStore([gRow('WON')])
    await gradeOutstanding(store, gDeps(), GNOW, null)
    const ledger = (await store.read<MissLedger>(MISS_LEDGER_KEY))!
    const g = ledger.gates['expected-move']!
    expect(g.causal).toMatchObject({ n: 1, hits: 1 })
    // the outcome the gate refused ALSO reaches eligibility, on the day it grades
    expect(g.sidedCost).toBe(1)
    expect(g.sidedSaved ?? 0).toBe(0)
    // …and the stopless columns beside it are untouched: a ±5pp upper bound and a
    // real stopped outcome are two different measurements and must stay two
    expect(g.cost).toBe(0)
    expect(g.saved).toBe(0)
    expect(g.costExcessSum).toBe(0)
    const ex = g.causal!.examples[0]
    expect(ex).toMatchObject({ sym: 'WON', side: 'long', gate: 'expected-move', wildcard: true, hit: true })
    expect(ex.excessPct).toBeGreaterThan(0)
  })

  it('…and one that did NOT charges the same gate a sided save — both directions, or the evidence only ever argues one way', async () => {
    const store = await gradedStore([gRow('LOST')])
    await gradeOutstanding(store, gDeps(), GNOW, null)
    const g = (await store.read<MissLedger>(MISS_LEDGER_KEY))!.gates['expected-move']!
    expect(g.causal).toMatchObject({ n: 1, hits: 0 })
    expect(g.sidedSaved).toBe(1)
    expect(g.sidedCost ?? 0).toBe(0)
    expect(g.causal!.examples[0]).toMatchObject({ wildcard: true, hit: false })
  })

  it('charges the gate STORED at selection, never one re-derived at grading', async () => {
    const store = await gradedStore([gRow('WON', { wildcard: { gate: 'dead-zone-core', priority: 2, hypothesis: 'h', gateEvidenceN: 3 } })])
    await gradeOutstanding(store, gDeps(), GNOW, null)
    const ledger = (await store.read<MissLedger>(MISS_LEDGER_KEY))!
    expect(ledger.gates['dead-zone-core']!.causal).toMatchObject({ n: 1, hits: 1 })
    expect(ledger.gates['expected-move']).toBeUndefined()
  })

  it('books ONCE — a second grading pass over the same row adds nothing', async () => {
    const store = await gradedStore([gRow('WON')])
    await gradeOutstanding(store, gDeps(), GNOW, null)
    await gradeOutstanding(store, gDeps(), GNOW, null)
    expect((await store.read<MissLedger>(MISS_LEDGER_KEY))!.gates['expected-move']!.causal).toMatchObject({ n: 1 })
  })

  it('REGRET=off books nothing at all — the pre-3b tree, exactly', async () => {
    vi.stubEnv('REGRET', 'off')
    const store = await gradedStore([gRow('WON')])
    await gradeOutstanding(store, gDeps(), GNOW, null)
    expect(await store.read<MissLedger>(MISS_LEDGER_KEY)).toBeNull()
  })

  // A LOST WRITE IS RECOVERABLE, NOT SILENT (fix wave, F-4). The grade is durable
  // long before the ledger hook runs — deliberately, so a blob failure can never
  // sit between a grade and its store.write — which used to mean that a ledger
  // throw destroyed the one causal sample the slot spent a week buying, with
  // nothing left on the row to say so.
  it('a ledger throw does not lose the outcome: the grade stands, the row says it is owed, the next run books it ONCE', async () => {
    const inner = memoryStore()
    let ledgerWritesFail = true
    const store = {
      read: inner.read,
      write: async (k: string, v: unknown) => {
        if (ledgerWritesFail && k === MISS_LEDGER_KEY) throw new Error('blobs 503')
        await inner.write(k, v)
      },
    } as unknown as Parameters<typeof gradeOutstanding>[0]
    await store.write(`predictions:${ENTRY}`, [gRow('WON')])
    await store.write('predictions-index', [ENTRY])

    await gradeOutstanding(store, gDeps(), GNOW, null)
    const afterFail = (await store.read<Prediction[]>(`predictions:${ENTRY}`))![0]
    expect(afterFail.outcome10!.hit, 'the grade is durable whatever the ledger did').toBe(true)
    expect(afterFail.wildcard!.booked, 'and the row itself records the debt').toBe(false)
    expect(await store.read<MissLedger>(MISS_LEDGER_KEY)).toBeNull()

    ledgerWritesFail = false
    await gradeOutstanding(store, gDeps(), GNOW, null)
    expect((await store.read<MissLedger>(MISS_LEDGER_KEY))!.gates['expected-move']!.causal).toMatchObject({ n: 1, hits: 1 })
    expect((await store.read<Prediction[]>(`predictions:${ENTRY}`))![0].wildcard!.booked).toBe(true)

    // …and ONCE. The stamp is the receipt, so a third pass finds nothing owed.
    await gradeOutstanding(store, gDeps(), GNOW, null)
    expect((await store.read<MissLedger>(MISS_LEDGER_KEY))!.gates['expected-move']!.causal).toMatchObject({ n: 1 })
  })

  // MIGRATION SAFETY, and it is why the stamp is a tri-state rather than a
  // boolean: a row graded before this field existed carries `booked: undefined`,
  // which must read as "settled long ago", never as "owed". `false` is written
  // WITH the grade, so only a row this engine graded can ever be re-offered.
  it('a wildcard graded before the receipt existed is never re-booked', async () => {
    const store = await gradedStore([
      gRow('WON', { outcome10: { excessPct: 9, rawPct: 10, spyPct: 1, stopped: false, hit: true } } as Partial<Prediction>),
    ])
    await gradeOutstanding(store, gDeps(), GNOW, null)
    expect(await store.read<MissLedger>(MISS_LEDGER_KEY)).toBeNull()
  })
})

/** The honesty pane's stored shape — read here rather than imported, because the
 * blob is a contract with the app and the panel and this file is one of the
 * places that has to notice when it changes. */
type Scorecard = {
  byGrade: Record<string, { n: number; hits: number; sumExcess: number }>
  byRegime: Record<string, { n: number; hits: number }>
  bySetup: Record<string, { n: number; hits: number; sumExcess: number }>
  byPostMortem: Record<string, number>
  lifetime: { live: { graded: number; hits: number; sumExcess: number }; shadow: { graded: number; hits: number; sumExcess: number }; since: string }
}

describe('what a graded wildcard may NOT move', () => {
  const plain = (sym: string) => gRow(sym, { catalyst: undefined, wildcard: undefined, riskPct: 1 })

  /** Three arms over the SAME tape: no row at all, one ordinary sized winner, and
   * one wildcard winner. Everything below is read as a DELTA against the empty
   * arm, because the grading pass installs the committed seed's calibration and
   * factor evidence on first load — an absolute count would be measuring the
   * seed, and the question here is what ONE row moved. */
  const arms = async () => {
    const run = async (rows: Prediction[]) => {
      const store = await gradedStore(rows)
      await gradeOutstanding(store, gDeps(), GNOW, null)
      return {
        risk: (await store.read<RiskState>('risk-state'))!,
        weights: (await store.read<WeightsState>('engine-weights'))!,
        calibration: (await store.read<CalibrationState>('engine-calibration'))!,
        scorecard: (await store.read<Scorecard>('engine-scorecard'))!,
      }
    }
    return { none: await run([]), ordinary: await run([plain('PLAIN')]), experiment: await run([gRow('WON')]) }
  }
  const bucketN = (c: CalibrationState) => Object.values(c.buckets).reduce((s, b) => s + b.n, 0)

  it('the risk ladder’s rung counters: an ordinary row moves them and a wildcard does not', async () => {
    const { none, ordinary, experiment } = await arms()
    expect(ordinary.risk.gradedAtRung - none.risk.gradedAtRung).toBe(1)
    expect(ordinary.risk.cohorts!.large.gradedAtRung - none.risk.cohorts!.large.gradedAtRung).toBe(1)
    // the same tape, the same grade, the same cohort — and the ladder never heard
    // about it. The rung is earned on the calls the engine BELIEVED.
    expect(experiment.risk.gradedAtRung - none.risk.gradedAtRung).toBe(0)
    expect(experiment.risk.cohorts!.large.gradedAtRung - none.risk.cohorts!.large.gradedAtRung).toBe(0)
  })

  it('factor IC: the stack is never trained on a vote it did not cast', async () => {
    const { none, ordinary, experiment } = await arms()
    const ic = (w: WeightsState) => w.ic.technical.nAgree + w.ic.technical.nDisagree
    expect(ic(ordinary.weights) - ic(none.weights)).toBe(1)
    expect(ic(experiment.weights) - ic(none.weights)).toBe(0)
  })

  it('…but calibration still learns from it: it was the reader’s money, at a real size', async () => {
    const { none, experiment } = await arms()
    expect(bucketN(experiment.calibration) - bucketN(none.calibration)).toBe(1)
  })

  // ---- THE FOURTH ARM (fix wave, F-2): the two readings of the engine's SKILL ----
  //
  // `newlyGraded` feeds exactly two consumers, and both of them answer "is this
  // tool any good?": the Brier trail (which decides `brierImproving`, which is a
  // precondition of every rung promotion) and the lifetime counters (the Ledger's
  // never-resets headline). A wildcard is the engine deliberately overriding its
  // own no at a quarter of the rung — an experiment, not a claim of skill — so
  // letting it into either would let one refused trade a week talk the ladder up
  // and restate the tool's lifetime accuracy.

  it('the BRIER trail: an ordinary row is a point on it and an experiment is not', async () => {
    const { none, ordinary, experiment } = await arms()
    expect(ordinary.calibration.brier.length - none.calibration.brier.length).toBe(1)
    expect(experiment.calibration.brier.length - none.calibration.brier.length).toBe(0)
  })

  it('the LIFETIME counters — the headline that never resets — never hear about an experiment', async () => {
    const { none, ordinary, experiment } = await arms()
    const live = (s: Scorecard) => s.lifetime.live.graded
    const shadow = (s: Scorecard) => s.lifetime.shadow.graded
    expect(live(ordinary.scorecard) - live(none.scorecard)).toBe(1)
    expect(live(experiment.scorecard) - live(none.scorecard)).toBe(0)
    // …and it does not sneak in through the shadow column either
    expect(shadow(experiment.scorecard) - shadow(none.scorecard)).toBe(0)
  })

  // THE SCORECARD ADJUDICATION (fix wave, F-2), pinned pane by pane. The rule:
  // at every pane a wildcard takes the SAME treatment the pane already gives a
  // SHADOW, because both are populations carrying no reader conviction and every
  // pane has already had to decide what to do with such a population.
  it('the scorecard panes: the SHAPE panes count it, the SKILL panes do not, and it never wears a letter', async () => {
    const { none, ordinary, experiment } = await arms()
    const n = (o: { n: number } | undefined) => o?.n ?? 0

    // byGrade — the ordinary row lands on its letter; the experiment gets its OWN
    // key, exactly as a shadow does. Its grade is not why it published, so
    // crediting C with it would make the letter mean two different things.
    expect(n(ordinary.scorecard.byGrade.C) - n(none.scorecard.byGrade.C)).toBe(1)
    expect(n(experiment.scorecard.byGrade.C) - n(none.scorecard.byGrade.C)).toBe(0)
    expect(experiment.scorecard.byGrade.wildcard).toMatchObject({ n: 1, hits: 1 })
    expect(none.scorecard.byGrade.wildcard).toBeUndefined()

    // byRegime — the LIVE pane (it already drops shadows for this reason): "how
    // does the engine read THIS tape?" is a skill question, and the answer must
    // not include the row it published because it read the tape the other way.
    expect(n(ordinary.scorecard.byRegime.amber) - n(none.scorecard.byRegime.amber)).toBe(1)
    expect(n(experiment.scorecard.byRegime.amber) - n(none.scorecard.byRegime.amber)).toBe(0)

    // bySetup — the SHAPE pane, which counts shadows deliberately ("does this
    // shape of call work?"). A wildcard's family is real, and it is a sized,
    // stopped, graded outcome of it. It counts.
    expect(n(experiment.scorecard.bySetup.continuation) - n(none.scorecard.bySetup.continuation)).toBe(1)
  })

  it('byPostMortem is the HOW-WE-LOSE roll-up: a win has no place in it, and a losing experiment does', async () => {
    const won = await gradedStore([gRow('WON')])
    await gradeOutstanding(won, gDeps(), GNOW, null)
    // the row IS post-mortemed (the slot is examined either way) and the roll-up
    // still says nothing — a `won` key under a setup family would read as a way
    // the engine loses
    expect((await won.read<Prediction[]>(`predictions:${ENTRY}`))![0].postMortem!.cls).toBe('won')
    expect((await won.read<Scorecard>('engine-scorecard'))!.byPostMortem).toEqual({})

    const lost = await gradedStore([gRow('LOST')])
    await gradeOutstanding(lost, gDeps(), GNOW, null)
    expect((await lost.read<Scorecard>('engine-scorecard'))!.byPostMortem).toEqual({ 'continuation:amber:adverse-move': 1 })
  })
})

describe('the mandatory post-mortem — win or lose', () => {
  it('a WINNING wildcard is explained; a winning ordinary call still is not', async () => {
    const store = await gradedStore([gRow('WON'), gRow('PLAIN', { catalyst: undefined, wildcard: undefined, riskPct: 1 })])
    await gradeOutstanding(store, gDeps(), GNOW, null)
    const rows = (await store.read<Prediction[]>(`predictions:${ENTRY}`))!
    const by = Object.fromEntries(rows.map(p => [p.sym, p]))

    expect(by.WON.outcome10!.hit).toBe(true)
    expect(by.WON.postMortem).toMatchObject({ cls: 'won', at: GNOW })
    expect(by.WON.postMortem!.detail).toContain('cleared the bar')
    // …and the rest of the engine is untouched: winners still say nothing
    expect(by.PLAIN.outcome10!.hit).toBe(true)
    expect('postMortem' in by.PLAIN).toBe(false)
  })

  it('a LOSING wildcard keeps the ordinary loser precedence — the win branch adds, it does not replace', async () => {
    const store = await gradedStore([gRow('LOST')])
    await gradeOutstanding(store, gDeps(), GNOW, null)
    const row = (await store.read<Prediction[]>(`predictions:${ENTRY}`))![0]
    expect(row.outcome10!.hit).toBe(false)
    expect(row.postMortem!.cls).toBe('adverse-move')
  })

  it('a winning wildcard buys NO llm sentence — the prompt explains a loss that did not happen', async () => {
    const asked: unknown[] = []
    const store = await gradedStore([gRow('WON'), gRow('LOST')])
    await gradeOutstanding(
      store,
      { ...gDeps(), postMortemSentence: async (p: unknown) => { asked.push(p); return null } } as unknown as EngineDeps,
      GNOW,
      null,
    )
    // exactly one ask, and it is the loser's
    expect(asked).toHaveLength(1)
    expect(JSON.stringify(asked[0])).toContain('LOST')
  })
})
