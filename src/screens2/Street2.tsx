// THE STREET (owner request, 2026-08-17):
//   "i think the summary of youtube video input deserve a section of their own,
//    and there should be a system where the youtube suggestions are also
//    evaluated by our engine and highlighted - all in a new page/tab
//    altogether. i dont like the intel page which is overwhelmed by news desk."
//
// Everything OTHER PEOPLE say, in one place, with the engine answering back.
// The tracked channels have been analysed since the video lane shipped and the
// app showed eight names of the result on the home screen and nothing else —
// the videos themselves, the deep narrative reads and the whole consensus have
// never been on a screen at all. This page is those, plus the social pulse,
// which left Intel because a crowd's chatter is the same kind of thing a
// channel's video is: an opinion, read and not obeyed.
//
// TWO SLICES, AND THE SECOND ONE IS THE POINT. `street:wire` is this page's
// own (netlify/functions/market-data.mts `type=street`); `board` is the slice
// Today already fetched, and the engine's stance is READ off it rather than
// asked for again. A name on neither today's board nor the open book gets "no
// view", said plainly — see ChannelPickRow for the honesty rules that carries.
//
// EMPTY STATES: each section renders NOTHING when it has nothing (the
// secondary-section rule OpenCallsStrip's header states — a skeleton on a
// section that may legitimately be empty is a lie about loading). The one
// exception is the page as a whole: a screen that renders nothing at all reads
// as broken, so an empty wire says so in a line.

import { useState } from 'react'
import { Link } from 'wouter'
import { useSlice } from '../lib/useSlice'
import { usePullRefresh, useSlicesRefresh, type SliceRefreshEntry } from '../lib/usePullRefresh'
import { getSocialPulse, getStreetWire, type StreetRead, type StreetVideo } from '../lib/api'
import { getBoardSlice } from '../lib/apiViews'
import type { ChannelPick } from '../lib/apiViews'
import type { EnginePrediction, OpenTraceEntry } from '../lib/api'
import { decodeEntities, relativeStamp } from '../lib/format'
import { ChannelPickRow, indexBoard, indexBySym } from './parts/ChannelPickRow'
import { RefreshStrip } from './parts/RefreshStrip'
import { SocialPulse } from './parts/SocialPulse'

/** How many videos the wire shows before the reader asks for more. Twelve is
 * roughly the last three days of the tracked channels — the window in which a
 * stance is still news. */
const WIRE_PAGE = 12

/** THE CHIP COLOUR IS THE STANCE AND NOTHING ELSE. Green and red are reserved
 * app-wide for direction (tokens.css), which is exactly what a bull/bear call
 * is; a neutral mention took no side, so it takes no colour — borrowing one
 * would turn "they said the name out loud" into "they liked it". */
const STANCE_CLASS: Record<StreetVideo['tickers'][number]['stance'], string> = {
  bull: 'pill long',
  bear: 'pill short',
  neutral: 'pill stt-flat',
}

/** HOW THE FACTS WERE OBTAINED, in one word. A model that WATCHED the video
 * saw the levels drawn on charts (EXTRACT_PROMPT_VIDEO says so); one that read
 * a transcript saw only what was spoken. A row from before the field existed
 * carries no `via`, and then this says nothing rather than guessing. */
function ViaMark({ via }: { via: StreetVideo['via'] }) {
  if (!via) return null
  const watched = via === 'gemini-video'
  return (
    <span className="stt-via" title={watched ? 'A model watched the video itself — chart levels included.' : 'A model read the words: the transcript, not the charts.'}>
      {watched ? 'watched' : 'read'}
    </span>
  )
}

/** (a) THE CHANNELS' PICKS — AND WHAT THE ENGINE THINKS. The full board, not
 * the home screen's eight: every name the street took a side on this week,
 * each beside the engine's own read. */
function PicksSection({ consensus, board, openCalls }: { consensus: ChannelPick[]; board: EnginePrediction[]; openCalls: OpenTraceEntry[] | undefined }) {
  // A NEUTRAL MENTION IS NOT A PICK — the same filter the board slice's own
  // channelPicks applies (engine.mts), applied here because this page reads the
  // raw consensus rather than that projection.
  const picks = consensus.filter(p => p.bulls + p.bears > 0)
  if (picks.length === 0) return null
  const rows = indexBoard(board)
  const open = indexBySym(openCalls ?? [])
  return (
    <section id="picks" className="card itl-section stt-picks" aria-label="The channels’ picks">
      <h2 className="sec-label">The channels’ picks — and what the engine thinks</h2>
      <p className="cc-reason itl-feed-intro">
        Every name the tracked channels took a side on this week, most-mentioned first, each beside the engine’s own stance on it.
      </p>
      <div className="cp-list stt-picks-list">
        {picks.map(p => (
          <ChannelPickRow key={p.sym} pick={p} row={rows.get(p.sym)} open={open.get(p.sym)} detailed />
        ))}
      </div>
    </section>
  )
}

/** (b) THE WIRE — WHAT THE CHANNELS SAID. The owner's "summary of youtube
 * video input… a section of their own": one card a video, newest first. */
function WireSection({ videos }: { videos: StreetVideo[] }) {
  const [visible, setVisible] = useState(WIRE_PAGE)
  if (videos.length === 0) return null
  return (
    <section id="wire" className="card itl-section stt-wire">
      <h2 className="sec-label">The wire — what the channels said</h2>
      <p className="cc-reason itl-feed-intro">Every video the desk has analysed, newest first. The chips are the names each one took a side on.</p>
      <div className="stt-video-list">
        {/* url+index: the extracts blob has no URL-level dedup, so a
            re-analysed video can appear twice (the news desk's own key rule) */}
        {videos.slice(0, visible).map((v, i) => (
          <div className="stt-video" key={`${v.url}-${i}`}>
            <div className="stt-video-head">
              <b className="stt-chan">{v.channel}</b>
              <span className="stt-at">{relativeStamp(v.at)}</span>
              <ViaMark via={v.via} />
            </div>
            <a className="stt-video-title" href={v.url} target="_blank" rel="noreferrer">
              {decodeEntities(v.title)}
            </a>
            {(v.tickers.length > 0 || v.themes.length > 0) && (
              <div className="stt-video-meta">
                {v.tickers.map((t, j) => (
                  <Link key={`${t.sym}-${j}`} href={`/stock/${t.sym}`} className={STANCE_CLASS[t.stance] ?? STANCE_CLASS.neutral}>
                    {t.sym}
                  </Link>
                ))}
                {v.themes.map((th, j) => (
                  <span key={`${th}-${j}`} className="stt-theme">
                    {th}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {visible < videos.length && (
        <button type="button" className="stx-showmore" onClick={() => setVisible(videos.length)}>
          Show more ({videos.length - visible})
        </button>
      )}
    </section>
  )
}

/** (c) THE DEEP READS. The watch-tier narrative the engine pays real money for
 * (three a day, capped) — printed as written, because it is already prose and
 * summarising a summary is how a claim drifts. */
function ReadsSection({ reads }: { reads: StreetRead[] }) {
  if (reads.length === 0) return null
  return (
    <section id="reads" className="card itl-section stt-reads">
      <h2 className="sec-label">The deep reads</h2>
      <p className="cc-reason itl-feed-intro">The handful of videos the desk analysed in full, in its own words.</p>
      <div className="stt-read-list">
        {reads.map((r, i) => (
          <figure className="stt-read" key={`${r.url}-${i}`}>
            <blockquote className="stt-read-body">{r.analysis}</blockquote>
            <figcaption className="stt-read-cap">
              <b className="stt-chan">{r.channel}</b>
              <a className="stt-read-title" href={r.url} target="_blank" rel="noreferrer">
                {decodeEntities(r.title)}
              </a>
              <span className="stt-at">{relativeStamp(r.at)}</span>
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  )
}

/** The board slice rides here for its ENGINE STANCE only — same key Today
 * fetches, so opening this page after the home screen costs no request. */
const REFRESH_ENTRIES: SliceRefreshEntry[] = [
  { key: 'street:wire', fetcher: getStreetWire },
  { key: 'board', fetcher: getBoardSlice },
  { key: 'intel:social', fetcher: getSocialPulse },
]

export default function Street2() {
  const { data: wire } = useSlice('street:wire', getStreetWire)
  const { data: boardSlice } = useSlice('board', getBoardSlice)
  const { refresh, refreshing } = useSlicesRefresh(REFRESH_ENTRIES)
  const { pull } = usePullRefresh(refresh)

  const videos = wire?.videos ?? []
  const reads = wire?.reads ?? []
  const consensus = wire?.consensus ?? []
  // RESOLVED AND EMPTY is a different statement from NOT YET LOADED, and only
  // the first one earns the sentence.
  const nothingYet = wire != null && videos.length === 0 && reads.length === 0 && consensus.length === 0

  return (
    <div className="stt">
      <RefreshStrip refreshing={refreshing} pull={pull} onRefresh={refresh} />
      <h1>The street</h1>
      <p className="cc-reason stt-intro">Everything other people are saying — and what the engine says back.</p>
      {nothingYet && <p className="cc-reason">The channels haven’t said anything the engine has read yet — the wire fills as videos land.</p>}
      <div className="stt-grid">
        {/* the wrappers are LAYOUT ONLY: `display: contents` on the phone, so
            the sections stay one column in the order the owner asked for, and
            real columns at desk width, where each side flows independently
            instead of leaving a hole under whichever section is shorter */}
        <div className="stt-col">
          <PicksSection consensus={consensus} board={boardSlice?.board?.board ?? []} openCalls={boardSlice?.openTrace?.entries} />
          <div className="stt-social">
            <SocialPulse />
          </div>
        </div>
        <div className="stt-col">
          <WireSection videos={videos} />
          <ReadsSection reads={reads} />
        </div>
      </div>
    </div>
  )
}
