import { useEffect, useState } from 'react'
import { db, getCapital, getChannels } from '../lib/db'
import { getCalendar, getFeed, getAiRead, resolveChannel, getInsiders, getSignalStats, getSmartMoney, getAlertHistory, getVideoAnalyses } from '../lib/api'
import { mirrorConfig } from '../lib/configMirror'
import { fmtPct } from '../lib/format'
import { useMarketData } from '../hooks/useMarketData'

type Feed = Awaited<ReturnType<typeof getFeed>>
type Earnings = Awaited<ReturnType<typeof getCalendar>>
type AiRead = Awaited<ReturnType<typeof getAiRead>>

export function Digest() {
  const [symbols, setSymbols] = useState<string[]>([])
  const [earnings, setEarnings] = useState<Earnings>([])
  const [feed, setFeed] = useState<Feed>({ news: [], videos: [] })
  const [ai, setAi] = useState<AiRead | null>(null)
  const [capital, setCapital] = useState('5000')
  const [channels, setChannels] = useState<{ id: string; name: string }[]>([])
  const [newHandle, setNewHandle] = useState('')
  const [resolving, setResolving] = useState(false)
  const [insiders, setInsiders] = useState<Awaited<ReturnType<typeof getInsiders>>>([])
  const [signalStats, setSignalStats] = useState<Awaited<ReturnType<typeof getSignalStats>> | null>(null)
  const [smartMoney, setSmartMoney] = useState<Awaited<ReturnType<typeof getSmartMoney>> | null>(null)
  const [history, setHistory] = useState<Awaited<ReturnType<typeof getAlertHistory>>>([])
  const [videoAnalyses, setVideoAnalyses] = useState<Awaited<ReturnType<typeof getVideoAnalyses>>>([])
  const { rows } = useMarketData(symbols)

  useEffect(() => {
    db.watchlist.toArray().then(items => {
      const syms = items.map(i => i.symbol)
      setSymbols(syms)
      if (syms.length) {
        getCalendar(syms).then(setEarnings).catch(() => {})
        getInsiders(syms).then(setInsiders).catch(() => {})
      }
    })
    getFeed().then(setFeed).catch(() => {})
    getAiRead().then(setAi).catch(() => {})
    getSignalStats().then(setSignalStats).catch(() => {})
    getSmartMoney().then(setSmartMoney).catch(() => {})
    getAlertHistory().then(setHistory).catch(() => {})
    getVideoAnalyses().then(setVideoAnalyses).catch(() => {})
    getCapital().then(c => setCapital(String(c)))
    getChannels().then(setChannels)
  }, [])

  const saveCapital = async () => {
    const v = parseFloat(capital)
    if (Number.isFinite(v) && v > 0) {
      await db.settings.put({ key: 'capital', value: String(v) })
      mirrorConfig()
    }
  }

  const addChannel = async () => {
    if (!newHandle.trim() || resolving) return
    setResolving(true)
    try {
      const ch = await resolveChannel(newHandle.trim())
      const next = [...channels.filter(c => c.id !== ch.id), ch]
      setChannels(next)
      await db.settings.put({ key: 'ytChannels', value: JSON.stringify(next) })
      setNewHandle('')
      mirrorConfig()
    } catch {
      /* not found — leave input for correction */
    } finally {
      setResolving(false)
    }
  }

  const removeChannel = async (id: string) => {
    const next = channels.filter(c => c.id !== id)
    setChannels(next)
    await db.settings.put({ key: 'ytChannels', value: JSON.stringify(next) })
    mirrorConfig()
  }

  const perf = [...rows].filter(r => r.quote).sort((a, b) => (b.quote!.changePct ?? 0) - (a.quote!.changePct ?? 0))

  return (
    <>
      <header className="topbar">
        <span className="brand">Digest</span>
      </header>
      <div className="content">
        <div className="ai-card">
          <h3>AI read</h3>
          {ai?.text ? (
            <>
              <p>{ai.text}</p>
              <span className="ai-note">AI interpretation ({ai.provider}) — not a prediction, not advice.</span>
            </>
          ) : ai?.unconfigured ? (
            <p className="ai-note">Add a GEMINI_API_KEY or GROQ_API_KEY to the Netlify environment to enable the AI read.</p>
          ) : ai?.empty ? (
            <p className="ai-note">Add tickers to your watchlist first.</p>
          ) : (
            <p className="ai-note">Loading…</p>
          )}
        </div>

        <a className="link-card" href="/report">
          📰 Morning strategy report
          <span>Published each weekday ~06:45 by the research routine</span>
        </a>

        <section className="digest-section">
          <h3 className="section-title">Last session — watchlist</h3>
          {perf.map(r => (
            <div key={r.symbol} className="perf-row">
              <span>{r.symbol}</span>
              <span className={r.quote!.changePct >= 0 ? 'up-text' : 'down-text'}>{fmtPct(r.quote!.changePct)}</span>
            </div>
          ))}
          {perf.length === 0 && <p className="empty-line">No watchlist data yet.</p>}
        </section>

        <section className="digest-section">
          <h3 className="section-title">Earnings — next 14 days</h3>
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

        {videoAnalyses.length > 0 && (
          <section className="digest-section">
            <h3 className="section-title">AI-watched videos</h3>
            {videoAnalyses.map(v => (
              <div key={v.url} className="ai-card" style={{ marginBottom: 8 }}>
                <h3 style={{ fontSize: 13 }}>
                  <a href={v.url} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>▶ {v.title || v.url}</a>
                  <span style={{ color: 'var(--faint)', fontWeight: 400 }}> · {v.channel}</span>
                </h3>
                <p style={{ fontSize: 13 }}>{v.analysis}</p>
                <span className="ai-note">Gemini watched the full video (frames + audio). Sentiment input, not signals — verify levels yourself.</span>
              </div>
            ))}
          </section>
        )}

        <section className="digest-section">
          <h3 className="section-title">Channels</h3>
          <ul className="news-list">
            {feed.videos.slice(0, 8).map(v => (
              <li key={v.url}>
                <a href={v.url} target="_blank" rel="noreferrer">▶ {v.title}</a>
                <span>{v.channel}</span>
              </li>
            ))}
          </ul>
          {feed.videos.length === 0 && <p className="empty-line">No new videos in the last 24h.</p>}
        </section>

        {insiders.length > 0 && (
          <section className="digest-section">
            <h3 className="section-title">Insider buying — last 90 days</h3>
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
            <p className="empty-line" style={{ fontSize: 11 }}>Open-market buys (Form 4 code P) only — clustered buying has real empirical support; single buys are weak evidence.</p>
          </section>
        )}

        {signalStats && signalStats.scores.length > 0 && (
          <section className="digest-section">
            <h3 className="section-title">Signal scoreboard — live calibration</h3>
            {signalStats.scores.map(s => (
              <div key={s.setup} className="perf-row">
                <span>{s.setup} <span style={{ color: 'var(--faint)' }}>×{s.n}</span></span>
                <span>{s.win5 != null ? `${Math.round(s.win5 * 100)}% win · ${s.avg5!.toFixed(1)}% @5d` : 'too recent to score'}</span>
              </div>
            ))}
            <p className="empty-line" style={{ fontSize: 11 }}>{signalStats.totalSignals} signals logged. Treat nothing here as meaningful below ~30 scored signals per setup.</p>
          </section>
        )}

        {smartMoney && smartMoney.funds.length > 0 && (
          <section className="digest-section">
            <h3 className="section-title">Smart money — latest 13F moves</h3>
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

        {history.length > 0 && (
          <section className="digest-section">
            <h3 className="section-title">Recent alerts</h3>
            {history.slice(0, 12).map((h, i) => (
              <div key={i} className="perf-row" style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.text}</span>
                <span style={{ color: 'var(--faint)', flex: '0 0 auto', marginLeft: 8 }}>
                  {new Date(h.at * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ))}
          </section>
        )}

        <section className="digest-section">
          <h3 className="section-title">Elsewhere</h3>
          <a className="link-card" href="https://www.quiverquant.com/congresstrading/" target="_blank" rel="noreferrer">
            🏛 Congressional trading <span>QuiverQuant — treat as positioning signal, not gospel</span>
          </a>
          <a className="link-card" href="https://www.investing.com/economic-calendar/" target="_blank" rel="noreferrer">
            📅 Economic calendar <span>Fed/BoE decisions, CPI, jobs — the macro tape-movers</span>
          </a>
        </section>

        <section className="digest-section">
          <h3 className="section-title">Settings</h3>
          <div className="settings-grid">
            <label className="tf-full">Capital (£)
              <input inputMode="decimal" value={capital} onChange={e => setCapital(e.target.value)} onBlur={saveCapital} aria-label="Capital setting" />
            </label>
            {channels.map(c => (
              <div key={c.id} className="chan-row">
                <span>{c.name}</span>
                <button className="remove" onClick={() => removeChannel(c.id)} aria-label={`Remove ${c.name}`}>✕</button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8 }}>
              <input placeholder="Add channel by @handle" value={newHandle} onChange={e => setNewHandle(e.target.value)} style={{ flex: 1 }} aria-label="Add channel handle" />
              <button className="mini-btn" onClick={addChannel} disabled={resolving}>{resolving ? '…' : 'Add'}</button>
            </div>
          </div>
        </section>

        <footer className="foot">This digest informs — it does not predict.</footer>
      </div>
    </>
  )
}
