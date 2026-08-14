import type { Candle } from '../../../shared/types'
import type { Prediction } from '../../../shared/engine/types'
import { effectiveVelocityStop } from '../../../shared/engine/velocityLane'
import type { AppStore } from './store'

// THE £10,000 BOOK: a mock account the engine trades with its own calls, so
// "is the tool working?" has a pounds-and-pence answer. Rules, all mechanical:
//   • £10,000 fresh on the first run of each month; the finished month's
//     result is banked into paper-months (permanent) and the book resets.
//   • The engine opens its live board calls (not shadows), sized by its own
//     risk ladder: risk% of equity divided by the stop distance, capped at
//     20% of equity per name, max 8 open, £200 minimum.
//   • Exits on daily CLOSES only, same as grading: stop, target, the
//     10-session horizon, or month-end. Entry marks at the call's printed
//     entry (the close the level was computed from). Currency is nominal
//     "£" 1:1 with the quote currency — it's a mock book, not an FX desk.
//
// …with ONE exit that is not a fixed number: a position opened from a row stamped
// `trail: 'velocity'` carries that stamp (below), and its stop is re-read from the
// tape every run — max(published stop, the highest the lane's trail has been drawn
// since entry). A momentum position is closed by losing its trail, so a book that
// held it to a stale printed level would be reporting a discipline no reader was
// told to follow — and a trail read only as of today would do the same thing more
// quietly, sliding the exit back down behind a rolling 8-EMA. It ratchets.
//
// THE SPLIT, STATED HONESTLY (the same one openTrace.ts documents): GRADING is
// untouched — gradePrediction measures the PUBLISHED stop, so the calibration
// contract and the hit definition stay exactly as they were. This book trades the
// trail. One row can therefore be closed here on a trail hit and later graded
// against a lower level it never had to survive: grading measures the original
// thesis, the book trades the falsifier that was actually in force.

export interface PaperPosition {
  sym: string
  side: 'long' | 'short'
  grade: string
  openedDate: string
  entry: number
  stop: number // the PUBLISHED stop, always: the trail is derived, never stored
  target: number
  qty: number
  costGBP: number // committed capital: qty × entry (shorts: same, as margin)
  // Copied off the board row at entry, and load-bearing: the board moves on
  // overnight, so from tomorrow this position is the ONLY place that remembers
  // its stop was a trail. Without it the marker dies the day after opening and no
  // later run can enforce anything.
  trail?: 'velocity'
}

export interface ClosedTrade extends PaperPosition {
  closedDate: string
  exit: number
  plGBP: number
  plPct: number
  // 'trail' is a stop that MOVED before it fired — recorded separately from 'stop'
  // so a month of exits can be read for what actually closed them.
  reason: 'stop' | 'trail' | 'target' | 'horizon' | 'month-end'
}

export interface PaperBook {
  month: string // '2026-07'
  startGBP: number
  cash: number
  positions: PaperPosition[]
  closed: ClosedTrade[]
  history: { date: string; equity: number }[]
}

export interface PaperMonth {
  month: string
  startGBP: number
  endGBP: number
  returnPct: number
  trades: number
  wins: number
}

const HORIZON_SESSIONS = 10
const MAX_OPEN = 8
const MAX_POSITION_FRAC = 0.2
const MIN_POSITION_GBP = 200
export const BOOK_START_GBP = 10_000

const r2 = (x: number) => Math.round(x * 100) / 100

export const freshBook = (month: string): PaperBook => ({ month, startGBP: BOOK_START_GBP, cash: BOOK_START_GBP, positions: [], closed: [], history: [] })

export const positionPl = (p: PaperPosition, price: number): number => (p.side === 'long' ? (price - p.entry) * p.qty : (p.entry - price) * p.qty)

export const bookEquity = (book: PaperBook, lastCloseOf: (sym: string) => number | null): number =>
  r2(book.cash + book.positions.reduce((s, p) => s + p.costGBP + positionPl(p, lastCloseOf(p.sym) ?? p.entry), 0))

/** Size a new position off current equity: risk% ÷ stop distance, then the
 * caps. Returns null when the maths says the position isn't worth opening. */
export function sizePaperPosition(equity: number, cash: number, call: { entry: number; stop: number; riskPct?: number }): { qty: number; costGBP: number } | null {
  const stopDist = Math.abs(call.entry - call.stop)
  if (!stopDist || call.entry <= 0) return null
  const riskAmount = (equity * (call.riskPct || 1)) / 100
  let qty = riskAmount / stopDist
  qty = Math.min(qty, (equity * MAX_POSITION_FRAC) / call.entry, cash / call.entry)
  const cost = qty * call.entry
  if (cost < MIN_POSITION_GBP) return null
  return { qty: Math.round(qty * 10000) / 10000, costGBP: r2(cost) }
}

/** Walk each open position through the daily closes SINCE it opened and
 * close on the first event: stop / target / the 10-session horizon.
 * Close-based on purpose — identical yardstick to the grading.
 *
 * A `trail: 'velocity'` position is walked against its LIVE stop: the highest the
 * trail has been drawn on any session since entry, floored at the published stop,
 * so it can only ever tighten (`effectiveVelocityStop`). Every other position is
 * compared to the published stop exactly as before — an untrailed row's stop is a
 * fixed number and moving it by a penny would invent an exit the call never made. */
export function manageOpenPositions(book: PaperBook, candlesBySym: Map<string, Candle[]>, todayISO: string): void {
  const still: PaperPosition[] = []
  for (const p of book.positions) {
    const candles = candlesBySym.get(p.sym) ?? []
    const opened = Date.parse(p.openedDate) / 1000
    // `since` is the tail of `candles` (they are chronological), and the trail needs
    // the history BEFORE it too — so the walk keeps the index into the full series.
    const startIdx = candles.findIndex(c => c.t > opened)
    const since = startIdx === -1 ? [] : candles.slice(startIdx)
    // The entry session — the last bar at or before the open, i.e. the close the
    // position was marked at and the basis the published stop was drawn from. The
    // trail RATCHETS from here, so it is where the running max starts.
    const entryIdx = Math.max(0, startIdx - 1)
    let exit: { price: number; date: string; reason: ClosedTrade['reason'] } | null = null
    for (let i = 0; i < since.length; i++) {
      const c = since[i]
      const date = new Date(c.t * 1000).toISOString().slice(0, 10)
      // The stop as it stands on THIS session — the published number for everything
      // that isn't trailed, and for everything that is, the highest the trail has
      // been drawn since entry, never below the published stop.
      const stopNow = p.trail === 'velocity' ? effectiveVelocityStop(p.stop, candles.slice(0, startIdx + i + 1), entryIdx) : p.stop
      if (p.side === 'long' ? c.c <= stopNow : c.c >= stopNow) { exit = { price: c.c, date, reason: stopNow === p.stop ? 'stop' : 'trail' }; break }
      if (p.side === 'long' ? c.c >= p.target : c.c <= p.target) { exit = { price: c.c, date, reason: 'target' }; break }
      if (i + 1 >= HORIZON_SESSIONS) { exit = { price: c.c, date, reason: 'horizon' }; break }
    }
    if (!exit) { still.push(p); continue }
    const plGBP = r2(positionPl(p, exit.price))
    book.cash = r2(book.cash + p.costGBP + plGBP)
    book.closed.push({ ...p, closedDate: exit.date, exit: exit.price, plGBP, plPct: r2((plGBP / p.costGBP) * 100), reason: exit.reason })
  }
  book.positions = still
  void todayISO
}

/** Month rolled over: mark-to-market close whatever is open, bank the month. */
export function closeOutMonth(book: PaperBook, lastCloseOf: (sym: string) => number | null): PaperMonth {
  for (const p of book.positions) {
    const price = lastCloseOf(p.sym) ?? p.entry
    const plGBP = r2(positionPl(p, price))
    book.cash = r2(book.cash + p.costGBP + plGBP)
    book.closed.push({ ...p, closedDate: book.history[book.history.length - 1]?.date ?? book.month, exit: price, plGBP, plPct: r2((plGBP / p.costGBP) * 100), reason: 'month-end' })
  }
  book.positions = []
  const end = r2(book.cash)
  return {
    month: book.month,
    startGBP: book.startGBP,
    endGBP: end,
    returnPct: r2(((end - book.startGBP) / book.startGBP) * 100),
    trades: book.closed.length,
    wins: book.closed.filter(t => t.plGBP > 0).length,
  }
}

/** The daily tick, run from the predict chain after buildBoard. */
export async function runPaperBook(store: AppStore, deps: { candles: (sym: string) => Promise<Candle[] | null> }, nowSec: number): Promise<PaperBook> {
  const todayISO = new Date(nowSec * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
  const month = todayISO.slice(0, 7)

  let book = (await store.read<PaperBook>('paper-book')) ?? freshBook(month)

  // candles for everything the book holds (or held this run)
  const need = [...new Set(book.positions.map(p => p.sym))]
  const candlesBySym = new Map<string, Candle[]>()
  for (const sym of need) {
    const c = await deps.candles(sym).catch(() => null)
    if (c) candlesBySym.set(sym, c)
  }
  const lastCloseOf = (sym: string) => {
    const c = candlesBySym.get(sym)
    return c?.length ? c[c.length - 1].c : null
  }

  if (book.month !== month) {
    const finished = closeOutMonth(book, lastCloseOf)
    const months = ((await store.read<PaperMonth[]>('paper-months')) ?? []).filter(m => m.month !== finished.month)
    months.push(finished)
    months.sort((a, b) => a.month.localeCompare(b.month))
    await store.write('paper-months', months)
    book = freshBook(month)
  }

  manageOpenPositions(book, candlesBySym, todayISO)

  // open today's ACTIONABLE calls the book doesn't already hold — watch-only
  // entries (grade C / low evidence) are observations and never take capital
  //
  // …AND THAT INCLUDES THE 🃏 WILDCARD (Stage 3d, adjudicated in the final
  // review). An experiment row is sized and not watch-only, so it enters the book
  // like any other call, at the quarter-size `riskPct` it published with. That is
  // the consistent answer, not an oversight: this book is a record of OUTCOMES,
  // and it already opens `paperOnly` shorts — rows an ISA could never place —
  // because what it models is the engine's calls, not the reader's brokerage. The
  // accepted cost, stated once: the equity headline carries an experiment's P&L
  // with no mark anywhere near it. Telling the experiment apart is the job of the
  // records built for it — the scorecard's own 🃏 key, the causal ledger, the
  // board's marked row — and the book is deliberately not one of them.
  const boardBlob = await store.read<{ date: string; board: Prediction[] }>('engine-board').catch(() => null)
  // …and NOT the crypto cohort, which is the one row kind this book must refuse
  // (Stage 1c Phase B). Not on the "an ISA could never place it" argument above —
  // that argument is settled and it lets paperOnly shorts in — but on the tape:
  // every mark, every stop walk and every exit here is struck off
  // `deps.candles(sym)`, which for a coin is the RAW Yahoo series INCLUDING
  // today's still-moving 00:00-UTC bar. The crypto partition has a candle seam
  // whose whole purpose is that nothing is ever measured against a bar that has
  // not closed (cryptoCalibration.ts, `completedCryptoBars`), and this book does
  // not go through it: a crypto position would be stopped out on a price six
  // hours old and marked at another, and the equity curve the reader trusts would
  // move for a reason no closed bar supports. The row still publishes, still
  // grades on its own clock and still teaches the crypto partition. Wiring the
  // book to the crypto seam is a recorded follow-up, not a line to slip in here.
  const live = (boardBlob?.board ?? []).filter(b => !b.shadow && !b.watchOnly && b.cohort !== 'crypto')
  for (const call of live) {
    if (book.positions.length >= MAX_OPEN) break
    if (book.positions.some(p => p.sym === call.sym && p.side === call.side)) continue
    const equity = bookEquity(book, lastCloseOf)
    const sized = sizePaperPosition(equity, book.cash, { entry: call.entry, stop: call.stop, riskPct: call.riskPct })
    if (!sized) continue
    book.cash = r2(book.cash - sized.costGBP)
    book.positions.push({
      sym: call.sym, side: call.side, grade: call.grade,
      openedDate: todayISO, entry: call.entry, stop: call.stop, target: call.target,
      qty: sized.qty, costGBP: sized.costGBP,
      // …and the trail marker travels with the position, not with the board row it
      // came from: tomorrow's board no longer has this row, and the exit has to
      // keep working [codex-v2 #10].
      trail: call.trail,
    })
    const c = await deps.candles(call.sym).catch(() => null)
    if (c) candlesBySym.set(call.sym, c)
  }

  const equity = bookEquity(book, lastCloseOf)
  book.history = [...book.history.filter(h => h.date !== todayISO), { date: todayISO, equity }].slice(-40)
  await store.write('paper-book', book)
  return book
}
