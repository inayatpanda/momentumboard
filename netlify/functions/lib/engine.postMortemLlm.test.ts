import { describe, expect, it, vi } from 'vitest'
import { gradeOutstanding, type EngineDeps } from './engine'
import { memoryStore } from './store'
import { POSTMORTEM_LLM_BUDGET } from './postMortemLlm'
import type { Candle } from '../../../shared/types'
import type { Prediction } from '../../../shared/engine/types'

// The budgeted sentence, end to end through the grading pass: who gets asked,
// what a failure costs, and the one path to `news-reversal`.

const T0 = Date.parse('2026-01-05') / 1000
const DAY = 86_400
const BARS = 60
const IDX_A = 30
const IDX_B = 31
const dateOf = (i: number) => new Date((T0 + i * DAY) * 1000).toISOString().slice(0, 10)
const DATE_A = dateOf(IDX_A)
const DATE_B = dateOf(IDX_B)
const NOW = Math.floor(T0 + BARS * DAY)

const tape = (closeAt: (i: number) => number): Candle[] =>
  Array.from({ length: BARS }, (_, i) => {
    const c = closeAt(i)
    return { t: T0 + i * DAY, o: c, h: c * 1.01, l: c * 0.99, c, v: 1_000_000 }
  })

const flat = tape(() => 100)
const stopper = tape(i => (i < IDX_A + 2 ? 100 : 85))
const drifter = tape(i => (i <= IDX_A ? 100 : 100 - (i - IDX_A) * 0.4))
const winner = tape(i => (i <= IDX_A ? 100 : 110))

const TAPES: Record<string, Candle[]> = {
  SPY: flat,
  STOP: stopper,
  DRAG: flat, // never stopped, excess exactly 0 — a market-drag loser
  LOSE: drifter,
  LOSEB: drifter,
  SHDW: drifter,
  WTCH: drifter,
  WIN: winner,
}

const deps = (postMortemSentence?: (prompt: string) => Promise<string>): EngineDeps =>
  ({
    candles: async (sym: string) => TAPES[sym] ?? null,
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
    ...(postMortemSentence ? { postMortemSentence } : {}),
  }) as unknown as EngineDeps

const call = (sym: string, date: string, over: Partial<Prediction> = {}): Prediction =>
  ({
    id: `${date}:${sym}:long`,
    date,
    sym,
    side: 'long',
    composite: 33,
    regime: 'amber',
    probability: 0.55,
    provisional: false,
    grade: 'B',
    riskRung: 3,
    riskPct: 1, // SIZED — the reader had money on it
    priceAtPrediction: 100,
    entry: 100,
    stop: 90,
    target: 120,
    instrument: null,
    setup: 'continuation',
    thesis: 'the base broke on real volume',
    falsifier: 'a close back under 90',
    factors: { technical: { score: 30, detail: '', weight: 1 } },
    ...over,
  }) as unknown as Prediction

/** Four sized losers over two dates — one more than the budget — plus the three
 * kinds of row that must never cost a token: a shadow, a watch row, a winner. */
const seed = async () => {
  const store = memoryStore()
  await store.write(`predictions:${DATE_A}`, [
    call('STOP', DATE_A),
    call('DRAG', DATE_A, { setup: 'reversal' }),
    call('SHDW', DATE_A, { shadow: true, riskPct: 0 }),
    call('WTCH', DATE_A, { watchOnly: true, riskPct: 0 }),
    call('WIN', DATE_A),
  ])
  await store.write(`predictions:${DATE_B}`, [call('LOSE', DATE_B), call('LOSEB', DATE_B)])
  await store.write('predictions-index', [DATE_A, DATE_B])
  return store
}

const rowsOf = async (store: { read: <T>(k: string) => Promise<T | null> }, date: string) => {
  const rows = (await store.read<Prediction[]>(`predictions:${date}`))!
  return Object.fromEntries(rows.map(p => [p.sym, p])) as Record<string, Prediction>
}

const answer = (sentence: string, catalystFlip = false) => JSON.stringify({ sentence, catalystFlip })

describe('gradeOutstanding → the budgeted post-mortem sentence', () => {
  it('buys the newest sized losers a sentence, marks the overflow, and never spends a token on a shadow, a watch row or a winner', async () => {
    const store = await seed()
    const asked: string[] = []
    const llm = vi.fn(async (prompt: string) => {
      asked.push(prompt.split('CALL: ')[1].split(' ')[0])
      return answer('It faded straight after entry and never got back.')
    })

    await gradeOutstanding(store, deps(llm), NOW, null)

    expect(llm).toHaveBeenCalledTimes(POSTMORTEM_LLM_BUDGET)
    // newest date first, worst loss first inside it
    expect(asked).toEqual(['LOSE', 'LOSEB', 'STOP'])

    const a = await rowsOf(store, DATE_A)
    const b = await rowsOf(store, DATE_B)
    for (const p of [b.LOSE, b.LOSEB, a.STOP]) {
      expect(p.postMortem!.sentence).toBe('It faded straight after entry and never got back.')
      expect(p.postMortem!.via).toBe('llm')
    }
    // the fourth sized loser was past the budget and SAYS so
    expect(a.DRAG.postMortem!.via).toBe('budget')
    expect(a.DRAG.postMortem!.sentence).toBeUndefined()
    expect(a.DRAG.postMortem!.cls).toBe('market-drag') // the deterministic line stands

    // unsized rows are explained deterministically and never asked
    for (const p of [a.SHDW, a.WTCH]) {
      expect(p.postMortem!.cls).toBe('adverse-move')
      expect(p.postMortem!.via).toBeUndefined()
      expect(p.postMortem!.sentence).toBeUndefined()
    }
    expect(a.WIN.postMortem).toBeUndefined()
  })

  it('a dead provider costs the sentences and NOTHING else — every grade, every class and every deterministic line survives', async () => {
    const store = await seed()
    const llm = vi.fn(async () => {
      throw new Error('all 2 LLM providers failed — groq HTTP 429 | gemini HTTP 429')
    })

    const withLlm = await gradeOutstanding(store, deps(llm), NOW, null)

    const store2 = await seed()
    const without = await gradeOutstanding(store2, deps(), NOW, null)
    expect(withLlm.graded).toBe(without.graded)

    const a = await rowsOf(store, DATE_A)
    const a2 = await rowsOf(store2, DATE_A)
    const b = await rowsOf(store, DATE_B)
    const b2 = await rowsOf(store2, DATE_B)
    for (const [sym, p] of Object.entries({ ...a, ...b })) {
      const ref = ({ ...a2, ...b2 })[sym]
      expect(p.outcome10).toEqual(ref.outcome10)
      expect(p.postMortem?.cls).toBe(ref.postMortem?.cls)
      expect(p.postMortem?.detail).toBe(ref.postMortem?.detail)
      expect(p.postMortem?.sentence).toBeUndefined()
    }
    // ONE attempt for the whole run: callLlm already tried every provider
    expect(llm).toHaveBeenCalledTimes(1)
    expect(b.LOSE.postMortem!.via).toBe('failed')
  })

  it('an affirmed tone flip is the ONLY door to news-reversal — and the roll-up counts the upgraded class', async () => {
    const store = await seed()
    let n = 0
    const llm = vi.fn(async () => (++n === 1 ? answer('The upgrade that drove it was withdrawn the same week.', true) : answer('It simply drifted.')))

    await gradeOutstanding(store, deps(llm), NOW, null)

    const b = await rowsOf(store, DATE_B)
    expect(b.LOSE.postMortem!.cls).toBe('news-reversal')
    expect(b.LOSE.postMortem!.detail).toContain('adverse-move') // the deterministic class, kept verbatim
    expect(b.LOSE.postMortem!.sentence).toContain('withdrawn')
    // …and the rest of the day is untouched by one flip
    expect(b.LOSEB.postMortem!.cls).toBe('adverse-move')

    // the pass runs BEFORE the scorecard is built, so the roll-up reads the
    // upgraded class rather than lagging a day behind it
    const card = (await store.read<{ byPostMortem: Record<string, number> }>('engine-scorecard'))!
    expect(card.byPostMortem['continuation:amber:news-reversal']).toBe(1)
    expect(card.byPostMortem['continuation:amber:adverse-move']).toBe(3) // LOSEB, SHDW, WTCH
  })

  it('with no sentence dep configured the rows are exactly what Task 2 wrote — no marker, no sentence, no extra field', async () => {
    const store = await seed()
    await gradeOutstanding(store, deps(), NOW, null)
    const rows = [...Object.values(await rowsOf(store, DATE_A)), ...Object.values(await rowsOf(store, DATE_B))]
    for (const p of rows) {
      if (!p.postMortem) continue
      expect(Object.keys(p.postMortem).sort()).toEqual(['at', 'cls', 'detail'])
    }
  })
})
