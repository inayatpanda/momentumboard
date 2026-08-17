// THE PAPER'S FACTS — the deterministic half of the composed edition.
//
// Everything in here exists because a PROMPT IS NOT A CONTRACT. The composer's
// briefs have asked for correct company names, a calendar that matches its own
// table and a short desk that stays on the short side since the day they were
// written, and the four editions of 2026-08-13..16 broke all three anyway:
// "CrowdWave Technologies" for CoreWeave, a Tape that said Monday about an event
// its own table printed on Tuesday, and a Short Desk filled with long-side watch
// names. A model asked nicely drifts; a string check does not.
//
// So each function here is either (a) a FRAGMENT the prompt is told to weave in
// verbatim — a fact it never has to derive — or (b) a POST-PASS that repairs the
// composed prose against the same data the deterministic sections rendered. All
// pure, all host-neutral, all unit-tested against the real defects.

import type { CalendarRow, PaperPostMortem } from './newspaper'

// ---------- W1: NAME LOCK ----------

/** Corporate suffixes and connectors that carry no identity: "CoreWeave" and
 * "CoreWeave Inc" are the same company, and a paper that rewrote every short
 * form into its registry form would read like a filings index. */
const NAME_NOISE = new Set([
  'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'companies', 'ltd', 'limited', 'plc',
  'llc', 'lp', 'llp', 'holdings', 'holding', 'group', 'groupe', 'sa', 'nv', 'ag', 'se', 'ab', 'as', 'asa',
  'oyj', 'spa', 'the', 'and', 'adr', 'class', 'cl', 'ord', 'shares', 'reit', 'trust', 'plc.', 'nspa',
])

/** Case-, punctuation- and suffix-insensitive shape of a company name. */
function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(w => w && !NAME_NOISE.has(w))
    .join(' ')
    .trim()
}

/** Do these two strings name the SAME company? Containment either way, so a
 * short form ("CoreWeave"), a longer registry form ("Barrick Gold Corporation")
 * and a house form ("Barrick Gold Corp") all agree — while "CrowdWave
 * Technologies" and "Aya Gold & Copper" do not agree with anything. */
function sameCompany(a: string, b: string): boolean {
  const x = normName(a)
  const y = normName(b)
  if (!x || !y) return true // nothing to compare — never rewrite on a blank
  return x === y || x.includes(y) || y.includes(x)
}

/** Sentence furniture that can sit capitalised in front of a company name and is
 * never part of one. Only ever TRIMMED off a candidate, never replaced — the
 * point is that the fix rewrites the name and leaves the sentence standing. */
const NAME_LEAD_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'but', 'so', 'now', 'then', 'today', 'yesterday', 'tomorrow', 'meanwhile',
  'however', 'elsewhere', 'here', 'there', 'this', 'that', 'these', 'those', 'it', 'we', 'he', 'she', 'they',
  'buy', 'buying', 'sell', 'selling', 'short', 'shorting', 'long', 'add', 'adds', 'avoid', 'fade', 'fading',
  'watch', 'watching', 'own', 'hold', 'holding', 'enter', 'exit', 'take', 'in', 'on', 'at', 'for', 'with',
  'from', 'into', 'via', 'is', 'was', 'are', 'were', 'if', 'when', 'while', 'because', 'buy/sell',
])

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// One name token: a capitalised word, keeping the punctuation real names carry
// (Gold.com, Moody's, Aya Gold & Silver, Reckitt-Benckiser).
const NAME_TOKEN = "[A-Z][A-Za-z0-9&.'’\\-]*"

/** The candidate name in front of a "(SYM)" or behind a "SYM ·", trimmed of the
 * sentence furniture the regex inevitably swallows at a sentence start. */
function trimCandidate(raw: string): string {
  let tokens = raw.trim().split(/\s+/).filter(Boolean)
  while (tokens.length > 1 && NAME_LEAD_STOPWORDS.has(tokens[0].toLowerCase().replace(/[^a-z0-9/'’-]/g, ''))) tokens = tokens.slice(1)
  return tokens.join(' ')
}

export interface NameFix { sym: string; from: string; to: string }

/** THE NAME LOCK: wherever the prose binds a company-ish name to a ticker we
 * hold a canonical name for, and the bound name is not that company, the
 * canonical name replaces it.
 *
 * Three bindings, because those are the three the paper writes: "Name (SYM)",
 * "SYM · Name" (the board and radar house form) and "SYM (Name)". Nothing else
 * is touched: an unknown ticker, a bare name with no ticker beside it, and every
 * true short/long form of a known name are all left exactly as written. */
export function lockCompanyNames(text: string, names: ReadonlyMap<string, string>): { text: string; fixes: NameFix[] } {
  if (!text || !names.size) return { text, fixes: [] }
  const fixes: NameFix[] = []
  let out = text
  for (const [rawSym, canonical] of names) {
    const sym = rawSym.toUpperCase()
    if (!canonical || !/^[A-Z0-9][A-Z0-9.\-]{0,9}$/.test(sym)) continue
    const S = esc(sym)
    // at most five tokens: long enough for "Aya Gold & Silver Inc", short enough
    // that a rewrite can never swallow a whole clause of the sentence around it
    const NAME = `${NAME_TOKEN}(?:\\s+(?:${NAME_TOKEN}|of|and|the|&|for|de|van|von)){0,4}`
    // "Name (SYM)" replaces the whole span (the name is in front of the anchor);
    // the two ticker-first forms replace the name alone, via lookbehind.
    const boundBefore = new RegExp(`(${NAME})(\\s*\\(${S}\\))`, 'g')
    const boundAfter = [
      new RegExp(`(?<=\\b${S}\\s*[·•\\-–—]\\s*)(${NAME})`, 'g'), // SYM · Name
      new RegExp(`(?<=\\b${S}\\s*\\()(${NAME})(?=\\))`, 'g'), // SYM (Name)
    ]
    out = out.replace(boundBefore, (whole, name: string, tail: string) => {
      const bound = trimCandidate(name)
      if (!bound || sameCompany(bound, canonical)) return whole
      fixes.push({ sym, from: bound, to: canonical })
      const prefix = name.slice(0, name.length - bound.length)
      return `${prefix}${canonical}${tail}`
    })
    for (const re of boundAfter) {
      out = out.replace(re, (name: string) => {
        const bound = trimCandidate(name)
        if (!bound || sameCompany(bound, canonical)) return name
        fixes.push({ sym, from: bound, to: canonical })
        return canonical
      })
    }
  }
  return { text: out, fixes }
}

/** The register handed to every section that can name a company: the SAME names
 * the board, the ideas and the radar are typeset from, so the prose and the
 * tables downstream cannot disagree. Empty in, empty out — an empty register
 * would otherwise print an instruction with nothing to obey. */
export function companyNamesBlock(names: ReadonlyMap<string, string>): string {
  const pairs = [...names].filter(([sym, name]) => sym && name).map(([sym, name]) => `${sym.toUpperCase()} = ${name}`)
  if (!pairs.length) return ''
  return `NAMES — use these exactly, never invent or vary (a ticker's company name is a FACT, not a style choice): ${pairs.join('; ')}. A ticker not in this list gets no company name at all — write the bare ticker rather than a guess.`
}

// ---------- W2: THE CALENDAR IS THE TABLE ----------

/** One event as the Tape is allowed to state it: a finished sentence fragment
 * built from the SAME row the calendar table typesets, carrying the weekday in
 * words so nothing downstream ever has to derive one from a date again. */
export interface TapeEvent {
  title: string
  weekday: string // 'Tuesday' — London, from the row's own timestamp
  time: string // '13:30' UK, exactly as the table prints it
  line: string // the fragment the prompt is told to weave in verbatim
  /** The phrases this event is recognised by in composed prose (title first,
   * then the acronym and the two-word short form a writer actually uses). */
  keys: string[]
}

const LONDON = 'Europe/London'
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** The event fragments the Tape is written from — and the ONLY schedule facts it
 * is given. The Tape used to be handed the raw calendar (epoch timestamps and
 * ISO dates) and asked to preview the next 48 hours from it, so it re-derived
 * every weekday itself; on 2026-08-16 it derived them one day early while the
 * table three inches below printed the right ones. A fragment cannot drift. */
export function tapeEventLines(rows: readonly CalendarRow[], max = 6): TapeEvent[] {
  return rows.slice(0, max).map(e => {
    const d = new Date(e.at * 1000)
    const weekday = d.toLocaleString('en-GB', { weekday: 'long', timeZone: LONDON })
    const time = d.toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: LONDON })
    const nums =
      e.forecast && e.previous
        ? `forecast ${e.forecast} vs ${e.previous} previous`
        : e.forecast
          ? `forecast ${e.forecast}, no previous published`
          : e.previous
            ? `no forecast published, ${e.previous} previous`
            : 'no forecast published'
    const where = [e.country, e.impact ? `${e.impact} impact` : ''].filter(Boolean).join(', ')
    return {
      title: e.title,
      weekday,
      time,
      line: `${weekday} ${time} UK — ${e.title}${where ? ` (${where})` : ''}: ${nums}`,
      keys: eventKeys(e.title),
    }
  })
}

/** How an event is recognised in prose: its full title, any acronym it contains
 * (CPI, FOMC, NFP), and its first two capitalised words — because a writer says
 * "Claimant Count", not "Claimant Count Change m/m". Longest first, so the most
 * specific phrase wins the match. */
function eventKeys(title: string): string[] {
  const keys = new Set<string>()
  if (title.trim().length >= 3) keys.add(title.trim())
  for (const tok of title.match(/\b[A-Z]{3,6}\b/g) ?? []) keys.add(tok)
  const words = title.split(/\s+/).filter(Boolean)
  if (words.length >= 2 && /^[A-Z]/.test(words[0]) && /^[A-Z]/.test(words[1])) {
    const pair = `${words[0]} ${words[1]}`
    if (pair.length >= 6) keys.add(pair)
  }
  return [...keys].sort((a, b) => b.length - a.length)
}

const DAY_WORD = /\b(Mondays?|Mon|Tuesdays?|Tues|Tue|Wednesdays?|Weds|Wed|Thursdays?|Thurs|Thur|Thu|Fridays?|Fri|Saturdays?|Sat|Sundays?|Sun)\b/gi

const dayOf = (word: string): string | null => {
  const key = word.toLowerCase().slice(0, 3)
  return DAY_NAMES.find(d => d.toLowerCase().startsWith(key)) ?? null
}

/** How far from an event's name a weekday word is still talking about it. Wide
 * enough for "Monday brings the UK Claimant Count Change", short enough that a
 * weekday in an unrelated sentence is left alone. */
const WEEKDAY_WINDOW = 60

/** THE DETERMINISTIC CHECK: every weekday word standing next to an event's name
 * in the composed Tape must be that event's weekday in the calendar table. Where
 * it is not, the table wins and the word is corrected in place — abbreviations
 * stay abbreviated, so "Tue" becomes "Wed" and "Tuesday" becomes "Wednesday".
 *
 * The table is the authority for a reason: it is rendered from the same rows
 * these fragments are built from, so the correction can never introduce a
 * disagreement of its own. */
export function correctTapeWeekdays(
  tape: string,
  events: readonly TapeEvent[],
): { text: string; fixes: { from: string; to: string; title: string }[] } {
  if (!tape || !events.length) return { text: tape, fixes: [] }
  // where each event is named in the prose
  const hits: { start: number; end: number; event: TapeEvent }[] = []
  for (const event of events) {
    for (const key of event.keys) {
      const re = new RegExp(esc(key).replace(/\\?\s+/g, '\\s+'), 'gi')
      for (const m of tape.matchAll(re)) hits.push({ start: m.index, end: m.index + m[0].length, event })
    }
  }
  if (!hits.length) return { text: tape, fixes: [] }

  const edits: { start: number; end: number; text: string }[] = []
  const fixes: { from: string; to: string; title: string }[] = []
  for (const m of tape.matchAll(DAY_WORD)) {
    const word = m[0]
    const start = m.index
    const end = start + word.length
    const said = dayOf(word)
    if (!said) continue
    // Every event named within the window, split by which side of the word it
    // sits on. A weekday INTRODUCES the event that follows it ("Wednesday 13:30
    // brings CPI"), so a following event is always the better claim on it; a
    // preceding one only speaks when nothing follows ("CPI lands Tue").
    const near = hits
      .map(h => ({ event: h.event, ahead: h.start >= end, gap: h.start >= end ? h.start - end : start >= h.end ? start - h.end : 0 }))
      .filter(h => h.gap <= WEEKDAY_WINDOW)
      .sort((a, b) => a.gap - b.gap)
    const side = near.some(h => h.ahead) ? near.filter(h => h.ahead) : near
    // …and if ANY event on that side is on the day the writer said, the writer
    // was right about one of them: correcting would be the drift, not the fix.
    if (!side.length || side.some(h => h.event.weekday === said)) continue
    const nearest = { event: side[0].event }
    const truth = nearest.event.weekday
    const abbreviated = word.length <= 5 && !DAY_NAMES.some(d => d.toLowerCase() === word.toLowerCase().replace(/s$/, ''))
    let next = abbreviated ? truth.slice(0, 3) : truth
    if (!abbreviated && /s$/.test(word) && !/day$/i.test(word)) next = `${next}s`
    if (word[0] === word[0].toLowerCase()) next = next.toLowerCase()
    edits.push({ start, end, text: next })
    fixes.push({ from: word, to: next, title: nearest.event.title })
  }
  let text = tape
  for (const e of [...edits].sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end)
  return { text, fixes }
}

// ---------- W4: THE SHORT DESK'S OWN, SMALLER WORLD ----------

/** Everything the scope needs of a board row. Structural, so the compose pipe's
 * slimmed journalist rows satisfy it without a cast. */
export interface ShortScopeRow {
  sym: string
  side: 'long' | 'short'
  nearMiss?: boolean
}

/** THE SHORT DESK'S ENTIRE INPUT: the short side of the board, split into the
 * rows that cleared something and the rows that cleared nothing.
 *
 * The section used to be written from the whole prompt document — the full board,
 * the sector tables, the social pulse, the channel consensus — and it read like
 * it: long-side watch names, rotation copy, and one edition citing a small-cap
 * discovery the Small-Cap Wire two sections below said had never been made. A
 * section that cannot see those things cannot write them. */
export function shortDeskScope<T extends ShortScopeRow>(board: readonly T[]): { shorts: T[]; nearMisses: T[] } {
  const short = board.filter(r => r.side === 'short')
  return { shorts: short.filter(r => !r.nearMiss), nearMisses: short.filter(r => !!r.nearMiss) }
}

/** Is there anything on this desk at all? A near miss counts: "nothing cleared
 * the gates; the closest was X" is a line the reader is owed. */
export function shortsLive(scope: { shorts: unknown[]; nearMisses: unknown[] }): boolean {
  return scope.shorts.length > 0 || scope.nearMisses.length > 0
}

/** The scoped document handed to the short-desk prompt in place of the paper's
 * full data JSON. Deliberately two keys and no more. */
export function shortDeskData(scope: { shorts: unknown[]; nearMisses: unknown[] }): string {
  return JSON.stringify({ shortBoard: scope.shorts, shortNearMisses: scope.nearMisses }, null, 1)
}

// ---------- W3: THE HONEST CLOSE ANSWERS FOR A REAL LOSS ----------

/** The day's experiment, as the compose pipe already assembles it. */
export interface WildcardFacts {
  label: string
  sym: string
  gate: string
  hypothesis: string
  warning: string
}

/** WHAT THE CLOSE IS ALLOWED TO SAY ABOUT LOSING.
 *
 * The engine writes a post-mortem for every graded loser the moment the grade
 * lands (postMortem.ts + postMortemLlm.ts) — "Gapped through the stop on an
 * unscheduled guidance cut — nothing in the setup priced that." The composer had
 * that list buried in a 28KB data document and closed four editions running with
 * "the trade lost because it was stopped out": the outcome, restated as its own
 * cause. This block puts ONE loss and ONE sentence in front of the writer, names
 * the circular sentence as forbidden, and — when there is nothing to answer for —
 * says that instead of leaving a gap an older loss will be dragged into.
 *
 * `losses` arrives newest-explanation-first (paperPostMortems sorts by when the
 * post-mortem landed), so the head of the list IS the most recent loss. */
export function honestCloseFacts(losses: readonly PaperPostMortem[], wildcard?: WildcardFacts | null): string {
  const parts: string[] = []
  const loss = losses[0]
  if (!loss) {
    parts.push(
      'ACCOUNTABILITY: no sized call has been graded a loss in the paper\'s recent publication days. If the close touches the subject, say exactly that — do not reach back for an older loss, and never invent one to sound accountable.',
    )
  } else {
    const cost = typeof loss.excessPct === 'number' ? `, ${loss.excessPct > 0 ? '+' : ''}${loss.excessPct}pp` : ''
    parts.push(
      `ACCOUNTABILITY — the close's loss sentence is written from THIS row and nothing else you might remember:\n` +
        `MOST RECENT SIZED LOSS: ${loss.sym} ${loss.side}, published ${loss.date}${cost}.\n` +
        `THE ENGINE'S OWN POST-MORTEM, VERBATIM: "${loss.why}"\n` +
        `Name THAT loss — it is the newest one, and an older call the reader has already been answered for is not accountability. Quote the sentence above (you may shorten it; never reword its cause, and never print the class name). NEVER explain a loss with the fact that it lost: "it was stopped out", "the trade hit its invalidation" and "it lost money because it went against us" say nothing the reader cannot see, and one of them ran four editions in a row.`,
    )
  }
  if (wildcard?.hypothesis) {
    parts.push(
      `TODAY'S EXPERIMENT: ${wildcard.label} on ${wildcard.sym}, testing the ${wildcard.gate} gate. HYPOTHESIS, VERBATIM: "${wildcard.hypothesis}" WARNING, VERBATIM: "${wildcard.warning}" It is not a call, not a conviction idea and not the engine's best thought — it is a trade the engine's own gates refused, taken at quarter size to find out what happens.`,
    )
  }
  return parts.join('\n\n')
}
