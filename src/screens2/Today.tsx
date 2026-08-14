// Today — the home screen (plan Task 13). The ratified "Today stack" layout
// (brainstorm/67693-1786687483/content/home-layout.html, option A): today's
// sized calls as big cards up top, then one counts rail (developing / watch /
// refused), then the yesterday strip — everything else is one tap deeper.
//
// Data: ONE slice, `board` (getBoardSlice) — the amendments folded the
// original brief's second fetch (`ledger:2` for yesterday) and the funnel
// count into the board slice itself / a no-fetch chip, so Today never awaits
// more than the one slice it paints from cache first (CX-4's local-first
// contract, useSlice.ts).

import { useSlice } from '../lib/useSlice'
import { getBoardSlice } from '../lib/apiViews'
import { splitBoardRows } from '../lib/boardTaxonomy'
import { NO_SIZED_TODAY } from '../lib/copy'
import { CallCard } from './parts/CallCard'
import { CountsRail } from './parts/CountsRail'
import { IntradayFlagsStrip } from './parts/IntradayFlagsStrip'
import { YesterdayStrip } from './parts/YesterdayStrip'

export default function Today() {
  const { data } = useSlice('board', getBoardSlice)
  const blob = data?.board ?? null
  const rows = blob?.board ?? []
  // "sized" mirrors src/components/EngineBoard.tsx:251's `trades` split — the
  // only rows a grade pill and a probability may ever show on (CallCard's own
  // hard rule, checked again there rather than trusted from here). Shared
  // taxonomy helper (src/lib/boardTaxonomy.ts) so Today, Board, and
  // CountsRail can never drift on what counts as "sized".
  const { sized } = splitBoardRows(rows)

  return (
    <div className="today">
      <div className="today-head">
        <h1>Today</h1>
        {blob && <span className={`pill ${blob.regime === 'green' ? 'accent' : ''}`}>{blob.regime}</span>}
      </div>
      {blob === null ? (
        <>
          <div className="skeleton" style={{ height: 118, marginBottom: 10 }} />
          <div className="skeleton" style={{ height: 118 }} />
        </>
      ) : sized.length === 0 ? (
        <p className="cc-reason">{NO_SIZED_TODAY}</p>
      ) : (
        <div className="today-cards">
          {sized.map(row => (
            <CallCard key={row.id} row={row} />
          ))}
        </div>
      )}
      {/* the morning's setups at today's prices — the board slice has always
          carried them and no v2 screen read them (crypto-v2 wave, finding 8).
          Under the cards, because they are those same cards' levels being
          reached, never new calls. */}
      <IntradayFlagsStrip blob={data?.intradayFlags ?? null} />
      <CountsRail board={rows} />
      <YesterdayStrip yesterday={data?.yesterday ?? null} />
    </div>
  )
}
