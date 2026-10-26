import { StockIdentity } from '../../components/StockIdentity'
// ONE ROW, TWO SCREENS — the street's read on a name beside the engine's own.
//
// This was ChannelPicksStrip's private row until The street page needed the
// same thing without the home screen's eight-name cap (owner: "there should be
// a system where the youtube suggestions are also evaluated by our engine and
// highlighted — all in a new page/tab altogether"). Two renderings of the same
// claim would drift, and the claim is the delicate part: the engine's stance is
// never manufactured for the occasion.
//
// THE HONESTY RULE. The engine's stance is READ — off today's board row, or the
// open book's re-walk — and a name in neither gets "no view", said plainly. A
// grade is a read on evidence only a sized row ever cleared (CX-13,
// boardTaxonomy.ts), so an unsized row shows its real state and no letter, and
// the experiment slot carries its label and its standing warning here exactly
// as it does on a card.

import { Link } from 'wouter'
import type { EnginePrediction, OpenTraceEntry } from '../../lib/api'
import type { ChannelPick } from '../../lib/apiViews'
import { rowKind, unsizedReason, type RowKind } from '../../lib/boardTaxonomy'
import { isCryptoSymbol } from '../../../shared/symbols'
import { WILDCARD_LABEL, WILDCARD_WARNING } from '../../../shared/engine/voice'
import { VERDICT_CLASS, VERDICT_WORD, crossedWord } from './OpenCallsStrip'

/** The chip word for a row the engine published without sizing. The LAW's own
 * sentence is longer than a chip (boardTaxonomy.ts's `unsizedReason`) and rides
 * along as the title, so the short word can never quietly say something the law
 * does not — it labels the state, it does not explain it. */
const UNSIZED_WORD: Record<Exclude<RowKind, 'sized-live'>, string> = {
  watch: 'watch',
  'near-miss': 'Close to qualifying',
  observation: 'observation',
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** THE COIN ALIAS. The channels say "BTC"; the engine publishes the pair it
 * would actually trade, `BTC-USD`. Only quote-currency pairs are aliased
 * (shared/symbols.ts) — `BRK-B`'s dash is a share class, and folding it to
 * "BRK" would hand one company's stance to another. */
const aliases = (sym: string) => (isCryptoSymbol(sym) ? [sym, sym.split('-')[0]] : [sym])

export function indexBySym<T extends { sym: string }>(rows: T[]): Map<string, T> {
  const map = new Map<string, T>()
  for (const row of rows) for (const key of aliases(row.sym)) if (!map.has(key)) map.set(key, row)
  return map
}

/** Today's board, indexed for lookup — a SIZED row wins, because it is the
 * engine's stance even on a day it also published a watch row for the same
 * name on the other side. */
export const indexBoard = (board: EnginePrediction[]) =>
  indexBySym([...board].sort((a, b) => Number(rowKind(a) !== 'sized-live') - Number(rowKind(b) !== 'sized-live')))

/** WHO said it, as a line — "Josh, Gareth + 2 more". The server caps the names
 * at six and keeps the full count beside them, so the tail is arithmetic on two
 * numbers it actually sent, never an estimate. Null when the payload carries no
 * names at all (a slice cached before the field existed): the caller then falls
 * back to the count, which is exactly what was true before. */
export function whoSaidIt(names: string[] | undefined, total: number): string | null {
  const shown = (names ?? []).filter(n => typeof n === 'string' && n.trim() !== '')
  if (shown.length === 0) return null
  const rest = total - shown.length
  return rest > 0 ? `${shown.join(', ')} + ${rest} more` : shown.join(', ')
}

/** What the engine currently says about this name — read, never invented. */
export function EngineStance({ row, open }: { row: EnginePrediction | undefined; open: OpenTraceEntry | undefined }) {
  // today's board is the fresher word: a name published this morning reads as
  // what the engine says now, not as what it said the day it was called
  if (row) {
    const kind = rowKind(row)
    if (kind !== 'sized-live') {
      return (
        <span className="cp-stance cp-unsized" title={unsizedReason(kind, row.belowBase)}>
          {UNSIZED_WORD[kind]}
        </span>
      )
    }
    return (
      <span className="cp-stance">
        <span className={`pill ${row.side}`}>{row.side}</span>
        {row.wildcard && <span className="pill cp-wild">{WILDCARD_LABEL}</span>}
        <span className="pill accent" aria-label={`Grade ${row.grade}`}>
          {row.grade}
        </span>
      </span>
    )
  }
  if (open) {
    const word = open.verdict ? VERDICT_WORD[open.verdict] : crossedWord(open.status)
    return (
      <span className="cp-stance">
        <span className="cp-open">open call · day {open.day}</span>
        {word && <span className={`cp-verdict ${open.verdict ? VERDICT_CLASS[open.verdict] : 'flat'}`}>{word}</span>}
      </span>
    )
  }
  // …and the honest third answer, which is the one that makes the other two
  // worth reading: the engine is not looking at this name at all.
  return (
    <span className="cp-stance cp-noview" title="Not on today’s board and not in the open book — the engine has no read on this name.">
      no view
    </span>
  )
}

/** One name: what the channels said, and what the engine says back.
 *
 * `detailed` is The street page's fuller row — the channel NAMES in place of
 * the bare count, and the week's stance flip called out. The home screen's
 * strip stays the thin version it was ratified as; the difference is which
 * facts are shown, never what any of them mean. */
export function ChannelPickRow({
  pick,
  row,
  open,
  detailed = false,
}: {
  pick: ChannelPick
  row: EnginePrediction | undefined
  open: OpenTraceEntry | undefined
  detailed?: boolean
}) {
  const who = detailed ? whoSaidIt(pick.channelNames, pick.channels) : null
  return (
    <div className="cp-row">
      <Link href={`/stock/${pick.sym}`} className="cp-sym">
        {pick.sym}<span className="cp-company"><StockIdentity symbol={pick.sym} name={row?.name} nameOnly /></span>
      </Link>
      <span className="cp-street">
        {pick.bulls > 0 && <b className="cp-bull num">{pick.bulls} {pick.bulls === 1 ? 'expects' : 'expect'} a rise</b>}
        {pick.bulls > 0 && pick.bears > 0 && <span className="cp-dot"> · </span>}
        {pick.bears > 0 && <b className="cp-bear num">{pick.bears} {pick.bears === 1 ? 'expects' : 'expect'} a fall</b>}
        {/* the names carry the count inside them ("+ 2 more"), so when they are
            shown the count goes with them, onto its own line below — a first
            line of variable length puts the engine's answer at a different
            x on every row, and reading that column down IS the section */}
        {!who && <span className="cp-chan num"> from {plural(pick.channels, 'channel')}</span>}
        {/* heavy one-sided coverage is a contrarian warning, never a second
            vote for the direction (videoTrends.ts's own word) — and it is part
            of the STREET's read, so it rides that line */}
        {pick.crowded && (
          <>
            <span className="cp-dot"> · </span>
            <span className="cp-crowded">crowded</span>
          </>
        )}
      </span>
      <EngineStance row={row} open={row ? undefined : open} />
      {/* WHO said it, and whether they changed their minds — both are facts
          about the CHANNELS, so they share one quiet line under the row.
          `shifted` is the stance balance reversing against the PRIOR seven days
          (videoTrends.ts): a fact about their conviction, never about the
          engine's, and never a direction to trade. */}
      {detailed && (who || pick.shifted) && (
        <p className="cp-who">
          {who}
          {pick.shifted && <span className="pill cp-shifted">stance flipped this week</span>}
        </p>
      )}
      {row?.wildcard && <p className="cc-reason cp-wild-note">{WILDCARD_WARNING}</p>}
    </div>
  )
}
