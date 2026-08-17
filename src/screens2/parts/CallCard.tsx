// CallCard (plan Task 13) — one board row, the way Today shows it. Reused
// later by the Board screen (Task 14), so it stays honest about EVERY row
// shape the engine publishes, not just the sized ones Today leads with.
//
// THE HARD RULE: a letter grade and a probability are a read on evidence that
// only exists once a row is sized/live. `nearMiss`, `observation` and a plain
// `watchOnly` row each explain themselves in one line instead — the DATA
// semantics are the old src/components/EngineBoard.tsx:70-121 ternary, worded
// fresh for the new card (see `reasonLine`).

import { Link } from 'wouter'
import type { EnginePrediction } from '../../lib/api'
import { rowKind, unsizedReason } from '../../lib/boardTaxonomy'
import { fmtRiskPct, sizeLabel } from '../../lib/format'
import { Sparkline } from '../../components/Sparkline'
import { WILDCARD_LABEL, WILDCARD_WARNING } from '../../../shared/engine/voice'
import { exchangeFor } from '../../../shared/symbols'
import type { Quote } from '../../../shared/types'
import { exchangeOpenNow } from '../../lib/marketClock'
import { CohortPill, WhySized } from './CohortMarks'
import { RouteNote } from './RouteNote'

/** Within this much of the entry, "1.9% below" is false precision — the reader
 * is AT the entry and the only useful word is that. */
const AT_ENTRY_PCT = 0.3

/** Where the tape stands against the level, in the reader's words.
 *
 * The side inverts it: a long that has not triggered sits BELOW its entry, a
 * short ABOVE it, and either one that HAS triggered is simply past it. Null
 * when there is nothing honest to say (no level, no price). */
export function entryDistance(price: number, entry: number, side: 'long' | 'short'): string | null {
  if (!Number.isFinite(price) || !Number.isFinite(entry) || entry <= 0 || price <= 0) return null
  const pct = ((price - entry) / entry) * 100
  if (Math.abs(pct) <= AT_ENTRY_PCT) return 'at entry'
  const triggered = side === 'long' ? pct > 0 : pct < 0
  if (triggered) return 'past entry'
  return `${Math.abs(pct).toFixed(1)}% ${pct < 0 ? 'below' : 'above'} entry`
}

const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** What to call the number: the tape while the exchange trades, and the CLOSE
 * it actually is once the bell has gone. `asOf` is UNIX SECONDS on a Quote,
 * but other feeds in this codebase store milliseconds — decide by magnitude,
 * the same rule src/lib/format.ts's relativeStamp states. */
function priceLabel(quote: Quote, sym: string, nowMs: number): string {
  if (exchangeOpenNow(exchangeFor(sym), nowMs)) return 'now'
  if (!quote.asOf || quote.asOf <= 0) return 'last close'
  const ms = quote.asOf > 1e12 ? quote.asOf : quote.asOf * 1000
  // The weekday is the MARKET's, read in UTC: a close belongs to the session
  // that produced it, and both sessions this app prices (13:30–20:00 and
  // 08:00–16:30 UTC) sit inside one UTC day. Reading it locally would date a
  // Friday close to Saturday for a reader east of Greenwich.
  return `${WEEKDAYS_SHORT[new Date(ms).getUTCDay()]} close`
}

/** THE LIVE LINE (dynamism wave). One line under the levels: what the name is
 * actually trading at, and how far that is from the entry the card is asking
 * for. Renders only when a real quote exists — out of hours it is labelled as
 * a close, never dressed up as a tick. */
function LiveLine({ row, quote, now }: { row: EnginePrediction; quote: Quote; now?: number }) {
  const nowMs = now ?? Date.now()
  const distance = entryDistance(quote.price, row.entry, row.side)
  return (
    <p className="cc-live">
      <span className="num">
        {priceLabel(quote, row.sym, nowMs)} {quote.price.toFixed(2)}
      </span>
      {distance && <span className="num cc-live-gap"> · {distance}</span>}
    </p>
  )
}

// The row-kind law (which shape is this, and what does it say instead of a
// grade) lives in src/lib/boardTaxonomy.ts — ONE copy, shared with VerdictHero.
// It used to be duplicated here, and the duplicate had drifted (Task 17 review).

// `spark` is an OPTIONAL second prop, not part of the row: the board slice
// (Task 13's only sanctioned data source — the amendment killed the extra
// ledger/funnel fetches) carries no price history, so Today never passes one
// today. The prop exists so a future caller with candles in hand (the Board
// screen, Task 14) can hand them in without this component changing shape.
export function CallCard({
  row,
  spark,
  quote,
  now,
}: {
  row: EnginePrediction
  spark?: number[]
  /** A live (or last-close) quote for this row's symbol, when the screen has
   * one — src/lib/useLiveQuotes.ts. Absent renders nothing extra at all. */
  quote?: Quote | null
  /** Frozen clock, for tests. */
  now?: number
}) {
  const kind = rowKind(row)
  const sized = kind === 'sized-live'
  const pct = Math.round(row.probability * 100)
  // composite is signed and effectively unbounded past the grade bar; the bar
  // is decoration, not a measurement, so it clamps rather than overflows.
  const convictionPct = Math.max(0, Math.min(100, Math.abs(row.composite)))
  const sizingNote = `risk ${fmtRiskPct(row.riskPct)}%${sizeLabel(row.riskPct, row.riskRung)}${
    row.instrument ? ` · ${row.instrument.ticker} ${row.instrument.leverage}x` : row.paperOnly ? ' · paper-only' : ''
  }`
  // THE COHORT'S OWN EXPLANATION (crypto-v2 wave, finding 6) is a <details>, and
  // interactive content may not nest inside an anchor — so a cohort row wraps
  // the link in the card instead of BEING the card, and the disclosure sits
  // beside it. An equity row's markup is byte-identical to what it always was.
  const cohortNote = row.cohort === 'crypto' && row.note ? <WhySized cohort={row.cohort} note={row.note} /> : null
  const card = (
    <Link href={`/stock/${row.sym}`} className={cohortNote ? 'pressable cc' : 'card pressable cc'}>
      <div className="cc-top">
        <span className="cc-sym">
          {row.sym}
          <span className={`pill ${row.side}`}>{row.side === 'long' ? 'Long' : 'Short'}</span>
          <CohortPill cohort={row.cohort} />
          {row.name && <span className="cc-name">{row.name}</span>}
        </span>
        {sized && (
          <span className="pill accent" aria-label={`Grade ${row.grade}`}>
            {row.grade}
          </span>
        )}
      </div>
      <div className="convbar">
        <i style={{ width: `${convictionPct}%` }} />
      </div>
      {spark && spark.length > 1 && <Sparkline closes={spark} />}
      {row.wildcard && (
        <div className="cc-wildcard">
          <span className="pill">{WILDCARD_LABEL}</span>
          <span>{WILDCARD_WARNING}</span>
        </div>
      )}
      <div className="cc-levels">
        <span>
          Entry <b className="num">{row.entry}</b>
        </span>
        <span>
          Stop <b className="num">{row.stop}</b>
        </span>
        <span>
          Target <b className="num">{row.target}</b>
        </span>
      </div>
      {quote && <LiveLine row={row} quote={quote} now={now} />}
      {sized ? (
        <div className="cc-meta">
          <span className="num" aria-label={`Probability ${pct} percent`}>
            {pct}% · ~{row.expectedMovePct}%
          </span>
          <span className="num">{sizingNote}</span>
        </div>
      ) : (
        <p className="cc-reason">{unsizedReason(kind, row.belowBase)}</p>
      )}
      {/* the levels above are the UNDERLYING's, whatever the ticker beside them
          says — and only a geared route decays (parts/RouteNote.tsx) */}
      <RouteNote instrument={row.instrument} />
    </Link>
  )
  if (!cohortNote) return card
  return (
    <div className="card cc-wrap">
      {card}
      {cohortNote}
    </div>
  )
}
