// Record (plan Task 20) — Track record: the engine's accountability as a
// first-class tab. Scorecard tiles → calibration → the ledger as cards
// (legacy 11-column sideways table dies here) → the regret surface with
// named examples.
//
// DATA (DS-5, accepted): `learning` (the WHOLE slice — scorecard, calibration
// and regrets; gateState/weights/roster/channelCred are the NEXT task's Gates
// & learning page and are never read here) plus `ledger:30`.
//
// OWNER ITERATION 2 — "Track record is basically useless, the graph doesnt
// mean anything. more information need to stay in track record." Three things
// were added and one taken away:
//   + the CUMULATIVE LINE: what following every sized call would have done,
//     which is the only question a track record actually owes the reader
//   + BEST & WORST of the window, named, with the engine's own post-mortem
//   + the PER-GRADE table: do the letters separate, in n / hit% / avg excess
//   − the "Load 30 days" button. The window is now thirty from the first
//     paint: one slice, one window, no button whose only job was to widen a
//     number the reader had no reason to think was narrow.

import { useSlice } from '../lib/useSlice'
import { getLearning, getLedgerDays, getPaperBook } from '../lib/apiViews'
import type { LearningSlice, LedgerDay } from '../lib/apiViews'
import type { EngineData } from '../lib/api'
import { CalibrationPlot } from '../components/CalibrationPlot'
import { cryptoLedgerSummary, flattenLedger } from '../lib/ledgerStats'
import { bestAndWorst, cumulativeExcessSeries } from '../lib/ledgerSeries'
import type { LedgerExtreme } from '../lib/ledgerSeries'
import { longDate } from '../lib/format'
import { CumulativeLine } from './parts/CumulativeLine'
import { LedgerDayCards } from './parts/LedgerDayCards'
import { Regrets } from './parts/Regrets'
import { WILDCARD_LABEL, WILDCARD_WARNING } from '../../shared/engine/voice'
import { PaperBookPanel } from './parts/PaperBookPanel'

const LEDGER_DAYS = 30

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

/** THE TABLE READS AS A LADDER OR IT READS AS NOTHING (visibility wave,
 * 2026-08-17). `Object.entries` hands back whatever order the blob was built
 * in — which is population order, so the best tier landed last and the reader
 * scanning top-to-bottom was scanning by n, a number the table already prints.
 * Letters descend A→Z; the two non-tiers follow, in the order they lose the
 * reader's conviction: shadow was never offered, the wildcard was offered
 * BECAUSE the gates refused it. */
export function tierRank(key: string): number {
  if (key === 'shadow') return 100
  if (key === 'wildcard') return 101
  return /^[A-Za-z]$/.test(key) ? key.toUpperCase().charCodeAt(0) - 65 : 90
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
      <GradeTable scorecard={scorecard} />
    </section>
  )
}

/** DO THE LETTERS SEPARATE? (owner iteration 2). Side by side in one table the
 * reader can see whether an A is actually worth more than a C — which is the
 * whole claim a grade makes. This is the ONLY per-grade surface: it used to sit
 * under a tile grid carrying the same numbers, and the duplication was exactly
 * the crowding the owner sent the page back over. Being the only surface, it
 * renders even with one populated tier, and the wildcard warning rides under
 * it whenever the wildcard row prints. */
function GradeTable({ scorecard }: { scorecard: Scorecard }) {
  const rows = Object.entries(scorecard.byGrade)
    .filter(([, s]) => s.n > 0)
    .sort((a, b) => tierRank(a[0]) - tierRank(b[0]))
  if (rows.length === 0) return null
  return (
    <div className="rec-grade-wrap">
      <table className="rec-grade-table" aria-label="Per-grade record">
        <thead>
          <tr>
            <th>Tier</th>
            <th>n</th>
            <th>Hit</th>
            <th>Avg excess</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([key, s]) => (
            <tr key={key}>
              <td>{tileLabel(key)}</td>
              <td className="num">{s.n}</td>
              <td className="num">{pct(s.hits, s.n)}</td>
              <td className="num">{fmtExcess(s.sumExcess / s.n)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.some(([key]) => key === 'wildcard') && <p className="rec-tile-warn">{WILDCARD_WARNING}</p>}
    </div>
  )
}

/** BEST & WORST OF THE WINDOW (owner iteration 2). An average hides both ends,
 * and the ends are what a reader remembers — so name them, and let the worst
 * one carry the engine's own explanation where it wrote one. */
function ExtremesSection({ best, worst }: { best: LedgerExtreme | null; worst: LedgerExtreme | null }) {
  if (!best && !worst) return null
  const card = (kind: 'best' | 'worst', row: LedgerExtreme) => (
    <div className={`card rec-extreme rec-extreme-${kind}`}>
      <span className="rec-tile-label">{kind === 'best' ? 'Best of the window' : 'Worst of the window'}</span>
      <span className="rec-extreme-sym">{row.sym}</span>
      <span className={`num rec-extreme-pp ${row.excessPct >= 0 ? 'up' : 'down'}`}>
        {row.excessPct >= 0 ? '+' : '−'}
        {Math.abs(row.excessPct).toFixed(1)}pp
      </span>
      <span className="num rec-tile-sub">{longDate(row.date)}</span>
      {kind === 'worst' && row.postMortem && <p className="rec-ledger-pm">{row.postMortem}</p>}
    </div>
  )
  return (
    <section aria-label="Best and worst" className="rec-extremes">
      {best && card('best', best)}
      {/* one graded row is its own best AND worst; printing that ONE row twice
          would read as two calls. Identity, not symbol — two different calls on
          one name genuinely are two rows. */}
      {worst && !(best && worst.sym === best.sym && worst.date === best.date && worst.excessPct === best.excessPct) && card('worst', worst)}
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
      {/* WHAT THE READER IS LOOKING AT (owner iteration 3). A compact setup
          scorecard replaces the old self-referential claimed-v-realized plot. */}
      <p className="cc-reason rec-calibration-explainer">
        Which direction and market regime have actually beaten the ordinary-candidate bar, with sample size and uncertainty shown.
      </p>
      <CalibrationPlot
        buckets={calibration.buckets as Record<string, { n: number; hits: number }>}
        seeded={calibration.seeded}
        referenceBase={referenceBase}
      />
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
function LedgerSection({ days }: { days: LedgerDay[] }) {
  return (
    <section aria-label="The ledger">
      <p className="sec-label">The ledger — the receipts</p>
      <LedgerDayCards days={days} />
    </section>
  )
}

export default function Record() {
  const { data: learning } = useSlice('learning', getLearning)
  // ONE WINDOW, THIRTY DAYS, FROM THE FIRST PAINT (owner iteration 2). It was
  // seven with a "Load 30 days" button, which meant the screen quoted the
  // narrow window until the reader happened to press something — and the
  // cumulative line below is only worth drawing over a window wide enough to
  // have a shape. One slice for the whole page keeps the crypto panel, the
  // chart, the extremes and the cards all rolling the SAME rows (codex #11's
  // rule, now enforced by there being nothing to widen).
  const { data: ledger } = useSlice<{ days: LedgerDay[] }>(`ledger:${LEDGER_DAYS}`, () => getLedgerDays(LEDGER_DAYS))
  const { data: paperBook } = useSlice('paper-book', getPaperBook)
  const days = ledger?.days ?? []
  const series = cumulativeExcessSeries(days)
  const { best, worst } = bestAndWorst(days)
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
        </>
      )}
      {/* the line and the two ends sit BETWEEN the tiles and the calibration:
          the tiles say what each tier did, this says what the whole book did,
          and the plot says whether the probabilities behind it were honest */}
      <CumulativeLine points={series} days={LEDGER_DAYS} />
      <PaperBookPanel data={paperBook ?? undefined} />
      <ExtremesSection best={best} worst={worst} />
      {learning != null && <CalibrationSection calibration={learning.calibration} />}
      <LedgerSection days={days} />
      <Regrets regrets={learning?.regrets ?? null} />
    </div>
  )
}
