// Intel (plan Task 19; CX-19 — restructured by owner iteration 2) — the news
// desk, the insider clusters and the congressional filings. This is news's
// ONLY home in the app (spec §3.5): a side dish, never the meal.
//
// THE OWNER'S REVIEW REBUILT THIS PAGE:
//   "The Daily bulletin takes up the entire space, and scrolling is difficult
//    to reach directly to the News desk without scrolling through the entire
//    bulletin. News desk doesnt show date of news. Intel doesnt show insider
//    news/buying congressional things."
// So: a STICKY chip row jumps to any section in one tap; every headline
// carries a stamp; and the two feeds the engine has always collected and never
// shown — insider clusters and congressional disclosures — get sections of
// their own.
//
// THE PAGE THINNED TWICE (owner 2026-08-17). "The Daily bulletin takes up the
// entire space" took the paper to its own tab; "i dont like the intel page
// which is overwhelmed by news desk" took the social pulse to The street, with
// the channels' videos — the same kind of thing, other people's opinions. What
// is left is the three feeds that are reported FACT: what was published, who
// bought their own stock, and what Congress filed.
//
// Three stacked sections, each its OWN `useSlice` + skeleton: one section's
// failure (a rejected fetch, or simply not yet cached) must never blank the
// others. `useSlice` already never throws into render — a failed fetch just
// flips `offline` and leaves `data` at whatever was cached (null on a cold
// slice) — so this file needs no error boundary of its own.

import { useState } from 'react'
import { Link } from 'wouter'
import { useSlice } from '../lib/useSlice'
import { usePullRefresh, useSlicesRefresh, type SliceRefreshEntry } from '../lib/usePullRefresh'
import { RefreshStrip } from './parts/RefreshStrip'
import { db } from '../lib/db'
import { getCongress, getInsiderClusters, getNewsDesk } from '../lib/api'
import type { CongressTrade, InsiderCluster } from '../lib/api'
import { compactUsd, decodeEntities, longDate, relativeStamp } from '../lib/format'

const PAGE = 30
const FEED_PAGE = 12

/** WHAT THE PILL ON A HEADLINE IS. The news editor scores every headline for
 * importance, 0–100 (lib/api.ts's NewsDeskItem doc) — a bare indigo `35`
 * beside a headline said nothing about which direction was good. */
const SCORE_HINT = 'triage score 0–100'

/** The STOCK Act's disclosure window. A filing inside it is simply a filing;
 * past it, the gap between trading and telling is itself the information. */
const DISCLOSURE_WINDOW_DAYS = 45

/** The jump rail's targets, in page order. Ids live on the sections.
 * The paper left this page for its own tab (owner 2026-08-17) — the news
 * desk is now the first thing on Intel, which is where the reader's most
 * frequent check belongs — and the social pulse left for The street (owner:
 * "i dont like the intel page which is overwhelmed by news desk"), where it
 * sits with the other opinions the engine reads and does not obey. */
const SECTIONS = [
  { id: 'news', label: 'News' },
  { id: 'insiders', label: 'Insiders' },
  { id: 'congress', label: 'Congress' },
] as const

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** Whole days between two ISO calendar dates. Manual parse via Date.UTC, the
 * same timezone-proofing rule src/lib/format.ts states: a bare YYYY-MM-DD fed
 * to `new Date()` is UTC midnight and walks a day west of Greenwich. */
function daysBetween(fromIso: string, toIso: string): number | null {
  const p = (s: string) => {
    const [y, m, d] = (s ?? '').split('-').map(Number)
    return Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d) ? Date.UTC(y, m - 1, d) : null
  }
  const a = p(fromIso)
  const b = p(toIso)
  if (a == null || b == null) return null
  return Math.round((b - a) / 86_400_000)
}

/** THE JUMP RAIL (owner iteration 2). Anchor links, so they work with no JS at
 * all and read as links to a screen reader; the click handler only upgrades
 * the jump to a smooth one. `scroll-margin-top` on the sections keeps the
 * landing heading clear of this very rail. */
function JumpChips() {
  return (
    <nav className="itl-jump" aria-label="Jump to a section">
      {SECTIONS.map(s => (
        <a
          key={s.id}
          href={`#${s.id}`}
          className="pill itl-jump-chip"
          onClick={e => {
            const el = document.getElementById(s.id)
            if (!el) return // no element, no upgrade — let the plain anchor do its job
            e.preventDefault()
            el.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }}
        >
          {s.label}
        </a>
      ))}
    </nav>
  )
}

function NewsSection() {
  const { data } = useSlice('intel:news', getNewsDesk)
  const [visible, setVisible] = useState(PAGE)
  // NEWEST FIRST, asserted here rather than assumed of the server (owner
  // iteration 2). The desk documents itself as newest-first; a feed that has
  // been re-triaged or merged can arrive otherwise, and an out-of-order dated
  // list is worse than an undated one.
  const rows = data ? [...data].sort((a, b) => (b.at ?? 0) - (a.at ?? 0)) : []

  return (
    <section id="news" className="card itl-section">
      <h2 className="sec-label">News desk</h2>
      {!data ? (
        <div className="skeleton" style={{ height: 160 }} />
      ) : rows.length === 0 ? (
        <p className="cc-reason">Nothing fresh right now.</p>
      ) : (
        <>
          {/* the pills had no key anywhere on the page (visibility wave) */}
          <p className="cc-reason itl-feed-intro">Every headline the desk triaged, newest first. The pill is its importance score, 0–100.</p>
          <div className="itl-news-list">
            {rows.slice(0, visible).map((item, i) => (
              // url+index: the desk's stored array has no URL-level dedup, so a
              // re-triaged URL can appear twice (same fix as StockPage's catalysts)
              <div key={`${item.url}-${i}`} className="itl-news-row">
                <a className="itl-news-title" href={item.url} target="_blank" rel="noreferrer">
                  {decodeEntities(item.title)}
                </a>
                <div className="itl-news-meta">
                  {/* the stamp first — the owner's complaint was that a big
                      collection of cards said nothing about when any of it happened */}
                  <span className="itl-news-at">{relativeStamp(item.at)}</span>
                  {/* WHO published it (owner 2026-08-17: a desk that was 100%
                      "finnhub.io" — the url's host is the aggregator, the
                      `source` field is the outlet). Host only as fallback. */}
                  <span className="itl-news-host">{item.source ?? hostOf(item.url)}</span>
                  {item.syms.map(s => (
                    <Link key={s} href={`/stock/${s}`} className="pill">
                      {s}
                    </Link>
                  ))}
                  <span className="pill accent num" title={SCORE_HINT}>
                    {item.score}
                  </span>
                </div>
              </div>
            ))}
          </div>
          {visible < rows.length && (
            <button type="button" className="stx-showmore" onClick={() => setVisible(rows.length)}>
              Show more ({rows.length - visible})
            </button>
          )}
        </>
      )}
    </section>
  )
}

/** INSIDERS (owner iteration 2). The engine's daily rotation has been
 * collecting per-symbol insider coverage all along and the app never showed a
 * row of it. Open-market buying clusters only — a single officer's scheduled
 * sale is noise, several distinct buyers inside ninety days is not. */
/** A LONE BUYER IS NOT A CLUSTER (visibility wave, 2026-08-17). The section's
 * whole claim is "several distinct buyers inside ninety days", and a one-buyer
 * row is the single officer the intro explicitly calls noise — printed at the
 * top, in the same weight, under a heading that says cluster. Stable sort, so
 * the server's own ordering survives inside each group; the singles simply go
 * last, where the reader meets them after the rows that earned the heading. */
export function orderClusters(rows: InsiderCluster[]): InsiderCluster[] {
  return [...rows].sort((a, b) => (a.buyers > 1 ? 0 : 1) - (b.buyers > 1 ? 0 : 1))
}

function InsidersSection() {
  const { data } = useSlice('intel:insiders', getInsiderClusters)
  const [visible, setVisible] = useState(FEED_PAGE)
  const clusters = orderClusters(data?.clusters ?? [])

  return (
    <section id="insiders" className="card itl-section">
      <h2 className="sec-label">Insider buying</h2>
      {!data ? (
        <div className="skeleton" style={{ height: 120 }} />
      ) : clusters.length === 0 ? (
        <p className="cc-reason">No insider-buying clusters in the engine's coverage yet.</p>
      ) : (
        <>
          <p className="cc-reason itl-feed-intro">Distinct open-market buyers over the last ~90 days, across the names the engine covers.</p>
          <div className="itl-feed-list">
            {clusters.slice(0, visible).map(c => (
              <div className={`itl-feed-row${c.buyers === 1 ? ' itl-feed-lone' : ''}`} key={c.symbol}>
                <Link href={`/stock/${c.symbol}`} className="itl-feed-sym">
                  {c.symbol}
                </Link>
                <span className="num itl-feed-strong">
                  {c.buyers} {c.buyers === 1 ? 'buyer' : 'buyers'}
                </span>
                {c.buyers === 1 && <span className="itl-feed-note">— not yet a cluster</span>}
                <span className="num itl-feed-strong">{compactUsd(c.totalValueUsd)}</span>
                <span className="num itl-feed-date">last {longDate(c.lastDate)}</span>
                {c.names.length > 0 && <span className="itl-feed-names">{c.names.join(', ')}</span>}
              </div>
            ))}
          </div>
          {visible < clusters.length && (
            <button type="button" className="stx-showmore" onClick={() => setVisible(clusters.length)}>
              Show more ({clusters.length - visible})
            </button>
          )}
        </>
      )}
    </section>
  )
}

/** HOW LATE, against the statutory window rather than against zero. The row
 * already prints the raw gap ("disclosed 217d later"), which is the whole
 * distance from trade to filing — of which the first 45 days are simply the
 * law. The overrun is the part that is information about the filer, so that is
 * the number the cue carries. Null when the filing was inside the window, or
 * when either date is missing. (Visibility wave, 2026-08-17.) */
export function daysLate(traded: string, filed: string): number | null {
  const lag = daysBetween(traded, filed)
  if (lag == null || lag <= DISCLOSURE_WINDOW_DAYS) return null
  return lag - DISCLOSURE_WINDOW_DAYS
}

/** One disclosure row. `side` IS the direction, so it carries the long/short
 * colours the rest of the app uses for exactly that — a bought line and a sold
 * line must never read the same at a glance.
 *
 * `flagLate` only on the watchlist block: a reader scanning their OWN names is
 * the reader for whom "and nobody was told for seven months" changes what the
 * row means. On the general feed it would be a chip on nearly every line. */
function CongressRow({ t, flagLate = false }: { t: CongressTrade; flagLate?: boolean }) {
  const lag = daysBetween(t.traded, t.filed)
  const late = flagLate ? daysLate(t.traded, t.filed) : null
  return (
    <div className="itl-feed-row itl-congress-row">
      <span className="itl-congress-who">
        {t.politician}
        <span className="itl-congress-chamber">{t.chamber}</span>
      </span>
      <span className={`pill ${t.side === 'buy' ? 'long' : 'short'}`}>{t.side === 'buy' ? 'bought' : 'sold'}</span>
      <Link href={`/stock/${t.symbol}`} className="itl-feed-sym">
        {t.symbol}
      </Link>
      {t.amountRange && <span className="num itl-feed-strong">{t.amountRange}</span>}
      <span className="num itl-feed-date">
        {longDate(t.traded)}
        {lag != null && lag >= 0 ? ` · disclosed ${lag}d later` : ''}
      </span>
      {late != null && (
        <span className="itl-late num" title={`Filed ${lag}d after the trade — the STOCK Act allows ${DISCLOSURE_WINDOW_DAYS}`}>
          {late}d late
        </span>
      )}
    </div>
  )
}

/** The watchlist symbols ride the FETCHER, never the slice key: the server
 * computes `watchlistHits` from them, and putting them in the key would mint a
 * fresh cache entry (and a fresh cold-start skeleton) every time the reader
 * added a ticker. Module-level so `useSlice` sees one stable function. */
const congressFetcher = async () => {
  const syms = await db.watchlist
    .toArray()
    .then(list => list.map(w => w.symbol))
    .catch(() => [] as string[])
  return getCongress(syms)
}

/** CONGRESS (owner iteration 2). STOCK Act disclosures — public filings the
 * engine already sweeps and the app never rendered. Every claim here is
 * hedged by what the payload actually carries: the roll-ups and the
 * buys-vs-SPY scorecard are null until enough sweeps have accumulated, and a
 * dead source ladder says so rather than showing an empty list. */
function CongressSection() {
  const { data } = useSlice('intel:congress', congressFetcher)
  const [visible, setVisible] = useState(FEED_PAGE)
  const trades = data?.trades ?? []
  const hits = data?.watchlistHits ?? []
  // SORTED BY THE NUMBER IT PRINTS (visibility wave, 2026-08-17). The live desk
  // read "Most bought: GOOGL (5) · SPGI (4) · CHRW (6)" — the server's own
  // ordering, taken as a ranking it never claimed to be, so a line headed "most
  // bought" put the most-bought name last.
  const topBought = [...(data?.aggregates?.topTickers ?? [])].filter(t => t.buys > 0).sort((a, b) => b.buys - a.buys).slice(0, 3)
  const best = data?.scorecard?.rows?.[0] ?? null

  return (
    <section id="congress" className="card itl-section">
      <h2 className="sec-label">Congressional trades</h2>
      {!data ? (
        <div className="skeleton" style={{ height: 120 }} />
      ) : data.source === 'none' && trades.length === 0 ? (
        <p className="cc-reason">
          No congressional disclosures reachable right now — every upstream source is dead or unkeyed. The filings themselves are public; this section
          fills in the moment one answers.
        </p>
      ) : trades.length === 0 ? (
        <p className="cc-reason">No disclosures in the current sweep.</p>
      ) : (
        <>
          {hits.length > 0 && (
            <div className="itl-congress-hits">
              <p className="sec-label">On your watchlist</p>
              {hits.slice(0, 5).map((t, i) => (
                <CongressRow t={t} flagLate key={`hit-${t.politician}-${t.symbol}-${t.traded}-${i}`} />
              ))}
            </div>
          )}
          {topBought.length > 0 && (
            <p className="cc-reason itl-feed-intro">
              Most bought over the last 90 days: {topBought.map(t => `${t.symbol} (${t.buys})`).join(' · ')}
            </p>
          )}
          {data.scorecard && (
            <p className="cc-reason itl-feed-intro">
              {best ? (
                <>
                  Graded against SPY so far: <span className="num">{data.scorecard.gradedBuys}</span> disclosed buys. Best on record — {best.politician} (
                  {best.chamber}), <span className="num">{`${best.avgExcessPct >= 0 ? '+' : '−'}${Math.abs(best.avgExcessPct).toFixed(1)}pp`}</span> average
                  excess across <span className="num">{best.gradedBuys}</span> buys.
                </>
              ) : (
                <>
                  Graded against SPY so far: <span className="num">{data.scorecard.gradedBuys}</span> disclosed buys — not enough yet to name anyone.
                </>
              )}
            </p>
          )}
          <div className="itl-feed-list">
            {trades.slice(0, visible).map((t, i) => (
              <CongressRow t={t} key={`${t.politician}-${t.symbol}-${t.traded}-${i}`} />
            ))}
          </div>
          {visible < trades.length && (
            <button type="button" className="stx-showmore" onClick={() => setVisible(trades.length)}>
              Show more ({trades.length - visible})
            </button>
          )}
        </>
      )}
    </section>
  )
}

/** The three feeds this page is, named once for the refresh (dynamism wave).
 * Each section owns its own `useSlice` — a failure in one must never blank the
 * others — so a page-wide refresh force-revalidates their keys and lets each
 * section repaint off the store's write announcement. */
const REFRESH_ENTRIES: SliceRefreshEntry[] = [
  { key: 'intel:news', fetcher: getNewsDesk },
  { key: 'intel:insiders', fetcher: getInsiderClusters },
  { key: 'intel:congress', fetcher: congressFetcher },
]

export default function Intel() {
  const { refresh, refreshing } = useSlicesRefresh(REFRESH_ENTRIES)
  const { pull } = usePullRefresh(refresh)
  return (
    <div className="itl">
      <RefreshStrip refreshing={refreshing} pull={pull} onRefresh={refresh} />
      <h1>Intel</h1>
      <JumpChips />
      <NewsSection />
      <InsidersSection />
      <CongressSection />
    </div>
  )
}
