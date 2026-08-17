// CryptoWire (owner, 2026-08-17: "i dont see any crpto information anywhere").
//
// He was right. The lane prices BTC and ETH every morning, grades them on their
// own clock and keeps a partition of its own record — and the app rendered NONE
// of it unconditionally: Record's cohort pane only mounts when `learning.crypto`
// is non-null (in production it never has been), and a coin otherwise surfaced
// only if the engine happened to publish one. So this is the one section in the
// app that may NOT go absent-when-empty. It renders on a day the lane says
// nothing, and says that instead.
//
// THREE THINGS, in this order:
//
//  1. THE TAPE. BTC-USD and ETH-USD, through the SAME quotes machinery the
//     watchlist rows use — the `quotes:` namespace, so the record lands in the
//     quotes table on the 120s quote TTL and one in-flight fetch is shared with
//     any other reader of the same key (store.ts). Its OWN key rather than the
//     watchlist's: that one is keyed to whatever the reader happens to hold, and
//     this section's two pairs are not the reader's business. Rendered by
//     StockRow, cache-only on the sparkline (`sparkCachedOnly`) — a decoration
//     must not cost two candle requests on every visit to this screen.
//
//  2. THE ENGINE'S STANCE, under the row-kind law and nothing else. A sized
//     cohort row is a CallCard, exactly as the board renders it, grade and
//     probability and size and its own `WhySized` note included. Every other
//     shape — near miss, observation, watch — gets `unsizedReason` from
//     src/lib/boardTaxonomy.ts and NO letter, NO probability, NO size. The law
//     is imported, never re-derived (the drift Task 17's review had to unpick
//     came from two cards each keeping their own copy of it).
//
//     A crypto row is one the lane STAMPED (`cohort: 'crypto'`) or one whose
//     symbol is a coin (`isCryptoSymbol`) — the same both-doors test
//     ledgerStats.isCryptoCohort makes, so a legacy row published before the
//     stamp existed is still a coin here.
//
//  3. THE BASIS. One standing line (src/lib/copy.ts): what a crypto number in
//     this app even means, and why the lane is observation first.
//
// The board slice is read EAGERLY, unlike this screen's rails. It is the slice
// Today already warmed on the way in, it paints from Dexie before any network
// call, and a section whose whole point is being visible cannot wait for a
// scroll to say what the engine thinks.

import { Link } from 'wouter'
import { useSlice } from '../../lib/useSlice'
import { getQuotes, type EnginePrediction } from '../../lib/api'
import { getBoardSlice } from '../../lib/apiViews'
import { rowKind, unsizedReason } from '../../lib/boardTaxonomy'
import { CRYPTO_BASIS, NO_BOARD_YET, NO_CRYPTO_TODAY } from '../../lib/copy'
import { isCryptoSymbol } from '../../../shared/symbols'
import { CallCard } from './CallCard'
import { CohortPill } from './CohortMarks'
import { StockRow } from './StockRow'
import type { Quote } from '../../../shared/types'

/** The two pairs the wire always shows. The engine's own starter watchlist
 * names the same two (src/lib/starter.ts), and the paper's Crypto Wire is
 * briefed on them (netlify/functions/lib/newspaper.ts). */
export const CRYPTO_WIRE_SYMBOLS = ['BTC-USD', 'ETH-USD']

const QUOTES_KEY = `quotes:${CRYPTO_WIRE_SYMBOLS.join(',')}`

/** Stamped by the lane, or a coin by its symbol — the same both-doors test
 * `ledgerStats.isCryptoCohort` makes over the ledger's rows. */
export const isCryptoRow = (p: EnginePrediction): boolean => p.cohort === 'crypto' || isCryptoSymbol(p.sym)

/** One unsized cohort row: which side, which partition, and the one sentence
 * the row-kind law gives it INSTEAD of a grade. Never a letter, never a
 * probability, never a size — the same rule Board's thin rows and VerdictHero's
 * unsized branch keep. */
function UnsizedCryptoRow({ p }: { p: EnginePrediction }) {
  const kind = rowKind(p)
  return (
    <Link href={`/stock/${p.sym}`} className="card pressable cw-stance">
      <span className="board-row-main">
        <b>{p.sym}</b>
        <span className={`pill ${p.side}`}>{p.side === 'long' ? 'Long' : 'Short'}</span>
        <CohortPill cohort={p.cohort} />
      </span>
      <p className="cc-reason">{unsizedReason(kind, p.belowBase)}</p>
    </Link>
  )
}

function CryptoStance() {
  const { data } = useSlice('board', getBoardSlice)
  if (!data) return <div className="skeleton" style={{ height: 44 }} aria-hidden="true" />
  // the slice landed and there IS no board (cold store, or before the morning's
  // run) — a different fact from "no coin on it", and said as such
  if (!data.board) return <p className="cc-reason">{NO_BOARD_YET}</p>
  const rows = data.board.board.filter(isCryptoRow)
  if (rows.length === 0) return <p className="cc-reason">{NO_CRYPTO_TODAY}</p>
  return (
    <>
      {rows.map(p => (rowKind(p) === 'sized-live' ? <CallCard key={p.id} row={p} /> : <UnsizedCryptoRow key={p.id} p={p} />))}
    </>
  )
}

export function CryptoWire() {
  const { data: quotes } = useSlice<(Quote | null)[]>(QUOTES_KEY, () => getQuotes(CRYPTO_WIRE_SYMBOLS))
  return (
    <section aria-label="Crypto wire" className="cw">
      <p className="sec-label">Crypto wire</p>
      <div className="stx-watchlist">
        {CRYPTO_WIRE_SYMBOLS.map((sym, i) => {
          // by NAME first, by position second: the batch comes back aligned to
          // the request (that is what WatchlistRows' indexOf relies on), but a
          // row that painted the wrong pair's price would be the worst kind of
          // wrong, so the symbol on the record decides whenever it carries one.
          const q = quotes?.find(x => x?.symbol === sym) ?? quotes?.[i] ?? null
          return <StockRow key={sym} symbol={sym} name={q?.name} quote={q} sparkCachedOnly />
        })}
      </div>
      <div className="cw-stances">
        <CryptoStance />
      </div>
      <p className="cc-reason cw-basis">{CRYPTO_BASIS}</p>
    </section>
  )
}
