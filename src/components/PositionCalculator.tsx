import { useState } from 'react'
import { positionSize } from '../../shared/risk'
import { IconWarn } from './icons'

export function PositionCalculator({ defaultEntry, defaultStop, riskClass, capital = 5000 }: { defaultEntry: number | null; defaultStop: number | null; riskClass: 'normal' | 'speculative'; capital?: number }) {
  const [entry, setEntry] = useState(defaultEntry != null ? String(+defaultEntry.toFixed(4)) : '')
  const [stop, setStop] = useState(defaultStop != null ? String(+defaultStop.toFixed(4)) : '')
  const result = positionSize({ capital, riskPct: 2, entry: parseFloat(entry) || 0, stop: parseFloat(stop) || 0, riskClass })

  return (
    <section className="calc">
      <h3>Position size <span className="calc-sub">£{capital.toLocaleString('en-GB')} capital · {riskClass === 'speculative' ? '1% (speculative)' : '2%'} risk</span></h3>
      <div className="calc-inputs">
        <label>
          Entry
          <input inputMode="decimal" value={entry} onChange={e => setEntry(e.target.value)} aria-label="Calculator entry" />
        </label>
        <label>
          Stop
          <input inputMode="decimal" value={stop} onChange={e => setStop(e.target.value)} aria-label="Calculator stop" />
        </label>
      </div>
      {result ? (
        <div className="calc-out">
          <div><strong>{result.units}</strong><span>units</span></div>
          <div><strong>{result.positionValue.toLocaleString('en-GB', { maximumFractionDigits: 0 })}</strong><span>position ({result.positionPctOfCapital}%)</span></div>
          <div><strong>{result.riskAmount.toFixed(0)}</strong><span>risk to stop</span></div>
        </div>
      ) : (
        <p className="calc-hint">Enter an entry and a stop to size the trade.</p>
      )}
      {result?.warnings.map(w => (
        <p key={w} className="calc-warn"><IconWarn size={12} /> {w}</p>
      ))}
      <p className="calc-hint">Figures in the instrument's own currency; treats capital 1:1 across GBP/USD — fine for risk discipline, not accounting.</p>
    </section>
  )
}
