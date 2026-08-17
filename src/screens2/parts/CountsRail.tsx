// CountsRail (plan Task 13) — the "everything else, one tap deeper" strip
// from the ratified Today-stack mockup: Developing/Watch counts read straight
// off the board rows already in hand (no extra fetch).
//
// REFUSED CARRIES ITS COUNT NOW (visibility wave, 2026-08-17), superseding the
// Task-13 amendment that left it bare to save a network trip. Two chips
// quantified and a third not reads as "we don't know" — or worse, as a chip
// that does something different from its siblings — and the live desk showed
// the third number is the one that says most about the day (358 refused
// against six watched). The trip is one GET, on the same `funnel:${date}` key
// the Board itself reads, so a reader who opens the board pays for it once.
// It degrades honestly: until the funnel resolves the chip is bare, exactly as
// it was, and it never guesses.

import { Link } from 'wouter'
import type { EnginePrediction } from '../../lib/api'
import { getBoardSlice, getFunnel } from '../../lib/apiViews'
import { useSlice } from '../../lib/useSlice'
import { splitBoardRows } from '../../lib/boardTaxonomy'

/** The funnel is keyed to the BOARD's date, never `funnel:latest` (DS-17) —
 * the same rule BoardColumn's RefusedSection follows, and the same cache. */
function RefusedCount({ date }: { date: string }) {
  const { data } = useSlice(`funnel:${date}`, () => getFunnel(date))
  if (!data || data.missing) return null
  return (
    <>
      {' · '}
      <span className="num">{data.refusals.length}</span>
    </>
  )
}

function RefusedChip() {
  // the board slice Today has already read — same key, so `revalidate`'s
  // in-flight map and the freshness check make this free
  const { data } = useSlice('board', getBoardSlice)
  const date = data?.board?.date ?? null
  return (
    <Link href="/board#refused" className="pill pressable">
      Refused
      {date && <RefusedCount date={date} />}
    </Link>
  )
}

export function CountsRail({ board }: { board: EnginePrediction[] }) {
  // same taxonomy src/components/EngineBoard.tsx:252-253 sorts the board into:
  // nearMiss/observation rows are never "developing" or "watch", they are
  // their own thing and have no chip here. Shared helper
  // (src/lib/boardTaxonomy.ts) so this rail, Board, and Today can never drift
  // on what counts as what.
  const { developing, watch } = splitBoardRows(board)
  return (
    <div className="hrail">
      <Link href="/board#developing" className="pill pressable">
        Developing · <span className="num">{developing.length}</span>
      </Link>
      <Link href="/board#watch" className="pill pressable">
        Watch · <span className="num">{watch.length}</span>
      </Link>
      <RefusedChip />
    </div>
  )
}
