// The channels' picks — and what the engine thinks (owner request).
//
// The tracked YouTube channels' week of stances has been computed since the
// video lane shipped (netlify/functions/lib/videoTrends.ts — the AI extracts,
// the consensus maths is pure code) and read by nobody outside the paper and
// the social pulse. This is that list on the home screen, and the reason it is
// worth the space is the SECOND column: every name the street is pushing sits
// beside the engine's own current stance on it.
//
// THE ROW ITSELF LIVES IN ChannelPickRow — The street page renders the same
// claim uncapped and fuller (owner: "a new page/tab altogether"), and two
// renderings of one claim would drift. This file is now the home screen's
// framing of it: the thin version, capped by the server at eight.
//
// SECONDARY BY CONSTRUCTION: no skeleton, ever — see OpenCallsStrip's header
// for the rule. Absent picks render nothing at all.

import type { EnginePrediction, OpenTraceEntry } from '../../lib/api'
import type { ChannelPick } from '../../lib/apiViews'
import { ChannelPickRow, indexBoard, indexBySym } from './ChannelPickRow'

export function ChannelPicksStrip({
  picks,
  board,
  openCalls,
}: {
  picks: ChannelPick[] | null | undefined
  board: EnginePrediction[]
  openCalls: OpenTraceEntry[] | undefined
}) {
  if (!picks || picks.length === 0) return null
  const rows = indexBoard(board)
  const open = indexBySym(openCalls ?? [])
  return (
    <section className="cp-strip" aria-label="Channel picks">
      <p className="sec-label">The channels’ picks — and what the engine thinks</p>
      <div className="card cp-list">
        {picks.map(p => (
          <ChannelPickRow key={p.sym} pick={p} row={rows.get(p.sym)} open={open.get(p.sym)} />
        ))}
      </div>
    </section>
  )
}
