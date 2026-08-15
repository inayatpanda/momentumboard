// The cumulative-excess chart (owner iteration 2): "the graph doesnt mean
// anything". This one answers the only question a track record owes the
// reader — what following every sized call would have done — and says so in
// its own title.
//
// Hand-rolled SVG, no chart library (the same rule Sparkline.tsx follows).
// The plot stretches to the card's width via preserveAspectRatio="none", so
// every stroke carries `vector-effect="non-scaling-stroke"` — without it the
// non-uniform scale fattens the vertical runs — and every LABEL is HTML
// outside the SVG rather than text inside it, which that same scale would
// distort.

import type { CumulativePoint } from '../../lib/ledgerSeries'
import { shortDateWithWeekday } from '../../lib/format'

const W = 640
const H = 180
const PAD = 8

const pp = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}pp`

export function CumulativeLine({ points, days }: { points: CumulativePoint[]; days: number }) {
  // one point is a dot, not a line — and a dot on an axis teaches nothing
  if (points.length < 2) {
    return (
      <section className="card rec-chart" aria-label="Cumulative excess">
        <p className="sec-label">If you'd taken every sized call — cumulative excess vs SPY, last {days} days</p>
        <p className="cc-reason">
          {points.length === 0
            ? 'Nothing has graded in this window yet — the line starts on the first matured call.'
            : 'One graded day so far. The line starts once there are two to join.'}
        </p>
      </section>
    )
  }

  const vals = points.map(p => p.cumulative)
  const min = Math.min(0, ...vals)
  const rawMax = Math.max(0, ...vals)
  const max = rawMax === min ? min + 1 : rawMax
  const span = max - min
  const x = (i: number) => (i / (points.length - 1)) * W
  const y = (v: number) => PAD + (1 - (v - min) / span) * (H - 2 * PAD)
  const zeroY = y(0)
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.cumulative).toFixed(1)}`).join(' ')
  const area = `${d} L${W},${zeroY.toFixed(1)} L0,${zeroY.toFixed(1)} Z`
  const last = points[points.length - 1]
  const gradedRows = points.reduce((n, p) => n + p.n, 0)

  return (
    <section className="card rec-chart" aria-label="Cumulative excess">
      <p className="sec-label">If you'd taken every sized call — cumulative excess vs SPY, last {days} days</p>
      <p className="rec-chart-headline">
        <span className={`num rec-chart-total ${last.cumulative >= 0 ? 'up' : 'down'}`}>{pp(last.cumulative)}</span>
        <span className="cc-reason">
          across <span className="num">{gradedRows}</span> graded {gradedRows === 1 ? 'call' : 'calls'} on{' '}
          <span className="num">{points.length}</span> {points.length === 1 ? 'day' : 'days'}
        </span>
      </p>
      <div className="rec-chart-plot">
        <svg className="rec-chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Cumulative excess, ending ${pp(last.cumulative)}`}>
          <path className="rec-chart-area" d={area} />
          {/* the zero line: above it the calls beat SPY, below it they did not */}
          <line className="rec-chart-zero" x1="0" x2={W} y1={zeroY} y2={zeroY} vectorEffect="non-scaling-stroke" />
          <path className="rec-chart-path" d={d} vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="num rec-chart-ymax">{pp(max)}</span>
        {/* the zero label only when zero is INSIDE the range: a book that never
            went negative puts the zero line exactly on the minimum, and the two
            labels then print on top of each other */}
        {min < 0 && max > 0 && (
          <span className="num rec-chart-yzero" style={{ top: `${(zeroY / H) * 100}%` }}>
            0
          </span>
        )}
        <span className="num rec-chart-ymin">{pp(min)}</span>
      </div>
      <div className="rec-chart-xaxis">
        <span className="num">{shortDateWithWeekday(points[0].date)}</span>
        {points.length > 2 && <span className="num">{shortDateWithWeekday(points[Math.floor(points.length / 2)].date)}</span>}
        <span className="num">{shortDateWithWeekday(last.date)}</span>
      </div>
    </section>
  )
}
