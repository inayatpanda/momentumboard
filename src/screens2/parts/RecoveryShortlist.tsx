import { Link } from 'wouter'
import { nextCheckWording } from '../../lib/plainLanguage'
import type { EngineLabSnapshot } from '../../../shared/engine/strategyLab'
import { recoveryChecklist } from '../../../shared/engine/recoveryChecklist'

export function RecoveryShortlist({lab, onResearch}:{lab?:EngineLabSnapshot|null;onResearch:()=>void}) {
  if (!lab) return null
  const rows=lab.observations.filter(r=>r.sleeve==='quality-dip' && r.state!=='avoid')
    .sort((a,b)=>Number(b.state==='setup')-Number(a.state==='setup') || Number(b.metrics.financialHealth==='healthy')-Number(a.metrics.financialHealth==='healthy') || b.score-a.score).slice(0,3)
  return <section className="recovery-shortlist" aria-label="Recovery shortlist">
    <header><div><span className="research-eyebrow">After a price fall</span><h2>Could these businesses recover?</h2></div><button type="button" onClick={onResearch}>View research <span aria-hidden="true">↗</span></button></header>
    <p>Stocks that have fallen in price. Check the business, the risks and what still needs to improve.</p>
    {!rows.length ? <p>No recovery candidate currently meets the watchlist screen. The next daily scan will reassess new reports and prices.</p> : <div className="recovery-shortlist-rows">{rows.map(row=>{
      const checks=recoveryChecklist(row), next=checks.find(c=>!c.passed)
      return <Link key={row.id} href={`/stock/${row.sym}`} className="recovery-shortlist-row">
        <div><strong>{row.sym}</strong><span className={`research-state ${row.state}`}>{row.state==='setup'?'Worth a closer look':'Still being checked'}</span></div>
        <p>{typeof row.metrics.drawdownPct==='number'?`${Math.abs(row.metrics.drawdownPct).toFixed(1)}% below its recent high`:'Recovery under review'} · {checks.filter(c=>c.passed).length}/{checks.length} checks met</p>
        <span><b>{next?'Next check':'Before acting'}</b> {next ? nextCheckWording(next.label, next.detail) : 'Review current prices, company results and sources'}</span>
      </Link>
    })}</div>}
  </section>
}
