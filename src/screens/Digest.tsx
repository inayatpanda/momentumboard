import { useEffect, useState } from 'react'
import { db, getCapital, getChannels } from '../lib/db'
import { getCalendar, getFeed, getAiRead, resolveChannel } from '../lib/api'
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
  const { rows } = useMarketData(symbols)

  useEffect(() => {
    db.watchlist.toArray().then(items => {
      const syms = items.map(i => i.symbol)
      setSymbols(syms)
      if (syms.length) getCalendar(syms).then(setEarnings).catch(() => {})
    })
    getFeed().then(setFeed).catch(() => {})
    getAiRead().then(setAi).catch(() => {})
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
