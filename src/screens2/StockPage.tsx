import { StockContextPanel } from './parts/StockContextPanel'
// StockPage (plan Task 17) — THE journey page: one name, the whole of the
// engine's mind about it. Every symbol anywhere in the app links here.
//
// RATIFIED ORDER (brainstorm/67693-1786687483/content/journey-layout.html,
// option B's verdict hero, placed BELOW the chart): price chart (range pills)
// → the verdict hero → factor votes → the funnel path → past calls → the open
// call, when one is live → the utilities (alerts, position size, catalysts).
//
// DATA — one slice does almost all of it: `journey:${sym}` (getJourney).
// A name today's scan never looked at (no board row, no calls, no funnel) has
// nothing in that slice to render, and falls through to `verdict:${sym}` —
// the on-demand read, which is NEVER dressed as a scanned call (no grade, no
// calibrated probability; see VerdictHero's rule).
//
// THE RANGE PILLS run 1D · 1W · 1M · 3M · 6M · 1Y and open on the MONTH (owner:
// "can i have 1 day and 1 week, 1 month views as well rather than starting with
// 3 months"). The choice is the reader's and it sticks — lib/chartRange.ts owns
// the table, the default and the memory; each range has its own candles slice,
// so switching never overwrites another range's cache.
//
// The chart is the app's heaviest component (lightweight-charts) — it is
// React.lazy'd so it stays in its own chunk and never blocks this page's
// first paint, and jsdom (which cannot run it) mocks the module in tests.

import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { Link } from 'wouter'
import { useSlice } from '../lib/useSlice'
import { getJourney, getVerdict } from '../lib/apiViews'
import { getCandles, getFilings, getNews } from '../lib/api'
import { db, getCapital, type RuleItem } from '../lib/db'
import { mirrorConfig } from '../lib/configMirror'
import { CHART_RANGES, chartRangeOf, readChartRange, writeChartRange, type ChartRangeId } from '../lib/chartRange'
import { fmtPct, fmtPrice, sessionLabel } from '../lib/format'
import { engineLevelLines } from '../lib/engineLevels'
import { AlertEditor } from '../components/AlertEditor'
import { PositionCalculator } from '../components/PositionCalculator'
import { VerdictHero } from './parts/VerdictHero'
import { FactorVotes } from './parts/FactorVotes'
import { FunnelPath, funnelDayKind, isPublishedGate } from './parts/FunnelPath'
import { PastCalls } from './parts/PastCalls'
import { OpenTraceCard } from './parts/OpenTraceCard'
import { SessionLine } from './parts/SessionLine'
import { AskSheet } from './parts/AskSheet'
import type { OpenTraceEntry } from '../lib/api'
import { StrategyLabPanel } from './parts/StrategyLabPanel'
import { BusinessHealthPanel } from './parts/BusinessHealthPanel'
import { CompanySources } from './parts/CompanySources'
import { WatchStockButton } from './parts/WatchStockButton'
import '../styles/dossier.css'

const PriceChart = lazy(() => import('../components/PriceChart').then(m => ({ default: m.PriceChart })))
const RsiChart = lazy(() => import('../components/RsiChart').then(m => ({ default: m.RsiChart })))

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** The on-demand branch: a second slice, a second fetch, and it only ever
 * mounts for a name the scan did not touch — so an ordinary journey page
 * never pays for it. It replaces THREE sections at once: the hero, the factor
 * votes (from `computed`/`nulls`), and the funnel path, which cannot exist
 * for a name that was never in the funnel. */
function OnDemandRead({ sym, openTrace }: { sym: string; openTrace?: OpenTraceEntry | null }) {
  const { data, error, refresh, refreshing } = useSlice(`verdict:${sym}`, () => getVerdict(sym))
  const [added, setAdded] = useState(false)
  const [askOpen, setAskOpen] = useState(false)
  const addToWatchlist = async () => {
    await db.watchlist.put({ symbol: sym, addedAt: Date.now(), riskClass: 'normal' })
    setAdded(true)
    window.dispatchEvent(new Event('mb-watchlist-changed'))
    mirrorConfig() // CX-22: server-side alerts and cross-device sync depend on it
  }
  if (!data && error) return <p role="alert">The stock analysis could not be loaded. <button onClick={refresh} disabled={refreshing}>Retry stock analysis</button></p>
  if (!data) return <div className="skeleton" style={{ height: 140 }} />
  return (
    <>
      <VerdictHero verdict={data} onWatch={addToWatchlist} watched={added} />
      <button type="button" className="ask-open-btn" onClick={() => setAskOpen(true)}>
        Ask the desk
      </button>
      <AskSheet open={askOpen} onClose={() => setAskOpen(false)} sym={sym} verdict={data} openTrace={openTrace} />
      <details className="company-detail"><summary>See the evidence: why this view</summary><FactorVotes computed={data.computed} nulls={data.nulls} />
      <section aria-label="The funnel path">
        <p className="sec-label">The funnel path</p>
        <p className="cc-reason">Not in today's scan universe — the engine never put this name through its gates, so there is no path to show.</p>
      </section>
      </details>
    </>
  )
}

function Catalysts({ sym }: { sym: string }) {
  const { data, error } = useSlice(`news:${sym}`, () => getNews(sym))
  const items = (data ?? []).slice(0, 3)
  return (
    <section aria-label="Catalysts">
      <p className="sec-label">Catalysts</p>
      {items.length === 0 ? (
        <p className="cc-reason">{error ? 'Recent headlines could not be loaded; news risk is unknown.' : !data ? 'Checking recent headlines…' : 'No recent headlines for this name.'}</p>
      ) : (
        /* two wires can carry the SAME url (a syndicated headline) — keying on
           the url alone drops the duplicate rather than showing both */
        items.map((n, i) => (
          <a className="card sp-news pressable" key={`${n.url}-${i}`} href={n.url} target="_blank" rel="noreferrer">
            <span className="sp-news-title">{n.title}</span>
            <span className="sp-news-src">{hostOf(n.url)}</span>
          </a>
        ))
      )}
    </section>
  )
}

function Filings({ sym }: { sym: string }) {
  const { data } = useSlice(`filings:${sym}`, () => getFilings(sym))
  if (!data) return null
  return (
    <section aria-label="Company filings" className="sp-filings">
      <p className="sec-label">Primary-source filings{data.company ? ` · ${data.company}` : ''}</p>
      {data.unavailable ? (
        <p className="cc-reason">SEC filing feed is temporarily unavailable; absence is not being treated as “no filings”.</p>
      ) : data.filings.length === 0 ? (
        <p className="cc-reason">No recent catalyst-class SEC filing surfaced for this symbol.</p>
      ) : (
        data.filings.slice(0, 5).map(filing => (
          <a key={filing.accession} className="catalyst-filing pressable" href={filing.url} target="_blank" rel="noreferrer">
            <span><b>{filing.form}</b>{filing.description && filing.description !== filing.form ? ` · ${filing.description}` : ''}{filing.items ? ` · items ${filing.items}` : ''}</span>
            <span>{filing.filed}</span>
          </a>
        ))
      )}
      <p className="sp-source-line">Source: SEC EDGAR. Links open the original filing.</p>
    </section>
  )
}

export default function StockPage({ sym }: { sym: string }) {
  const [view, setView] = useState<'overview' | 'business' | 'research' | 'tools'>('overview')
  useEffect(() => setView('overview'), [sym])
  // The reader's own last choice, or the month (chartRange.ts owns both). Read
  // lazily — localStorage is touched once per mount, not once per render.
  const [range, setRange] = useState<ChartRangeId>(readChartRange)
  const pickRange = (id: ChartRangeId) => {
    setRange(id)
    writeChartRange(id) // it applies to the NEXT stock page too, not just this one
  }
  const { data: journey, error: journeyError, refresh: retryJourney } = useSlice(`journey:${sym}`, () => getJourney(sym))
  const { data: chart, error: chartError, refresh: retryChart } = useSlice(`candles:${sym}:${range}`, () => getCandles(sym, range))
  const [rules, setRules] = useState<RuleItem[]>([])
  const [capital, setCapital] = useState(5000)
  const [askOpen, setAskOpen] = useState(false)

  useEffect(() => {
    void db.rules.where('symbol').equals(sym).toArray().then(setRules)
  }, [sym])
  useEffect(() => {
    void getCapital().then(setCapital)
  }, [])

  const row = journey?.boardRow ?? null
  const quote = chart?.quote ?? null
  const candles = chart?.candles ?? []
  const intradayRange = chartRangeOf(range).intraday
  // WHAT THE HERO MAY SAY, AND FROM WHICH DAY (Task 17 review, C1).
  //
  // Only the NEWEST funnel day speaks for the hero. The old memo scanned every
  // day for the first non-publication row, so a Monday refusal outlived a
  // Tuesday call: the page said "Not today — refused" about a name the engine
  // had since published. Older days are history and the funnel path below
  // already tells them, in order.
  //
  // And a day is judged WHOLE, by funnelDayKind (the same per-day precedence
  // FunnelPath's dots use): a day carrying ANY `called-*` row PUBLISHED, even
  // if its other side was refused. A refusal row from a day that published is
  // not a refusal — it is one side of a day the engine acted on.
  const newest = useMemo(() => {
    const days = [...(journey?.funnel ?? [])].sort((a, b) => b.date.localeCompare(a.date))
    return days[0] ?? null
  }, [journey])
  const newestKind = newest ? funnelDayKind(newest) : null
  const refusalRow = newest && newestKind === 'refused' ? newest.rows.find(r => !isPublishedGate(r.gate)) : null
  const refusal = newest && refusalRow ? { date: newest.date, row: refusalRow } : null
  // Published on the newest day, and gone from today's board: an honest line
  // about that day, with no grade — the letter belongs to that day's row.
  const publishedRow = newest && newestKind === 'published' ? newest.rows.find(r => isPublishedGate(r.gate)) : null
  const published = newest && publishedRow && !row ? { date: newest.date, gate: publishedRow.gate } : null
  // …and a day that only ever looked: the nearest miss is a real verdict, not
  // an absence, so it must not fall through to the no-read line.
  const nearMissDate = newest && newestKind === 'seen' && newest.nearMiss && !row ? newest.date : null
  // Nothing at all in the scan's record of today: fall through to on demand.
  const unscanned = journey != null && row == null && journey.calls.length === 0 && journey.funnel.length === 0
  // a near miss's levels are synthetic orientation, not a designed trade —
  // drawing them would read as engine conviction (same rule as TickerDetail)
  const priceLines = useMemo(() => (row && !row.nearMiss ? engineLevelLines(row) : []), [row])

  const saveRule = async (kind: 'priceAbove' | 'priceBelow', level: number) => {
    const existing = rules.find(r => r.kind === kind)
    const item: RuleItem = { id: existing?.id ?? `${sym}-${kind}-${Date.now()}`, symbol: sym, kind, level, createdAt: existing?.createdAt ?? Date.now() }
    await db.rules.put(item)
    setRules(r => [...r.filter(x => x.id !== item.id), item])
    mirrorConfig()
  }
  const deleteRule = async (id: string) => {
    await db.rules.delete(id)
    setRules(r => r.filter(x => x.id !== id))
    mirrorConfig()
  }

  return (
    <div className="stockpage company-dossier">
      <p className="dossier-kicker">Company research</p>
      <div className="sp-head">
        <div className="sp-title">
          <button
            type="button"
            className="sp-back"
            aria-label="Back"
            onClick={() => {
              if (window.history.length > 1) window.history.back()
              else window.location.assign('/app/')
            }}
          >
            ←
          </button>
          <h1>
            {sym}
            {(row?.name ?? quote?.name) && <span className="sp-name">{row?.name ?? quote?.name}</span>}
          </h1>
        </div>
        <WatchStockButton symbol={sym} />
        {quote && (
          <span
            className={`sp-px num${quote.stale ? ' stale' : ''}`}
            title={quote.stale ? 'last known price — the live quote is not answering' : undefined}
          >
            {fmtPrice(quote.price, quote.currency)}
            {quote.changePct != null && <span className={quote.changePct >= 0 ? 'sp-side long' : 'sp-side short'}> {fmtPct(quote.changePct)}</span>}
          </span>
        )}
        {!quote && <p className="cc-reason" role="status">{chartError ? 'Price temporarily unavailable' : 'Loading price…'}</p>}
      </div>
      <SessionLine />
      <nav className="dossier-nav stocks-tabs" role="tablist" aria-label="Company research sections">
        {(['overview', 'business', 'research', 'tools'] as const).map((tab, index, tabs) => <button type="button" key={tab} id={`company-tab-${tab}`} role="tab" aria-selected={view === tab} aria-controls={`company-panel-${tab}`} tabIndex={view === tab ? 0 : -1}
          onClick={() => setView(tab)} onKeyDown={event => {
            const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
            if (next >= 0) { event.preventDefault(); setView(tabs[next]); document.getElementById(`company-tab-${tabs[next]}`)?.focus() }
          }}>{tab === 'overview' ? 'Overview' : tab === 'business' ? 'Business' : tab === 'research' ? 'Research' : 'Tools'}</button>)}
      </nav>
      <div id="company-panel-overview" role="tabpanel" aria-labelledby="company-tab-overview" hidden={view !== 'overview'}>

      {/* 1 — the chart, pinned at the top */}
      <section id={`${sym}-price`} className="sp-chart dossier-chart" aria-label="Price chart">
        <div className="dossier-section-head"><h2>Price & trend</h2><span className="dossier-caption">Explore the chart</span></div>
        <div className="seg" role="group" aria-label="Chart range">
          {CHART_RANGES.map(r => (
            <button key={r.id} aria-pressed={r.id === range} onClick={() => pickRange(r.id)}>
              {r.label}
            </button>
          ))}
        </div>
        {/* WHAT YOU ARE ACTUALLY LOOKING AT, on the intraday ranges only: the
            bar size, and WHOSE session — markets are shut most of the hours a
            UK reader is awake, so a 1D chart of a US name at breakfast is
            Friday's tape and must say so rather than imply a live one. */}
        {intradayRange && candles.length > 0 && (
          <p className="sp-chart-when" data-testid="chart-when">
            {chartRangeOf(range).bars} · {sessionLabel(candles[candles.length - 1].t)}
          </p>
        )}
        {candles.length > 1 ? (
          <Suspense fallback={<div className="skeleton sp-chart-skel" />}>
            <PriceChart candles={candles} priceLines={priceLines} height={260} interactive intraday={intradayRange} initialDisplay="line" />
            <details className="company-detail"><summary>See the evidence: price momentum (RSI)</summary><RsiChart candles={candles} intraday={intradayRange} /></details>
          </Suspense>
        ) : chartError ? (
          <p role="alert">The price chart could not be loaded. <button onClick={retryChart}>Retry chart</button></p>
        ) : chart ? (
          <p className="cc-reason">Not enough price history is available for this range.</p>
        ) : (
          <div className="skeleton sp-chart-skel" />
        )}
      </section>

      <div id={`${sym}-thesis`} className="dossier-section">
      {journey == null && journeyError ? (
        <p role="alert">The engine’s stock record could not be loaded. <button onClick={retryJourney}>Retry engine record</button></p>
      ) : journey == null ? (
        <>
          <div className="skeleton" style={{ height: 150, marginTop: 14 }} />
          <div className="skeleton" style={{ height: 90, marginTop: 10 }} />
        </>
      ) : unscanned ? (
        /* 2-4 — the on-demand read replaces hero, votes and funnel path */
        <OnDemandRead sym={sym} openTrace={journey?.openTrace} />
      ) : (
        <>
          {/* 2 — the verdict */}
          <VerdictHero row={row} refusal={refusal} published={published} nearMissDate={nearMissDate} resolved />
          <button type="button" className="ask-open-btn" onClick={() => setAskOpen(true)}>
            Ask the desk
          </button>
          <AskSheet
            open={askOpen}
            onClose={() => setAskOpen(false)}
            sym={sym}
            row={row}
            refusal={refusal}
            published={published}
            nearMissDate={nearMissDate}
            openTrace={journey?.openTrace}
          />
          {/* 3 — the factor votes */}
          <details className="company-detail"><summary>See the evidence: why this view</summary><FactorVotes factors={row?.factors} /></details>
        </>
      )}

      </div>
      <StockContextPanel symbol={sym} context={journey?.stockContext} loading={!journey && !journeyError} />
      <Link className="stocks-today-link" href={`/stocks?view=sell&stock=${encodeURIComponent(sym)}`}><span><strong>Review selling {sym}</strong><small>Check business warnings, price weakness and valuation</small></span><span aria-hidden="true">→</span></Link>
      <div className="company-next"><button onClick={() => setView('business')}><strong>Business & reports</strong><span>Cash flow, financial health and trends →</span></button><button onClick={() => setView('research')}><strong>Research & sources</strong><span>Setups, channel views and past outcomes →</span></button></div>
      </div>
      <div id="company-panel-business" role="tabpanel" aria-labelledby="company-tab-business" hidden={view !== 'business'}>
      <BusinessHealthPanel sym={sym} />
      <Filings sym={sym} />
      </div>
      <div id="company-panel-research" role="tabpanel" aria-labelledby="company-tab-research" hidden={view !== 'research'}>
      <StrategyLabPanel symbol={sym} observations={journey?.lab} />
      {view === 'research' && <CompanySources symbol={sym} />}
      <Catalysts sym={sym} />
      {/* 5 — every past call, and what price then did */}
      <div id={`${sym}-history`} className="dossier-section">
      <PastCalls sym={sym} calls={journey?.calls ?? []} />

      {/* 6 — only while a published call is still open */}
      {journey?.openTrace && <OpenTraceCard trace={journey.openTrace} />}
      {journey && !unscanned && <details className="company-detail"><summary>Daily decision history</summary><FunnelPath days={journey.funnel} /></details>}
      </div>
      </div>
      {/* 7 — the utilities */}
      <div id="company-panel-tools" role="tabpanel" aria-labelledby="company-tab-tools" hidden={view !== 'tools'}>
      <div id={`${sym}-tools`} className="dossier-section dossier-tools">
      <section aria-label="Alerts">
        <p className="sec-label">Price alerts</p>
        <AlertEditor symbol={sym} rules={rules} onSave={saveRule} onDelete={deleteRule} />
      </section>
      {/* the calculator names its own inputs but not itself — a screen reader
          walking this page's landmarks needs to know what this block IS, so it
          is wrapped rather than edited (it is shared with other screens) */}
      <section aria-label="Position size">
        <PositionCalculator
          key={`${sym}-${row?.entry ?? quote?.price ?? 'none'}`}
          defaultEntry={row?.entry ?? quote?.price ?? null}
          defaultStop={row?.stop ?? null}
          riskClass="normal"
          capital={capital}
        />
      </section>
      </div>
      </div>
    </div>
  )
}
