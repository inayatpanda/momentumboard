// Record (plan Task 20) — Track record: the engine's accountability as a
// first-class tab. Scorecard tiles → calibration → the ledger as cards
// (legacy 11-column sideways table dies here) → the regret surface with
// named examples.
//
// DATA (DS-5, accepted): `learning` (the WHOLE slice — scorecard, calibration
// and regrets; gateState/weights/roster/channelCred are the NEXT task's Gates
// & learning page and are never read here) plus `ledger:7`, widened to
// `ledger:30` by "Load 30 days" — same swap-the-slice shape as PastCalls'
// "load older calls" (StockPage.tsx / parts/PastCalls.tsx).

import { useState } from 'react'
import { useSlice } from '../lib/useSlice'
import { getLearning, getLedgerDays } from '../lib/apiViews'
import type { LearningSlice, LedgerDay } from '../lib/apiViews'
import type { EngineData } from '../lib/api'
import { CalibrationPlot } from '../components/CalibrationPlot'
import { LedgerDayCards } from './parts/LedgerDayCards'
import { Regrets } from './parts/Regrets'
import { WILDCARD_LABEL, WILDCARD_WARNING } from '../../shared/engine/voice'

const pct = (hits: number, n: number) => (n ? `${Math.round((hits / n) * 100)}%` : '—')
const fmtExcess = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}%`

type Scorecard = NonNullable<EngineData['scorecard']>

/* Two of byGrade's keys are not letters, and neither names a population the
 * reader's conviction was ever behind: `shadow` (never offered) and
 * `wildcard` (offered BECAUSE the engine's own gates refused it). Printing
 * either as "Grade shadow"/"Grade wildcard" would invent a tier neither has
 * (same rule EnginePanel.tsx:120-125 reads for the legacy panel). */
function tileLabel(key: string): string {
  if (key === 'shadow') return 'Shadow book'
  if (key === 'wildcard') return WILDCARD_LABEL
  return `Grade ${key}`
}

function ScorecardTiles({ scorecard }: { scorecard: Scorecard | null }) {
  if (!scorecard || scorecard.totalGraded === 0) {
    return <p className="cc-reason">No graded predictions yet — the scorecard fills in as calls mature.</p>
  }
  return (
    <section aria-label="Scorecard">
      <p className="sec-label">
        Scorecard — <span className="num">{scorecard.totalGraded}</span> graded
      </p>
      <div className="rec-tiles">
        {Object.entries(scorecard.byGrade).map(([key, s]) => (
          <div className="card rec-tile" key={key}>
            <span className="rec-tile-label">{tileLabel(key)}</span>
            <span className="num rec-tile-n">{s.n}</span>
            <span className="num rec-tile-sub">
              {pct(s.hits, s.n)} hit ({s.hits}/{s.n})
            </span>
            <span className="num rec-tile-sub">avg {s.n ? fmtExcess(s.sumExcess / s.n) : '—'}</span>
            {key === 'wildcard' && <span className="rec-tile-warn">{WILDCARD_WARNING}</span>}
          </div>
        ))}
      </div>
    </section>
  )
}

function CalibrationSection({ calibration }: { calibration: LearningSlice['calibration'] }) {
  if (!calibration) return null
  const referenceBase = calibration.referenceBase
  return (
    <section aria-label="Calibration" className="rec-calibration">
      <CalibrationPlot buckets={calibration.buckets as Record<string, { n: number; hits: number }>} seeded={calibration.seeded} />
      <p className="cc-reason rec-calibration-context">
        {referenceBase != null ? (
          <>
            The grade bar sits at <span className="num">{Math.round(referenceBase * 100)}%</span> — the rate an ordinary candidate hits on the same test,
            swept from years of history and fixed until the engine is re-seeded.
          </>
        ) : (
          <>The grade bar is currently the engine's own pooled hit rate across every graded call, until a re-seed measures the ordinary-candidate rate directly.</>
        )}
      </p>
    </section>
  )
}

/** The ledger: `ledger:7` by default, "Load 30 days" swaps to `ledger:30` —
 * its own slice key, its own fetch, mounted only once asked, exactly
 * PastCalls' DeepCalls/"load older calls" shape. Until the wider slice lands,
 * the default 7-day list stays on screen as the fallback rather than
 * blanking (same rule PastCalls' DeepCalls follows). */
function Ledger30({ fallback }: { fallback: LedgerDay[] }) {
  const { data } = useSlice('ledger:30', () => getLedgerDays(30))
  return <LedgerDayCards days={data?.days ?? fallback} />
}

function LedgerSection() {
  const [wide, setWide] = useState(false)
  const { data } = useSlice('ledger:7', () => getLedgerDays(7))
  const days = data?.days ?? []
  return (
    <section aria-label="The ledger">
      <p className="sec-label">The ledger — the receipts</p>
      {wide ? <Ledger30 fallback={days} /> : <LedgerDayCards days={days} />}
      {!wide && (
        <button className="stx-showmore" onClick={() => setWide(true)}>
          Load 30 days
        </button>
      )}
    </section>
  )
}

export default function Record() {
  const { data: learning } = useSlice('learning', getLearning)
  return (
    <div className="rec2">
      <h1>Track record</h1>
      {learning == null ? (
        <>
          <div className="skeleton" style={{ height: 96, marginBottom: 12 }} />
          <div className="skeleton" style={{ height: 220, marginBottom: 12 }} />
          <div className="skeleton" style={{ height: 118 }} />
        </>
      ) : (
        <>
          <ScorecardTiles scorecard={learning.scorecard as unknown as Scorecard | null} />
          <CalibrationSection calibration={learning.calibration} />
        </>
      )}
      <LedgerSection />
      <Regrets regrets={learning?.regrets ?? null} />
    </div>
  )
}
