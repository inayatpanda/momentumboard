import { useEffect, useState } from 'react'
import { getBulletins, getOutcomes, getReportList } from '../lib/api'
import { humanError } from '../lib/format'
import { IconGear, IconTarget } from '../components/icons'

// REPORTS: every dispatch the desk has published, newest first — the same
// papers that land in the inbox each morning, archived in the app forever
// (well, the last 90 editions). Each row opens the full edition as printed.
// This is the paper's archive, so the serif headline voice lives here.

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
      <div className="content">
        {error && <p className="empty-line">Archive unavailable — {error}.</p>}
        {!dates && !error && (
          <div aria-hidden style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {[0, 1, 2, 3, 4].map(i => <div key={i} className="skeleton" style={{ height: 88 }} />)}
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
              const dt = new Date(d)
              const weekend = [0, 6].includes(dt.getDay())
              const scored = o?.picks.filter(p => p.f5 != null).length ?? 0
              const dayBulletins = bulletinsByDate.get(d) ?? []
              return (
                <a key={d} className="link-card report-card" href={`/report?date=${d}`} target="_blank" rel="noreferrer">
                  <span className="report-eyebrow">
                    <span className="eyebrow">{weekend ? 'Weekend edition' : 'Morning edition'}</span>
                    {d === today && <span className="badge info">today</span>}
                    {o?.regime && (
                      <span className={`badge ${o.regime === 'green' ? 'good' : o.regime === 'red' ? 'bad' : 'warn'}`}>{o.regime}</span>
                    )}
                  </span>
                  <strong className="report-headline">
                    {dt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
                  </strong>
                  {o && o.picks.length > 0 && (
                    <span className="report-meta">
                      {o.picks.length} {o.picks.length === 1 ? 'call' : 'calls'} on the board
                      {scored > 0 ? ` · ${scored} scored since print` : ''}
                    </span>
                  )}
                  {o && o.picks.length > 0 && (
                    <span className="report-picks">
                      {o.picks.slice(0, 5).map(p => (
                        <span key={p.ticker + p.side} className="report-pick">
                          {p.strength === 'strong' && <IconTarget size={10} />}
                          {p.ticker}
                          {p.side === 'short' ? '↓' : ''}
                          {p.f5 != null && (
                            <em className={p.f5 >= 0 ? 'up-text' : 'down-text'}> {p.f5 >= 0 ? '+' : ''}{p.f5.toFixed(1)}%</em>
                          )}
                        </span>
                      ))}
                    </span>
                  )}
                  <span className="report-bulletins">
                    {dayBulletins.map(k => (
                      <a
                        key={k}
                        className="badge info"
                        href={`/report?bulletin=${d}:${k}`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={e => e.stopPropagation()}
                      >
                        {k === 'premarket' ? 'pre-market' : 'evening'}
                      </a>
                    ))}
                    {/* the edition is one self-contained document — this saves it as a
                        share-anywhere .html that opens offline in any browser */}
                    <a className="badge" href={`/report?date=${d}&download=1`} onClick={e => e.stopPropagation()} title="Download this edition as a shareable HTML file">
                      ⤓ html
                    </a>
                  </span>
                  <span className="report-chev" aria-hidden="true">›</span>
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
