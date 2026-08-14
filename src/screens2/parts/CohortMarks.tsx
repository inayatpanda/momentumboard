// CohortMarks (crypto-v2 wave, findings 6 + 7) — the two things a cohort row
// must carry on every board surface, in one place so CallCard, BoardColumn and
// VerdictHero cannot drift on either.
//
// THE MARK. A cohort row's percentage, its letter and its size were all struck
// on a different partition: its own calibration, its own 14-bar clock, its own
// tape, no benchmark. Beside an equity row with the same pills it is
// indistinguishable, so it says which partition it belongs to. It is a LABEL,
// never a grade: it changes no row-kind law — a cohort row is sized or unsized
// exactly as an equity row is.
//
// THE EXPLANATION. The engine stamps the cohort's whole story into `note`
// (shared/engine/cryptoLane.ts, `cryptoVoice`): its own 14-bar calibration, the
// ~50 outcomes it needs before its base rate stops reading a flat 0.5, the
// C-at-half-size DESIGNED FLOOR that follows from that, the size cap until the
// cohort's own record earns the full rung, and — naming the missing instrument —
// why a pair is paper-only. V2 rendered none of it, leaving an unexplained C at
// half size that reads as the engine's opinion of bitcoin. A reader shown a wall
// of Cs with no explanation is being told something false by omission.
//
// Collapsed rather than always-on because the sentence is long and every cohort
// row carries the same one; the summary is the question a reader actually asks.

export const COHORT_LABEL = 'crypto'
export const WHY_SIZED_SUMMARY = 'why sized like this'

export function CohortPill({ cohort }: { cohort?: 'crypto' }) {
  if (cohort !== 'crypto') return null
  return <span className="pill cc-cohort">{COHORT_LABEL}</span>
}

/** The row's own note, on demand. Renders nothing off-cohort (an equity row's
 * note is the factor line, and it has its own home behind the evidence toggle)
 * and nothing when the row carries no note at all. */
export function WhySized({ cohort, note }: { cohort?: 'crypto'; note?: string | null }) {
  if (cohort !== 'crypto' || !note) return null
  return (
    <details className="cc-why">
      <summary>{WHY_SIZED_SUMMARY}</summary>
      <p className="cc-reason">{note}</p>
    </details>
  )
}
