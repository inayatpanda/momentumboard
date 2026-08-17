// The channels' picks — and what the engine thinks (owner request).
//
// The tracked YouTube channels' week of stances has been computed since the
// video lane shipped (netlify/functions/lib/videoTrends.ts — the AI extracts,
// the consensus maths is pure code) and read by nobody outside the paper and
// the social pulse. This is that list on the home screen, and the reason it is
// worth the space is the SECOND column: every name the street is pushing sits
// beside the engine's own current stance on it.
//
// THE HONESTY RULE HERE. The engine's stance is never manufactured for the
// occasion — it is read off today's board row, or the open book's re-walk, and
// a name in neither gets "no view", said plainly. A grade is a read on evidence
// only a sized row ever cleared (CX-13, boardTaxonomy.ts), so an unsized row
// shows its real state and no letter, and the experiment slot carries its label
// and its standing warning here exactly as it does on a card.
//
// SECONDARY BY CONSTRUCTION: no skeleton, ever — see OpenCallsStrip's header
// for the rule. Absent picks render nothing at all.

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
  'near-miss': 'nearest miss',
  observation: 'observation',
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** THE COIN ALIAS. The channels say "BTC"; the engine publishes the pair it
 * would actually trade, `BTC-USD`. Only quote-currency pairs are aliased
 * (shared/symbols.ts) — `BRK-B`'s dash is a share class, and folding it to
 * "BRK" would hand one company's stance to another. */
const aliases = (sym: string) => (isCryptoSymbol(sym) ? [sym, sym.split('-')[0]] : [sym])

function indexBySym<T extends { sym: string }>(rows: T[]): Map<string, T> {
  const map = new Map<string, T>()
  for (const row of rows) for (const key of aliases(row.sym)) if (!map.has(key)) map.set(key, row)
  return map
}

/** What the engine currently says about this name — read, never invented. */
function EngineStance({ row, open }: { row: EnginePrediction | undefined; open: OpenTraceEntry | undefined }) {
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

export function ChannelPicksStrip({
  picks,
  board,
  openCalls,
}: {
  picks: ChannelPick[] | null | undefined
  board: EnginePrediction[]
  openCalls: OpenTraceEntry[] | undefined
}) {
  if (!picks || picks.length === 0) return null
  // a sized row is the engine's stance even on a day it also published a watch
  // row for the same name on the other side
  const rows = indexBySym([...board].sort((a, b) => Number(rowKind(a) !== 'sized-live') - Number(rowKind(b) !== 'sized-live')))
  const open = indexBySym(openCalls ?? [])
  return (
    <section className="cp-strip" aria-label="Channel picks">
      <p className="sec-label">The channels’ picks — and what the engine thinks</p>
      <div className="card cp-list">
        {picks.map(p => {
          const row = rows.get(p.sym)
          return (
            <div className="cp-row" key={p.sym}>
              <Link href={`/stock/${p.sym}`} className="cp-sym">
                {p.sym}
              </Link>
              <span className="cp-street">
                {p.bulls > 0 && <b className="cp-bull num">{plural(p.bulls, 'bull')}</b>}
                {p.bulls > 0 && p.bears > 0 && <span className="cp-dot"> · </span>}
                {p.bears > 0 && <b className="cp-bear num">{plural(p.bears, 'bear')}</b>}
                <span className="cp-chan num"> from {plural(p.channels, 'channel')}</span>
                {/* heavy one-sided coverage is a contrarian warning, never a
                    second vote for the direction (videoTrends.ts's own word) —
                    and it is part of the STREET's read, so it rides that line */}
                {p.crowded && (
                  <>
                    <span className="cp-dot"> · </span>
                    <span className="cp-crowded">crowded</span>
                  </>
                )}
              </span>
              <EngineStance row={row} open={row ? undefined : open.get(p.sym)} />
              {row?.wildcard && <p className="cc-reason cp-wild-note">{WILDCARD_WARNING}</p>}
            </div>
          )
        })}
      </div>
    </section>
  )
}
