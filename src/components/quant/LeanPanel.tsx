// Panel 1 — Next-day lean (hero). An HONEST calibrated directional tilt built
// from four measurable inputs (regime, overnight tape, news tone, VIX move),
// NOT a forecast. Each input's signed contribution is shown as a diverging bar
// so the tilt reads as arithmetic, never as a black box. The tilt % is
// deliberately capped near 62% — a probabilistic lean, not a promise.

import type { EngineData } from '../../lib/api'

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

// widest a single component can swing is the regime/tape band (±0.4) — scale the
// diverging bars to that so every contribution shares one honest axis.
const MAX_MAG = 0.4

function signed(v: number): string {
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`
}

function CompBar({ label, value }: { label: string; value: number }) {
  const pct = clamp((Math.abs(value) / MAX_MAG) * 50, 0, 50)
  const pos = value >= 0
  // exact zero reads as neutral ink; otherwise green up / red down
  const color = value === 0 ? 'var(--faint)' : pos ? 'var(--green)' : 'var(--red)'
  return (
    <div className="quant-comp">
      <span className="quant-comp-label">{label}</span>
      <div className="quant-div">
        <span className="quant-div-mid" />
        {value !== 0 && (
          <div
            className="quant-div-fill"
            style={pos ? { left: '50%', width: `${pct}%`, background: 'var(--green)' } : { right: '50%', width: `${pct}%`, background: 'var(--red)' }}
          />
        )}
      </div>
      <span className="quant-comp-val num" style={{ color }}>{signed(value)}</span>
    </div>
  )
}

export function LeanPanel({
  board,
  calibration,
  vixChangePct,
  analogue,
  analogueSym,
}: {
  board: EngineData['board']
  calibration: EngineData['calibration']
  vixChangePct: number | null
  analogue: { n: number; median5: number; p75_5: number; median20: number; maxExt5: number } | null
  analogueSym?: string
}) {
  const regime = board?.regime ?? 'unknown'
  const regimeScore = regime === 'green' ? 0.4 : regime === 'red' ? -0.4 : 0

  const votes = board?.worldTape?.votes
  const on = votes?.on ?? 0
  const off = votes?.off ?? 0
  const tapeScore = ((on - off) / Math.max(on + off, 1)) * 0.4

  const newsLabel = board?.newsTone?.label
  const newsScore = newsLabel === 'upbeat' ? 0.15 : newsLabel === 'sour' ? -0.15 : 0

  const vix = vixChangePct ?? 0
  const vixScore = vix >= 5 ? -0.1 : vix <= -5 ? 0.1 : 0

  const lean = clamp(regimeScore + tapeScore + newsScore + vixScore, -1, 1)
  const tilt = Math.round((0.5 + Math.abs(lean) * 0.12) * 100)
  // a ~50% tilt is a coin flip — call that "no clear", don't dress it as a side
  const flat = tilt <= 50
  const direction = flat ? 'no clear' : lean >= 0 ? 'risk-on' : 'risk-off'
  const dirColor = flat ? 'var(--muted)' : lean >= 0 ? 'var(--green)' : 'var(--red)'

  // engine base hit-rate: Laplace-smoothed over every calibration bucket.
  // STAYS POOLED [spec §9]: the sentence below says "engine base hit-rate", and
  // that is a statement about the population the engine actually publishes — how
  // often ITS calls land. `referenceBase` answers a different question (what
  // ordinary candidates do, which is what grades are measured against) and printing
  // it under this label would quietly relabel a measurement as a benchmark. It gets
  // its own label instead, right beside this one — see `gradeBar`.
  const buckets = calibration?.buckets ? Object.values(calibration.buckets) : []
  const nSum = buckets.reduce((a, b) => a + (b?.n ?? 0), 0)
  const hitSum = buckets.reduce((a, b) => a + (b?.hits ?? 0), 0)
  const baseRate = Math.round(((hitSum + 2) / (nSum + 4)) * 100)
  // …and BESIDE it, the other number, when a seed measured one: the bar the letter
  // grades are struck against. Without it a reader who sees "hit-rate 42%" next to a
  // B earned at 43% has no way to know the bar was 37% — the two numbers answer
  // different questions and only one of them is a yardstick. Printed only when
  // `referenceBase` exists: on a blob with none the grades ARE anchored to the
  // pooled rate above, and printing that twice under two names would invent a
  // distinction the engine is not making today.
  const gradeBar = calibration?.referenceBase != null ? Math.round(calibration.referenceBase * 100) : null

  return (
    <section className="card quant-hero">
      <h3 className="section-title">Next-day lean</h3>
      <p className="quant-hero-line" style={{ color: dirColor }}>
        Next session: {direction} lean · ~{tilt}% tilt
      </p>

      <div className="quant-comps">
        <CompBar label="Regime" value={regimeScore} />
        <CompBar label="Overnight tape" value={tapeScore} />
        <CompBar label="News tone" value={newsScore} />
        <CompBar label="Volatility" value={vixScore} />
      </div>

      <p className="empty-line quant-hero-note">
        A probabilistic tilt from measurable inputs (regime, overnight tape, news tone, volatility) — not a forecast. Engine base hit-rate {baseRate}%
        {gradeBar != null ? <> · grade bar {gradeBar}% — what an ordinary candidate does, and what A/B/C are measured against.</> : '.'}
      </p>

      {analogue && (
        <p className="empty-line quant-hero-analogue">
          When {analogueSym ? `${analogueSym} ` : 'this '}last did this ({analogue.n} priors):{' '}
          <span className="num">{signed(analogue.median5)}%</span> median @5d ·{' '}
          <span className="num">{signed(analogue.median20)}%</span> median @20d
        </p>
      )}
    </section>
  )
}
