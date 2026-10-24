import type { ContextTrialAudit } from '../../../shared/engine/stockContext'
export function ContextTrialPanel({ audit }: { audit?: ContextTrialAudit }) {
  if (!audit) return null
  return <section className="patterns-card" aria-label="Testing the extra market context"><h3>Does the extra context help predictions?</h3>
    <p>We save two estimates before the result: the original stock forecast and a version that also considers sector strength, wider markets and available news.</p>
    <p><strong>{audit.completed} completed comparisons</strong> · {audit.pending} being followed.</p>
    <p>{audit.status === 'collecting' ? 'The comparison is collecting evidence. The experimental version is not used for live confidence percentages.' : audit.status === 'early-improvement' ? 'The experimental version made smaller probability errors in both halves of this sample. This is an early finding, not proof of a trading advantage.' : 'The extra context has not consistently reduced probability errors. The original forecast remains in use.'}</p>
    <details className="research-method"><summary>See the evidence: the paired prediction test</summary>
      <p>Same stock, same three-session result. We compare the saved probabilities of finishing higher, using only forecasts recorded before their outcomes. No historic headlines are reconstructed.</p>
      <p>Original probability error: {audit.baselineBrier?.toFixed(4) ?? 'Awaiting results'}. Experimental probability error: {audit.candidateBrier?.toFixed(4) ?? 'Awaiting results'}. Lower is better (Brier score).</p>
      <p>{audit.changed} estimates differed across {audit.publicationDays} publication days. The early comparison needs 60 changed, completed forecasts and 30 publication days. Each day has equal weight when checking improvement in the earlier and later halves; overlapping results for the same stock are excluded.</p>
      <p>Fixed experimental rule: up to one percentage point each for joint stock/sector strength, the broad market backdrop and a linked news interpretation, capped at three points overall. No news interpretation means no news adjustment. Earnings-risk cases and missing price, sector or market data are not eligible. Historical dates and seasonal averages never receive a direct probability boost.</p>
      <p>This tests probability accuracy, not portfolio returns or beating the market. There is no automatic promotion or position-size change. A separate market-return test is still required.</p>
    </details>
  </section>
}
