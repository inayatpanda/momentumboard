// THE VOICE. Every call the engine publishes says two things in plain English:
// what it believes, and what would prove it wrong. This module owns both
// sentences, for all three producers (composite, dip lane, velocity lane), and
// nothing else in the engine writes reader prose for a call.
//
// WHY IT IS ITS OWN MODULE. The narration the board used to carry was
// `${factorName}: ${factor.detail}` — the machine's own field names, joined with
// a dot: "technical: pullback, every timeframe pointing up · momentum: 21d RS vs
// SPY +6.4pp". That is a debug line, not a thesis, and it violates the paper's
// own standing rule (PERSONA, newspaper.ts): never print internal data key names
// in reader-facing prose. Putting the humanisation in one tested module makes the
// mapping CONCRETE — a table you can read, a phrase per factor derived from that
// factor's own `detail` semantics, and a banned-token sweep every producer's
// output is held to.
//
// THE DIVISION OF LABOUR WITH THE LLM. These sentences are deterministic and are
// stored on the row. The paper's journalist may POLISH the thesis; it may never
// invent a different one, and the falsifier is reproduced verbatim. That is why
// the falsifier is stored as its own field rather than only being the last
// sentence of the thesis: a level the reader is told to act on must be copyable,
// not paraphrasable.
//
// `note` is untouched and still carries the factor breakdown — it survives as the
// evidence line beneath the thesis on every surface. The thesis replaces it as
// the LEAD line only.

import type { Stage } from '../technicals'
import type { FactorName, FactorScore } from './types'
import { round1 } from './types'

// ---------- the banned-token rule ----------

/** Words that are the machine's names for things, never the reader's. Two
 * families, one rule:
 *
 *  · FACTOR + FIELD NAMES — `technical`, `momentum`, `expectedMovePct`,
 *    `watchOnly`… The 2026-07-23 ban (newspaper.ts PERSONA, "PLAIN ENGLISH")
 *    already forbids these in the paper's prose; the engine must not hand the
 *    paper prose that breaks the rule before the model even sees it.
 *  · STAGE ENUM VALUES — `pullback`, `early-reversal`, `exhausted`… The whole
 *    purpose of STAGE_PHRASE below is to translate them, so leaking one back out
 *    means the translation silently failed somewhere.
 *
 * Matched on token boundaries and case-insensitively, so "weakness", "pulled
 * back" and "the trend is intact" are all fine while "weak", "pullback" and
 * "trending" are not. Exported because free text the engine did not write
 * (a catalyst reason, a YouTube channel's name) is checked against it before
 * being embedded — see `safe`. */
export const BANNED_TOKENS: readonly string[] = [
  // the ten factor names
  'technical', 'momentum', 'sector', 'social', 'channels', 'insiders', 'news', 'seasonality', 'smartMoney', 'catalyst',
  // the eight technical stages
  'early-reversal', 'falling-knife', 'pullback', 'basing', 'trending', 'extended', 'exhausted', 'weak',
  // the setup families
  'continuation', 'reversal', 'fade', 'velocity',
  // engine field names that have leaked into prose before, or plausibly could
  'composite', 'expectedMovePct', 'capacityPct', 'riskPct', 'riskRung', 'watchOnly', 'paperOnly',
  'nearMiss', 'belowBase', 'famAgree', 'contextPts', 'coverage', 'dropPct', 'greenStreak',
  'emaStack', 'volThrust', 'volumeConfirmed', 'entryQuality', 'typical10dMovePct', 'socialPulse',
  'engineBoard', 'rs5', 'rs21', 'rvol', 'smallCap', 'earningsRisk', 'capUsdM', 'worldTape',
  'redditRank', 'surgeMultiple', 'modelVersion', 'priceAtPrediction',
]

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// A token is a leak only as a whole word: `weak` is banned, `weakness` is prose.
const BANNED_RE = BANNED_TOKENS.map(t => ({ token: t, re: new RegExp(`(?<![A-Za-z0-9])${escapeRe(t)}(?![A-Za-z0-9])`, 'i') }))
// …and anything shaped like an identifier is a leak whether or not it is on the
// list: no English sentence contains `someFieldName`.
const CAMEL_RE = /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g

/** Every internal name found in a candidate sentence — empty means it is safe to
 * show a reader. The sweep every producer's output is tested against, and the
 * guard `safe()` uses on text the engine did not write itself. */
export function bannedTokensIn(text: string): string[] {
  const hits = BANNED_RE.filter(({ re }) => re.test(text)).map(({ token }) => token)
  for (const m of text.match(CAMEL_RE) ?? []) if (!hits.includes(m)) hits.push(m)
  return hits
}

/** Free text the engine did not author (a catalyst's reason, a channel's name)
 * passed through only when it is clean. Dropping a concrete detail costs the
 * reader some colour; printing `news: momentum names bid` costs them the whole
 * point of the rewrite, and the invariant "no thesis ever leaks a field name"
 * has to hold BY CONSTRUCTION rather than by hoping about upstream strings.
 *
 * EXPORTED for the same rule one layer out: the gate-state blob's `why` strings
 * are template-built but hand-editable and travel into the paper's prompt, so
 * `gateState.ts` scrubs them through this exact sweep rather than a second one
 * that could drift from it. */
export function safe(text: string | null | undefined, maxLen = 90): string | null {
  // Markup and prompt-steering characters are stripped, not escaped: a thesis
  // travels into the journalist's LLM prompt as well as the DOM, and the only
  // characters a headline legitimately needs are words and prices. (The catalyst
  // reason was already an LLM-payload passenger before the thesis existed — this
  // hardens the whole class, it doesn't close a new hole.)
  const t = (text ?? '').replace(/[<>`"{}\[\]]/g, ' ').trim().replace(/\s+/g, ' ')
  if (!t) return null
  const cut = t.length > maxLen ? `${t.slice(0, maxLen).replace(/[\s,;:.-]+\S*$/, '')}…` : t
  return bannedTokensIn(cut).length ? null : cut
}

// ---------- the stage table ----------

/** Where the chart is, said the way a person says it. Every one of the eight
 * stages has an entry — a missing one would fall through to the no-stage
 * sentence and quietly drop the most important clause in the thesis. The
 * phrases deliberately avoid the enum's own word (`basing` → "has built a
 * base"), which is the point of the table. */
export const STAGE_PHRASE: Record<Stage, string> = {
  'early-reversal': 'the chart is turning up off its low',
  basing: 'the chart has built a base',
  pullback: 'it has pulled back into support',
  trending: 'the trend is intact',
  weak: 'the chart is broken',
  extended: 'it is stretched well above its own averages',
  exhausted: 'the run looks spent',
  'falling-knife': 'it is still falling',
}

/** The stage clause, with the honest sentence for a chart the engine could not
 * read at all (stage is nullable on EngineCall, and a call CAN publish without
 * one — that is what a null `setup` means). */
export function stagePhrase(stage: Stage | string | null | undefined): string {
  return (stage && STAGE_PHRASE[stage as Stage]) || 'the chart is not giving a clean read'
}

// ---------- one phrase per factor, from that factor's own detail ----------

// EVERY phrase below is a NOUN PHRASE, not a sentence. They are read in two
// slots — "…{stage phrase} with {phrase}" and "…, and {phrase}" — and a clause
// with its own finite verb ("it has outrun the S&P") produces "the chart is
// broken with it has lagged the S&P", which is not English. Participles, always.
const num = (detail: string, re: RegExp): number | null => {
  const m = detail.match(re)
  return m ? Number(m[1]) : null
}

/** The chart factor, MINUS the stage — the stage already leads the sentence, so
 * repeating it ("the chart has built a base with a base…") is the one thing this
 * phrase must not do. What is left is the confirmation the stage did or did not
 * get: timeframe agreement, the week's participation, today's volume.
 *
 * TWO OF THOSE THREE READ DIFFERENTLY ON A SHORT, and the difference is measured,
 * not stylistic (factors.ts, technicalFactor):
 *
 *  · VOLUME is scored LONG-ONLY. The ×1.2 confirmation boost is gated on
 *    `volumeConfirmed && base > 0` because over 96 live shorts, weakness WITH
 *    volume behind it did worse (47.6% / −1.97%) than weakness without it (65.3%
 *    / +4.31%) — heavy volume into a fall is usually capitulation. The engine
 *    gives a short exactly zero credit for it, so "volume behind it" in a short's
 *    thesis is the prose claiming a reason the number refused. The fact is still
 *    worth printing (factors.ts keeps reporting the RVOL "so the reader sees what
 *    the engine saw") — printed with its accounting attached.
 *  · THE WEEK is scored on BOTH sides: the thrust multiplier is applied to the
 *    signed score, so a week of heavy participation deepens a short exactly as it
 *    lifts a long. That one IS a reason for a short — but "the crowd arriving"
 *    is a bull's sentence, and the same fact needs a word that does not cheer. */
function technicalPhrase(f: FactorScore, side: 'long' | 'short'): string | null {
  const d = f.detail
  const long = side === 'long'
  const parts: string[] = []
  if (/every timeframe pointing/.test(d)) parts.push('every timeframe pointing the same way')
  if (/a week of building participation/.test(d)) parts.push(long ? 'a week of the crowd arriving' : 'a heavy week')
  else if (/a week of thinning participation/.test(d)) parts.push(long ? 'a week of the crowd leaving' : 'a quiet week')
  if (/volume-confirmed/.test(d)) parts.push(long ? 'volume behind it' : "heavy volume into the weakness, which the engine does not count in a short's favour")
  else if (/unconfirmed turn/.test(d)) parts.push('no volume behind the turn yet')
  return parts.length ? parts.slice(0, 2).join(' and ') : null
}

/** 21-session relative strength vs SPY, in points rather than in the factor's
 * own shorthand. */
function momentumPhrase(f: FactorScore): string | null {
  // …and the CRYPTO partition's own sentence (Stage 1c Phase B), because the
  // equity one would be a plain falsehood on a crypto row: `cryptoMomentumFactor`
  // measures an ABSOLUTE move against the pair's own typical travel, and there is
  // no S&P in it to outperform. Read off the detail's own shape, exactly as every
  // other phrase in this file is — the factor writes one sentence, this reads it.
  const crypto = /(\d+)-bar move ([+-]?\d+(?:\.\d+)?)% vs its own typical/.exec(f.detail)
  if (crypto) {
    const move = Number(crypto[2])
    return `${round1(Math.abs(move))}% ${move >= 0 ? 'up' : 'down'} over the last ${crypto[1]} bars, a big move against its own usual travel`
  }
  const pp = num(f.detail, /([+-]?\d+(?:\.\d+)?)pp/)
  if (pp == null) return null
  const mag = round1(Math.abs(pp))
  return `${mag} points of ${pp >= 0 ? 'out' : 'under'}performance against the S&P over the last month`
}

/** The name's industry standing, as a bucket. A middling rank is left unsaid:
 * "ranks in the 51st percentile" is a measurement, not a reason. */
function sectorPhrase(f: FactorScore): string | null {
  const p = num(f.detail, /\bp(\d+)\b/)
  if (p == null) return null
  if (p >= 70) return 'its industry group among the strongest in the market'
  if (p >= 56) return 'its industry group on the right side of the market'
  if (p <= 30) return 'its industry group among the weakest in the market'
  if (p <= 44) return 'its industry group on the wrong side of the market'
  return null
}

/** The month's own average, with EXACTLY one sign in front of it. The capture is
 * already signed — seasonalityFactor writes `August avg +3.1% over 7 yrs` — so
 * the magnitude is separated from the sign before either is printed, rather than
 * a `+` being prefixed onto a string that may already carry one ("averaging
 * ++3.1%"). Reading the sign off the captured text rather than off `Number()`
 * keeps the factor's own rounding: this phrase reformats nothing. */
function seasonalityPhrase(f: FactorScore): string | null {
  const m = f.detail.match(/^([A-Za-z]+) avg ([+-]?)([\d.]+)% over (\d+) yrs$/)
  if (!m) return null
  return `${m[1]} averaging ${m[2] === '-' ? '-' : '+'}${m[3]}% here over ${m[4]} years`
}

function socialPhrase(f: FactorScore): string | null {
  if ((f.score ?? 0) <= 0) return null
  const surge = num(f.detail, /([\d.]+)x surge/)
  const crowded = /crowded\+hot/.test(f.detail)
  const base = surge != null ? `retail chatter running at ${surge}x its usual` : 'retail chatter picking up'
  return crowded ? `${base} on a chart that is already crowded` : base
}

function channelsPhrase(f: FactorScore): string | null {
  const names = safe(f.detail.split(': ')[1], 60)
  const lean = (f.score ?? 0) >= 0 ? 'calling it higher' : 'calling it lower'
  return names ? `the commentators we follow ${lean} (${names})` : `the commentators we follow ${lean}`
}

/** The insider factor's three details are `cluster: N insiders buying`, `insider
 * buying`, and — the one a substring test gets wrong — `no insider buying`. The
 * match is anchored so the absence of buying cannot phrase itself as a purchase.
 * (composeCall only ever quotes a factor whose score agrees with the side, and
 * that branch scores 0, so this was unreachable from the board; a phrase function
 * that states the opposite of its input is a defect wherever it sits.) */
function insidersPhrase(f: FactorScore): string | null {
  const n = num(f.detail, /cluster: (\d+)/)
  if (n != null) return `${n} of the company's own directors buying together`
  return /^insider buying$/.test(f.detail) ? "one of the company's own directors buying" : null
}

function newsPhrase(f: FactorScore): string | null {
  const n = num(f.detail, /^(\d+) headline/)
  if (n == null || !n) return null
  const lean = (f.score ?? 0) >= 0 ? 'positive' : 'negative'
  return `${n} ${n === 1 ? 'headline' : 'headlines'} on it reading ${lean}`
}

function smartMoneyPhrase(f: FactorScore): string | null {
  if (!f.score) return null
  return f.score > 0 ? 'a fund we track adding to it in the latest filings' : 'a fund we track selling out of it in the latest filings'
}

/** The live event, with its own reason quoted ONLY when the reason is clean —
 * catalyst reasons are assembled from headlines and from the lanes' own reads,
 * and a lane's read is full of the words this module exists to keep out. */
function catalystPhrase(f: FactorScore): string | null {
  const reason = safe(f.detail.replace(/^[a-z-]+: /, '').replace(/ \(strength \d+\)$/, ''))
  return reason ? `a live event on it — ${reason}` : 'a live event on it today'
}

/** Every phrase reads the SIDE as well as the factor. Most ignore it — a fund
 * that sold is a fund that sold whichever way the call points — but a phrase that
 * needs it must be able to ask, and a phrase that silently could not was how a
 * bull's clause ended up in a short's thesis. */
type PhraseWriter = (f: FactorScore, side: 'long' | 'short') => string | null

const FACTOR_PHRASE: Record<FactorName, PhraseWriter> = {
  technical: technicalPhrase,
  momentum: momentumPhrase,
  sector: sectorPhrase,
  seasonality: seasonalityPhrase,
  social: socialPhrase,
  channels: channelsPhrase,
  insiders: insidersPhrase,
  news: newsPhrase,
  smartMoney: smartMoneyPhrase,
  catalyst: catalystPhrase,
}

/** One factor, one clause — or null when that factor's detail carries nothing a
 * reader would recognise as a reason. Null is a real answer: the caller walks on
 * to the next contributor rather than printing a hollow clause.
 *
 * `side` is REQUIRED rather than defaulted, because the default would have been
 * `long` and the whole class of defect this parameter exists to close is a long's
 * sentence appearing under a short. A caller that has not decided which way the
 * call points has nothing for this function to write yet. */
export function factorPhrase(name: FactorName, f: FactorScore | null | undefined, side: 'long' | 'short'): string | null {
  if (!f || f.score == null) return null
  const phrase = FACTOR_PHRASE[name]?.(f, side) ?? null
  return phrase && !bannedTokensIn(phrase).length ? phrase : null
}

// ---------- the three templates ----------

const sideWord = (side: 'long' | 'short') => (side === 'long' ? 'Long' : 'Short')

/** The fixed-level falsifier both the composite and the dip lane publish. A
 * stop is a level and a direction, and the sentence says both. */
export function fixedFalsifier(side: 'long' | 'short', stop: number): string {
  return `Wrong if it closes ${side === 'long' ? 'below' : 'above'} ${stop}.`
}

/** …and the moving one. The velocity lane's stop is a TRAIL that is re-read
 * every session (openTrace.ts, paperBook.ts), so a sentence naming today's level
 * and stopping there would be false by tomorrow. It says both halves. */
export function trailFalsifier(stop: number): string {
  return `Wrong on the first close below the trail (${stop} today, and it ratchets).`
}

export interface ThesisInput {
  sym: string
  side: 'long' | 'short'
  stage: Stage | string | null
  stop: number
  /** The strongest CORE contributor arguing FOR this side, from composeCall's own
   * contributor ordering. */
  core?: { name: FactorName; factor: FactorScore } | null
  /** …and the strongest context one, quoted only when the context layer actually
   * moved the number (see CONTEXT_MIN_PTS). */
  context?: { name: FactorName; factor: FactorScore } | null
  /** The capped context contribution actually applied (evidence.contextPts). */
  contextPts?: number
}

/** Context is capped colour (±the context cap — 12 by default, and gate feedback
 * may move it anywhere in [12, 16]; gateState.ts, GATE_BOUNDS.contextCap). Below
 * this it did not change the call, and a thesis that cites it anyway is telling
 * the reader a headline bought them a trade that the chart bought them.
 *
 * The floor below is deliberately NOT tied to that cap: it asks whether the
 * context layer moved the number enough to be worth a sentence, which is a
 * question about the reader, not about how much room the layer was given. */
export const CONTEXT_MIN_PTS = 4

/** …and the other half of the same claim. The threshold asks whether the context
 * layer moved the number ENOUGH; this asks whether it moved it toward THIS call.
 * Context points are signed with the side they argue for, so a long's supporting
 * context is positive and a short's is negative — and −9 points under a long is
 * context that argued against the trade the paper is about to print. Quoting it
 * as a reason to take the trade is the same lie as quoting volume on a short,
 * one layer up. */
export function contextMoved(contextPts: number | undefined, side: 'long' | 'short'): boolean {
  const pts = contextPts ?? 0
  return side === 'long' ? pts >= CONTEXT_MIN_PTS : pts <= -CONTEXT_MIN_PTS
}

/** The composite call's two sentences.
 *
 *   "Long ABBV — it has pulled back into support with every timeframe pointing
 *    the same way, and the 3 headlines on it read positive. Wrong if it closes
 *    below 182.40."
 *
 * The thesis ENDS with the falsifier and the falsifier is also returned on its
 * own: the paper prints one of them verbatim in the invalidation cell, and the
 * two must be the same sentence, not two sentences that agree. */
export function composeThesis(input: ThesisInput): { thesis: string; falsifier: string } {
  const falsifier = fixedFalsifier(input.side, input.stop)
  const core = input.core ? factorPhrase(input.core.name, input.core.factor, input.side) : null
  const ctx = contextMoved(input.contextPts, input.side) && input.context ? factorPhrase(input.context.name, input.context.factor, input.side) : null
  const body = core ? `${stagePhrase(input.stage)} with ${core}` : stagePhrase(input.stage)
  return {
    thesis: `${sideWord(input.side)} ${input.sym} — ${body}${ctx ? `, and ${ctx}` : ''}. ${falsifier}`,
    falsifier,
  }
}

/** What the dip lane's own news question found (dipNews.ts). The engine holds
 * the verdict, the lane does not — so the lane writes the thesis without a
 * clause and buildBoard re-composes it once the read is back. */
export type DipNewsRead = 'transient' | 'structural' | 'unclear' | null

const DIP_NEWS_CLAUSE: Record<'transient' | 'structural' | 'unclear', string> = {
  transient: ', and the story behind the fall reads like an overreaction',
  structural: ', though the story behind the fall reads like something actually broke',
  unclear: '', // unchecked is not evidence either way, and must not be dressed as one
}

/** The dip lane's two sentences.
 *
 *   "Long GLW — hit 14.2% and holding, and the story behind the fall reads like
 *    an overreaction. Wrong if it closes below 42.10." */
export function dipThesis(input: { sym: string; dropPct: number; stop: number; news?: DipNewsRead }): { thesis: string; falsifier: string } {
  const falsifier = fixedFalsifier('long', input.stop)
  const clause = input.news ? DIP_NEWS_CLAUSE[input.news] : ''
  return { thesis: `Long ${input.sym} — hit ${round1(input.dropPct)}% and holding${clause}. ${falsifier}`, falsifier }
}

/** THE MARK ITSELF, split out of the label because the surfaces that carry the
 * ROW are not the surfaces that carry a SENTENCE. The paper's board chip, the
 * print edition, both intraday bulletins, the ledger table and the stop/target
 * pings each print a glyph beside a row rather than a label inside prose — and
 * every one of them printed the experiment as an ordinary call until the final
 * review of Stage 3d. Spec §4.1's "distinctly labelled" is a promise about every
 * surface the reader is SENT, not about the two the engine happens to compose.
 *
 * ONE SURFACE CANNOT PRINT IT: the print edition's WinAnsi standard fonts have no
 * code point for U+1F0CF, so `sanitizeWinAnsi` (reportPdf.ts) drops it. There the
 * mark is the WORD instead, and every clause that carries the glyph is worded so
 * that losing it still leaves a true sentence. */
export const WILDCARD_MARK = '🃏'

/** THE EXPERIMENT'S LABEL, one exported constant because four surfaces print it
 * — the row's thesis and note here, the board card's badge, the panel line and
 * the paper's brief — and a reader who learns to recognise one glyph must find
 * the same glyph everywhere. Spec §4.1: "distinctly labelled". */
export const WILDCARD_LABEL = `${WILDCARD_MARK} Wildcard`

/** …and the STANDING WARNING, printed on every wildcard row without exception
 * and never softened by how good the particular row looks. The slot exists to
 * take trades the engine's own gates refused, so it will lose more often than the
 * board does — and the one thing that must never happen is a reader meeting one
 * of these rows without being told that in the row's own words. */
export const WILDCARD_WARNING = 'Experiments lose more often than the board does.'

/** The wildcard's two sentences.
 *
 *   "🃏 Wildcard · Long GLW — quarter size, testing a gate: dead-zone-core has 7
 *    priced outcomes and 40 unpriced in the miss ledger, none of them causal;
 *    this takes the long it blocked, core read 23.1, for one real outcome with a
 *    stop. Experiments lose more often than the board does. Wrong if it closes
 *    below 42.10."
 *
 * The hypothesis arrives already built, from numbers only (wildcardLane.ts) — it
 * is quoted here, never composed, so the sentence the choice was made on is the
 * sentence the reader gets. */
export function wildcardThesis(input: { sym: string; side: 'long' | 'short'; stop: number; hypothesis: string }): { thesis: string; falsifier: string } {
  const falsifier = fixedFalsifier(input.side, input.stop)
  return {
    thesis: `${WILDCARD_LABEL} · ${sideWord(input.side)} ${input.sym} — quarter size, testing a gate: ${input.hypothesis} ${WILDCARD_WARNING} ${falsifier}`,
    falsifier,
  }
}

const DOOR_PHRASE = {
  early: 'the first paid break of its 20-session high',
  confirmation: 'an established run that has paused without breaking',
} as const

/** The velocity lane's two sentences.
 *
 *   "Long NVDA — the first paid break of its 20-session high on 3.4x its usual
 *    volume. Wrong on the first close below the trail (98.4 today, and it
 *    ratchets)." */
export function velocityThesis(input: {
  sym: string
  door: 'early' | 'confirmation'
  stop: number
  /** The multiple the door was actually paid at (VelocityRead.paidMult). */
  paidMult?: number | null
}): { thesis: string; falsifier: string } {
  const falsifier = trailFalsifier(input.stop)
  const volume =
    input.paidMult == null ? 'the volume that paid for it'
    : input.door === 'early' ? `${round1(input.paidMult)}x its usual volume`
    : `a ${round1(input.paidMult)}x up-day`
  return { thesis: `Long ${input.sym} — ${DOOR_PHRASE[input.door]} on ${volume}. ${falsifier}`, falsifier }
}
