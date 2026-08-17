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
import { useLiveQuotes } from '../lib/useLiveQuotes'
import { usePullRefresh } from '../lib/usePullRefresh'
import { getBoardSlice } from '../lib/apiViews'
import type { BoardBlob } from '../lib/apiViews'
import { splitBoardRows } from '../lib/boardTaxonomy'
import { NO_BOARD_YET, NO_SIZED_NO_ROUTE, NO_SIZED_TODAY } from '../lib/copy'
import { CallCard } from './parts/CallCard'
import { ChannelPicksStrip } from './parts/ChannelPicksStrip'
import { CountsRail } from './parts/CountsRail'
import { EventRadarStrip } from './parts/EventRadarStrip'
import { IntradayFlagsStrip } from './parts/IntradayFlagsStrip'
import { OpenCallsStrip } from './parts/OpenCallsStrip'
import { RefreshStrip } from './parts/RefreshStrip'
import { SessionLine } from './parts/SessionLine'
import { StaleBoardNote } from './parts/StaleBoardNote'
import { TodayHeadlines } from './parts/TodayHeadlines'
import { YesterdayStrip } from './parts/YesterdayStrip'

/** THE TAPE LINE (owner iteration 2). The board blob has always carried the
 * world tape's own sentence and the day's news tone, and the screen showed a
 * one-word regime pill and nothing else — so the reader got the engine's
 * verdict on the day with none of the reading behind it. One quiet line under
 * the header; nothing when the blob carries neither. */
function TapeLine({ blob }: { blob: BoardBlob | null }) {
  const detail = blob?.worldTape?.detail?.trim()
  const tone = blob?.newsTone?.label
  if (!detail && !tone) return null
  return (
    <p className="cc-reason today-tape">
      {detail}
      {detail && tone ? ' · ' : ''}
      {tone && <>news tone: {tone}</>}
    </p>
  )
}

export default function Today() {
  // …and the slice's OWN refresh, which no screen had ever called (dynamism
  // wave): a pull on the phone, the ↻ at desk, both driving the one board slice.
  const { data, refreshing, refresh } = useSlice('board', getBoardSlice)
  const { pull } = usePullRefresh(refresh)
  const blob = data?.board ?? null
  const rows = blob?.board ?? []
  // "sized" mirrors src/components/EngineBoard.tsx:251's `trades` split — the
  // only rows a grade pill and a probability may ever show on (CallCard's own
  // hard rule, checked again there rather than trusted from here). Shared
  // taxonomy helper (src/lib/boardTaxonomy.ts) so Today, Board, and
  // CountsRail can never drift on what counts as "sized".
  const { sized, developing, watch, observations } = splitBoardRows(rows)
  // WHICH "nothing sized" SENTENCE (T13a). A day the engine looked at and
  // published nothing at all is not the day it published five rows that cleared
  // every gate and had nowhere to be placed — and until now both got the
  // "nothing cleared its gates" line, printed directly above the rail counting
  // the rows that did. Near misses are deliberately NOT counted here: they
  // cleared no gate, so on a board of nothing but near misses the first
  // sentence is the true one.
  const clearedButUnsized = developing.length + watch.length + observations.length > 0
  // THE LIVE LINE'S SYMBOLS (dynamism wave): the cards the reader can act on —
  // the sized rows, plus the wildcard slot, which is a published call whatever
  // else it is. Nothing else: a quote batch is an API call, and the rows below
  // the fold are watching, not waiting on a price.
  const liveSyms = [...new Set([...sized, ...rows.filter(r => r.wildcard)].map(r => r.sym))]
  const liveQuotes = useLiveQuotes(liveSyms)

  return (
    <div className="today">
      <RefreshStrip refreshing={refreshing} pull={pull} onRefresh={refresh} />
      <div className="today-head">
        <h1>Today</h1>
        {blob && <span className={`pill ${blob.regime === 'green' ? 'accent' : ''}`}>{blob.regime}</span>}
      </div>
      {/* WHEN the reader is (dynamism wave): the session's own state, ticking,
          and the stamp the board has always carried and nothing ever showed. */}
      <SessionLine generatedAt={blob?.generatedAt} />
      <TapeLine blob={blob} />
      {/* …and what the desk has taken in SINCE the run (dynamism wave): three
          headlines, each a door into Intel's news desk. News keeps its one
          home; this is the doorway, not a feed. */}
      <TodayHeadlines />
      {/* …and WHICH DAY these cards belong to (dynamism wave): a weekend
          reader was shown Friday's board unlabelled. Nothing when it is
          today's — the fresh case must stay silent. */}
      <StaleBoardNote date={blob?.date} />
      {data && blob === null ? (
        // the slice RESOLVED and there is no board (cold store, pre-run
        // morning) — an empty state, never a skeleton that looks hung (A1)
        <p className="cc-reason">{NO_BOARD_YET}</p>
      ) : blob === null ? (
        <>
          <div className="skeleton" style={{ height: 118, marginBottom: 10 }} />
          <div className="skeleton" style={{ height: 118 }} />
        </>
      ) : sized.length === 0 ? (
        <p className="cc-reason">{clearedButUnsized ? NO_SIZED_NO_ROUTE : NO_SIZED_TODAY}</p>
      ) : (
        <div className="today-cards">
          {sized.map(row => (
            <CallCard key={row.id} row={row} quote={liveQuotes[row.sym]} />
          ))}
        </div>
      )}
      {/* the morning's setups at today's prices — the board slice has always
          carried them and no v2 screen read them (crypto-v2 wave, finding 8).
          Under the cards, because they are those same cards' levels being
          reached, never new calls. */}
      <IntradayFlagsStrip blob={data?.intradayFlags ?? null} />
      {/* …and then the calls ALREADY on the table (owner iteration 2): the open
          book first, because that is where the reader's money is, then the
          dated prints the engine is watching but refuses to bet. Both render
          nothing at all until their bytes exist — no skeletons on secondary
          sections (the rule OpenCallsStrip's header states). */}
      <OpenCallsStrip entries={data?.openTrace?.entries} />
      <EventRadarStrip radar={data?.eventRadar} />
      {/* …and then the OTHER voice in the room (owner request): what the tracked
          channels have been recommending this week, each name beside the
          engine's own stance on it. Reads only what this slice already carries
          — the picks, today's board rows and the open book — so a name in
          neither says "no view" rather than borrowing a grade. */}
      <ChannelPicksStrip picks={data?.channelPicks} board={rows} openCalls={data?.openTrace?.entries} />
      <CountsRail board={rows} />
      <YesterdayStrip yesterday={data?.yesterday ?? null} />
    </div>
  )
}
