import { useEffect, useState } from 'react'
import { getBulletins, getOutcomes, getReportList } from '../lib/api'
import { humanError } from '../lib/format'
import { IconGear, IconNews, IconTarget } from '../components/icons'
import { SubNav } from '../components/TabBar'

// REPORTS: every dispatch the desk has published, newest first — the same
// papers that land in the inbox each morning, archived in the app forever
// (well, the last 90 editions). Each row opens the full edition as printed.

export function Reports({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [dates, setDates] = useState<string[] | null>(null)
  const [outcomes, setOutcomes] = useState<Awaited<ReturnType<typeof getOutcomes>>>([])
  const [error, setError] = useState<string | null>(null)

  const [bulletins, setBulletins] = useState<{ date: string; kind: 'premarket' | 'evening' }[]>([])

  useEffect(() => {
    getReportList().then(setDates).catch(e => setError(humanError(e)))
    getOutcomes().then(o => setOutcomes(o ?? [])).catch(() => {})
    getBulletins().then(b => setBulletins(b ?? [])).catch(() => {})
  }, [])

  const byDate = new Map(outcomes.map(o => [o.date, o]))
  const bulletinsByDate = new Map<string, ('premarket' | 'evening')[]>()
  for (const b of bulletins) bulletinsByDate.set(b.date, [...(bulletinsByDate.get(b.date) ?? []), b.kind])
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })

  return (
    <>
      <header className="topbar">
        <span className="brand">Reports</span>
        <button className="gear" onClick={onOpenSettings} aria-label="Settings"><IconGear /></button>
      </header>
      <SubNav />
      <div className="content">
        {error && <p className="empty-line">Archive unavailable — {error}.</p>}
        {!dates && !error && (
          <div aria-hidden style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {[0, 1, 2, 3, 4].map(i => <div key={i} className="skeleton" style={{ height: 64 }} />)}
          </div>
        )}
        {dates && dates.length === 0 && (
          <div className="empty" style={{ marginTop: 12 }}>
            <p>No editions yet.</p>
            <p>The desk publishes every morning (~06:45 UK); weekend editions look at the week ahead.</p>
          </div>
        )}
        {dates && dates.length > 0 && (
          <div style={{ marginTop: 8 }}>
            {dates.map(d => {
              const o = byDate.get(d)
              return (
                <a key={d} className="link-card" href={`/report?date=${d}`} target="_blank" rel="noreferrer">
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <IconNews />
                    <strong>
                      {new Date(d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
                    </strong>
                    {d === today && <span className="badge info">today</span>}
                    {o?.regime && (
                      <span className={`badge ${o.regime === 'green' ? 'good' : o.regime === 'red' ? 'bad' : 'warn'}`} style={{ marginLeft: 'auto' }}>{o.regime}</span>
                    )}
                  </span>
                  {o && o.picks.length > 0 && (
                    <span>
                      {o.picks.slice(0, 5).map(p => (
                        <span key={p.ticker + p.side} style={{ marginRight: 10 }}>
                          {p.strength === 'strong' && <IconTarget size={10} />}
                          {p.ticker}
                          {p.side === 'short' ? '↓' : ''}
                          {p.f5 != null && (
                            <em className={p.f5 >= 0 ? 'up-text' : 'down-text'} style={{ fontStyle: 'normal' }}> {p.f5 >= 0 ? '+' : ''}{p.f5.toFixed(1)}%</em>
                          )}
                        </span>
                      ))}
                    </span>
                  )}
                  {(bulletinsByDate.get(d) ?? []).length > 0 && (
                    <span style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                      {(bulletinsByDate.get(d) ?? []).map(k => (
                        <a
                          key={k}
                          className="badge info"
                          href={`/report?bulletin=${d}:${k}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ textDecoration: 'none' }}
                          onClick={e => e.stopPropagation()}
                        >
                          {k === 'premarket' ? 'pre-market' : 'evening'}
                        </a>
                      ))}
                    </span>
                  )}
                </a>
              )
            })}
          </div>
        )}
        <footer className="foot">
          The last 90 editions, exactly as published. Same paper lands in your email each morning once email delivery is configured in Settings → the server env.
        </footer>
      </div>
    </>
  )
}
