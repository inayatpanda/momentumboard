// CalibrationPlot — the honesty diagram. Each dot is a calibration bucket:
// x = the probability the engine CLAIMED (Laplace-smoothed (hits+2)/(n+4)),
// y = the hit rate it actually REALIZED. A perfectly-calibrated engine sits on
// the 45° diagonal; dots above it were pessimistic, below it were overconfident.
// Dot area scales with sample size; long buckets ink-green, short ink-red.
//
// Inline SVG, no deps. Colours come from CSS tokens (currentColor for the frame,
// var(--green)/var(--red) for the marks) so it reads correctly in both themes.

interface Bucket {
  n: number
  hits: number
}

// plot geometry, in viewBox units — a square plot with room for axis labels
const ML = 30
const MT = 12
const SIZE = 180
const MB = 26
const MR = 12
const VBW = ML + SIZE + MR
const VBH = MT + SIZE + MB
const TICKS = [0.3, 0.5, 0.7]

const px = (claimed: number) => ML + claimed * SIZE
const py = (realized: number) => MT + (1 - realized) * SIZE
// area ∝ n, gently: readable at n=5, capped so a fat bucket can't swamp the plot
const radius = (n: number) => Math.max(3, Math.min(9, 2.5 + Math.sqrt(n)))

export function CalibrationPlot({ buckets, seeded }: { buckets: Record<string, Bucket>; seeded?: boolean }) {
  const dots = Object.entries(buckets)
    .filter(([, b]) => b.n >= 5)
    .map(([key, b]) => {
      const [side, regime, band] = key.split(':')
      const claimed = (b.hits + 2) / (b.n + 4)
      const realized = b.hits / b.n
      return { key, side, regime, band, n: b.n, hits: b.hits, claimed, realized }
    })
    .sort((a, b) => b.n - a.n) // big dots first, small ones drawn on top

  return (
    <div className="digest-section">
      <h3 className="section-title" style={{ marginTop: 10 }}>
        Calibration — claimed vs realized{seeded ? ' · seeded from 2y backtest' : ''}
      </h3>
      {dots.length === 0 ? (
        <p className="empty-line" style={{ fontSize: 12 }}>
          Not enough graded predictions yet to plot — buckets need at least five outcomes before a dot is honest.
        </p>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${VBW} ${VBH}`}
            role="img"
            aria-label="Calibration scatter: claimed probability against realized hit rate"
            style={{ width: '100%', maxWidth: 380, height: 'auto', display: 'block', overflow: 'visible' }}
          >
            {/* plot frame — left and bottom axes as hairlines */}
            <line x1={ML} y1={MT} x2={ML} y2={MT + SIZE} stroke="var(--line)" strokeWidth={1} />
            <line x1={ML} y1={MT + SIZE} x2={ML + SIZE} y2={MT + SIZE} stroke="var(--line)" strokeWidth={1} />

            {/* the "honest" 45° diagonal: claimed == realized */}
            <line
              x1={px(0)}
              y1={py(0)}
              x2={px(1)}
              y2={py(1)}
              stroke="var(--faint)"
              strokeWidth={1}
              strokeDasharray="3 3"
            />

            {/* ticks + labels at 0.3 / 0.5 / 0.7 on both axes */}
            {TICKS.map(t => (
              <g key={t} style={{ fontFamily: 'var(--font-num)' }}>
                <line x1={px(t)} y1={MT + SIZE} x2={px(t)} y2={MT + SIZE + 3} stroke="var(--line)" strokeWidth={1} />
                <text x={px(t)} y={MT + SIZE + 15} textAnchor="middle" fontSize={10} fill="var(--muted)">
                  {t.toFixed(1)}
                </text>
                <line x1={ML - 3} y1={py(t)} x2={ML} y2={py(t)} stroke="var(--line)" strokeWidth={1} />
                <text x={ML - 5} y={py(t) + 3.5} textAnchor="end" fontSize={10} fill="var(--muted)">
                  {t.toFixed(1)}
                </text>
              </g>
            ))}

            {/* axis captions */}
            <text x={ML + SIZE / 2} y={VBH - 1} textAnchor="middle" fontSize={10} fill="var(--faint)" letterSpacing="0.06em">
              CLAIMED
            </text>
            <text
              x={10}
              y={MT + SIZE / 2}
              textAnchor="middle"
              fontSize={10}
              fill="var(--faint)"
              letterSpacing="0.06em"
              transform={`rotate(-90 10 ${MT + SIZE / 2})`}
            >
              REALIZED
            </text>

            {/* the buckets — long ink-green, short ink-red (market semantics) */}
            {dots.map(d => (
              <circle
                key={d.key}
                cx={px(d.claimed)}
                cy={py(d.realized)}
                r={radius(d.n)}
                style={{ fill: d.side === 'short' ? 'var(--red)' : 'var(--green)', fillOpacity: 0.45, stroke: d.side === 'short' ? 'var(--red)' : 'var(--green)' }}
                strokeWidth={1}
              >
                <title>
                  {d.side} · {d.regime} · band {d.band} — claimed {Math.round(d.claimed * 100)}%, realized {Math.round(d.realized * 100)}% ({d.hits}/{d.n})
                </title>
              </circle>
            ))}
          </svg>
          <p className="empty-line" style={{ fontSize: 11, marginTop: 4 }}>
            Each dot a conviction bucket; larger = more graded. On the dashed line, the engine's claimed odds matched reality.{' '}
            <span style={{ color: 'var(--green)' }}>Long</span> · <span style={{ color: 'var(--red)' }}>short</span>.
          </p>
        </>
      )}
    </div>
  )
}
