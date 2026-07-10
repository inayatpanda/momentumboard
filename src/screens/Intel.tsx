import { useEffect, useState } from 'react'
import { db } from '../lib/db'
import {
  getEcon, getCalendar, getConsensus, getInsiders, getSmartMoney, getVideoAnalyses, getFeed,
  getAlertHistory, getSocialPulse, getSectors, getCongress, getInsiderClusters,
  type CongressTrade, type InsiderCluster,
} from '../lib/api'
import { IconGear, IconCalendar, IconLandmark, IconFlame, IconPlay, stripEmoji } from '../components/icons'
import { EngineBoard } from '../components/EngineBoard'
import { ClampText } from '../components/AskDesk'

// Intel, in four streams the user asked for:
//   Markets: macro, earnings, 13F, headlines, alerts
//   Sectors: rotation heatmap + relative-strength monitor
//   Congress & insiders: STOCK Act trades + Form 4 open-market buying
//   Social: unified pulse across Reddit, StockTwits and the YouTube channels

const SUBTABS = ['Markets', 'Sectors', 'Congress & insiders', 'Social'] as const
type SubTab = (typeof SUBTABS)[number]

// publisher host for a compact news-row meta line
const newsSource = (url: string) => {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

// relative age of an ISO date (STOCK-Act / Form-4 filings are day-resolution)
const relDate = (iso: string) => {
  const t = Date.parse(iso)
  if (isNaN(t)) return ''
  const days = Math.round((Date.now() - t) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  if (days < 28) return `${Math.round(days / 7)}w ago`
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

const fmtUsd = (usd: number) =>
  usd >= 1_000_000 ? `~$${(usd / 1_000_000).toFixed(1)}M` : `~$${Math.round(usd / 1000)}k`

// heatmap intensity: sign + one of three magnitude bands (excess RS vs SPY, pp)
const heatClass = (v: number | null) => {
  if (v == null) return 'heat-flat'
  const a = Math.abs(v)
  const lvl = a < 1.5 ? 1 : a < 4 ? 2 : 3
  return v >= 0 ? `heat-up-${lvl}` : `heat-dn-${lvl}`
}

function TradeRow({ t, rowKey }: { t: CongressTrade; rowKey: string }) {
  return (
    <div key={rowKey} className="perf-row intel-crow">
      <span className="intel-crow-main">
        <span className="intel-crow-pol">{t.politician}</span>
        <span className="intel-crow-sub">{t.chamber}{t.party ? ` · ${t.party}` : ''}</span>
      </span>
      <span className="intel-crow-trade">
        <span className="intel-crow-deal">
          <b className="intel-crow-sym">{t.symbol}</b>{' '}
          <span className={t.side === 'buy' ? 'up-text' : 'down-text'}>
            {t.side === 'buy' ? '↗' : '↘'} {t.amountRange || (t.side === 'buy' ? 'buy' : 'sell')}
          </span>
        </span>
        <span className="intel-crow-when">{relDate(t.traded)}</span>
      </span>
    </div>
  )
}

function ClusterRow({ c }: { c: InsiderCluster }) {
  return (
    <div className="perf-row intel-crow">
      <span className="intel-crow-main">
        <span className="intel-clus-head">
          <b className="intel-crow-sym">{c.symbol}</b>{' '}
          <span className="intel-crow-sub">{c.buyers} buyers · {fmtUsd(c.totalValueUsd)}</span>
        </span>
        {c.names.length > 0 && <span className="intel-names">{c.names.join(' · ')}</span>}
      </span>
      <span className="intel-crow-when">{relDate(c.lastDate)}</span>
    </div>
  )
}

export function Intel({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [tab, setTab] = useState<SubTab>('Markets')
  const [econ, setEcon] = useState<Awaited<ReturnType<typeof getEcon>>>([])
  const [earnings, setEarnings] = useState<Awaited<ReturnType<typeof getCalendar>>>([])
  const [consensus, setConsensus] = useState<Awaited<ReturnType<typeof getConsensus>> | null>(null)
  const [insiders, setInsiders] = useState<Awaited<ReturnType<typeof getInsiders>>>([])
  const [smartMoney, setSmartMoney] = useState<Awaited<ReturnType<typeof getSmartMoney>> | null>(null)
  const [videoAnalyses, setVideoAnalyses] = useState<Awaited<ReturnType<typeof getVideoAnalyses>>>([])
  const [feed, setFeed] = useState<Awaited<ReturnType<typeof getFeed>>>({ news: [], videos: [] })
  const [history, setHistory] = useState<Awaited<ReturnType<typeof getAlertHistory>>>([])
  const [pulse, setPulse] = useState<Awaited<ReturnType<typeof getSocialPulse>> | null>(null)
  const [sectors, setSectors] = useState<Awaited<ReturnType<typeof getSectors>> | null>(null)
  const [congress, setCongress] = useState<Awaited<ReturnType<typeof getCongress>> | null>(null)
  const [clusters, setClusters] = useState<Awaited<ReturnType<typeof getInsiderClusters>> | null>(null)
  const [congMore, setCongMore] = useState(false)

  useEffect(() => {
    db.watchlist.toArray().then(items => {
      const syms = items.map(i => i.symbol)
      if (syms.length) {
        getCalendar(syms).then(setEarnings).catch(() => {})
        getInsiders(syms).then(setInsiders).catch(() => {})
      }
      getCongress(syms).then(setCongress).catch(() => {})
    })
    getEcon().then(setEcon).catch(() => {})
    getConsensus().then(setConsensus).catch(() => {})
    getSmartMoney().then(setSmartMoney).catch(() => {})
    getVideoAnalyses().then(setVideoAnalyses).catch(() => {})
    getFeed().then(setFeed).catch(() => {})
    getAlertHistory().then(setHistory).catch(() => {})
    getSocialPulse().then(setPulse).catch(() => {})
    getSectors().then(setSectors).catch(() => {})
    getInsiderClusters().then(setClusters).catch(() => {})
  }, [])

  const congEmpty = congress != null && congress.source === 'none' && congress.trades.length === 0

  return (
    <>
      <header className="topbar">
        <span className="brand">Intel</span>
        <button className="gear" onClick={onOpenSettings} aria-label="Settings"><IconGear /></button>
      </header>
      <div className="content digest-cols">
        <div className="subtabs" style={{ columnSpan: 'all' }}>
          {SUBTABS.map(t => (
            <button key={t} className={t === tab ? 'active' : ''} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </div>

        {tab === 'Markets' && (
          <>
            <EngineBoard />
            {econ.length > 0 && (
              <section className="digest-section">
                <h3 className="section-title">Macro this week: Fed, data, tape-movers</h3>
                {econ.slice(0, 8).map(e => (
                  <div key={e.title + e.at} className="perf-row">
                    <span>
                      {e.title} <span className={`badge ${e.impact === 'High' ? 'bad' : 'warn'}`}>{e.impact}</span>
                    </span>
                    <span className="intel-meta">
                      {new Date(e.at * 1000).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })} UK · {e.country}
                    </span>
                  </div>
                ))}
                <p className="empty-line intel-fine">High-impact events ping you the morning of, and an hour before.</p>
              </section>
            )}

            <section className="digest-section">
              <h3 className="section-title">Earnings next 14 days</h3>
              {earnings.map(e => (
                <div key={e.symbol + e.date} className="perf-row">
                  <b>{e.symbol}</b>
                  <span className="intel-meta">
                    {new Date(e.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                    {e.hour ? ` · ${e.hour}` : ''}
                    {e.epsEstimate != null ? ` · est ${e.epsEstimate}` : ''}
                  </span>
                </div>
              ))}
              {earnings.length === 0 && <p className="empty-line">No watchlist earnings in the window. Binary-event risk: avoid fresh entries into a print.</p>}
            </section>

            {smartMoney && smartMoney.funds.length > 0 && (
              <section className="digest-section">
                <h3 className="section-title">Smart money: latest 13F moves</h3>
                {smartMoney.funds.map(f => (
                  <div key={f.fund} className="perf-row intel-row-col">
                    <span>{f.fund} <span className="intel-crow-sub">filed {f.filedAt}</span></span>
                    <span className="intel-crow-sub">
                      {f.newPositions.length > 0 && <>NEW: {f.newPositions.map(h => h.issuer).join(', ')} </>}
                      {f.increased.length > 0 && <>· ADDED: {f.increased.map(h => `${h.issuer} +${h.pctChange}%`).join(', ')} </>}
                      {f.exited.length > 0 && <>· EXITED: {f.exited.map(h => h.issuer).join(', ')}</>}
                    </span>
                  </div>
                ))}
                <p className="empty-line intel-fine">{smartMoney.lagNote}</p>
              </section>
            )}

            <section className="digest-section">
              <h3 className="section-title">Headlines</h3>
              <ul className="news-rows">
                {feed.news.slice(0, 8).map(n => (
                  <li key={n.url}>
                    <a className="news-row" href={n.url} target="_blank" rel="noreferrer">
                      <span className="news-row-main">
                        <span className="news-row-title">{n.title}</span>
                        {(n.symbols.length > 0 || newsSource(n.url)) && (
                          <span className="news-row-meta">{[newsSource(n.url), n.symbols.join(', ')].filter(Boolean).join(' · ')}</span>
                        )}
                      </span>
                      <span className="news-row-go" aria-hidden="true">↗</span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>

            {history.length > 0 && (
              <section className="digest-section">
                <h3 className="section-title">Recent alerts</h3>
                {history.slice(0, 10).map((h, i) => (
                  <div key={i} className="perf-row intel-alert">
                    <span className="intel-ellip">{stripEmoji(h.text)}</span>
                    <span className="intel-when">
                      {new Date(h.at * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                ))}
              </section>
            )}

            <section className="digest-section">
              <h3 className="section-title">Elsewhere</h3>
              <a className="link-card" href="https://www.investing.com/economic-calendar/" target="_blank" rel="noreferrer">
                <IconCalendar /> Full economic calendar <span>Everything beyond the high-impact list above.</span>
              </a>
            </section>
          </>
        )}

        {tab === 'Sectors' && (
          <>
            {sectors ? (
              <>
                <section className="digest-section">
                  <h3 className="section-title">Sector heatmap — 1-month relative strength</h3>
                  <div className="heat-grid">
                    {sectors.rows.map(s => {
                      const v = s.rs21
                      return (
                        <div key={s.sym} className={`heat-tile ${heatClass(v)}`}>
                          <span className="heat-name">{s.name}</span>
                          <span className="heat-pct">{v != null ? `${v >= 0 ? '+' : ''}${v}` : '·'}</span>
                        </div>
                      )
                    })}
                  </div>
                  <p className="empty-line intel-fine">Tint = 1-month excess return vs SPY. Green leading = money rotating in; display-only.</p>
                </section>

                <section className="digest-section">
                  <h3 className="section-title">Rotation monitor: relative strength vs SPY</h3>
                  {(sectors.rotatingIn.length > 0 || sectors.rotatingOut.length > 0) && (
                    <p className="empty-line" style={{ fontSize: 12.5, color: 'var(--text)' }}>
                      {sectors.rotatingIn.length > 0 && <>Money rotating <span className="up-text">into {sectors.rotatingIn.join(', ')}</span>. </>}
                      {sectors.rotatingOut.length > 0 && <>Rotating <span className="down-text">out of {sectors.rotatingOut.join(', ')}</span>.</>}
                    </p>
                  )}
                  {sectors.rows.map(s => (
                    <div key={s.sym} className="perf-row">
                      <span>
                        {s.trend === 'in' ? '↗ ' : s.trend === 'out' ? '↘ ' : ''}
                        {s.name} <span className="intel-crow-sub" style={{ fontFamily: 'var(--font-num)' }}>{s.sym}</span>
                      </span>
                      <span style={{ fontFamily: 'var(--font-num)', fontSize: 12 }}>
                        <em className={s.rs5 != null && s.rs5 >= 0 ? 'up-text' : 'down-text'} style={{ fontStyle: 'normal' }}>{s.rs5 != null ? `${s.rs5 >= 0 ? '+' : ''}${s.rs5}` : '·'}</em>
                        <span style={{ color: 'var(--faint)' }}> / </span>
                        <em className={s.rs21 != null && s.rs21 >= 0 ? 'up-text' : 'down-text'} style={{ fontStyle: 'normal' }}>{s.rs21 != null ? `${s.rs21 >= 0 ? '+' : ''}${s.rs21}` : '·'}</em>
                        <span style={{ color: 'var(--faint)' }}> / </span>
                        <em className={s.rs63 != null && s.rs63 >= 0 ? 'up-text' : 'down-text'} style={{ fontStyle: 'normal' }}>{s.rs63 != null ? `${s.rs63 >= 0 ? '+' : ''}${s.rs63}` : '·'}</em>
                      </span>
                    </div>
                  ))}
                  <p className="empty-line intel-fine">Columns: 1-week / 1-month / 3-month excess return vs SPY (%). ↗ short-term strength leading = rotation in. Position ahead of the rotation, not after it is obvious.</p>
                </section>
              </>
            ) : (
              <p className="empty-line">Loading sector data…</p>
            )}
            <p className="empty-line intel-fine">Per-ticker seasonality (day-of-week and monthly tendencies over 5 years) lives on each ticker's chart page.</p>
          </>
        )}

        {tab === 'Congress & insiders' && (
          <>
            <section className="digest-section">
              <h3 className="section-title">Congressional trading</h3>
              {congress == null ? (
                <p className="empty-line">Loading congressional trades…</p>
              ) : congEmpty ? (
                <>
                  <div className="card intel-notice">
                    <div className="icon-tile amber"><IconLandmark /></div>
                    <div>
                      <strong>Congressional feeds need a free data key.</strong>
                      <p>Ask the admin to add <code>FMP_API_KEY</code> in Netlify — trades appear within the hour.</p>
                    </div>
                  </div>
                  <a className="link-card" href="https://unusualwhales.com/politics" target="_blank" rel="noreferrer">
                    <IconLandmark /> Browse congress trades on the web
                    <span>Unusual Whales' public tracker — most-held names, active traders, politician portfolios.</span>
                  </a>
                </>
              ) : (
                <>
                  {congress.watchlistHits.length > 0 && (
                    <>
                      <p className="eyebrow" style={{ margin: '10px 0 6px' }}>On your watchlist</p>
                      {congress.watchlistHits.map((t, i) => (
                        <TradeRow key={`wl-${t.symbol}-${t.traded}-${i}`} t={t} rowKey={`wl-${t.symbol}-${t.traded}-${i}`} />
                      ))}
                    </>
                  )}
                  {congress.trades.length > 0 && (
                    <>
                      <p className="eyebrow" style={{ margin: '12px 0 6px' }}>Recent — market-wide</p>
                      {congress.trades.slice(0, congMore ? 60 : 15).map((t, i) => (
                        <TradeRow key={`mkt-${t.politician}-${t.symbol}-${t.traded}-${i}`} t={t} rowKey={`mkt-${t.politician}-${t.symbol}-${t.traded}-${i}`} />
                      ))}
                      {congress.trades.length > 15 && (
                        <button className="mini-btn ghost intel-more" onClick={() => setCongMore(m => !m)}>
                          {congMore ? 'show less' : `show ${Math.min(congress.trades.length, 60) - 15} more`}
                        </button>
                      )}
                    </>
                  )}
                  <p className="empty-line intel-fine">Filed under the STOCK Act. A cluster of same-side trades is positioning, not gospel.</p>
                  <a className="link-card" href="https://unusualwhales.com/politics" target="_blank" rel="noreferrer">
                    <IconLandmark /> Go deeper on the web
                    <span>Unusual Whales' free tracker — most-held names, active traders, politician portfolio returns.</span>
                  </a>
                </>
              )}
            </section>

            <section className="digest-section">
              <h3 className="section-title">Insider buying — on your watchlist</h3>
              {insiders.length > 0 ? (
                <>
                  {insiders.map(i => (
                    <div key={i.symbol} className="perf-row intel-row-col">
                      <span className="intel-il-head">
                        <b>{i.symbol}</b> {i.isCluster && <span className="badge good">cluster</span>}{' '}
                        <span className="intel-crow-sub">
                          {i.buyers.length} insider{i.buyers.length > 1 ? 's' : ''}
                          {i.totalValueUsd > 0 && ` · ${fmtUsd(i.totalValueUsd)}`}
                        </span>
                      </span>
                      <span className="intel-names">{i.latest.map(l => `${l.name.split(' ')[0]} +${l.shares.toLocaleString()}`).join(' · ')}</span>
                    </div>
                  ))}
                  <p className="empty-line intel-fine">Open-market buys only (Form 4, code P). Clustered buying has real empirical support.</p>
                </>
              ) : (
                <p className="empty-line">No open-market insider buys on your watchlist in the last 90 days. Executives buying their own beaten-down stock is one of the few signals with real empirical weight; when it appears here, pay attention.</p>
              )}
            </section>

            <section className="digest-section">
              <h3 className="section-title">Insider clusters — market-wide</h3>
              {clusters == null ? (
                <p className="empty-line">Loading insider sweep…</p>
              ) : clusters.clusters.length > 0 ? (
                <>
                  {clusters.clusters.map(c => <ClusterRow key={c.symbol} c={c} />)}
                  <p className="empty-line intel-fine">Distinct open-market buyers over ~90 days, aggregated across the engine's roster coverage.</p>
                </>
              ) : (
                <p className="empty-line">The engine's insider sweep is still accumulating coverage.</p>
              )}
            </section>
          </>
        )}

        {tab === 'Social' && (
          <>
            {pulse && pulse.discoveries.length > 0 && (
              <section className="digest-section">
                <h3 className="section-title">Up &amp; coming: chatter worth a look</h3>
                {pulse.discoveries.map(d => (
                  <div key={d.sym} className="ai-card intel-ai-pos" style={{ marginBottom: 8 }}>
                    <h3 className="intel-ai-h">
                      {d.sym} {d.surging && <span className="badge warn"><IconFlame size={11} /> {d.surgeMultiple}x in 24h</span>} {d.sources >= 2 && <span className="badge good">{d.sources} platforms</span>}
                      <span className="intel-crow-sub" style={{ fontWeight: 400 }}>
                        {' '}{d.companyName ?? ''}{d.capUsdM ? ` · $${(d.capUsdM / 1000).toFixed(1)}B` : ''}
                      </span>
                    </h3>
                    <ClampText text={d.opinion ?? `Reddit #${d.redditRank}, ${d.redditMentions} mentions${d.stocktwits ? ', trending on StockTwits' : ''}. Take pending.`} />
                    <span className="ai-note">The analyst's read, not a recommendation. Small caps: half-size risk.</span>
                  </div>
                ))}
              </section>
            )}

            {pulse && pulse.alsoLoud.length > 0 && (
              <p className="empty-line" style={{ fontSize: 12 }}>
                Also loud today (household names, already everywhere): {pulse.alsoLoud.join(' · ')}
              </p>
            )}

            {pulse && pulse.pulse.length > 0 && (
              <section className="digest-section">
                <h3 className="section-title">Rest of the pulse</h3>
                {pulse.pulse.slice(0, 8).map(p => (
                  <div key={p.sym} className={`perf-row${p.onWatchlist ? ' intel-wl' : ''}`}>
                    <span>
                      {p.sym} {p.surging && <span className="badge warn"><IconFlame size={11} /></span>}
                      {p.onWatchlist && <span className="badge info">watchlist</span>}
                    </span>
                    <span className="intel-meta">
                      {p.redditMentions != null && `r/ #${p.redditRank} · ${p.redditMentions}×`}
                      {p.stocktwits && ' · ST'}
                      {p.channelNet != null && ` · YT ${p.channelNet > 0 ? `+${p.channelNet}` : p.channelNet}`}
                    </span>
                  </div>
                ))}
                <p className="empty-line intel-fine">Early chatter on a small name is opportunity; mature crowding is the contrarian tell.</p>
              </section>
            )}

            {consensus && consensus.tickers.length > 0 && (
              <section className="digest-section">
                <h3 className="section-title">Channel consensus, last 7 days</h3>
                {consensus.tickers.slice(0, 10).map(t => (
                  <div key={t.sym} className="perf-row">
                    <span>
                      {t.sym}{' '}
                      {t.crowded && <span className="badge warn">crowded</span>}{' '}
                      {t.shifted && <span className="badge info">stance flip</span>}
                    </span>
                    <span className="intel-meta">
                      {t.mentions7d}× ({t.mentionsPrior7d}× prior) · {t.channels}ch ·{' '}
                      <span className={t.net > 0 ? 'up-text' : t.net < 0 ? 'down-text' : ''}>{t.net > 0 ? `+${t.net} bull` : t.net < 0 ? `${t.net} bear` : 'split'}</span>
                    </span>
                  </div>
                ))}
              </section>
            )}

            {videoAnalyses.length > 0 && (
              <section className="digest-section">
                <h3 className="section-title">AI-watched videos</h3>
                {videoAnalyses.map(v => (
                  <div key={v.url} className="ai-card" style={{ marginBottom: 8 }}>
                    <h3 className="intel-ai-h" style={{ fontSize: 13 }}>
                      <a href={v.url} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}><IconPlay /> {v.title || v.url}</a>
                      <span className="intel-crow-sub" style={{ fontWeight: 400 }}> · {v.channel}</span>
                    </h3>
                    <ClampText text={v.analysis} />
                    <span className="ai-note">Gemini watched the full video. Sentiment input, not signals.</span>
                  </div>
                ))}
              </section>
            )}

            <section className="digest-section">
              <h3 className="section-title">New from the channels</h3>
              <ul className="news-rows">
                {feed.videos.slice(0, 8).map(v => (
                  <li key={v.url}>
                    <a className="news-row" href={v.url} target="_blank" rel="noreferrer">
                      <span className="news-row-main">
                        <span className="news-row-title"><IconPlay /> {v.title}</span>
                        <span className="news-row-meta">{v.channel}</span>
                      </span>
                      <span className="news-row-go" aria-hidden="true">↗</span>
                    </a>
                  </li>
                ))}
              </ul>
              {feed.videos.length === 0 && <p className="empty-line">No new videos in the last 24h.</p>}
            </section>
          </>
        )}

        <footer className="foot">This intel informs. It does not predict.</footer>
      </div>
    </>
  )
}
