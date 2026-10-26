import type { StrategyObservation } from '../../../shared/engine/strategyLab'
import { holdingPeriod, researchWording } from '../../lib/plainLanguage'
const LABELS: Record<StrategyObservation['sleeve'], string> = { 'short-horizon': 'Short-term direction', 'quality-dip': 'Recovery after a fall', 'social-ignition': 'Growing attention', 'macro-event': 'Major events', 'composite-control': 'Combined view' }
const STATES = { setup: 'Worth a closer look', watch: 'Watching', avoid: 'Avoid for now', collecting: 'Needs more evidence' }
export function StrategyGlance({ symbol, observations, onEvidence }: { symbol: string; observations?: StrategyObservation[]; onEvidence: () => void }) {
  const now = Date.now() / 1000
  const rows = [...(observations ?? [])].filter(r => r.sym === symbol && r.availableAt <= now)
    .sort((a, b) => b.availableAt - a.availableAt).filter((r, i, all) => all.findIndex(p => p.sleeve === r.sleeve) === i)
  if (!rows.length) return null
  return <section className="strategy-glance" aria-label="Strategy views at a glance">
    <div className="dossier-section-head"><div><span className="dossier-eyebrow">Separate views</span><h2>What each strategy sees</h2></div></div>
    <div className="strategy-glance-grid">{rows.map(row => <article key={row.sleeve}>
      <h3>{LABELS[row.sleeve]}</h3><span className={`strategy-glance-state ${row.state}`}>{STATES[row.state]}</span>
      <p>{researchWording(row.reasons[0] || 'Waiting for enough information to judge this strategy.')}</p>
      <small>{holdingPeriod(row.forecast.horizonSessions)} · {now - row.availableAt > 3 * 86400 ? 'Older scan · ' : ''}{new Date(row.availableAt * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</small>
    </article>)}</div>
    <button className="strategy-evidence-link" type="button" onClick={onEvidence}>See the evidence for these strategies <span aria-hidden="true">→</span></button>
  </section>
}
