import { ClaimEvidence, ProcessingJobs, SocialLearning } from './parts/SocialEvidence'
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

import { useMemo, useState } from 'react'
import { filterStreetVideos, latestStreetVideos } from '../lib/socialFeed'
import { ChannelCoverage } from './parts/ChannelCoverage'
import { Link } from 'wouter'
import { useSlice } from '../lib/useSlice'
import { usePullRefresh, useSlicesRefresh, type SliceRefreshEntry } from '../lib/usePullRefresh'
import { getSocialPulse, getStreetWire, type StreetRead, type StreetVideo, type StreetWire } from '../lib/api'
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
    <span className="stt-via" title={watched ? 'A model reviewed the video; visual details require verification.' : `${via === 'github' ? 'Captured on GitHub. ' : ''}A model read the words: the transcript, not the charts.`}>
      {watched ? 'watched' : 'read'}
    </span>
  )
}

function VideoHealth({ health, onRefresh }: { health: StreetWire['videoIngestion']; onRefresh: () => unknown }) {
  if (!health) return null
  return <section className="card itl-section" aria-label="YouTube processing status">
    <h2 className="sec-label">YouTube processing</h2>
    <button type="button" className="pill" onClick={onRefresh}>Check for updates</button>
    {health.nativeRunner && <div className="cc-reason">
      <div className="cloud-status-title"><div><strong>Free cloud video research</strong><span>{health.nativeRunner.scheduled ? 'Hourly · Your Mac can stay off' : 'Automatic reads paused'}</span></div><span className="cloud-state">{health.nativeRunner.running ? 'Processing' : health.nativeRunner.capped ? 'Waiting' : health.nativeRunner.status === 'error' ? 'Needs attention' : 'Ready'}</span></div>
      <p>{health.nativeRunner.running ? 'Reading new videos and saving findings.' : health.nativeRunner.status === 'error' ? 'The last read needs attention; saved progress is retained.' : `${health.nativeRunner.published} findings updates · ${health.nativeRunner.failed} unsuccessful on the last run.`} Checked {relativeStamp(health.nativeRunner.at)}.</p>
      {health.nativeRunner.dailyRequests != null && <div className="cloud-allowance"><div><span>Video time used</span><strong>{health.nativeRunner.dailyMinutes} <small>/ {health.nativeRunner.minuteLimit} min</small></strong><progress aria-label="Daily video allowance used" value={health.nativeRunner.dailyMinutes} max={health.nativeRunner.minuteLimit} /></div><div><span>Analysis requests</span><strong>{health.nativeRunner.dailyRequests} <small>/ {health.nativeRunner.requestLimit}</small></strong><progress aria-label="Daily analysis allowance used" value={health.nativeRunner.dailyRequests} max={health.nativeRunner.requestLimit} /></div></div>}
      {health.nativeRunner.pending != null && <p className="cloud-counts"><span><strong>{health.nativeRunner.completed}</strong> finished</span><span><strong>{health.nativeRunner.partial}</strong> partly read</span><span><strong>{health.nativeRunner.pending}</strong> waiting or in progress</span></p>}
      {health.nativeRunner.capped && <p>{health.nativeRunner.pauseReason === 'provider-quota' ? 'Google’s free capacity is temporarily unavailable.' : 'The free processing allowance or service limit has been reached.'} Saved sections are retained; unfinished videos will resume{health.nativeRunner.retryAt ? ` after ${new Date(health.nativeRunner.retryAt * 1000).toLocaleString()}` : ' when capacity returns'}.</p>}
      {health.nativeRunner.stale && <p>No recent check-in; check the cloud run for delays.</p>}
      <details className="company-detail"><summary>How free processing works</summary><p>Saved captions are read first. Other videos continue in consecutive sections with progress saved between hourly runs. Your followed channels take turns.</p><p>Up to 7 hours of video sections and 400 requests per day. Actual throughput depends on lengths, access and the shared project’s free quota. Failed attempts count. The allowance resets at midnight Pacific time. No paid fallback.</p><p>{health.nativeRunner.endReported ?? 0} videos have an ending reported by AI without independent duration confirmation. Partial reads and unconfirmed endings are labelled in Videos.</p></details>
      <a href="https://github.com/inayatpanda/momentumboard/actions/workflows/youtube-native-capture.yml" target="_blank" rel="noopener noreferrer">View direct video reads ↗</a>
    </div>}
    {!!health.nativeProgress?.length && <details><summary>Full-video queue ({health.nativeProgress.length} shown)</summary><ul>{health.nativeProgress.map(w => <li key={w.url}><a href={w.url} target="_blank" rel="noopener noreferrer">{w.title}</a><p className="cc-reason">{w.mode === 'captions' ? 'Reading saved captions' : `${Math.round(w.processedSeconds / 60)} minutes processed${w.sourceDurationSeconds ? ` of ${Math.ceil(w.sourceDurationSeconds / 60)}` : ' · source duration not confirmed'}`} · {w.stage === 'needs-attention' ? 'Repeated access failures' : w.stage === 'retry' ? 'Waiting to retry' : 'Queued to continue'}</p></li>)}</ul></details>}
    {health.githubRunner && <details className="company-detail cc-reason"><summary>Fallback caption & audio capture</summary>
      <p><strong>Cloud collector · GitHub</strong><br />{health.githubRunner.stale ? 'No recent check-in. The schedule may be delayed or stopped.' : health.githubRunner.status === 'error' ? 'The last run stopped early; saved progress is retained.' : health.githubRunner.running ? 'Checking captions and transcribing available audio.' : `${health.githubRunner.saved} saved${health.githubRunner.reused ? ` · ${health.githubRunner.reused} already available` : ''} · ${health.githubRunner.unavailable} unavailable on the last run.`} Last seen {relativeStamp(health.githubRunner.at)}.</p>
      <p>Scheduled every three hours, even when your Mac is off. Up to 12 videos and two audio transcriptions per run. {health.githubLastSavedAt ? `Latest cloud transcript ${relativeStamp(health.githubLastSavedAt)}.` : 'No cloud transcript saved yet.'}</p>
      {health.githubRunner.blocked > 0 && <p>YouTube blocked access to {health.githubRunner.blocked} videos on the last run. They remain pending for later retries.</p>}
      <a href="https://github.com/inayatpanda/momentumboard/actions/workflows/youtube-capture.yml" target="_blank" rel="noopener noreferrer">View cloud runs ↗</a>
    </details>}
    {health.localRunner && <details><summary>Optional Mac backup</summary><p className="cc-reason">{health.localRunner.stale ? 'Not seen recently; resumes when the Mac is awake and connected' : health.localRunner.running ? 'Capturing videos' : `${health.localRunner.saved} saved on its last run`}. Last seen {relativeStamp(health.localRunner.at)}{health.localRunner.buffered ? ` · ${health.localRunner.buffered} captured transcripts waiting to upload` : ''}. This can fill gaps when YouTube blocks cloud access.</p></details>}
    {health.provider && <details><summary>Transcript provider</summary><p className="cc-reason">Supadata: {health.provider.status === 'exhausted' ? 'no credits remaining' : health.provider.status}{health.provider.plan ? ` · ${health.provider.plan}` : ''} · checked {relativeStamp(health.provider.checkedAt)}. GitHub and Mac capture work independently of this subscription.</p></details>}
    <details className="company-detail"><summary>Other processing queues & retries</summary>
    <p className="cc-reason">{health.pendingTranscripts} awaiting captions · {health.queued} queued analyses · {health.deferred} deferred · {health.failed} failed</p>
    <p className="cc-reason">{health.lastExtractAt ? `Latest completed analysis ${relativeStamp(health.lastExtractAt)}.` : 'No completed video analysis yet.'} {health.nextRetryAt ? `Next retry eligible ${new Date(health.nextRetryAt * 1000).toLocaleString()}; completion depends on the next worker run.` : ''}</p>
    {(health.pendingTranscripts > 0 || health.deferred > 0) && <p className="cc-reason">Caption access and daily analysis limits can delay videos. Refresh checks progress; it does not start a new analysis.</p>}
    <ProcessingJobs health={health} onRefresh={onRefresh} />
    {health.recentFailures.length > 0 && <details>
      <summary>Recent processing problems</summary>
      <ul>{health.recentFailures.map((failure, i) => <li key={`${failure.at}-${i}`}>{failure.title || 'Video'}: {failure.reason}</li>)}</ul>
    </details>}
    </details>
  </section>
}

// A deliberately small text renderer: React escapes source text, and no HTML
// or model-provided links are executed. The original video stays the source.
function NarrativeText({ text }: { text: string }) {
  const inline = (value: string) => value.split(/(\*\*[^*]+\*\*)/g).map((part, i) => part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part)
  return <>{text.split(/\n\s*\n/).filter(Boolean).map((block, i) => {
    const lines = block.split('\n').filter(line => line.trim())
    return <div key={i} style={{ marginBottom: 12 }}>{lines.map((line, j) => <p key={j} style={{ margin: '4px 0' }}>{inline(line.replace(/^\s*#{1,6}\s+/, '').replace(/^\s*[-*]\s+/, '• '))}</p>)}</div>
  })}</>
}

/** (a) THE CHANNELS' PICKS — AND WHAT THE ENGINE THINKS. The full board, not
 * the home screen's eight: every name the street took a side on this week,
 * each beside the engine's own read. */
function PicksSection({ consensus, board, openCalls }: { consensus: ChannelPick[]; board: EnginePrediction[]; openCalls: OpenTraceEntry[] | undefined }) {
  // A NEUTRAL MENTION IS NOT A PICK — the same filter the board slice's own
  // channelPicks applies (engine.mts), applied here because this page reads the
  // raw consensus rather than that projection.
  const [expanded, setExpanded] = useState(false)
  const picks = consensus.filter(p => p.bulls + p.bears > 0)
  if (picks.length === 0) return null
  const rows = indexBoard(board)
  const open = indexBySym(openCalls ?? [])
  return (
    <section id="picks" className="card itl-section stt-picks" aria-label="The channels’ picks">
      <h2 className="sec-label">The channels’ picks</h2>
      <p className="cc-reason itl-feed-intro">
        This week’s most-discussed stocks, with the engine’s view alongside.
      </p>
      <div className="cp-list stt-picks-list">
        {(expanded ? picks : picks.slice(0, 6)).map(p => (
          <ChannelPickRow key={p.sym} pick={p} row={rows.get(p.sym)} open={open.get(p.sym)} detailed />
        ))}
      </div>
      {picks.length > 6 && <button className="discovery-more" onClick={() => setExpanded(v => !v)}>{expanded ? 'Show fewer stocks' : `View all ${picks.length} stocks`}</button>}
    </section>
  )
}

/** (b) THE WIRE — WHAT THE CHANNELS SAID. The owner's "summary of youtube
 * video input… a section of their own": one card a video, newest first. */
function WireSection({ videos, channel, onChannel }: { videos: StreetVideo[]; channel: string; onChannel: (name: string) => void }) {
  const [visible, setVisible] = useState(WIRE_PAGE)
  const [query, setQuery] = useState(() => new URLSearchParams(window.location.search).get('stock')?.slice(0, 15) ?? '')
  const [sourcedOnly, setSourcedOnly] = useState(false)
  const filtered = filterStreetVideos(videos, channel, query, sourcedOnly)
  return (
    <section id="wire" className="card itl-section stt-wire">
      <h2 className="sec-label">The wire — what the channels said</h2>
      <p className="cc-reason itl-feed-intro">Latest findings, newest first. Coverage can be partial; open the evidence to check the creator’s words and timestamps.</p>
      <div className="street-filters">
      <label className="street-search">Find a video<input type="search" placeholder="Company, ticker or topic" value={query} onChange={e => { setQuery(e.target.value); setVisible(WIRE_PAGE) }} /></label>
      <label className="discovery-market">YouTube channel
        <select aria-label="YouTube channel" value={channel} onChange={e => { onChannel(e.target.value); setVisible(WIRE_PAGE) }}>
          <option value="">All channels ({videos.length} videos)</option>
          {[...new Set([...videos.map(v => v.channel), ...(channel ? [channel] : [])])].sort().map(name => <option key={name} value={name}>{name} ({videos.filter(v => v.channel === name).length})</option>)}
        </select>
      </label>
      <label className="street-sourced"><input type="checkbox" checked={sourcedOnly} onChange={e => { setSourcedOnly(e.target.checked); setVisible(WIRE_PAGE) }} /> With matched quotes</label>
      </div>
      <p className="social-evidence__note" role="status">{filtered.length} {filtered.length === 1 ? 'video' : 'videos'}{sourcedOnly ? ' with a quote matched to the source. This does not verify the claim itself.' : ''}</p>
      {!filtered.length && <div className="street-empty"><h3>{videos.length ? 'No videos match these filters' : 'No completed videos yet'}</h3><p>{channel ? `No completed analysis is available for ${channel} with these filters. Check Tracking for capture progress.` : 'Try another search, or check Tracking to see what is being processed.'}</p>{(query || channel || sourcedOnly) && <button onClick={() => { setQuery(''); onChannel(''); setSourcedOnly(false) }}>Clear filters</button>}</div>}
      <div className="stt-video-list">
        {/* url+index: the extracts blob has no URL-level dedup, so a
            re-analysed video can appear twice (the news desk's own key rule) */}
        {filtered.slice(0, visible).map((v, i) => (
          <div className="stt-video" key={`${v.url}-${i}`}>
            <div className="stt-video-head">
              <b className="stt-chan">{v.channel}</b>
              <span className="stt-at">{relativeStamp(v.at)}</span>
              <ViaMark via={v.via} />
            </div>
            <a className="stt-video-title" href={v.url} target="_blank" rel="noreferrer">
              {decodeEntities(v.title)}
            </a>
            {v.nativeTranscript && <p className="social-evidence__note">{v.nativeTranscript.progress?.completion === 'complete' ? 'All video sections processed · AI transcription'
              : v.nativeTranscript.progress?.completion === 'end-reported' ? 'Ending reported by AI · full coverage unconfirmed'
                : `Partial video coverage${v.nativeTranscript.progress ? ` · ${Math.round(v.nativeTranscript.progress.processedSeconds / 60)} minutes processed` : ''}`}</p>}
            {v.transcriptMethod === 'speech' && <p className="social-evidence__note">Transcribed from audio{v.via === 'github' ? ' on GitHub' : ' on the Mac'}. Machine transcription can mishear names and numbers; check the linked source.</p>}
            {v.nativeTranscript && <details className="street-video-evidence">
              <summary>AI transcript{v.nativeTranscript.characters > v.nativeTranscript.excerpt.length ? ' excerpt' : ''}</summary>
              <p className="social-evidence__note">{v.nativeTranscript.progress
                ? v.nativeTranscript.progress.completion === 'complete' ? `All ${v.nativeTranscript.progress.sections} sections processed across the known video duration.`
                  : v.nativeTranscript.progress.completion === 'end-reported' ? 'The AI reports reaching the ending; the source duration has not been independently confirmed.'
                    : `Processed through minute ${Math.round(v.nativeTranscript.progress.processedSeconds / 60)}${v.nativeTranscript.progress.sourceDurationSeconds ? ` of ${Math.ceil(v.nativeTranscript.progress.sourceDurationSeconds / 60)}` : ''}. Remaining sections are queued.`
                : `Earlier partial read, limited to the first ${Math.round(v.nativeTranscript.limitSeconds / 60)} minutes.`} Words, numbers and completeness have not been independently verified. These findings do not enter verified consensus or outcome tracking.</p>
              <p className="cc-reason">{v.nativeTranscript.excerpt}</p>
            </details>}
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
            {v.provenance === 'third-party' && <p className="social-evidence__note">Third-party coverage. The creator’s original statement has not been checked; excluded from consensus and learning.</p>}
            {v.provenance === 'manual' && <p className="social-evidence__note">Manually forwarded view. Excluded from automated consensus and learning.</p>}
            {v.claims && <details className="street-video-evidence"><summary>Claims and source excerpts <span>{v.claims.length}</span></summary><ClaimEvidence video={v} /></details>}
            {!v.claims && v.tickers.some(t => t.thesis || t.evidenceQuote) && <details className="cc-reason">
              <summary>What was said and supporting words</summary>
              {v.tickers.filter(t => t.thesis || t.evidenceQuote).map((ticker, j) => <div key={`${ticker.sym}-evidence-${j}`}>
                <p><b>{ticker.company ?? ticker.sym}</b>{ticker.company ? ` (${ticker.sym})` : ''}: {ticker.thesis || 'Source excerpt only.'}{ticker.hype && ' Promotional language flagged.'}</p>
                {ticker.evidenceQuote && <blockquote>{ticker.evidenceQuote}</blockquote>}
              </div>)}
            </details>}
          </div>
        ))}
      </div>
      {visible < filtered.length && (
        <button type="button" className="stx-showmore" onClick={() => setVisible(filtered.length)}>
          Show more ({filtered.length - visible})
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
      <p className="cc-reason itl-feed-intro">AI summaries of the source material. Check the original video before relying on company identities, quoted levels or the creator’s claims.</p>
      <div className="stt-read-list">
        {reads.map((r, i) => (
          <figure className="stt-read" key={`${r.url}-${i}`}>
            <details className="street-read-detail"><summary>Read analysis</summary><blockquote className="stt-read-body"><NarrativeText text={r.analysis} /></blockquote></details>
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
  const { data: wire, error: wireError, refreshing: wireLoading, refresh: retryWire } = useSlice('street:wire', getStreetWire)
  const { data: boardSlice } = useSlice('board', getBoardSlice)
  const { refresh, refreshing } = useSlicesRefresh(REFRESH_ENTRIES)
  const { pull } = usePullRefresh(refresh)

  const [view, setView] = useState<'insights' | 'videos' | 'tracking'>(() => new URLSearchParams(window.location.search).has('stock') ? 'videos' : 'insights')
  const [channel, setChannel] = useState('')
  const videos = useMemo(() => latestStreetVideos(wire?.videos ?? []), [wire?.videos])
  const openChannel = (name: string) => { setChannel(name); setView('videos') }
  const reads = wire?.reads ?? []
  const consensus = wire?.consensus ?? []
  // RESOLVED AND EMPTY is a different statement from NOT YET LOADED, and only
  // the first one earns the sentence.
  const nothingYet = wire != null && videos.length === 0 && reads.length === 0 && consensus.length === 0

  return (
    <div className="stt">
      <RefreshStrip refreshing={refreshing} pull={pull} onRefresh={refresh} />
      <div className="street-heading"><div><p className="stocks-eyebrow">VOICES. EVIDENCE. OUTCOMES.</p><h1>The street</h1></div><Link href="/">Stocks ↗</Link></div>
      <p className="cc-reason stt-intro">What creators are saying, what supports it and what happened next.</p>
      {wire && <button className="street-status" onClick={() => setView('tracking')}><span className="street-status__dot" aria-hidden="true" /><span>{wire.videoIngestion?.lastExtractAt ? `Latest analysis ${relativeStamp(wire.videoIngestion.lastExtractAt)}` : videos.length ? `${videos.length} completed videos in the feed` : 'Waiting for the first completed analysis'}<small>{wire.videoIngestion ? `${wire.videoIngestion.queued} analyses waiting${wire.videoIngestion.failed ? ` · ${wire.videoIngestion.failed} need attention` : ''}` : 'See channel coverage and capture progress'}</small></span><span aria-hidden="true">→</span></button>}
      <div className="stocks-tabs street-tabs" role="tablist" aria-label="Channel research views">
        {(['insights', 'videos', 'tracking'] as const).map((key, index, keys) => <button key={key} role="tab" id={`street-tab-${key}`} aria-controls="street-view" aria-selected={view === key} tabIndex={view === key ? 0 : -1} onClick={() => setView(key)} onKeyDown={e => {
          const next = e.key === 'ArrowRight' ? (index + 1) % keys.length : e.key === 'ArrowLeft' ? (index + keys.length - 1) % keys.length : e.key === 'Home' ? 0 : e.key === 'End' ? keys.length - 1 : -1
          if (next < 0) return
          e.preventDefault(); setView(keys[next]); document.getElementById(`street-tab-${keys[next]}`)?.focus()
        }}>{key === 'insights' ? 'Insights' : key === 'videos' ? 'Videos' : 'Tracking'}</button>)}
      </div>
      {wireError && <section role="alert" aria-label="Video feed error" className="card itl-section">
        <p>{wire ? 'The latest video update failed. Showing saved results.' : 'Video analysis could not be loaded.'}</p>
        <p className="cc-reason">{wireError}</p>
        <button type="button" onClick={retryWire} disabled={wireLoading}>Retry video feed</button>
      </section>}
      {!wire && !wireError && <p className="cc-reason" role="status">Loading video evidence…</p>}
      <div id="street-view" role="tabpanel" aria-labelledby={`street-tab-${view}`}>
      {view === 'insights' ? <>
        {nothingYet && <p className="cc-reason">The channels haven’t said anything the engine has read yet — the wire fills as videos land.</p>}
        <div className="street-insights-grid"><div>
          <PicksSection consensus={consensus} board={boardSlice?.board?.board ?? []} openCalls={boardSlice?.openTrace?.entries} />
          {wire && !nothingYet && !consensus.some(p => p.bulls + p.bears > 0) && <section className="card itl-section"><h2 className="sec-label">No directional consensus yet</h2><p className="cc-reason">Completed videos are available below. A company mention alone does not count as a bullish or bearish call.</p></section>}
          {videos.length > 0 && <section className="card itl-section street-recent" aria-label="Recently analysed videos"><div className="discovery-heading"><h2>Recently analysed</h2><button className="stocks-text-link" onClick={() => openChannel('')}>View all →</button></div>{videos.slice(0, 3).map(v => <button className="street-recent__row" key={v.url} onClick={() => openChannel(v.channel)}><span className="street-recent__play" aria-hidden="true">▷</span><span><small>{v.channel} · {relativeStamp(v.at)}</small><strong>{decodeEntities(v.title)}</strong><small>{v.tickers.map(t => t.sym).slice(0, 4).join(' · ') || 'Market context'}</small></span><span aria-hidden="true">→</span></button>)}</section>}
        </div><div><SocialLearning learning={wire?.socialLearning} /><SocialPulse /></div></div>
      </> : view === 'videos' ? <><WireSection videos={videos} channel={channel} onChannel={setChannel} /><ReadsSection reads={channel ? reads.filter(r => r.channel === channel) : reads} /></> : <>
        <VideoHealth health={wire?.videoIngestion} onRefresh={refresh} />
        <ChannelCoverage health={wire?.videoIngestion} onChannel={openChannel} />
      </>}
      </div>
    </div>
  )
}
