import { useEffect, useState } from 'react'
import { getAiRead, getPicks, getPickStats, getOutcomes, getEventDossiers } from '../lib/api'
import { IconGear, IconNews } from '../components/icons'

// Research: everything the analyst produces and how it performs.
// The accountability page: reports, picks, persistence, scorecard, track record.

export function Research({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [ai, setAi] = useState<Awaited<ReturnType<typeof getAiRead>> | null>(null)
  const [picks, setPicks] = useState<Awaited<ReturnType<typeof getPicks>> | null>(null)
  const [pickStats, setPickStats] = useState<Awaited<ReturnType<typeof getPickStats>> | null>(null)
  const [outcomes, setOutcomes] = useState<Awaited<ReturnType<typeof getOutcomes>>>([])
  const [events, setEvents] = useState<Awaited<ReturnType<typeof getEventDossiers>>>([])

  useEffect(() => {
    getAiRead().then(setAi).catch(() => {})
    getPicks().then(setPicks).catch(() => {})
    getPickStats().then(setPickStats).catch(() => {})
    getOutcomes().then(setOutcomes).catch(() => {})
    getEventDossiers().then(setEvents).catch(() => {})
  }, [])

  return (
    <>
      <header className="topbar">
        <span className="brand">Research</span>
        <button className="gear" onClick={onOpenSettings} aria-label="Settings"><IconGear /></button>
      </header>
      <div className="content digest-cols">
        {events.length > 0 && (
          <section className="digest-section">
            <h3 className="section-title">Event assessments</h3>
            {events.map(e => (
              <div key={e.sym + e.at} className="ai-card" style={{ marginBottom: 8, borderColor: e.kind === 'shock' ? 'rgba(255,93,115,0.45)' : 'rgba(245,184,61,0.45)' }}>
                <h3 style={{ color: 'var(--text)', fontSize: 14 }}>
                  {e.kind === 'shock' ? `⚡ ${e.name} ${e.movePct! > 0 ? '+' : ''}${e.movePct}%` : `🎈 ${e.name} stretched (${e.zScore}σ, RSI ${e.rsi})`}
                  <span style={{ color: 'var(--faint)', fontWeight: 400, fontSize: 11 }}>
                    {' '}{new Date(e.at * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </h3>
                <p style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{e.assessment}</p>
                <span className="ai-note">Magnitude scenarios are grounded in measured historical analogues. Assessment, not advice.</span>
              </div>
            ))}
          </section>
        )}

        <a className="link-card hero-card" href="/report">
          <IconNews /> Today's strategy report
          <span>Fresh analysis every weekday morning. Sundays: the week ahead.</span>
        </a>

        <div className="ai-card">
          <h3>AI read</h3>
          {ai?.text ? (
            <>
              <p>{ai.text}</p>
              <span className="ai-note">AI interpretation ({ai.provider}). Not a prediction, not advice.</span>
            </>
          ) : ai?.unconfigured ? (
            <p className="ai-note">AI gateway not configured on this site.</p>
          ) : ai?.empty ? (
            <p className="ai-note">Add tickers to your watchlist first.</p>
          ) : (
            <p className="ai-note">Loading…</p>
          )}
        </div>

        {picks && picks.persistence.length > 0 && (
          <section className="digest-section">
            <h3 className="section-title">Pick persistence ({picks.reports} reports)</h3>
            {picks.persistence.slice(0, 10).map(p => (
              <div key={p.ticker + p.side} className="perf-row" style={p.persistent ? { borderColor: 'rgba(34,201,141,0.5)' } : undefined}>
                <span>
                  {p.ticker} <span className={`badge ${p.side === 'long' ? 'good' : 'bad'}`}>{p.side}</span>{' '}
                  {p.persistent && <span className="badge good">📌 persistent</span>}
                </span>
                <span style={{ color: 'var(--muted)' }}>
                  {p.streak > 1 ? `${p.streak} in a row` : `${p.appearances} of last 7`}
                  {p.latestConviction ? ` · grade ${p.latestConviction}` : ''}
                </span>
              </div>
            ))}
            <p className="empty-line" style={{ fontSize: 11 }}>A pick surviving several independent analyses is stronger evidence than one day's conviction.</p>
          </section>
        )}

        {pickStats && pickStats.scores.length > 0 && (
          <section className="digest-section">
            <h3 className="section-title">Scorecard: is the research earning?</h3>
            {pickStats.scores.slice(0, 8).map(s => (
              <div key={s.bucket} className="perf-row">
                <span>{s.bucket} <span style={{ color: 'var(--faint)' }}>×{s.n}</span></span>
                <span>{s.win5 != null ? <><span className={s.avg5! >= 0 ? 'up-text' : 'down-text'}>{s.avg5!.toFixed(1)}% @5d</span> · {Math.round(s.win5 * 100)}% win</> : 'too recent to score'}</span>
              </div>
            ))}
            <p className="empty-line" style={{ fontSize: 11 }}>Every pick scored against what price actually did. Below ~30 scored picks, treat as noise.</p>
          </section>
        )}

        {outcomes.length > 0 && (
          <section className="digest-section">
            <h3 className="section-title">The track record, day by day</h3>
            {outcomes.slice(0, 10).map(d => (
              <div key={d.date} className="perf-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 3 }}>
                <span>
                  <a href={`/report?date=${d.date}`} target="_blank" rel="noreferrer" style={{ color: 'var(--text)' }}>
                    {new Date(d.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                  </a>
                  {d.regime && <span className={`badge ${d.regime === 'green' ? 'good' : d.regime === 'red' ? 'bad' : 'warn'}`} style={{ marginLeft: 6 }}>{d.regime}</span>}
                </span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {d.picks.map(p => (
                    <span key={p.ticker + p.side} style={{ marginRight: 10 }}>
                      {p.strength === 'strong' && '🎯'}{p.ticker}{p.side === 'short' ? '↓' : ''}
                      {p.f5 != null && <em className={p.f5 >= 0 ? 'up-text' : 'down-text'} style={{ fontStyle: 'normal' }}> {p.f5 >= 0 ? '+' : ''}{p.f5.toFixed(1)}%</em>}
                    </span>
                  ))}
                </span>
              </div>
            ))}
            <p className="empty-line" style={{ fontSize: 11 }}>Each date opens the full article. The % is the 5-session move after the call.</p>
          </section>
        )}

        <footer className="foot">Research, measured. Nothing here predicts.</footer>
      </div>
    </>
  )
}
