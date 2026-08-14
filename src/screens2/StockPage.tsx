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
// The chart is the app's heaviest component (lightweight-charts) — it is
// React.lazy'd so it stays in its own chunk and never blocks this page's
// first paint, and jsdom (which cannot run it) mocks the module in tests.

import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { useSlice } from '../lib/useSlice'
import { getJourney, getVerdict } from '../lib/apiViews'
import { getCandles, getNews } from '../lib/api'
import { db, getCapital, type RuleItem } from '../lib/db'
import { mirrorConfig } from '../lib/configMirror'
import { fmtPct, fmtPrice } from '../lib/format'
import { engineLevelLines } from '../lib/engineLevels'
import { AlertEditor } from '../components/AlertEditor'
import { PositionCalculator } from '../components/PositionCalculator'
import { VerdictHero } from './parts/VerdictHero'
import { FactorVotes } from './parts/FactorVotes'
import { FunnelPath, funnelDayKind, isPublishedGate } from './parts/FunnelPath'
import { PastCalls } from './parts/PastCalls'
import { OpenTraceCard } from './parts/OpenTraceCard'

const PriceChart = lazy(() => import('../components/PriceChart').then(m => ({ default: m.PriceChart })))

const RANGES = ['3mo', '6mo', '1y'] as const
type Range = (typeof RANGES)[number]

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
function OnDemandRead({ sym }: { sym: string }) {
  const { data } = useSlice(`verdict:${sym}`, () => getVerdict(sym))
  const [added, setAdded] = useState(false)
  const addToWatchlist = async () => {
    await db.watchlist.put({ symbol: sym, addedAt: Date.now(), riskClass: 'normal' })
    setAdded(true)
    mirrorConfig() // CX-22: server-side alerts and cross-device sync depend on it
  }
  if (!data) return <div className="skeleton" style={{ height: 140 }} />
  return (
    <>
      <VerdictHero verdict={data} onWatch={addToWatchlist} watched={added} />
      <FactorVotes computed={data.computed} nulls={data.nulls} />
      <section aria-label="The funnel path">
        <p className="sec-label">The funnel path</p>
        <p className="cc-reason">Not in today's scan universe — the engine never put this name through its gates, so there is no path to show.</p>
      </section>
    </>
  )
}

function Catalysts({ sym }: { sym: string }) {
  const { data } = useSlice(`news:${sym}`, () => getNews(sym))
  const items = (data ?? []).slice(0, 3)
  return (
    <section aria-label="Catalysts">
      <p className="sec-label">Catalysts</p>
      {items.length === 0 ? (
        <p className="cc-reason">No recent headlines for this name.</p>
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

export default function StockPage({ sym }: { sym: string }) {
  const [range, setRange] = useState<Range>('6mo')
  const { data: journey } = useSlice(`journey:${sym}`, () => getJourney(sym))
  const { data: chart } = useSlice(`candles:${sym}:${range}`, () => getCandles(sym, range))
  const [rules, setRules] = useState<RuleItem[]>([])
  const [capital, setCapital] = useState(5000)

  useEffect(() => {
    void db.rules.where('symbol').equals(sym).toArray().then(setRules)
  }, [sym])
  useEffect(() => {
    void getCapital().then(setCapital)
  }, [])

  const row = journey?.boardRow ?? null
  const quote = chart?.quote ?? null
  const candles = chart?.candles ?? []
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
    <div className="stockpage">
      <div className="sp-head">
        <h1>
          {sym}
          {(row?.name ?? quote?.name) && <span className="sp-name">{row?.name ?? quote?.name}</span>}
        </h1>
        {quote && (
          <span className="sp-px num">
            {fmtPrice(quote.price, quote.currency)}
            {quote.changePct != null && <span className={quote.changePct >= 0 ? 'sp-side long' : 'sp-side short'}> {fmtPct(quote.changePct)}</span>}
          </span>
        )}
      </div>

      {/* 1 — the chart, pinned at the top */}
      <section className="sp-chart" aria-label="Price chart">
        <div className="seg" role="group" aria-label="Chart range">
          {RANGES.map(r => (
            <button key={r} aria-pressed={r === range} onClick={() => setRange(r)}>
              {r}
            </button>
          ))}
        </div>
        {candles.length > 1 ? (
          <Suspense fallback={<div className="skeleton sp-chart-skel" />}>
            <PriceChart candles={candles} priceLines={priceLines} height={260} interactive />
          </Suspense>
        ) : (
          <div className="skeleton sp-chart-skel" />
        )}
      </section>

      {journey == null ? (
        <>
          <div className="skeleton" style={{ height: 150, marginTop: 14 }} />
          <div className="skeleton" style={{ height: 90, marginTop: 10 }} />
        </>
      ) : unscanned ? (
        /* 2-4 — the on-demand read replaces hero, votes and funnel path */
        <OnDemandRead sym={sym} />
      ) : (
        <>
          {/* 2 — the verdict */}
          <VerdictHero row={row} refusal={refusal} published={published} nearMissDate={nearMissDate} resolved />
          {/* 3 — the factor votes */}
          <FactorVotes factors={row?.factors} />
          {/* 4 — the funnel path */}
          <FunnelPath days={journey.funnel} />
        </>
      )}

      {/* 5 — every past call, and what price then did */}
      <PastCalls sym={sym} calls={journey?.calls ?? []} />

      {/* 6 — only while a published call is still open */}
      {journey?.openTrace && <OpenTraceCard trace={journey.openTrace} />}

      {/* 7 — the utilities */}
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
      <Catalysts sym={sym} />
    </div>
  )
}
