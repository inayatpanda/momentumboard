import { useState } from 'react'
import type { Trade } from '../../shared/journal'

const PLAYBOOKS = [
  { key: 'R', label: 'R — Reversal' },
  { key: 'B', label: 'B — Pullback' },
  { key: 'A', label: 'A — Breakout' },
  { key: 'S', label: 'S — Fade (inverse)' },
] as const

export function TradeForm({ onAdd }: { onAdd: (t: Trade) => void }) {
  const [f, setF] = useState({ symbol: '', playbook: 'R', instrument: 'stock', leverage: '1', riskClass: 'normal', entry: '', stop: '', value: '', thesis: '', fromSuggestion: false })
  const set = (k: string, v: string | boolean) => setF(s => ({ ...s, [k]: v }))

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const entry = parseFloat(f.entry)
    const stop = parseFloat(f.stop)
    const value = parseFloat(f.value)
    if (!f.symbol.trim() || !Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(value) || entry <= 0 || value <= 0) return
    onAdd({
      id: `tr-${Date.now()}`,
      symbol: f.symbol.trim().toUpperCase(),
      direction: f.playbook === 'S' ? 'short' : 'long',
      instrument: f.instrument as 'stock' | 'etp',
      leverage: parseInt(f.leverage) || 1,
      riskClass: f.riskClass as 'normal' | 'speculative',
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
