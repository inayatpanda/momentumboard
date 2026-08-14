import { useEffect, useState } from 'react'
import { db, type NoteItem } from '../lib/db'
import { apiUrl, getMonthMap, getDayLedger } from '../lib/api'
import { IconGear, IconNews, IconTarget, stripEmoji } from '../components/icons'
import type { Trade } from '../../shared/journal'

// The day ledger: everything the desk produced on any given date — the paper,
// picks, alerts, event assessments, watched videos — merged with YOUR notes
// and trades from that day. Server supplies its side; Dexie supplies yours.

const monthLabel = (ym: string) =>
  new Date(`${ym}-01`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })

const todayISO = () => new Date().toISOString().slice(0, 10)

export function CalendarScreen({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [month, setMonth] = useState(todayISO().slice(0, 7))
  const [map, setMap] = useState<Awaited<ReturnType<typeof getMonthMap>>>({})
  const [selected, setSelected] = useState<string>(todayISO())
  const [ledger, setLedger] = useState<Awaited<ReturnType<typeof getDayLedger>> | null>(null)
  const [notes, setNotes] = useState<NoteItem[]>([])
  const [trades, setTrades] = useState<Trade[]>([])

  useEffect(() => {
    getMonthMap(month).then(setMap).catch(() => setMap({}))
  }, [month])

  useEffect(() => {
    if (!selected) return
    setLedger(null)
    getDayLedger(selected).then(setLedger).catch(() => {})
    const dayStart = Date.parse(selected) / 1000
    const dayEnd = dayStart + 86_400
    db.notes.toArray().then(all => setNotes(all.filter(n => n.at >= dayStart && n.at < dayEnd)))
    db.trades.toArray().then(all =>
      setTrades(all.filter(t => (t.openedAt >= dayStart && t.openedAt < dayEnd) || (t.closedAt != null && t.closedAt >= dayStart && t.closedAt < dayEnd))),
    )
  }, [selected])

  const shiftMonth = (delta: number) => {
    const d = new Date(`${month}-01T00:00:00Z`)
    d.setUTCMonth(d.getUTCMonth() + delta)
    setMonth(d.toISOString().slice(0, 7))
  }

  // grid: monday-first
  const first = new Date(`${month}-01T00:00:00Z`)
  const daysInMonth = new Date(first.getUTCFullYear(), first.getUTCMonth() + 1, 0).getDate()
  const lead = (first.getUTCDay() + 6) % 7
  const cells: (string | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`),
  ]

  return (
    <>
      <header className="topbar">
        <span className="brand">Calendar</span>
        <button className="gear" onClick={onOpenSettings} aria-label="Settings"><IconGear /></button>
      </header>
      <div className="content">
        <div className="cal-head">
          <button className="mini-btn ghost" onClick={() => shiftMonth(-1)} aria-label="Previous month">‹</button>
          <strong>{monthLabel(month)}</strong>
          <button className="mini-btn ghost" onClick={() => shiftMonth(1)} aria-label="Next month">›</button>
        </div>
        <div className="cal-grid">
          {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
            <span key={i} className="cal-dow">{d}</span>
          ))}
          {cells.map((date, i) =>
            date ? (
              <button
                key={date}
                className={`cal-day${date === selected ? ' sel' : ''}${date === todayISO() ? ' today' : ''}`}
                onClick={() => setSelected(date)}
              >
                {Number(date.slice(8))}
                <span className="cal-dots">
                  {map[date]?.r && <i className="dot report" title="Report" />}
                  {(map[date]?.p ?? 0) > 0 && <i className="dot picks" title="Picks" />}
                  {(map[date]?.a ?? 0) > 0 && <i className="dot alerts" title="Alerts" />}
                  {(map[date]?.e ?? 0) > 0 && <i className="dot events" title="Event" />}
                </span>
              </button>
            ) : (
              <span key={`x${i}`} />
            ),
          )}
        </div>

        <h3 className="section-title" style={{ marginTop: 18 }}>
          {new Date(selected).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
          {ledger?.regime && <span className={`badge ${ledger.regime === 'green' ? 'good' : ledger.regime === 'red' ? 'bad' : 'warn'}`} style={{ marginLeft: 8 }}>{ledger.regime}</span>}
        </h3>

        {!ledger && <p className="empty-line">Loading the day…</p>}
        {ledger && (
          <>
            {ledger.hasReport && (
              <a className="link-card" href={apiUrl(`/report?date=${selected}`)} target="_blank" rel="noreferrer">
                <IconNews /> The Street Signal — {new Date(selected).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} edition
                <span>The full paper as published that morning.</span>
              </a>
            )}

            {ledger.picks.length > 0 && (
              <section className="digest-section">
                <h3 className="section-title">Picks made this day</h3>
                {ledger.picks.map(p => (
                  <div key={p.ticker + p.side} className="perf-row">
                    <span>
                      {p.strength === 'strong' && <IconTarget size={11} />} {p.ticker}
                      <span className={`badge ${p.side === 'long' ? 'good' : 'bad'}`} style={{ marginLeft: 6 }}>{p.side}</span>
                    </span>
                    <span className="cal-meta">
                      {p.conviction ? `grade ${p.conviction}` : ''}{p.priceAtPick != null ? ` · at ${p.priceAtPick}` : ''}
                    </span>
                  </div>
                ))}
              </section>
            )}

            {trades.length > 0 && (
              <section className="digest-section">
                <h3 className="section-title">Your trades</h3>
                {trades.map(t => (
                  <div key={t.id} className="perf-row">
                    <span>{t.symbol} <span className="badge info">{t.exitPrice != null ? 'closed' : 'opened'}</span></span>
                    <span className="cal-meta">{t.units} @ {t.entryPrice}{t.exitPrice != null ? ` → ${t.exitPrice}` : ''}</span>
                  </div>
                ))}
              </section>
            )}

            {notes.length > 0 && (
              <section className="digest-section">
                <h3 className="section-title">Your notes</h3>
                {notes.map(n => (
                  <div key={n.id} className="card cal-note-card">
                    <span className="cal-note-text"><span className="badge info">{n.kind}</span> {n.text}</span>
                    {n.aiTake && <p className="cal-note-ai">{n.aiTake}</p>}
                  </div>
                ))}
              </section>
            )}

            {ledger.events.length > 0 && (
              <section className="digest-section">
                <h3 className="section-title">Event assessments</h3>
                {ledger.events.map(e => (
                  <div key={e.name + e.at} className="card cal-event-card">
                    <strong className="cal-event-name">{e.name} ({e.kind})</strong>
                    <p className="cal-event-assess">{e.assessment}…</p>
                  </div>
                ))}
              </section>
            )}

            {ledger.alerts.length > 0 && (
              <section className="digest-section">
                <h3 className="section-title">Alerts that day ({ledger.alerts.length})</h3>
                {ledger.alerts.map((a, i) => (
                  <div key={i} className="perf-row cal-alert">
                    <span className="cal-ellip">{stripEmoji(a.text)}</span>
                    <span className="cal-when">
                      {new Date(a.at * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                ))}
              </section>
            )}

            {ledger.videos.length > 0 && (
              <section className="digest-section">
                <h3 className="section-title">AI-watched that day</h3>
                <ul className="news-rows">
                  {ledger.videos.map(v => (
                    <li key={v.url}>
                      <a className="news-row" href={v.url} target="_blank" rel="noreferrer">
                        <span className="news-row-main">
                          <span className="news-row-title">{v.title ?? v.url}</span>
                          {v.channel && <span className="news-row-meta">{v.channel}</span>}
                        </span>
                        <span className="news-row-go" aria-hidden="true">↗</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {!ledger.hasReport && !ledger.picks.length && !ledger.alerts.length && !notes.length && !trades.length && !ledger.events.length && (
              <p className="empty-line">A quiet day — nothing recorded.</p>
            )}
          </>
        )}
        <footer className="foot">Every day's paper, picks, alerts and notes in one ledger.</footer>
      </div>
    </>
  )
}
