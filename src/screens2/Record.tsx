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
import { cryptoLedgerSummary, flattenLedger } from '../lib/ledgerStats'
import { LedgerDayCards } from './parts/LedgerDayCards'
import { Regrets } from './parts/Regrets'
import { WILDCARD_LABEL, WILDCARD_WARNING } from '../../shared/engine/voice'

const pct = (hits: number, n: number) => (n ? `${Math.round((hits / n) * 100)}%` : '—')
const fmtExcess = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}%`

/** The newest Brier point off a calibration blob. The wire shape is
 * `{ date, mean, n }[]` (shared/engine/calibration.ts) but the slice types it
 * `unknown[]`, and a bare number series is the shape an older blob carries —
 * read both rather than printing NaN at a reader. */
function latestBrier(brier: unknown[]): number | null {
  const last = brier?.[brier.length - 1]
  if (typeof last === 'number') return last
  const mean = (last as { mean?: unknown } | undefined)?.mean
  return typeof mean === 'number' ? mean : null
}

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
      {/* NAMED AS THE EQUITY PARTITION (crypto-v2 wave, finding 4). Every number
          under this header is an excess against SPY over ten sessions, and the
          grading pass keeps every cohort row out of `engine-scorecard` on
          purpose — so an unqualified "Scorecard" reads as the whole record when
          it is one partition of it. The cohort's own panel sits below. */}
      <p className="sec-label">
        Equity — excess vs SPY · <span className="num">{scorecard.totalGraded}</span> graded
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

/** THE COHORT'S OWN PANE (crypto-v2 wave, finding 4).
 *
 * The crypto partition is excluded from every equity aggregate on this page —
 * server-side from `engine-scorecard`, client-side from every mean in
 * ledgerStats.ts — because its outcome is an ABSOLUTE side-adjusted move over
 * fourteen crypto bars and the equity ones are excesses over SPY across ten
 * sessions. Averaging the two produces a number that answers neither question.
 * A population removed from every pane and given none of its own is a population
 * nobody can audit, so this is that pane.
 *
 * TWO SOURCES, deliberately. The hit rate and the mean raw move are rolled from
 * the cohort's own RECEIPTS (`cryptoLedgerSummary`, the same rows the cards
 * below show); the graded count and the rung come from the partition's own
 * blobs, because those are months-scale facts the visible window cannot see. The
 * blob's own base RATE is not used: `baseHitRate` returns a flat 0.5 under fifty
 * outcomes, which is a designed cold-start floor, not a measurement. */
function CryptoPanel({ crypto, rows }: { crypto: NonNullable<LearningSlice['crypto']>; rows: ReturnType<typeof flattenLedger> }) {
  const s = cryptoLedgerSummary(rows)
  const cold = crypto.gradedN < crypto.coldStartN
  const cal = crypto.calibration
  const buckets = cal ? Object.keys(cal.buckets ?? {}).length : 0
  const brier = cal ? latestBrier(cal.brier) : null
  return (
    <section aria-label="Crypto scorecard">
      <p className="sec-label">Crypto — raw, no benchmark</p>
      <div className="rec-tiles">
        <div className="card rec-tile">
          <span className="rec-tile-label">Hit rate</span>
          <span className="num rec-tile-n">{s.graded ? pct(s.hits, s.graded) : '—'}</span>
          <span className="num rec-tile-sub">{s.graded ? `${s.hits} of ${s.graded} graded here` : 'nothing graded in this window'}</span>
        </div>
        <div className="card rec-tile">
          <span className="rec-tile-label">Mean move</span>
          <span className="num rec-tile-n">{s.avgRaw10 == null ? '—' : fmtExcess(s.avgRaw10)}</span>
          <span className="rec-tile-sub">side-adjusted, over 14 bars</span>
        </div>
        <div className="card rec-tile">
          <span className="rec-tile-label">Own outcomes</span>
          <span className="num rec-tile-n">{crypto.gradedN}</span>
          <span className="rec-tile-sub">of the ~{crypto.coldStartN} its base rate needs</span>
        </div>
        <div className="card rec-tile">
          <span className="rec-tile-label">Its own rung</span>
          <span className="num rec-tile-n">R{crypto.rung ?? 0}</span>
          <span className="rec-tile-sub">earned on this cohort alone</span>
        </div>
      </div>
      <p className="cc-reason">
        A 24/7 asset class has no five-day week and no index to be measured against, so this cohort is graded on the move itself — absolute, nothing
        subtracted, over fourteen crypto bars.
        {cold && ' Until it has watched itself about fifty times, every row grades C at half size: that is a designed floor, not a verdict on the asset.'}
      </p>
      {/* THE COHORT'S OWN CALIBRATION (codex #4). It has one — served on the
          learning slice as `crypto.calibration`, struck on the absolute basis —
          and nothing rendered a character of it, so the only calibration on this
          page was the equity one and a cohort reader had no way to know theirs
          existed. Compact on purpose: a second plot beside the equity one would
          read as two views of one measurement when they share no basis at all. */}
      {cal && (
        <p className="cc-reason rec-crypto-cal">
          Its own calibration, on the absolute basis: <span className="num">{buckets}</span> probability {buckets === 1 ? 'bucket' : 'buckets'} filled
          {brier != null && (
            <>
              , latest Brier <span className="num">{brier.toFixed(3)}</span>
            </>
          )}
          .
        </p>
      )}
    </section>
  )
}

function CalibrationSection({ calibration }: { calibration: LearningSlice['calibration'] }) {
  if (!calibration) return null
  const referenceBase = calibration.referenceBase
  return (
    <section aria-label="Calibration" className="rec-calibration">
      {/* NAMED AS THE EQUITY PARTITION TOO (D8). This plot is `engine-calibration`,
          which the grading pass keeps every cohort row out of — the same
          population the scorecard tiles above are about, and the header said so
          while this said nothing. An unlabelled calibration plot under a labelled
          equity scorecard reads as "and here is the whole engine's". */}
      <p className="sec-label">Calibration · Equity — excess vs SPY</p>
      <CalibrationPlot buckets={calibration.buckets as Record<string, { n: number; hits: number }>} seeded={calibration.seeded} />
      <p className="cc-reason rec-calibration-context">
        {referenceBase != null ? (
          <>
            The grade bar sits at <span className="num">{Math.round(referenceBase * 100)}%</span> — the rate an ordinary candidate hits on the same test,
            swept from years of history and fixed until the engine is re-seeded.
          </>
        ) : (
          /* "every graded call" was false the day the cohort started grading its
             own (codex #4): this pooled rate is struck over the equity partition
             alone, and a crypto row has never been in it. */
          <>
            The grade bar is currently the engine's own pooled hit rate across every graded equity call, until a re-seed measures the
            ordinary-candidate rate directly.
          </>
        )}
      </p>
    </section>
  )
}

/** `days` is passed IN rather than fetched here (crypto-v2 wave): the crypto
 * panel rolls the same receipts, and two components calling `useSlice` on one
 * key would revalidate one key twice for one screen. */
function LedgerSection({ days, wide, onWiden }: { days: LedgerDay[]; wide: boolean; onWiden: () => void }) {
  return (
    <section aria-label="The ledger">
      <p className="sec-label">The ledger — the receipts</p>
      <LedgerDayCards days={days} />
      {!wide && (
        <button className="stx-showmore" onClick={onWiden}>
          Load 30 days
        </button>
      )}
    </section>
  )
}

export default function Record() {
  const { data: learning } = useSlice('learning', getLearning)
  // THE WINDOW IS ONE DECISION, MADE HERE (codex #11). It used to live inside
  // LedgerSection, which meant the cards below could be showing thirty days
  // while the crypto panel above still rolled the seven it had been handed —
  // one screen quoting two windows, with nothing on it saying which was which.
  // Widening swaps the slice KEY rather than mounting a second hook: one slice
  // at a time, still fetched only once asked, and `useSlice` holds the 7-day
  // paint on screen until the wider one lands rather than blanking (the same
  // rule PastCalls' DeepCalls follows).
  const [wide, setWide] = useState(false)
  const { data: ledger } = useSlice<{ days: LedgerDay[] }>(wide ? 'ledger:30' : 'ledger:7', () => getLedgerDays(wide ? 30 : 7))
  const days = ledger?.days ?? []
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
          {/* the cohort's own numbers, beside the equity ones and never inside
              them — rendered only once the partition has actually moved, so a
              reader who has never watched a coin sees nothing about one */}
          {learning.crypto && <CryptoPanel crypto={learning.crypto} rows={flattenLedger(days)} />}
          <CalibrationSection calibration={learning.calibration} />
        </>
      )}
      <LedgerSection days={days} wide={wide} onWiden={() => setWide(true)} />
      <Regrets regrets={learning?.regrets ?? null} />
    </div>
  )
}
