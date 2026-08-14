import { describe, expect, it } from 'vitest'
import { bookEquity, closeOutMonth, freshBook, manageOpenPositions, runPaperBook, sizePaperPosition, type PaperBook, type PaperPosition } from './paperBook'
import { memoryStore } from './store'
import { velocityTrail } from '../../../shared/engine/velocityLane'
import type { Candle } from '../../../shared/types'
import type { Prediction } from '../../../shared/engine/types'

const mkCandles = (startISO: string, closes: number[]): Candle[] =>
  closes.map((c, i) => ({ t: Date.parse(startISO) / 1000 + i * 86_400, o: c, h: c + 1, l: c - 1, c, v: 1_000_000 }))

const pos = (over: Partial<PaperPosition>): PaperPosition =>
  ({ sym: 'AAA', side: 'long', grade: 'C', openedDate: '2026-07-01', entry: 100, stop: 95, target: 115, qty: 10, costGBP: 1000, ...over })

describe('sizePaperPosition', () => {
  it('risks the given % of equity over the stop distance', () => {
    // equity 10k, risk 1% = £100, stop distance 5 → 20 shares = £2000 cost — capped at 20% (£2000) exactly
    const s = sizePaperPosition(10_000, 10_000, { entry: 100, stop: 95, riskPct: 1 })!
    expect(s.qty).toBe(20)
    expect(s.costGBP).toBe(2000)
  })
  it('caps at 20% of equity and at available cash; skips dust', () => {
    // tight stop would size huge → capped to 20% of equity
    const capped = sizePaperPosition(10_000, 10_000, { entry: 100, stop: 99.5, riskPct: 2 })!
    expect(capped.costGBP).toBeLessThanOrEqual(2000)
    // cash-poor book can't overspend
    const cashCapped = sizePaperPosition(10_000, 500, { entry: 100, stop: 95, riskPct: 1 })!
    expect(cashCapped.costGBP).toBeLessThanOrEqual(500)
    // below £200 isn't worth opening
    expect(sizePaperPosition(10_000, 150, { entry: 100, stop: 95, riskPct: 1 })).toBeNull()
    expect(sizePaperPosition(10_000, 10_000, { entry: 100, stop: 100, riskPct: 1 })).toBeNull()
  })
})

describe('manageOpenPositions', () => {
  it('closes on the first close through the stop (long) and credits the loss', () => {
    const book: PaperBook = { ...freshBook('2026-07'), cash: 9000, positions: [pos({})] }
    const candles = mkCandles('2026-07-01', [100, 98, 94, 105]) // day 3 closes 94 < stop 95
    manageOpenPositions(book, new Map([['AAA', candles]]), '2026-07-06')
    expect(book.positions).toHaveLength(0)
    expect(book.closed[0]).toMatchObject({ reason: 'stop', exit: 94, plGBP: -60 })
    expect(book.cash).toBe(9000 + 1000 - 60)
  })
  it('closes shorts on target and books the gain', () => {
    const book: PaperBook = { ...freshBook('2026-07'), cash: 9000, positions: [pos({ side: 'short', stop: 110, target: 90 })] }
    const candles = mkCandles('2026-07-01', [99, 96, 89])
    manageOpenPositions(book, new Map([['AAA', candles]]), '2026-07-06')
    expect(book.closed[0]).toMatchObject({ reason: 'target', exit: 89, plGBP: 110 })
  })
  it('expires at the 10-session horizon at that close', () => {
    const closes = [101, 102, 101, 103, 102, 104, 103, 105, 104, 106, 108, 109] // never hits 95 stop or 115 target
    const book: PaperBook = { ...freshBook('2026-07'), cash: 9000, positions: [pos({})] }
    manageOpenPositions(book, new Map([['AAA', mkCandles('2026-07-01', closes)]]), '2026-07-20')
    expect(book.closed[0]).toMatchObject({ reason: 'horizon', exit: 108 }) // close of the 10th session after entry day
  })
  it('a position with no exit event stays open and marks to the last close', () => {
    const book: PaperBook = { ...freshBook('2026-07'), cash: 9000, positions: [pos({})] }
    manageOpenPositions(book, new Map([['AAA', mkCandles('2026-07-01', [101, 103])]]), '2026-07-03')
    expect(book.positions).toHaveLength(1)
    expect(bookEquity(book, () => 103)).toBe(9000 + 1000 + 30)
  })
})

// ---- the LIVE velocity trail (Task 6) ----
// Both tapes open on 2026-06-23 so the 2026-07-01 entry sits on eight (or ten)
// sessions of history — the 8-EMA and the prior-five low need it.

/** A run that keeps running: the trail climbs from the published 96.5 to 100.56,
 *  then the tape closes 99 — still 2.5 points ABOVE the published stop. */
const runningTape = () => mkCandles('2026-06-23', [92, 93, 94, 95, 96, 97, 98, 99, 100, 103, 104, 105, 99])

/** The mirror: a shelf sets the published stop at 98 and holds the trail flat AT it
 *  for the whole hold — nothing is ever raised — then a fade drags both legs under
 *  it (97.9 on the last bar) while the close sits at 97.95: above the live trail,
 *  below the published stop. */
const fadingTape = () => mkCandles('2026-06-21', [80, 80, 80, 80, 80, 99, 99, 99, 99, 99, 100, 99.5, 99.2, 99, 99.3, 98.9, 97.95])

/** RISE THEN FALL. Opened 2026-07-01 off a 113 close with a 96.56 published stop;
 *  the trail climbs to 110 by 07-04 and the tape then rolls it back to 105.68 by
 *  07-05, where the close is 107 — inside the live trail, through the earned one. */
const riseThenFallTape = (): Candle[] => {
  const cs = mkCandles('2026-06-20', [70, 70, 70, 70, 70, 70, 70, 70, 110.5, 111, 112, 113, 114, 115, 111, 107])
  cs[14] = { ...cs[14], l: 100 } // the washout wick that drops the low leg
  return cs
}

describe('manageOpenPositions — the velocity trail', () => {
  it('exits a velocity position on the RISEN trail, and leaves the identical non-velocity position alone', () => {
    const cs = runningTape()
    expect(velocityTrail(cs)).toBe(100.21) // the trail on the closing bar, 3.71 above the published stop
    const book: PaperBook = {
      ...freshBook('2026-07'),
      cash: 8000,
      positions: [
        pos({ sym: 'VELO', stop: 96.5, target: 107, trail: 'velocity' }),
        pos({ sym: 'DIPR', stop: 96.5, target: 107 }), // same levels, same tape, no trail
      ],
    }
    manageOpenPositions(book, new Map([['VELO', cs], ['DIPR', cs]]), '2026-07-05')

    expect(book.closed).toHaveLength(1)
    expect(book.closed[0]).toMatchObject({ sym: 'VELO', reason: 'trail', exit: 99, closedDate: '2026-07-05', plGBP: -10 })
    expect(book.positions.map(p => p.sym)).toEqual(['DIPR']) // the published stop never came near
  })

  it('the trail never lowers the exit: a trail under the published stop still exits at the published stop', () => {
    const cs = fadingTape()
    expect(velocityTrail(cs)).toBe(97.9) // …under the 98 the call published
    const book: PaperBook = { ...freshBook('2026-07'), cash: 9000, positions: [pos({ stop: 98, target: 104, trail: 'velocity' })] }
    manageOpenPositions(book, new Map([['AAA', cs]]), '2026-07-07')
    expect(book.closed[0]).toMatchObject({ reason: 'stop', exit: 97.95, closedDate: '2026-07-07' })
  })

  it('the trail RATCHETS: the book exits on the highest level the tape ever drew, not the one it sits at', () => {
    const cs = riseThenFallTape()
    // stated rather than assumed: the trail reached 110 on 07-04 and then the 8-EMA
    // rolled it back to 105.68 — under the 107 close the book is judging.
    expect(velocityTrail(cs.slice(0, 15))).toBe(110)
    expect(velocityTrail(cs)).toBe(105.68)
    const book: PaperBook = {
      ...freshBook('2026-07'),
      cash: 8000,
      positions: [
        pos({ sym: 'VELO', entry: 113, stop: 96.56, target: 130, costGBP: 1130, trail: 'velocity' }),
        pos({ sym: 'DIPR', entry: 113, stop: 96.56, target: 130, costGBP: 1130 }), // same levels, same tape, no trail
      ],
    }
    manageOpenPositions(book, new Map([['VELO', cs], ['DIPR', cs]]), '2026-07-05')

    expect(book.closed).toHaveLength(1)
    expect(book.closed[0]).toMatchObject({ sym: 'VELO', reason: 'trail', exit: 107, closedDate: '2026-07-05' })
    expect(book.positions.map(p => p.sym)).toEqual(['DIPR'])
  })
})

describe('runPaperBook — the marker survives the day it was opened', () => {
  const runningBoardRow = {
    id: '2026-07-01:VELO:long',
    sym: 'VELO',
    side: 'long',
    grade: 'B',
    entry: 100,
    stop: 96.5,
    target: 107,
    riskPct: 1,
    setup: 'velocity',
    trail: 'velocity',
  } as unknown as Prediction

  it('carries trail:velocity onto the position, and a LATER run exits on it with no board row in sight', async () => {
    const store = memoryStore()
    const cs = runningTape()
    const upToEntry = cs.slice(0, 9) // the tape as it stood on the day of the call
    await store.write('engine-board', { date: '2026-07-01', board: [runningBoardRow] })

    const day1 = await runPaperBook(store, { candles: async () => upToEntry }, Date.parse('2026-07-01T12:00:00Z') / 1000)
    expect(day1.positions).toHaveLength(1)
    expect(day1.positions[0]).toMatchObject({ sym: 'VELO', openedDate: '2026-07-01', trail: 'velocity' })

    // Four sessions later the board has moved on and no longer carries VELO at all.
    // The exit must come off the PERSISTED position — the marker is what makes it possible.
    await store.write('engine-board', { date: '2026-07-05', board: [] })
    const day2 = await runPaperBook(store, { candles: async () => cs }, Date.parse('2026-07-05T12:00:00Z') / 1000)
    expect(day2.positions).toHaveLength(0)
    expect(day2.closed).toHaveLength(1)
    expect(day2.closed[0]).toMatchObject({ sym: 'VELO', reason: 'trail', exit: 99, closedDate: '2026-07-05' })
  })

  it('…and an ordinary board row opens with no marker, so nothing else in the book trails', async () => {
    const store = memoryStore()
    const ordinary = { ...runningBoardRow, id: '2026-07-01:DIPR:long', sym: 'DIPR', setup: 'dip', trail: undefined } as unknown as Prediction
    await store.write('engine-board', { date: '2026-07-01', board: [ordinary] })
    const day1 = await runPaperBook(store, { candles: async () => runningTape().slice(0, 9) }, Date.parse('2026-07-01T12:00:00Z') / 1000)
    expect(day1.positions[0].trail).toBeUndefined()

    await store.write('engine-board', { date: '2026-07-05', board: [] })
    const day2 = await runPaperBook(store, { candles: async () => runningTape() }, Date.parse('2026-07-05T12:00:00Z') / 1000)
    expect(day2.closed).toHaveLength(0) // the published stop was never touched
    expect(day2.positions).toHaveLength(1)
  })

  it('refuses the CRYPTO cohort — every mark and exit here is struck off the raw, still-moving tape', async () => {
    const store = memoryStore()
    const coin = { ...runningBoardRow, id: '2026-07-01:BTC-USD:long', sym: 'BTC-USD', cohort: 'crypto', trail: undefined } as unknown as Prediction
    const equity = { ...runningBoardRow, id: '2026-07-01:DIPR:long', sym: 'DIPR', trail: undefined } as unknown as Prediction
    await store.write('engine-board', { date: '2026-07-01', board: [coin, equity] })
    const day1 = await runPaperBook(store, { candles: async () => runningTape().slice(0, 9) }, Date.parse('2026-07-01T12:00:00Z') / 1000)
    // the equity row opened; the coin did not, and the book's equity curve
    // therefore never moves for a bar that has not closed
    expect(day1.positions.map(p => p.sym)).toEqual(['DIPR'])
  })
})

describe('closeOutMonth', () => {
  it('marks open positions to the last close, banks the month, resets nothing it should keep', () => {
    const book: PaperBook = { ...freshBook('2026-07'), cash: 8800, positions: [pos({ qty: 10, costGBP: 1000 })], history: [{ date: '2026-07-31', equity: 9900 }] }
    book.closed.push({ ...pos({}), closedDate: '2026-07-10', exit: 94, plGBP: -60, plPct: -6, reason: 'stop' })
    const m = closeOutMonth(book, () => 110)
    expect(book.positions).toHaveLength(0)
    expect(m).toMatchObject({ month: '2026-07', startGBP: 10_000, trades: 2, wins: 1 })
    expect(m.endGBP).toBe(8800 + 1000 + 100)
    expect(m.returnPct).toBe(-1)
  })
})
