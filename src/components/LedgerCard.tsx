import type { LedgerPrediction, PredOutcome } from '../lib/api'
import { GradeChip } from './GradeChip'

// LedgerCard — one prediction, printed as a receipt. Grade, side, the levels it
// was taken at, and the OUTCOME TRAIL: at 5d and 10d, the side-adjusted excess
// vs SPY with hit / miss / stopped stated plainly. Ungraded horizons read
// "pending". Overlays, world-tape nudges and print-risk tags ride underneath.
// Shadows (suppressed hypotheses) render ghosted when the reader reveals them.

const fmtExcess = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}`

/** …and on a CRYPTO row the same number is not an excess at all (Stage 1c Phase
 * B). The crypto partition grades ABSOLUTE — there is no SPY for a 24/7 asset
 * class — so `excessPct` is the side-adjusted raw move and `spyPct` is a
 * structural 0. The digits are identical; the sentence they belong to is not,
 * and a receipt that says "excess vs SPY" over a bitcoin call is telling the
 * reader the engine beat a benchmark it never measured against. */
function Horizon({ label, o, absolute }: { label: string; o?: PredOutcome; absolute?: boolean }) {
  return (
    <span className="ledger-h">
      <span className="ledger-h-label">{label}</span>
      {!o ? (
        <span className="ledger-pending">pending</span>
      ) : (
        <>
          <span style={{ color: o.hit ? 'var(--green)' : 'var(--red)' }} title={absolute ? 'raw move — no benchmark' : 'side-adjusted excess vs SPY'}>
            {fmtExcess(o.excessPct)}
            {absolute ? ' raw' : ''} {o.hit ? 'hit' : 'miss'}
          </span>
          {o.stopped && <span className="badge bad ledger-stopped">stopped</span>}
        </>
      )}
    </span>
  )
}

export function LedgerCard({ p }: { p: LedgerPrediction }) {
  const absolute = p.cohort === 'crypto'
  const sideColor = p.side === 'long' ? 'var(--green)' : 'var(--red)'
  const showTape = p.worldTape && p.worldTape.mult !== 1
  const overlayColor =
    p.overlay?.flag === 'veto' ? 'var(--red)' : p.overlay?.flag === 'boost' ? 'var(--green)' : 'var(--amber)'

  return (
    <article className={`ledger-card${p.shadow ? ' is-shadow' : ''}`}>
      <div className="ledger-top">
        <span className="ledger-id">
          <GradeChip grade={p.grade} provisional={p.provisional} shadow={p.shadow} />
          <b className="ledger-sym">{p.sym}</b>
          <span className="ledger-side" style={{ color: sideColor }}>
            {p.side === 'long' ? '▲ long' : '▼ short'}
          </span>
        </span>
        <span className="ledger-prob num">
          {Math.round(p.probability * 100)}% · ~{p.expectedMovePct}%
        </span>
      </div>

      <div className="ledger-levels num">
        in {p.entry} · stop {p.stop} · tgt {p.target}
        {p.stage ? <span className="ledger-stage"> · {p.stage}</span> : null}
      </div>

      <div className="ledger-trail">
        {/* the crypto partition's lenses are 7 / 14 CRYPTO BARS, not 5 / 10
            sessions — the field names are the equity ones because renaming them
            would rewrite every stored row, so the LABEL is what has to be true */}
        <Horizon label={absolute ? '7b' : '5d'} o={p.outcome5} absolute={absolute} />
        <Horizon label={absolute ? '14b' : '10d'} o={p.outcome10} absolute={absolute} />
      </div>

      {(p.earningsRisk || p.paperOnly || p.instrument || showTape) && (
        <div className="ledger-tags">
          {p.earningsRisk && <span className="badge warn">earnings ≤10d</span>}
          {p.instrument ? (
            <span className="badge info">
              {p.instrument.ticker} {p.instrument.leverage}x
            </span>
          ) : (
            p.paperOnly && <span className="badge">paper-only</span>
          )}
          {showTape && (
            <span className="badge">
              tape {p.worldTape!.tone} ×{p.worldTape!.mult.toFixed(2)}
            </span>
          )}
        </div>
      )}

      {p.overlay && (
        <div className="ledger-overlay" style={{ color: overlayColor }}>
          <b>{p.overlay.flag.toUpperCase()}</b> — {p.overlay.reason}
        </div>
      )}

      {p.note && <div className="ledger-note">{p.note}</div>}
    </article>
  )
}
