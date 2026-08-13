import type { PostMortem } from '../../../shared/engine/postMortem'
import type { PredOutcome } from '../../../shared/engine/types'
import { extractJson } from './newspaper'

// THE PAPER SAYS WHY IT LOST — one budgeted sentence over a deterministic floor.
//
// postMortem.ts already classifies every graded loser from the tape alone, and
// that class is the FLOOR: it costs nothing, it never fails, and it is what the
// ledger and the roll-up are built on. What it cannot do is talk. "stopped —
// closed through the 92.5 stop on 2026-08-07 (session 3)" is exactly right and
// exactly unreadable to the person who took the trade, and the paper's whole
// premise is that the engine explains itself in the reader's language.
//
// So this module buys ONE plain sentence for the losers the reader actually had
// money on, and buys very few of them:
//
//  - POSTMORTEM_LLM_BUDGET calls a run, following DIP_NEWS_BUDGET's precedent
//    (dipNews.ts:42) because it is the only budget mechanism this repo has: there
//    is no per-day LLM counter anywhere (recon §4.4), Groq's daily token cap is
//    real, and the grading pass can mature a dozen rows at once after a quiet
//    week. Three sentences is a paper's worth; thirteen is a quota incident.
//  - SIZED, READER-FACING losers only. A shadow or a watch row loses instructively
//    and the deterministic line already says how; nobody was in it.
//  - NEWEST FIRST, worst-first inside the day — if the budget only stretches to
//    three, they should be the three the reader remembers.
//
// THE MODEL MAY ADD, AND MAY UPGRADE EXACTLY ONE THING. The sentence is stored
// beside the deterministic detail, never over it. The single exception is
// `news-reversal`: the spec's fourth class needs a judgement the pure classifier
// has no business making (postMortem.ts says so at length), so an AFFIRMED
// catalyst-tone flip — and only a literal affirmation, never a hedge — moves the
// class, and even then the deterministic class survives verbatim inside the
// detail. Everything else the model says is prose.
//
// FAIL-SOFT IS THE DEFAULT STATE, not the error path: no provider configured, a
// 429, a malformed answer, a run past the budget — every one of them leaves the
// deterministic class and detail exactly as classifyLoser wrote them. The only
// visible difference is a `via` marker saying which kind of nothing happened,
// because "no sentence" must never read as "the engine had nothing to say".

/** Sentences bought per grading run (DIP_NEWS_BUDGET's precedent, recon §4.4).
 * A run grades what matured that day, so this is a per-day budget in practice. */
export const POSTMORTEM_LLM_BUDGET = 3
/** The answer is one sentence and one boolean. dipNews asks for 200 and gets it;
 * the router's default is 700 (llm.ts) and this stays well inside it. */
export const POSTMORTEM_LLM_MAX_TOKENS = 200
/** A "plain sentence" that runs past this is not one. Clipped, never dropped. */
export const POSTMORTEM_SENTENCE_MAX_CHARS = 240

/** Everything the prompt may state, and nothing else — the numbers all come off
 * the row and its outcome, so the model is never in a position to need a fact it
 * has not been given. `postMortem` is the row's stored object and is MUTATED in
 * place: the sentence rides the same blob write the class already rides. */
export interface PostMortemAsk {
  sym: string
  side: 'long' | 'short'
  date: string
  setup?: string | null
  entry: number
  stop: number
  target?: number
  thesis?: string
  falsifier?: string
  catalyst?: { kind: string; reason: string } | null
  outcome: PredOutcome
  postMortem: PostMortem
}

const signed = (x: number) => (x > 0 ? `+${x}` : `${x}`)
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s)

export function postMortemPrompt(a: PostMortemAsk): string {
  const o = a.outcome
  return `A swing-trade call lost money. Explain it to the retail reader who took it, in ONE plain sentence.

CALL: ${a.sym} ${a.side} opened ${a.date} at ${a.entry}, stop ${a.stop}${a.target == null ? '' : `, target ${a.target}`}${a.setup ? ` (${a.setup} setup)` : ''}.
THESIS: ${a.thesis || 'not recorded'}
FALSIFIER: ${a.falsifier || 'not recorded'}
CATALYST: ${a.catalyst ? `${a.catalyst.kind} — ${a.catalyst.reason}` : 'none'}
TEN SESSIONS ON: ${signed(o.rawPct)}% against SPY ${signed(o.spyPct)}%, excess ${signed(o.excessPct)}pp; the stop ${o.stopped ? 'was hit' : 'held'}.
OUR OWN READ: ${a.postMortem.cls} — ${a.postMortem.detail}

Write the sentence from ONLY the facts above: no price, level or event that is not printed here, no advice, no hedging, under ${POSTMORTEM_SENTENCE_MAX_CHARS} characters.
Then answer one narrow question: do the facts above show the CATALYST'S TONE FLIPPED — that the news or event which justified this call turned against it? You have no live news access and must not guess, so answer true ONLY when the flip is stated above; a suspicion, a plain drawdown or a stop being hit is false.
Return ONLY JSON: {"sentence":"...","catalystFlip":true|false} — no prose, no markdown.`
}

/** Tolerant of fences and surrounding prose (extractJson, newspaper.ts), strict
 * about the two things that matter: a non-empty sentence, and an affirmation
 * that is literally an affirmation. Null = nothing usable came back, which is
 * the same outcome as no answer at all. */
export function parsePostMortemReply(raw: string): { sentence: string; flip: boolean } | null {
  const obj = extractJson<Record<string, unknown>>(raw ?? '')
  if (!obj || typeof obj !== 'object') return null
  // The same strip voice.ts applies to every non-engine-authored string: this
  // sentence is stored, then travels into all six section prompts AND the
  // reader's paper — markup and prompt-steering characters are removed. The
  // leak check is the IDENTIFIER sweep only, not the whole-word factor list:
  // a thesis must never say "news" (a field name there), but a post-mortem's
  // prose legitimately speaks that English — what it must never carry is a
  // `someFieldName`-shaped token. A leaky reply is DROPPED and the
  // deterministic line stands, the module's own fail-soft.
  const sentence =
    typeof obj.sentence === 'string' ? obj.sentence.replace(/[<>`"{}\[\]]/g, ' ').replace(/\s+/g, ' ').trim() : ''
  if (!sentence || /\b[a-z]+[A-Z][A-Za-z0-9]*\b/.test(sentence)) return null
  const f = obj.catalystFlip
  // `true` or the string "true" and nothing else. "maybe", "possibly true",
  // 1 and TRUE-ish are all hedges, and a hedge must never mint the one class
  // the deterministic floor cannot reach.
  const flip = f === true || (typeof f === 'string' && f.trim().toLowerCase() === 'true')
  return { sentence: clip(sentence, POSTMORTEM_SENTENCE_MAX_CHARS), flip }
}

/** Writes the sentence onto the stored post-mortem, and applies the ONE upgrade.
 *
 * The upgrade overwrites `cls` — including over `stopped`, which the
 * deterministic order puts first — because "the catalyst reversed" is the reason
 * the stop was hit, not a competing account of it. Nothing is lost: the original
 * class and its numbers move into `detail` verbatim, so the roll-up can be
 * re-derived and the reader can see both readings side by side. */
export function applyPostMortemSentence(pm: PostMortem, parsed: { sentence: string; flip: boolean }): void {
  pm.sentence = parsed.sentence
  pm.via = 'llm'
  if (!parsed.flip || pm.cls === 'news-reversal') return
  // clsBefore keeps the upgrade machine-recoverable: byPostMortem keys on cls
  // alone, and 3c must not have to regex prose to find the stopped population.
  pm.clsBefore = pm.cls
  pm.detail = `catalyst tone flipped · the deterministic read was ${pm.cls}: ${pm.detail}`
  pm.cls = 'news-reversal'
}

/** NEWEST FIRST, worst loss first inside a day, then the symbol so two runs over
 * the same rows spend the budget identically. Returns a COPY — the caller's
 * array is its own ordering of the day's rows and this must not disturb it. */
export function sentenceOrder(rows: readonly PostMortemAsk[]): PostMortemAsk[] {
  return [...rows].sort(
    (a, b) => b.date.localeCompare(a.date) || a.outcome.excessPct - b.outcome.excessPct || a.sym.localeCompare(b.sym),
  )
}

/** Buys up to `budget` sentences and marks everything it could not buy.
 *
 * NEVER THROWS and never retries: `llm` here is `callLlm`, which has already
 * tried every configured provider before it throws (llm.ts collects them all),
 * so a throw means the whole chain is down and the rest of the run is stood
 * down rather than spending a second failing round-trip on each remaining row.
 * A MALFORMED answer is different — the provider is alive and answering, so the
 * next row still gets its ask; that row simply spent its slot for nothing, and
 * the marker says so.
 *
 * The three markers, all of which mean "no sentence" and none of which mean the
 * same thing: `budget` = past the day's cap, never asked (and never asked
 * later either — a post-mortem is stamped once); `failed` = asked, nothing
 * usable came back; absent = never reached, because the provider chain had
 * already fallen over. */
export async function annotatePostMortems(
  rows: readonly PostMortemAsk[],
  llm: (prompt: string) => Promise<string>,
  budget = POSTMORTEM_LLM_BUDGET,
): Promise<{ asked: number; written: number; upgraded: number; overflow: number }> {
  let asked = 0
  let written = 0
  let upgraded = 0
  let overflow = 0
  let chainDown = false
  for (const [i, row] of sentenceOrder(rows).entries()) {
    // chain-down wins over budget: a row behind a dead provider chain was never
    // askable, and stamping it 'budget' would tell two stories for one cause
    // (Task-3 review, Minor 3). Unmarked = never reached, exactly as documented.
    if (chainDown) continue
    if (i >= budget) {
      row.postMortem.via = 'budget'
      overflow++
      continue
    }
    asked++
    let raw: string | null = null
    try {
      raw = await llm(postMortemPrompt(row))
    } catch {
      chainDown = true
    }
    const parsed = raw == null ? null : parsePostMortemReply(raw)
    if (!parsed) {
      row.postMortem.via = 'failed'
      continue
    }
    const before = row.postMortem.cls
    applyPostMortemSentence(row.postMortem, parsed)
    written++
    if (row.postMortem.cls !== before) upgraded++
  }
  return { asked, written, upgraded, overflow }
}
