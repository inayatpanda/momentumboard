import { useEffect, useState } from 'react'
import { getAiRead, getPicks, getPickStats, getOutcomes, getEventDossiers } from '../lib/api'
import { IconGear, IconNews, IconFlame, IconBalloon, IconPin, IconTarget, IconShare } from '../components/icons'
import { EnginePanel } from '../components/EnginePanel'
import { ClampText } from '../components/AskDesk'

// Research: everything the analyst produces and how it performs.
// The accountability page: reports, picks, persistence, scorecard, track record.

export function Research({ onOpenSettings, onOpenLedger }: { onOpenSettings: () => void; onOpenLedger: () => void }) {
  const [ai, setAi] = useState<Awaited<ReturnType<typeof getAiRead>> | null>(null)
  const [picks, setPicks] = useState<Awaited<ReturnType<typeof getPicks>> | null>(null)
  const [pickStats, setPickStats] = useState<Awaited<ReturnType<typeof getPickStats>> | null>(null)
  const [outcomes, setOutcomes] = useState<Awaited<ReturnType<typeof getOutcomes>>>([])
  const [events, setEvents] = useState<Awaited<ReturnType<typeof getEventDossiers>>>([])

  useEffect(() => {
    // ?? [] on the list fetchers: an empty server blob comes back as data:null,
    // and a null in list state crashes the whole screen on .length
    getAiRead().then(setAi).catch(() => {})
    getPicks().then(setPicks).catch(() => {})
    getPickStats().then(setPickStats).catch(() => {})
    getOutcomes().then(o => setOutcomes(o ?? [])).catch(() => {})
    getEventDossiers().then(e => setEvents(e ?? [])).catch(() => {})
  }, [])

  return (
    <>
      <header className="topbar">
        <span className="brand">Research</span>
        <button className="gear" onClick={onOpenSettings} aria-label="Settings"><IconGear /></button>
      </header>
      <div className="content digest-cols">
        <a className="link-card hero-card" onClick={e => { e.preventDefault(); onOpenLedger() }} href="#ledger" style={{ marginBottom: 12 }}>
          <IconTarget /> Prediction ledger
          <span>Every call the engine made — column by column, with what happened. Judge the tool.</span>
        </a>
        <EnginePanel />
        {events.length > 0 && (
          <section className="digest-section">
            <h3 className="section-title">Event assessments</h3>
            {events.map(e => (
              <div key={e.sym + e.at} className={`ai-card ${e.kind === 'shock' ? 'rsc-shock' : 'rsc-stretch'}`} style={{ marginBottom: 8 }}>
                <h3 className="rsc-ai-h">
                  {e.kind === 'shock' ? <><IconFlame /> {e.name}</> : <><IconBalloon /> {e.name} stretched ({e.zScore}σ, RSI {e.rsi})</>}
                  {e.kind === 'shock' && e.movePct != null && (
                    <span className={`chg-pill ${e.movePct >= 0 ? 'up' : 'down'}`} style={{ marginLeft: 8 }}>{e.movePct >= 0 ? '+' : ''}{e.movePct}%</span>
                  )}
                  <span className="rsc-when">
                    {' '}{new Date(e.at * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </h3>
                <ClampText text={e.assessment} />
                <span className="ai-note">Magnitude scenarios are grounded in measured historical analogues. Assessment, not advice.</span>
              </div>
            ))}
          </section>
        )}

        <div style={{ position: 'relative' }}>
          <a className="link-card hero-card" href="/report">
            <IconNews /> Today's strategy report
            <span>Fresh analysis every morning. Weekends: the week ahead.</span>
          </a>
          <button
            className="mini-btn ghost"
            style={{ position: 'absolute', top: 12, right: 12 }}
            onClick={e => {
              e.preventDefault()
              const url = `${location.origin}/report`
              if (navigator.share) navigator.share({ title: 'The Street Signal', url }).catch(() => {})
              else navigator.clipboard?.writeText(url)
            }}
            aria-label="Share report"
          >
            <IconShare size={13} /> Share
          </button>
        </div>

        <div className="ai-card">
          <h3>AI read</h3>
          {ai?.text ? (
            <>
              <ClampText text={ai.text} />
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
              <div key={p.ticker + p.side} className={`perf-row${p.persistent ? ' rsc-persist' : ''}`}>
                <span>
                  {p.ticker} <span className={`badge ${p.side === 'long' ? 'good' : 'bad'}`}>{p.side}</span>{' '}
                  {p.persistent && <span className="badge good"><IconPin /> persistent</span>}
                </span>
                <span className="rsc-win">
                  {p.streak > 1 ? `${p.streak} in a row` : `${p.appearances} of last 7`}
                  {p.latestConviction ? ` · grade ${p.latestConviction}` : ''}
                </span>
              </div>
            ))}
            <p className="empty-line rsc-fine">A pick surviving several independent analyses is stronger evidence than one day's conviction.</p>
          </section>
        )}

        {pickStats && pickStats.scores.length > 0 && (
          <section className="digest-section">
            <h3 className="section-title">Scorecard: is the research earning?</h3>
            {pickStats.scores.slice(0, 8).map(s => (
              <div key={s.bucket} className="perf-row">
                <span>{s.bucket} <span className="rsc-n">×{s.n}</span></span>
                <span>
                  {s.win5 != null ? (
                    <><span className={`chg-pill ${s.avg5! >= 0 ? 'up' : 'down'}`}>{s.avg5! >= 0 ? '+' : ''}{s.avg5!.toFixed(1)}% @5d</span> <span className="rsc-win">{Math.round(s.win5 * 100)}% win</span></>
                  ) : (
                    <span className="rsc-win">too recent to score</span>
                  )}
                </span>
              </div>
            ))}
            <p className="empty-line rsc-fine">Every pick scored against what price actually did. Below ~30 scored picks, treat as noise.</p>
          </section>
        )}

        {outcomes.length > 0 && (
          <section className="digest-section">
            <h3 className="section-title">The track record, day by day</h3>
            {outcomes.slice(0, 10).map(d => (
              <div key={d.date} className="perf-row rsc-day">
                <span>
                  <a href={`/report?date=${d.date}`} target="_blank" rel="noreferrer" style={{ color: 'var(--text)' }}>
                    {new Date(d.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                  </a>
                  {d.regime && <span className={`badge ${d.regime === 'green' ? 'good' : d.regime === 'red' ? 'bad' : 'warn'}`} style={{ marginLeft: 6 }}>{d.regime}</span>}
                </span>
                <span className="rsc-day-picks">
                  {d.picks.map(p => (
                    <span key={p.ticker + p.side} style={{ marginRight: 10 }}>
                      {p.strength === 'strong' && <IconTarget size={11} />}{p.ticker}{p.side === 'short' ? '↓' : ''}
                      {p.f5 != null && <em className={p.f5 >= 0 ? 'up-text' : 'down-text'} style={{ fontStyle: 'normal' }}> {p.f5 >= 0 ? '+' : ''}{p.f5.toFixed(1)}%</em>}
                    </span>
                  ))}
                </span>
              </div>
            ))}
            <p className="empty-line rsc-fine">Each date opens the full article. The % is the 5-session move after the call.</p>
          </section>
        )}

        <footer className="foot">Research, measured. Nothing here predicts.</footer>
      </div>
    </>
  )
}
