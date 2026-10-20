import { useEffect, useRef, useState } from 'react'
import { Link } from 'wouter'
import { useSlice } from '../lib/useSlice'
import { isNewSince, useNoteSeen, useSeenBaseline } from '../lib/lastSeen'
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
import { StrategyLabPanel } from './parts/StrategyLabPanel'
import { LearningPanel } from './parts/LearningPanel'
import { DecisionCockpit } from './parts/DecisionCockpit'
import '../styles/research.css'

const DESK_VIEWS = ['today', 'research', 'learning'] as const
type DeskView = typeof DESK_VIEWS[number]
const VIEW_LABELS: Record<DeskView, string> = { today: 'Today', research: 'Research', learning: 'Learning' }

function useMobileDesk() {
  const read = () => typeof window !== 'undefined' && window.innerWidth <= 760
  const [mobile, setMobile] = useState(read)
  useEffect(() => {
    const update = () => setMobile(read())
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  return mobile
}

function MarketContext({ blob }: { blob: BoardBlob | null }) {
  const detail = blob?.worldTape?.detail?.trim()
  const tone = blob?.newsTone?.label
  return <section className="research-weather" aria-label="Market context">
    <div className="research-weather-title">
      <svg width="34" height="34" viewBox="0 0 34 34" fill="none" aria-hidden="true"><path d="M4 24h26M8 29h18M10 24a7 7 0 0 1 14 0M17 4v5M5 10l4 4M29 10l-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      <div><span className="research-eyebrow">Daily weather</span><strong>Market context</strong></div>
    </div>
    <dl className="research-weather-readings">
      <div><dt>International tape</dt><dd>{blob?.worldTape?.tone ?? 'Awaiting data'}</dd></div>
      <div><dt>News tone</dt><dd>{tone ?? 'Awaiting data'}</dd></div>
      <div><dt>Board regime</dt><dd>{blob?.regime ?? 'Awaiting data'}</dd></div>
    </dl>
    {(detail || tone) && <p className="today-tape research-weather-note">{detail}{detail && tone ? ' · ' : ''}{tone && <>news tone: {tone}</>}</p>}
  </section>
}

export default function Today() {
  // One cached board slice owns the published calls, research and learning.
  const [newsOpen, setNewsOpen] = useState(false)
  const [view, setView] = useState<DeskView>('today')
  const mobile = useMobileDesk()
  const tabs = useRef<Partial<Record<DeskView, HTMLButtonElement | null>>>({})
  const { data, refreshing, refresh, error } = useSlice('board', getBoardSlice)
  const { pull } = usePullRefresh(refresh)
  const blob = data?.board ?? null
  const rows = blob?.board ?? []
  const { sized, developing, watch, observations } = splitBoardRows(rows)
  const clearedButUnsized = developing.length + watch.length + observations.length > 0
  const liveSyms = [...new Set([...sized, ...rows.filter(r => r.wildcard)].map(r => r.sym))]
  const liveQuotes = useLiveQuotes(liveSyms)
  const seen = useSeenBaseline()
  const boardIsNew = isNewSince(blob?.generatedAt, seen?.boardGeneratedAt ?? null)
  useNoteSeen({ boardGeneratedAt: blob?.generatedAt ?? null })

  return (
    <div className="today research-desk">
      <RefreshStrip refreshing={refreshing} pull={pull} onRefresh={refresh} />
      {mobile && <div className="brief-appbar"><span className="brief-wordmark"><span aria-hidden="true">↗</span> StreetSignal</span><div>
        <Link href="/stocks" className="brief-icon-button" aria-label="Search stocks"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg></Link>
        <button type="button" className="brief-icon-button" aria-label="Refresh daily brief" disabled={refreshing} onClick={refresh}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 11a8 8 0 1 0-2 6M20 4v7h-7"/></svg></button>
      </div></div>}
      <header className="research-hero">
        <div>
          <p className="research-eyebrow">{mobile ? new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London' }).format(new Date()) : 'StreetSignal / today'}</p>
          <div className="research-heading"><h1>{mobile ? 'Your daily brief' : 'Research desk'}</h1>{boardIsNew && <span className="new-dot" aria-label="New board since your last visit" />}</div>
          {!mobile && <p className="research-deck">Understand the setup. Test the thesis. Learn from the outcome.</p>}
          <SessionLine generatedAt={blob?.generatedAt} />
        </div>
        <nav className="research-jump" aria-label="Research desk sections">
          <a href="#published-calls">Calls <span aria-hidden="true">↗</span></a>
          <a href="#opportunities">Research <span aria-hidden="true">↗</span></a>
          <a href="#historical-learning">Learning <span aria-hidden="true">↗</span></a>
        </nav>
      </header>
      {mobile && <nav className="mobile-desk-tabs" role="tablist" aria-label="Daily brief views">
        {DESK_VIEWS.map(key => <button key={key} ref={el => { tabs.current[key] = el }} type="button" role="tab"
          id={`brief-tab-${key}`} aria-selected={view === key} aria-controls={`brief-panel-${key}`} tabIndex={view === key ? 0 : -1}
          onClick={() => setView(key)} onKeyDown={event => {
            const index = DESK_VIEWS.indexOf(key)
            const next = event.key === 'ArrowRight' ? DESK_VIEWS[(index + 1) % DESK_VIEWS.length]
              : event.key === 'ArrowLeft' ? DESK_VIEWS[(index + DESK_VIEWS.length - 1) % DESK_VIEWS.length]
                : event.key === 'Home' ? DESK_VIEWS[0] : event.key === 'End' ? DESK_VIEWS[DESK_VIEWS.length - 1] : null
            if (next) { event.preventDefault(); setView(next); tabs.current[next]?.focus() }
          }}>{VIEW_LABELS[key]}</button>)}
      </nav>}
      {!mobile && <><MarketContext blob={blob} /><DecisionCockpit data={data} /></>}
      {error && <section className="card research-error" role="alert" aria-label="Board refresh failed">
        <p><strong>{blob ? 'The board could not refresh. Showing the saved board.' : "Today's board could not load."}</strong></p>
        <p>{error}</p>
        <button type="button" className="mini-btn" onClick={refresh} disabled={refreshing}>Retry board</button>
      </section>}
      <div id="brief-panel-today" role={mobile ? 'tabpanel' : undefined} aria-labelledby={mobile ? 'brief-tab-today' : undefined} hidden={mobile && view !== 'today'}>
      {mobile && <details className="mobile-market-details">
        <summary><span>Market backdrop</span><span className="mobile-market-tone">{blob?.worldTape?.tone ?? 'Awaiting data'}</span><span className="mobile-market-chevron" aria-hidden="true">⌄</span></summary>
        <MarketContext blob={blob} /><DecisionCockpit data={data} />
      </details>}
      <section id="published-calls" className="research-section research-calls" aria-label="Published and active calls">
        <div className="research-section-head">
          <div><p className="research-eyebrow">01 / The live board</p><h2>Published calls</h2></div>
          {blob && <span className="research-count num">{sized.length} sized {sized.length === 1 ? 'call' : 'calls'}</span>}
        </div>
        <StaleBoardNote date={blob?.date} />
        {error && blob === null ? null : data && blob === null ? <p className="research-empty">{NO_BOARD_YET}</p>
          : blob === null ? <div aria-label="Loading board"><div className="skeleton" style={{ height: 118, marginBottom: 10 }} /><div className="skeleton" style={{ height: 118 }} /></div>
          : sized.length === 0 ? <p className="research-empty">{clearedButUnsized ? NO_SIZED_NO_ROUTE : NO_SIZED_TODAY}</p>
          : <div className={`today-cards${mobile ? ' brief-call-list' : ''}`}>{sized.map(row => <CallCard key={row.id} row={row} quote={liveQuotes[row.sym]} compact={mobile} />)}</div>}
        {mobile && blob && sized.length === 0 && <button type="button" className="brief-research-link" onClick={() => setView('research')}>Explore research ideas <span aria-hidden="true">→</span><small>Quality dips, shorter-term setups and their evidence</small></button>}
        <IntradayFlagsStrip blob={data?.intradayFlags ?? null} />
        <OpenCallsStrip entries={data?.openTrace?.entries} closed={data?.openTrace?.closed} />
        <CountsRail board={rows} />
      </section>
      {mobile && <nav className="mobile-brief-links" aria-label="Explore intelligence">
        <Link href="/intel#news"><span className="brief-explore-icon" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M5 4h14v16H5zM8 8h8M8 12h8M8 16h5"/></svg></span><span>News & events<small>What’s moving markets</small></span><span aria-hidden="true">↗</span></Link>
        <Link href="/more/street"><span className="brief-explore-icon" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="4"/><path d="m10 9 5 3-5 3z"/></svg></span><span>YouTube & social<small>Follow the evidence</small></span><span aria-hidden="true">↗</span></Link>
      </nav>}
      </div>
      <div id="brief-panel-research" role={mobile ? 'tabpanel' : undefined} aria-labelledby={mobile ? 'brief-tab-research' : undefined} hidden={mobile && view !== 'research'}>
      <div id="opportunities"><StrategyLabPanel lab={data?.engineLab} /></div>
      </div>
      <div id="brief-panel-learning" role={mobile ? 'tabpanel' : undefined} aria-labelledby={mobile ? 'brief-tab-learning' : undefined} hidden={mobile && view !== 'learning'}>
      <div id="historical-learning" className="research-section">
        <LearningPanel learning={data?.engineLab?.learning} />
        <YesterdayStrip yesterday={data?.yesterday ?? null} />
      </div>
      </div>
      {!mobile && <section className="research-section research-intelligence" aria-label="News and social intelligence">
        <div className="research-section-head"><div><p className="research-eyebrow">04 / Wider context</p><h2>Intelligence notebook</h2></div><span className="research-section-note">Open the evidence behind the noise</span></div>
        <div className="research-notebook-grid">
          <details className="research-disclosure" onToggle={e => setNewsOpen(e.currentTarget.open)}><summary><span><strong>News & upcoming events</strong><small>Latest headlines and the earnings calendar</small></span><span className="research-disclosure-plus" aria-hidden="true">+</span></summary>
            <div className="research-disclosure-body">{newsOpen && <TodayHeadlines />}<EventRadarStrip radar={data?.eventRadar} /><Link className="research-text-link" href="/intel#news">Open the news desk →</Link></div>
          </details>
          <details className="research-disclosure"><summary><span><strong>What the channels are saying</strong><small>Video commentary alongside the engine’s own view</small></span><span className="research-disclosure-plus" aria-hidden="true">+</span></summary>
            <div className="research-disclosure-body"><ChannelPicksStrip picks={data?.channelPicks} board={rows} openCalls={data?.openTrace?.entries} />{!data?.channelPicks?.length && <p className="research-muted">No channel picks are available in this board snapshot.</p>}<Link className="research-text-link" href="/more/street">Open the Street →</Link></div>
          </details>
        </div>
      </section>}
    </div>
  )
}
