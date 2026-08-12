import { useState } from 'react'
import type { Trade } from '../../shared/journal'
import type { EnginePrediction, EngineData } from '../lib/api'
import { positionSize } from '../../shared/risk'
import { IconWarn } from './icons'

const PLAYBOOKS = [
  { key: 'R', label: 'R — Reversal' },
  { key: 'B', label: 'B — Pullback' },
  { key: 'A', label: 'A — Breakout' },
  { key: 'S', label: 'S — Fade (inverse)' },
] as const

const gbp0 = (v: number) => v.toLocaleString('en-GB', { maximumFractionDigits: 0 })
const trim = (n: number) => +n.toFixed(2)

export function TradeForm({
  onAdd,
  board,
  riskState,
  capital = 5000,
}: {
  onAdd: (t: Trade) => void
  board?: EnginePrediction[]
  riskState?: EngineData['riskState']
  capital?: number
}) {
  const [f, setF] = useState({ symbol: '', playbook: 'R', instrument: 'stock', leverage: '1', riskClass: 'normal', entry: '', stop: '', value: '', thesis: '', fromSuggestion: false })
  const set = (k: string, v: string | boolean) => setF(s => ({ ...s, [k]: v }))

  const symbol = f.symbol.trim().toUpperCase()
  // The engine's own view of this ticker, if it made a live call today. A near
  // miss is NOT a call — offering its levels as "engine levels" would stamp
  // fromSuggestion on a name the engine declined. An observation IS a call and
  // still not a takeable one: an ISA cannot place it, so handing over its entry
  // and stop would size a position the engine never offered.
  const call = symbol ? board?.find(p => p.sym === symbol && !p.nearMiss && !p.observation) ?? null : null
  const riskClass = f.riskClass as 'normal' | 'speculative'
  const entryN = parseFloat(f.entry)
  const stopN = parseFloat(f.stop)

  // Risk budget: the engine's rung-adjusted riskPct when it has called this name,
  // else shared/risk defaults by class (2% / 1% spec). Engine pct already reflects
  // the rung, so it isn't re-halved for a speculative class — the engine's number wins.
  const riskPct = call ? call.riskPct : 2
  const size = positionSize({ capital, riskPct, entry: entryN || 0, stop: stopN || 0, riskClass: call ? 'normal' : riskClass })
  const naturalShares = size ? Math.floor(size.riskAmount / size.perUnitRisk) : null
  const effPct = size ? trim((size.riskAmount / capital) * 100) : 0
  const rungLabel = call ? `at R${call.riskRung}` : riskState ? `default · ladder at R${riskState.rung}` : 'default'

  const useEngineLevels = () => {
    if (!call) return
    setF(s => ({ ...s, entry: String(call.entry), stop: String(call.stop), fromSuggestion: true }))
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const entry = parseFloat(f.entry)
    const stop = parseFloat(f.stop)
    const value = parseFloat(f.value)
    if (!f.symbol.trim() || !Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(value) || entry <= 0 || value <= 0) return
    onAdd({
      id: `tr-${Date.now()}`,
      symbol,
      direction: f.playbook === 'S' ? 'short' : 'long',
      instrument: f.instrument as 'stock' | 'etp',
      leverage: parseInt(f.leverage) || 1,
      riskClass,
      playbook: f.playbook as Trade['playbook'],
      fromSuggestion: f.fromSuggestion,
      units: value / entry,
      entryPrice: entry,
      stop,
      positionValue: value,
      thesis: f.thesis.trim(),
      openedAt: Math.floor(Date.now() / 1000),
    })
    setF({ symbol: '', playbook: 'R', instrument: 'stock', leverage: '1', riskClass: 'normal', entry: '', stop: '', value: '', thesis: '', fromSuggestion: false })
  }

  return (
    <form className="trade-form" onSubmit={submit}>
      <div className="tf-row">
        <label>Ticker<input value={f.symbol} onChange={e => set('symbol', e.target.value)} placeholder="AAPL / 3LTS.L" aria-label="Trade ticker" /></label>
        <label>Playbook
          <select value={f.playbook} onChange={e => set('playbook', e.target.value)}>
            {PLAYBOOKS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </label>
      </div>
      <div className="tf-row">
        <label>Entry<input inputMode="decimal" value={f.entry} onChange={e => set('entry', e.target.value)} aria-label="Trade entry" /></label>
        <label>Stop<input inputMode="decimal" value={f.stop} onChange={e => set('stop', e.target.value)} aria-label="Trade stop" /></label>
        <label>£ invested<input inputMode="decimal" value={f.value} onChange={e => set('value', e.target.value)} aria-label="Trade value" /></label>
      </div>

      {call && (
        <div className="tf-engine">
          <button type="button" className="use-engine" onClick={useEngineLevels}>
            use engine levels
          </button>
          <span className="tf-engine-lv num">in {call.entry} · stop {call.stop} · tgt {call.target}</span>
        </div>
      )}

      {size && naturalShares != null && (
        <div className="tf-size">
          <span className="tf-size-main num">
            risk £{size.riskAmount.toFixed(2)} <span className="tf-size-sub">({effPct}% {rungLabel})</span> → {naturalShares} shares ≈ £{gbp0(naturalShares * entryN)}
          </span>
          {size.warnings.map(w => (
            <span key={w} className="calc-warn"><IconWarn size={12} /> {w}</span>
          ))}
        </div>
      )}

      <div className="tf-row">
        <label>Instrument
          <select value={f.instrument} onChange={e => set('instrument', e.target.value)}>
            <option value="stock">Stock / ETF</option>
            <option value="etp">Leveraged / inverse ETP</option>
          </select>
        </label>
        {f.instrument === 'etp' && (
          <label>Factor
            <select value={f.leverage} onChange={e => set('leverage', e.target.value)}>
              <option value="2">2x</option><option value="3">3x</option>
            </select>
          </label>
        )}
        <label>Class
          <select value={f.riskClass} onChange={e => set('riskClass', e.target.value)}>
            <option value="normal">Normal</option>
            <option value="speculative">Speculative</option>
          </select>
        </label>
      </div>
      <label className="tf-full">Thesis<input value={f.thesis} onChange={e => set('thesis', e.target.value)} placeholder="Why this trade — and what proves it wrong?" /></label>
      <div className="tf-row tf-bottom">
        <label className="tf-check"><input type="checkbox" checked={f.fromSuggestion} onChange={e => set('fromSuggestion', e.target.checked)} /> From a morning-report suggestion</label>
        <button>Log trade</button>
      </div>
    </form>
  )
}
