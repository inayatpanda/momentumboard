// Panel 3 — Learning curves. Two honesty diagrams in one card:
//   (a) the calibration scatter (reused component) — claimed vs realized odds;
//   (b) factor trust — how far each signal's live weight has moved from its base.
// Single blue hue for the bars (weight is not a market direction), with a faint
// tick marking where each factor STARTED so the drift is legible.

import { CalibrationPlot } from '../CalibrationPlot'
import type { EngineData } from '../../lib/api'

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

export function LearningPanel({ calibration, weights }: { calibration: EngineData['calibration']; weights: EngineData['weights'] }) {
  const current = weights?.current ?? {}
  const base = weights?.base ?? {}
  const entries = Object.entries(current).sort((a, b) => b[1] - a[1])
  const maxW = Math.max(...entries.map(([, v]) => Math.abs(v)), ...Object.values(base).map(v => Math.abs(v)), 0.0001)

  return (
    <section className="card quant-panel">
      <h3 className="section-title">Learning curves</h3>

      {calibration ? (
        <>
          <CalibrationPlot buckets={calibration.buckets} seeded={calibration.seeded} />
          <p className="empty-line quant-cap">dots on the diagonal = well-calibrated</p>
        </>
      ) : (
        <p className="empty-line">No calibration data yet.</p>
      )}

      <h3 className="section-title" style={{ marginTop: 16 }}>Factor trust</h3>
      {entries.length === 0 ? (
        <p className="empty-line">No learned weights yet.</p>
      ) : (
        <div className="quant-factors">
          {entries.map(([factor, v]) => {
            const w = clamp((v / maxW) * 100, 0, 100)
            const b = base[factor]
            const bPct = b == null ? null : clamp((b / maxW) * 100, 0, 100)
            return (
              <div key={factor} className="quant-frow">
                <div className="quant-frow-top">
                  <span className="quant-frow-label">{factor}</span>
                  <span className="quant-frow-val num">{v.toFixed(2)}</span>
                </div>
                <div className="quant-fbar">
                  <div className="quant-fbar-fill" style={{ width: `${w}%` }} />
                  {bPct != null && <span className="quant-fbar-tick" style={{ left: `${bPct}%` }} title={`base ${b!.toFixed(2)}`} />}
                </div>
              </div>
            )
          })}
        </div>
      )}
      <p className="empty-line quant-cap">how much the engine has learned to trust each signal (starts at the base tick, moves with performance)</p>
    </section>
  )
}
