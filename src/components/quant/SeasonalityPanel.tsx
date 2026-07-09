// Panel 4 — Seasonality (SPY). Twelve diverging monthly bars from the average
// month return: green above the zero line, red below, every bar labelled with
// its value (colour is never the only cue). The current calendar month wears a
// blue outline. Inline SVG in the Sparkline house style — no chart deps.

import type { getSeasonality } from '../../lib/api'

type Seasonality = Awaited<ReturnType<typeof getSeasonality>>

const VBW = 360
const VBH = 150
const PAD_TOP = 16
const PAD_BOTTOM = 26
const PLOT_H = VBH - PAD_TOP - PAD_BOTTOM
const MID_Y = PAD_TOP + PLOT_H / 2
const MAX_BAR_H = PLOT_H / 2 - 4
const COL_W = VBW / 12
const BAR_W = COL_W * 0.54

function signed(p: number): string {
  return `${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(1)}`
}

export function SeasonalityPanel({ data }: { data: Seasonality | null }) {
  const months = data?.months ?? []
  const currentMonth = new Date().getMonth() + 1

  return (
    <section className="card quant-panel">
      <h3 className="section-title">Seasonality · SPY</h3>

      {months.length === 0 || !data?.reliable ? (
        <p className="empty-line">Insufficient history to read a seasonal pattern.</p>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${VBW} ${VBH}`}
            role="img"
            aria-label="Average monthly return for SPY, diverging from a zero line"
            style={{ width: '100%', maxWidth: 560, height: 'auto', display: 'block', overflow: 'visible', color: 'var(--faint)' }}
          >
            {/* zero baseline */}
            <line x1={0} y1={MID_Y} x2={VBW} y2={MID_Y} stroke="currentColor" strokeWidth={1} opacity={0.45} />

            {[...months].sort((a, b) => a.month - b.month).map(m => {
              const av = m.avgPct ?? 0
              const maxAbs = Math.max(...months.map(x => Math.abs(x.avgPct ?? 0)), 0.1)
              const h = (Math.abs(av) / maxAbs) * MAX_BAR_H
              const cx = (m.month - 1) * COL_W + COL_W / 2
              const pos = av >= 0
              const y = pos ? MID_Y - h : MID_Y
              const isNow = m.month === currentMonth
              return (
                <g key={m.month}>
                  <rect
                    x={cx - BAR_W / 2}
                    y={y}
                    width={BAR_W}
                    height={Math.max(h, 0.5)}
                    rx={2}
                    style={{ fill: pos ? 'var(--green)' : 'var(--red)', fillOpacity: 0.85 }}
                    stroke={isNow ? 'var(--blue)' : 'none'}
                    strokeWidth={isNow ? 1.6 : 0}
                  >
                    <title>{m.name}: {signed(av)}% avg ({m.n})</title>
                  </rect>
                  {/* value label at the bar tip */}
                  <text
                    x={cx}
                    y={pos ? MID_Y - h - 3 : MID_Y + h + 9}
                    textAnchor="middle"
                    fontSize={7}
                    fill="currentColor"
                    style={{ fontFamily: 'var(--font-num)' }}
                  >
                    {signed(av)}
                  </text>
                  {/* month initial */}
                  <text
                    x={cx}
                    y={VBH - 6}
                    textAnchor="middle"
                    fontSize={9}
                    fontWeight={isNow ? 700 : 400}
                    fill={isNow ? 'var(--blue)' : 'currentColor'}
                  >
                    {m.name.slice(0, 1)}
                  </text>
                </g>
              )
            })}
          </svg>

          {(data.bestMonth || data.worstMonth) && (
            <p className="empty-line quant-cap">
              {data.bestMonth && <>Best <b style={{ color: 'var(--green)' }}>{data.bestMonth.name}</b> {data.bestMonth.avgPct != null ? `${signed(data.bestMonth.avgPct)}%` : ''}</>}
              {data.bestMonth && data.worstMonth && ' · '}
              {data.worstMonth && <>Worst <b style={{ color: 'var(--red)' }}>{data.worstMonth.name}</b> {data.worstMonth.avgPct != null ? `${signed(data.worstMonth.avgPct)}%` : ''}</>}
            </p>
          )}
        </>
      )}
    </section>
  )
}
