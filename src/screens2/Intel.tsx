// Intel (plan Task 19; CX-19 — restructured by owner iteration 2) — the
// paper + news + insiders + congress + social. This is news's ONLY home in the
// app (spec §3.5): a side dish, never the meal.
//
// THE OWNER'S REVIEW REBUILT THIS PAGE:
//   "The Daily bulletin takes up the entire space, and scrolling is difficult
//    to reach directly to the News desk without scrolling through the entire
//    bulletin. News desk doesnt show date of news. Intel doesnt show insider
//    news/buying congressional things."
// So: a STICKY chip row jumps to any section in one tap; the paper is a
// <details> CLOSED by default (a 70vh iframe is not a landing surface, and a
// reader who never opens it now pays for neither the pixels nor the fetch);
// every headline carries a stamp; and the two feeds the engine has always
// collected and never shown — insider clusters and congressional disclosures
// — get sections of their own.
//
// Five stacked sections, each its OWN `useSlice` + skeleton: one section's
// failure (a rejected fetch, or simply not yet cached) must never blank the
// others. `useSlice` already never throws into render — a failed fetch just
// flips `offline` and leaves `data` at whatever was cached (null on a cold
// slice) — so this file needs no error boundary of its own.
//
// The paper renders INLINE via the /report?format=json envelope
// (netlify/functions/report.mts; report.format.test.ts), dropped into a
// SANDBOXED srcDoc iframe (sandbox="" — no scripts, no navigation, no
// same-origin) rather than an iframe `src` navigation, which the report
// route's own X-Frame-Options would block outright.

import { useState } from 'react'
import { Link } from 'wouter'
import { useSlice } from '../lib/useSlice'
import { db } from '../lib/db'
import { getCongress, getInsiderClusters, getNewsDesk, getSocialPulse } from '../lib/api'
import type { CongressTrade } from '../lib/api'
import { compactUsd, decodeEntities, longDate, relativeStamp } from '../lib/format'

const PAGE = 30
const FEED_PAGE = 12

/** The jump rail's targets, in page order. Ids live on the sections.
 * The paper left this page for its own tab (owner 2026-08-17) — the news
 * desk is now the first thing on Intel, which is where the reader's most
 * frequent check belongs. */
const SECTIONS = [
  { id: 'news', label: 'News' },
  { id: 'insiders', label: 'Insiders' },
  { id: 'congress', label: 'Congress' },
  { id: 'social', label: 'Social' },
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
                  <span className="pill accent num">{item.score}</span>
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
function InsidersSection() {
  const { data } = useSlice('intel:insiders', getInsiderClusters)
  const [visible, setVisible] = useState(FEED_PAGE)
  const clusters = data?.clusters ?? []

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
              <div className="itl-feed-row" key={c.symbol}>
                <Link href={`/stock/${c.symbol}`} className="itl-feed-sym">
                  {c.symbol}
                </Link>
                <span className="num itl-feed-strong">{c.buyers} buyers</span>
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

/** One disclosure row. `side` IS the direction, so it carries the long/short
 * colours the rest of the app uses for exactly that — a bought line and a sold
 * line must never read the same at a glance. */
function CongressRow({ t }: { t: CongressTrade }) {
  const lag = daysBetween(t.traded, t.filed)
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
  const topBought = (data?.aggregates?.topTickers ?? []).filter(t => t.buys > 0).slice(0, 3)
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
                <CongressRow t={t} key={`hit-${t.politician}-${t.symbol}-${t.traded}-${i}`} />
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

function SocialSection() {
  const { data } = useSlice('intel:social', getSocialPulse)
  const [visible, setVisible] = useState(PAGE)
  const rows = data?.pulse ?? []

  return (
    <section id="social" className="card itl-section">
      <h2 className="sec-label">Social pulse</h2>
      {!data ? (
        <div className="skeleton" style={{ height: 160 }} />
      ) : rows.length === 0 && data.alsoLoud.length === 0 && data.discoveries.length === 0 ? (
        <p className="cc-reason">Nothing loud enough to show right now.</p>
      ) : (
        <>
          {data.alsoLoud.length > 0 && (
            <div className="itl-loud-row">
              <span>Also loud:</span>
              {data.alsoLoud.map(s => (
                <Link key={s} href={`/stock/${s}`} className="pill">
                  {s}
                </Link>
              ))}
            </div>
          )}
          {data.discoveries.length > 0 && (
            <div className="itl-discoveries">
              {data.discoveries.slice(0, 5).map(d => (
                <Link key={d.sym} href={`/stock/${d.sym}`} className="card pressable itl-discovery">
                  <span className="itl-pulse-sym">{d.sym}</span>
                  {d.companyName && <span className="itl-pulse-name">{d.companyName}</span>}
                  {d.opinion && <p className="cc-reason">{d.opinion}</p>}
                </Link>
              ))}
            </div>
          )}
          <div className="itl-pulse-list">
            {rows.slice(0, visible).map(r => (
              <Link key={r.sym} href={`/stock/${r.sym}`} className="card pressable itl-pulse-row">
                <span className="itl-pulse-sym">{r.sym}</span>
                {r.name && <span className="itl-pulse-name">{r.name}</span>}
                <span className="itl-pulse-meta">
                  {r.redditMentions != null && <span className="num">{r.redditMentions} mentions</span>}
                  {r.surging && <span className="pill accent">surging{r.surgeMultiple != null ? ` ${r.surgeMultiple.toFixed(1)}x` : ''}</span>}
                </span>
              </Link>
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

export default function Intel() {
  return (
    <div className="itl">
      <h1>Intel</h1>
      <JumpChips />
      <NewsSection />
      <InsidersSection />
      <CongressSection />
      <SocialSection />
    </div>
  )
}
