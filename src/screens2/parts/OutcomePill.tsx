// OutcomePill (crypto-v2 wave, finding 2) — ONE pill for both receipt surfaces.
//
// LedgerDayCards.tsx and PastCalls.tsx each held a private copy that hard-coded
// `10d … vs SPY`, and the two copies had already begun to drift. Both facts of
// that label are false on a cohort row:
//
//  · THE BASIS. `excessPct` on a row stamped `cohort: 'crypto'` is the
//    side-adjusted RAW move — the crypto partition grades absolute, and `spyPct`
//    is a structural 0 because nothing was subtracted. A 24/7 asset class has no
//    SPY: the benchmark's bars are 13.5 hours out of phase and it has no
//    Saturday. Printing "vs SPY" over a bitcoin call tells the reader the engine
//    beat a benchmark it never measured against.
//  · THE CLOCK. The stored fields are named for the equity lenses because
//    renaming them would rewrite every row in the ledger, so the LABEL is what
//    has to be true: `outcome10` is 14 CRYPTO BARS and `outcome21` is 29 — the
//    ×7/5 images of the calibrated horizon and a month, weekends included.
//
// The lens is passed as the EQUITY horizon and translated here, so the two
// surfaces cannot disagree about which bar count belongs to which field.
// (src/components/LedgerCard.tsx is where this branch was first made; that file
// dies at cutover.)

import type { PredOutcome } from '../../lib/api'

const signed = (pct: number) => `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`

/** The equity lens → the label the row was actually measured on. */
const HORIZON_LABEL: Record<10 | 21, { equity: string; crypto: string }> = {
  10: { equity: '10d', crypto: '14b' },
  21: { equity: '21d', crypto: '29b' },
}

export function OutcomePill({ lens, o, cohort }: { lens: 10 | 21; o: PredOutcome; cohort?: 'crypto' }) {
  const crypto = cohort === 'crypto'
  const label = HORIZON_LABEL[lens][crypto ? 'crypto' : 'equity']
  return (
    <span className={`pill num ${o.excessPct >= 0 ? 'long' : 'short'}`} title={crypto ? 'side-adjusted raw move over crypto bars — no benchmark' : 'side-adjusted excess vs SPY'}>
      {label} {signed(o.excessPct)} {crypto ? 'raw — no benchmark' : 'vs SPY'}
      {o.stopped ? ' · stopped' : o.hit ? ' · hit' : ''}
    </span>
  )
}
