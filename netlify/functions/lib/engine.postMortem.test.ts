import { describe, expect, it, vi } from 'vitest'
import { gradeOutstanding, type EngineDeps } from './engine'
import { memoryStore } from './store'
import type { Candle } from '../../../shared/types'
import { gradePrediction } from '../../../shared/engine/calibration'
import { VELOCITY_CATALYST_KIND } from '../../../shared/engine/catalyst'
import type { Prediction } from '../../../shared/engine/types'

// ---- fixtures ----

const T0 = Date.parse('2026-01-05') / 1000
const DAY = 86_400
const BARS = 60
const ENTRY_IDX = 30
const dateOf = (i: number) => new Date((T0 + i * DAY) * 1000).toISOString().slice(0, 10)
const ENTRY = dateOf(ENTRY_IDX)
const NOW = Math.floor(T0 + BARS * DAY)

const tape = (closeAt: (i: number) => number): Candle[] =>
  Array.from({ length: BARS }, (_, i) => {
    const c = closeAt(i)
    return { t: T0 + i * DAY, o: c, h: c * 1.01, l: c * 0.99, c, v: 1_000_000 }
  })

const flat = tape(() => 100)
/** closes through the 90 stop on the third session and stays there */
const stopper = tape(i => (i < ENTRY_IDX + 2 ? 100 : 85))
/** rides to 146 then collapses to 92 — under the trail it drew, miles clear of 80 */
const velo = tape(i => (i <= ENTRY_IDX ? 100 + i : i <= 34 ? 130 + (i - ENTRY_IDX) * 4 : 92))
// both of these move AFTER the entry session, because grading's base is that
// session's OPEN (calibration.ts) — a fixture that gaps on the entry bar itself
// would be scored flat and prove nothing.
/** bleeds ~0.4 a session with no level to break: the fallback, from any entry */
const drifter = tape(i => (i <= ENTRY_IDX ? 100 : 100 - (i - ENTRY_IDX) * 0.4))
/** +10% and never near its stop: a hit, and it must stay unexplained */
const winner = tape(i => (i <= ENTRY_IDX ? 100 : 110))

const deps = (): EngineDeps =>
  ({
    candles: async (sym: string) =>
      sym === 'SPY' ? flat
      : sym === 'STOP' ? stopper
      : sym === 'VELO' ? velo
      : sym === 'DRAG' ? flat
      : sym === 'LOSE' ? drifter
      : sym === 'WIN' ? winner
      : null,
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
  }) as unknown as EngineDeps

const call = (sym: string, over: Partial<Prediction> = {}): Prediction =>
  ({
    id: `${ENTRY}:${sym}:long`,
    date: ENTRY,
    sym,
    side: 'long',
    composite: 33,
    regime: 'amber',
    probability: 0.55,
    provisional: false,
    grade: 'B',
    riskRung: 3,
    riskPct: 1,
    priceAtPrediction: 100,
    entry: 100,
    stop: 90,
    target: 120,
    instrument: null,
    setup: 'continuation',
    factors: { technical: { score: 30, detail: '', weight: 1 } },
    ...over,
  }) as unknown as Prediction

/** THE POPULATION, one of every kind that can lose — and one that wins. */
const seedRows = (): Prediction[] => [
  call('STOP'), // sized: the stop fired
  call('VELO', { id: `${ENTRY}:VELO:long`, stop: 80, trail: 'velocity', shadow: true, setup: 'velocity', regime: 'green', catalyst: { kind: VELOCITY_CATALYST_KIND, reason: 'first paid break' } }),
  call('DRAG', { watchOnly: true, riskPct: 0, setup: 'reversal' }), // dead level with a dead tape
  call('LOSE', { stop: 50, observation: true, riskPct: 0, setup: null }), // no level to break
  call('WIN', { setup: 'continuation' }),
]

const seeded = async () => {
  const store = memoryStore()
  await store.write(`predictions:${ENTRY}`, seedRows())
  await store.write('predictions-index', [ENTRY])
  return store
}

const readRows = async (store: { read: <T>(k: string) => Promise<T | null> }) => {
  const rows = (await store.read<Prediction[]>(`predictions:${ENTRY}`))!
  return Object.fromEntries(rows.map(p => [p.sym, p])) as Record<string, Prediction>
}

describe('gradeOutstanding → post-mortems', () => {
  it('explains EVERY graded loser — sized, watch, shadow and observation — in the pinned order, and leaves the winner silent', async () => {
    const store = await seeded()
    expect((await gradeOutstanding(store, deps(), NOW, null)).graded).toBe(5)
    const by = await readRows(store)

    expect(by.STOP.postMortem).toMatchObject({ cls: 'stopped', at: NOW })
    expect(by.STOP.postMortem!.detail).toContain(dateOf(ENTRY_IDX + 2))
    // the shadow is explained like everything else — it was published to fail
    // instructively, and an unexplained shadow teaches nothing
    expect(by.VELO.shadow).toBe(true)
    expect(by.VELO.postMortem!.cls).toBe('thesis-break')
    expect(by.VELO.postMortem!.detail).toContain('velocity trail')
    expect(by.VELO.outcome10!.stopped).toBe(false) // …and the published stop never went
    expect(by.DRAG.postMortem!.cls).toBe('market-drag')
    expect(by.LOSE.postMortem!.cls).toBe('adverse-move')

    // the winner: graded, and carrying nothing to explain
    expect(by.WIN.outcome10!.hit).toBe(true)
    expect(by.WIN.postMortem).toBeUndefined()
    expect('postMortem' in by.WIN).toBe(false) // not even as an undefined key
  })

  it('a ledger row only ever GAINS the field: strip it back off and the row is byte-identical to the graded row without it', async () => {
    const before = JSON.parse(JSON.stringify(seedRows())) as Prediction[]
    const store = await seeded()
    await gradeOutstanding(store, deps(), NOW, null)
    const after = (await store.read<Prediction[]>(`predictions:${ENTRY}`))!

    for (const [i, row] of after.entries()) {
      const candles = (await deps().candles(row.sym))!
      // what the row would have been WITHOUT this feature: the seeded row plus the
      // three outcomes, in the order grading assigns them
      const expected = {
        ...before[i],
        outcome5: gradePrediction(before[i], candles, flat, 5)!,
        outcome10: gradePrediction(before[i], candles, flat, 10)!,
        outcome21: gradePrediction(before[i], candles, flat, 21)!,
      }
      const { postMortem, ...stripped } = row
      expect(JSON.stringify(stripped)).toBe(JSON.stringify(expected))
      expect(postMortem === undefined).toBe(row.outcome10!.hit)
    }
  })

  it('rolls the losers up by setup family × regime × class — and counts a setup-less row rather than dropping it', async () => {
    const store = await seeded()
    await gradeOutstanding(store, deps(), NOW, null)
    const card = (await store.read<{ byPostMortem: Record<string, number>; byGrade: Record<string, { n: number }> }>('engine-scorecard'))!

    expect(card.byPostMortem).toEqual({
      'continuation:amber:stopped': 1,
      'velocity:green:thesis-break': 1,
      'reversal:amber:market-drag': 1,
      'unknown:amber:adverse-move': 1,
    })
    // the arithmetic: one entry per loser, and the winner in none of them
    expect(Object.values(card.byPostMortem).reduce((s, n) => s + n, 0)).toBe(4)
  })

  it('accumulates across dates and never counts a row twice — a second pass re-grades nothing and re-explains nothing', async () => {
    const store = await seeded()
    // a second date carrying the same shapes, so the roll-up has to add rather than replace
    const second = dateOf(ENTRY_IDX + 1)
    const rows2 = seedRows()
      .filter(p => p.sym === 'STOP' || p.sym === 'LOSE')
      .map(p => ({ ...p, id: `${second}:${p.sym}:long`, date: second }))
    await store.write(`predictions:${second}`, rows2)
    await store.write('predictions-index', [ENTRY, second])

    await gradeOutstanding(store, deps(), NOW, null)
    const first = JSON.stringify(await store.read(`predictions:${ENTRY}`))
    const card1 = (await store.read<{ byPostMortem: Record<string, number> }>('engine-scorecard'))!
    expect(card1.byPostMortem['continuation:amber:stopped']).toBe(2)
    expect(card1.byPostMortem['unknown:amber:adverse-move']).toBe(2)

    // a second run at a later clock: already-graded rows are skipped, so no
    // post-mortem is restamped (`at` would move) and the roll-up is unchanged
    expect((await gradeOutstanding(store, deps(), NOW + 5 * DAY, null)).graded).toBe(0)
    expect(JSON.stringify(await store.read(`predictions:${ENTRY}`))).toBe(first)
    const card2 = (await store.read<{ byPostMortem: Record<string, number> }>('engine-scorecard'))!
    expect(card2.byPostMortem).toEqual(card1.byPostMortem)
  })

  it('REGRET=off is the pre-3b tree exactly: same grades, no class on any loser, no ledger key', async () => {
    // The parity seam (missLedger.ts `regretDisabled`). It exists so the window
    // walk can run itself twice and byte-compare what the reader got; this pins
    // that the switch costs the grade nothing and leaves no trace of itself.
    const on = await seeded()
    expect((await gradeOutstanding(on, deps(), NOW, null)).graded).toBe(5)

    vi.stubEnv('REGRET', 'off')
    const off = await seeded()
    try {
      expect((await gradeOutstanding(off, deps(), NOW, null)).graded).toBe(5)
    } finally {
      vi.unstubAllEnvs()
    }
    const rows = (await off.read<Prediction[]>(`predictions:${ENTRY}`))!
    for (const p of rows) expect(`${p.sym}: ${'postMortem' in p}`).toBe(`${p.sym}: false`)
    expect((await off.read<{ byPostMortem: Record<string, number> }>('engine-scorecard'))!.byPostMortem).toEqual({})
    // (the ledger half of the same switch is pinned in engine.missLedger.test.ts,
    // where a matured trace day exists for it to have measured)
    // …and the grades themselves are untouched: strip the field the ON run added
    // and the two stores hold the same rows, byte for byte
    const stripped = ((await on.read<Prediction[]>(`predictions:${ENTRY}`))!).map(p => {
      const { postMortem: _drop, ...rest } = p
      return rest
    })
    expect(JSON.stringify(rows)).toBe(JSON.stringify(stripped))
  })
})
