import { describe, expect, it } from 'vitest'
import { bookEquity, closeOutMonth, freshBook, manageOpenPositions, sizePaperPosition, type PaperBook, type PaperPosition } from './paperBook'
import type { Candle } from '../../../shared/types'

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
