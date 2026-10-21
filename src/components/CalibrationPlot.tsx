import '../styles/record.css'
interface Bucket {
  n: number
  hits: number
}

interface EvidenceRow {
  key: string
  side: 'long' | 'short'
  regime: string
  n: number
  hits: number
  rate: number
  low: number
  high: number
  lift: number
}

const pct = (value: number) => `${Math.round(value * 100)}%`
const pp = (value: number) => `${value >= 0 ? '+' : '−'}${Math.abs(Math.round(value * 100))}pp`

function wilson(hits: number, n: number): [number, number] {
  if (n <= 0) return [0, 0]
  const z = 1.96
  const p = hits / n
  const denominator = 1 + (z * z) / n
  const centre = (p + (z * z) / (2 * n)) / denominator
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)]
}

function statusFor(row: EvidenceRow, baseline: number) {
  if (row.n < 30) return { label: 'Early evidence', tone: 'early' }
  if (row.low > baseline) return { label: 'Earned edge', tone: 'good' }
  if (row.high < baseline) return { label: 'Below bar', tone: 'bad' }
  if (row.lift >= 0.02) return { label: 'Promising', tone: 'watch' }
  if (row.lift <= -0.02) return { label: 'Lagging', tone: 'bad' }
  return { label: 'At baseline', tone: 'neutral' }
}

function buildRows(buckets: Record<string, Bucket>, baseline: number): EvidenceRow[] {
  const groups = new Map<string, Omit<EvidenceRow, 'rate' | 'low' | 'high' | 'lift'>>()

  for (const [key, bucket] of Object.entries(buckets)) {
    if (!Number.isFinite(bucket.n) || !Number.isFinite(bucket.hits) || bucket.n <= 0) continue
    // Keys can be `side:regime:band` or `cohort:side:regime:band`. Parse from
    // the end, then pool conviction bands and cohorts into six readable setups.
    const parts = key.split(':')
    const side = parts.at(-3)
    const regime = parts.at(-2)
    if ((side !== 'long' && side !== 'short') || !regime) continue
    const groupKey = `${side}:${regime}`
    const current = groups.get(groupKey) ?? { key: groupKey, side, regime, n: 0, hits: 0 }
    current.n += bucket.n
    current.hits += bucket.hits
    groups.set(groupKey, current)
  }

  return [...groups.values()]
    .filter(group => group.n >= 5)
    .map(group => {
      const rate = group.hits / group.n
      const [low, high] = wilson(group.hits, group.n)
      return { ...group, rate, low, high, lift: rate - baseline }
    })
    .sort((a, b) => b.lift - a.lift || b.n - a.n)
}

export function CalibrationPlot({
  buckets,
  seeded,
  referenceBase,
}: {
  buckets: Record<string, Bucket>
  seeded?: boolean
  referenceBase?: number | null
}) {
  const totals = Object.values(buckets).reduce(
    (sum, bucket) => ({ n: sum.n + Math.max(0, bucket.n || 0), hits: sum.hits + Math.max(0, bucket.hits || 0) }),
    { n: 0, hits: 0 },
  )
  const pooled = totals.n > 0 ? totals.hits / totals.n : 0
  const hasMeasuredBase = referenceBase != null && Number.isFinite(referenceBase)
  const baseline = hasMeasuredBase ? referenceBase : pooled
  const rows = buildRows(buckets, baseline)
  const strongest = rows[0]
  const pooledLift = hasMeasuredBase ? pooled - baseline : null

  return (
    <div className="digest-section cal-evidence">
      <div className="cal-title-row">
        <h3 className="section-title" style={{ marginTop: 10 }}>
          Evidence by market setup{seeded ? ' · seeded from 2y backtest' : ''}
        </h3>
        <span className="cal-method" title="95% Wilson interval; all conviction bands pooled within each direction and market regime">
          95% range
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="empty-line" style={{ fontSize: 12 }}>
          Not enough graded predictions yet — a setup needs at least five outcomes before it is shown.
        </p>
      ) : (
        <>
          <div className="cal-summary" aria-label="Calibration evidence summary">
            <div className="cal-summary-stat">
              <span className="cal-summary-label">Engine hit rate</span>
              <strong className="num">{pct(pooled)}</strong>
              <span>{totals.n.toLocaleString()} graded outcomes</span>
            </div>
            <div className="cal-summary-stat">
              <span className="cal-summary-label">Ordinary candidate</span>
              <strong className="num">{hasMeasuredBase ? pct(baseline) : '—'}</strong>
              <span>{hasMeasuredBase && pooledLift != null ? `${pp(pooledLift)} engine lift` : 'benchmark not measured'}</span>
            </div>
            {strongest && (
              <div className="cal-summary-stat cal-summary-best">
                <span className="cal-summary-label">Best measured setup</span>
                <strong>{strongest.side} · {strongest.regime} tape</strong>
                <span>{pct(strongest.rate)} hit rate · {strongest.n.toLocaleString()} outcomes</span>
              </div>
            )}
          </div>

          <div className="cal-row-head" aria-hidden="true">
            <span>Direction and tape</span>
            <span>Historical result</span>
            <span>Evidence</span>
          </div>
          <div className="cal-rows">
            {rows.map(row => {
              const status = statusFor(row, baseline)
              return (
                <article className="cal-row" key={row.key}>
                  <div className="cal-setup">
                    <span className={`cal-side ${row.side}`}>{row.side}</span>
                    <div>
                      <strong>{row.regime} tape</strong>
                      <span>{status.label}</span>
                    </div>
                  </div>

                  <div className="cal-result">
                    <div className="cal-result-top">
                      <strong className="num">{pct(row.rate)} hit</strong>
                      <span className={`cal-lift ${status.tone}`}>{hasMeasuredBase ? `${pp(row.lift)} vs bar` : 'pooled view'}</span>
                    </div>
                    <div className="cal-track" aria-label={`${pct(row.rate)} hit rate; 95% range ${pct(row.low)} to ${pct(row.high)}`}>
                      <span className="cal-range" style={{ left: `${row.low * 100}%`, width: `${Math.max(1, (row.high - row.low) * 100)}%` }} />
                      <span className="cal-rate" style={{ left: `${row.rate * 100}%` }} />
                      {hasMeasuredBase && <span className="cal-base" style={{ left: `${baseline * 100}%` }} />}
                    </div>
                    <span className="cal-range-copy">likely range {pct(row.low)}–{pct(row.high)}</span>
                  </div>

                  <div className="cal-sample">
                    <strong className="num">n={row.n.toLocaleString()}</strong>
                    <span>{row.n >= 100 ? 'strong sample' : row.n >= 30 ? 'usable sample' : 'small sample'}</span>
                  </div>
                </article>
              )
            })}
          </div>

          <p className="empty-line cal-footnote">
            The line marks the ordinary-candidate bar; the dot is the observed hit rate and the shaded segment is its 95% range. This shows evidence, not a promise about the next trade.
          </p>
        </>
      )}
    </div>
  )
}
