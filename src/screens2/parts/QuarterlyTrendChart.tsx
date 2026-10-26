import { useState } from 'react'
import type { FinancialQuarter, QuarterlyMetric } from '../../../shared/quarterlyFinancials'
const METRICS: { key: QuarterlyMetric; label: string }[] = [{ key: 'revenue', label: 'Sales' }, { key: 'netIncome', label: 'Profit' }, { key: 'freeCashFlow', label: 'Free cash flow' }]
const money = (n: number | null) => n == null || !Number.isFinite(n) ? 'Unavailable' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', minimumFractionDigits: 0, maximumFractionDigits: 1 }).format(n)
const date = (end: string) => new Date(`${end}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' })
export function QuarterlyTrendChart({ quarters }: { quarters: FinancialQuarter[] }) {
  const [metric, setMetric] = useState<QuarterlyMetric>('revenue')
  const [selectedEnd, setSelectedEnd] = useState<string | null>(null)
  const points = quarters.slice(-8), selected = points.find(p => p.end === selectedEnd) ?? points.at(-1)
  if (!selected) return null
  const values = points.map(p => p.values[metric]).filter((n): n is number => n != null && Number.isFinite(n))
  const lo = Math.min(0, ...values), hi = Math.max(0, ...values), span = hi - lo || 1
  const zero = hi / span * 100
  const label = METRICS.find(m => m.key === metric)!.label
  return <div className="quarter-trends">
    <div className="report-segments" role="group" aria-label="Quarterly chart measure">{METRICS.map(m => <button key={m.key} aria-pressed={metric === m.key} onClick={() => setMetric(m.key)}>{m.label}</button>)}</div>
    <div className="quarter-selected" aria-live="polite"><strong>{money(selected.values[metric])}</strong><span>{label} · quarter ended {selected.end}</span></div>
    <div className="quarter-bars" role="group" aria-label={`${label} by quarter in US dollars`}>{points.map(p => {
      const n = p.values[metric], known = n != null && Number.isFinite(n)
      return <button key={p.end} type="button" aria-pressed={p.end === selected.end} aria-label={`${date(p.end)}: ${money(n)}`} onClick={() => setSelectedEnd(p.end)}>
        <span className="quarter-bar-track" aria-hidden="true"><i className="quarter-zero" style={{ top: `${zero}%` }}/>{known ? <i className={`quarter-bar ${n! < 0 ? 'negative' : ''}`} style={{ top: `${n! >= 0 ? zero - n! / span * 100 : zero}%`, height: `${Math.max(1, Math.abs(n!) / span * 100)}%` }} /> : <span className="quarter-missing">—</span>}</span>
        <span>{date(p.end)}</span>
      </button>
    })}</div>
    <p className="dossier-caption">{values.length ? 'Select a quarter to see its figures. USD · individual quarters.' : 'No reported values for this measure.'}{points.some(p => p.values[metric] == null) ? ' A dash means the figure is missing.' : ''}</p>
  </div>
}
