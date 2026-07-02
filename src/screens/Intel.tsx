import { useEffect, useState } from 'react'
import { db } from '../lib/db'
import { getEcon, getCalendar, getConsensus, getInsiders, getSmartMoney, getVideoAnalyses, getFeed, getAlertHistory, getSocialPulse, getSectors } from '../lib/api'
import { IconGear, IconCalendar, IconLandmark, IconFlame, IconPlay, stripEmoji } from '../components/icons'

// Intel, in three streams the user asked for:
//   Markets: macro, earnings, 13F, headlines, alerts
//   Congress & insiders: political + Form 4 positioning
//   Social: unified pulse across Reddit, StockTwits and the YouTube channels

const SUBTABS = ['Markets', 'Sectors', 'Congress & insiders', 'Social'] as const
type SubTab = (typeof SUBTABS)[number]

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

  useEffect(() => {
    db.watchlist.toArray().then(items => {
      const syms = items.map(i => i.symbol)
      if (syms.length) {
        getCalendar(syms).then(setEarnings).catch(() => {})
        getInsiders(syms).then(setInsiders).catch(() => {})
      }
    })
    getEcon().then(setEcon).catch(() => {})
    getConsensus().then(setConsensus).catch(() => {})
    getSmartMoney().then(setSmartMoney).catch(() => {})
    getVideoAnalyses().then(setVideoAnalyses).catch(() => {})
    getFeed().then(setFeed).catch(() => {})
    getAlertHistory().then(setHistory).catch(() => {})
    getSocialPulse().then(setPulse).catch(() => {})
    getSectors().then(setSectors).catch(() => {})
  }, [])

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
            {econ.length > 0 && (
              <section className="digest-section">
                <h3 className="section-title">Macro this week: Fed, data, tape-movers</h3>
                {econ.slice(0, 8).map(e => (
                  <div key={e.title + e.at} className="perf-row">
                    <span>
                      {e.title} <span className={`badge ${e.impact === 'High' ? 'bad' : 'warn'}`}>{e.impact}</span>
                    </span>
                    <span style={{ color: 'var(--muted)' }}>
                      {new Date(e.at * 1000).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })} UK · {e.country}
                    </span>
                  </div>
                ))}
                <p className="empty-line" style={{ fontSize: 11 }}>High-impact events ping you the morning of, and an hour before.</p>
              </section>
            )}

            <section className="digest-section">
              <h3 className="section-title">Earnings next 14 days</h3>
              {earnings.map(e => (
                <div key={e.symbol + e.date} className="perf-row">
                  <span>{e.symbol}</span>
                  <span>
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
                  <div key={f.fund} className="perf-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                    <span>{f.fund} <span style={{ color: 'var(--faint)', fontSize: 11 }}>filed {f.filedAt}</span></span>
                    <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                      {f.newPositions.length > 0 && <>NEW: {f.newPositions.map(h => h.issuer).join(', ')} </>}
                      {f.increased.length > 0 && <>· ADDED: {f.increased.map(h => `${h.issuer} +${h.pctChange}%`).join(', ')} </>}
                      {f.exited.length > 0 && <>· EXITED: {f.exited.map(h => h.issuer).join(', ')}</>}
                    </span>
                  </div>
                ))}
                <p className="empty-line" style={{ fontSize: 11 }}>{smartMoney.lagNote}</p>
              </section>
            )}

            <section className="digest-section">
              <h3 className="section-title">Headlines</h3>
              <ul className="news-list">
                {feed.news.slice(0, 8).map(n => (
                  <li key={n.url}>
                    <a href={n.url} target="_blank" rel="noreferrer">{n.title}</a>
                    {n.symbols.length > 0 && <span>{n.symbols.join(', ')}</span>}
                  </li>
                ))}
              </ul>
            </section>

            {history.length > 0 && (
              <section className="digest-section">
                <h3 className="section-title">Recent alerts</h3>
                {history.slice(0, 10).map((h, i) => (
                  <div key={i} className="perf-row" style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stripEmoji(h.text)}</span>
                    <span style={{ color: 'var(--faint)', flex: '0 0 auto', marginLeft: 8 }}>
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
                      {s.name} <span style={{ color: 'var(--faint)', fontFamily: 'var(--font-num)', fontSize: 11 }}>{s.sym}</span>
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
                <p className="empty-line" style={{ fontSize: 11 }}>Columns: 1-week / 1-month / 3-month excess return vs SPY (%). ↗ short-term strength leading = rotation in. Position ahead of the rotation, not after it is obvious.</p>
              </section>
            ) : (
              <p className="empty-line">Loading sector data…</p>
            )}
            <p className="empty-line" style={{ fontSize: 11 }}>Per-ticker seasonality (day-of-week and monthly tendencies over 5 years) lives on each ticker's chart page.</p>
          </>
        )}

        {tab === 'Congress & insiders' && (
          <>
            {insiders.length > 0 ? (
              <section className="digest-section">
                <h3 className="section-title">Insider buying, last 90 days</h3>
                {insiders.map(i => (
                  <div key={i.symbol} className="perf-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                    <span>
                      {i.symbol} {i.isCluster && <span className="badge good">cluster</span>}{' '}
                      <span style={{ color: 'var(--muted)' }}>
                        {i.buyers.length} insider{i.buyers.length > 1 ? 's' : ''}
                        {i.totalValueUsd > 0 && ` · ~$${Math.round(i.totalValueUsd / 1000)}k`}
                      </span>
                    </span>
                    <span style={{ color: 'var(--faint)', fontSize: 11 }}>{i.latest.map(l => `${l.name.split(' ')[0]} +${l.shares.toLocaleString()}`).join(' · ')}</span>
                  </div>
                ))}
                <p className="empty-line" style={{ fontSize: 11 }}>Open-market buys only (Form 4, code P). Clustered buying has real empirical support.</p>
              </section>
            ) : (
              <p className="empty-line">No open-market insider buys on your watchlist in the last 90 days. Executives buying their own beaten-down stock is one of the few signals with real empirical weight; when it appears here, pay attention.</p>
            )}

            <section className="digest-section">
              <h3 className="section-title">Congressional trading</h3>
              <a className="link-card" href="https://www.quiverquant.com/congresstrading/" target="_blank" rel="noreferrer">
                <IconLandmark /> QuiverQuant congress tracker <span>Clustered political buying is a positioning signal, not gospel. The morning report checks this daily; free structured feeds for in-app tables no longer exist.</span>
              </a>
            </section>
          </>
        )}

        {tab === 'Social' && (
          <>
            {pulse && pulse.discoveries.length > 0 && (
              <section className="digest-section">
                <h3 className="section-title">Up &amp; coming: chatter worth a look</h3>
                {pulse.discoveries.map(d => (
                  <div key={d.sym} className="ai-card" style={{ marginBottom: 8, borderColor: 'rgba(34,201,141,0.4)' }}>
                    <h3 style={{ fontSize: 14, color: 'var(--text)' }}>
                      {d.sym} {d.surging && <span className="badge warn"><IconFlame size={11} /> {d.surgeMultiple}x in 24h</span>} {d.sources >= 2 && <span className="badge good">{d.sources} platforms</span>}
                      <span style={{ color: 'var(--faint)', fontWeight: 400, fontSize: 12 }}>
                        {' '}{d.companyName ?? ''}{d.capUsdM ? ` · $${(d.capUsdM / 1000).toFixed(1)}B` : ''}
                      </span>
                    </h3>
                    <p style={{ fontSize: 13 }}>{d.opinion ?? `Reddit #${d.redditRank}, ${d.redditMentions} mentions${d.stocktwits ? ', trending on StockTwits' : ''}. Take pending.`}</p>
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
                  <div key={p.sym} className="perf-row" style={p.onWatchlist ? { borderColor: 'rgba(90,169,255,0.5)' } : undefined}>
                    <span>
                      {p.sym} {p.surging && <span className="badge warn"><IconFlame size={11} /></span>}
                      {p.onWatchlist && <span className="badge info">watchlist</span>}
                    </span>
                    <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                      {p.redditMentions != null && `r/ #${p.redditRank} · ${p.redditMentions}×`}
                      {p.stocktwits && ' · ST'}
                      {p.channelNet != null && ` · YT ${p.channelNet > 0 ? `+${p.channelNet}` : p.channelNet}`}
                    </span>
                  </div>
                ))}
                <p className="empty-line" style={{ fontSize: 11 }}>Early chatter on a small name is opportunity; mature crowding is the contrarian tell.</p>
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
                    <span style={{ color: 'var(--muted)' }}>
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
                    <h3 style={{ fontSize: 13 }}>
                      <a href={v.url} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}><IconPlay /> {v.title || v.url}</a>
                      <span style={{ color: 'var(--faint)', fontWeight: 400 }}> · {v.channel}</span>
                    </h3>
                    <p style={{ fontSize: 13 }}>{v.analysis}</p>
                    <span className="ai-note">Gemini watched the full video. Sentiment input, not signals.</span>
                  </div>
                ))}
              </section>
            )}

            <section className="digest-section">
              <h3 className="section-title">New from the channels</h3>
              <ul className="news-list">
                {feed.videos.slice(0, 8).map(v => (
                  <li key={v.url}>
                    <a href={v.url} target="_blank" rel="noreferrer"><IconPlay /> {v.title}</a>
                    <span>{v.channel}</span>
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
