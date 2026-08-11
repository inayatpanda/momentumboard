import { callLlm, type LlmEnv } from './llm'

// Dip-news corroboration. The dip lane (shared/engine/dipLane.ts) reads a price
// signature: a quality name hit hard but being BOUGHT. That read is blind to
// WHY the name fell — and the difference between "the market overreacted" and
// "the thesis broke" is the whole trade. A −14% sympathy move in a chip selloff
// is the dip lane's bread and butter; a −14% move because the SEC opened a fraud
// probe is a name that keeps falling, and buying it is how a modest edge turns
// into a hole.
//
// So the lane asks one narrow question per dip: given ONLY this name's recent
// headlines, does the drop read transient or structural? Structural stands the
// trade down (it still publishes as a shadow, so the ledger learns whether the
// veto was right). Anything else trades, honestly labelled.
//
// Deliberately tiny: at most DIP_NEWS_BUDGET fresh reads per run, deepest dip
// first, and verdicts cached for three days. Fail-soft at every step — no
// Finnhub key, no LLM provider, a malformed answer or a dead endpoint all land
// on 'unclear', which trades. The lane never blocks a call on a lookup it
// couldn't make; it only stands aside on evidence it actually has.

export interface DipNewsVerdict {
  /** transient = overreaction (tradeable) · structural = broken thesis (stand down) · unclear = no read */
  verdict: 'transient' | 'structural' | 'unclear'
  /** why, in a handful of words — printed on the card beside the price read */
  reason: string
  /** WHO decided: the model, or the keyword floor below it. Set at both production
   * sites in this file; absent on the verdicts the engine synthesises for itself
   * ('budget', 'lookup failed'), which are never cached. Provenance is not
   * decoration — a keyword hit on one headline is a far thinner read than a model
   * that saw twelve, and it is frozen for a shorter time because of it. */
  via?: 'llm' | 'heuristic'
}

/** Fresh news reads per run. The engine spends them on the DEEPEST dips first. */
export const DIP_NEWS_BUDGET = 5
/** A decisive LLM verdict holds for three days: a fraud probe is not yesterday's news. */
export const DIP_NEWS_TTL_SEC = 3 * 86_400
/** A KEYWORD verdict thaws daily. It is one regex on one headline — right often
 * enough to be the floor, wrong often enough that freezing it for three days
 * would keep a name stood down on a phrase the model would have read past. */
export const DIP_NEWS_HEURISTIC_TTL_SEC = 86_400
/** How far back the headline window reaches. A dip's cause is days old, not weeks. */
export const DIP_NEWS_WINDOW_DAYS = 7
/** Headlines are cheap but a prompt is not: cap what the LLM is asked to read. */
const MAX_HEADLINES = 12
const MAX_REASON_CHARS = 140

const VERDICTS = new Set(['transient', 'structural', 'unclear'])

// --- the keyword floor -------------------------------------------------------
// Not a cleverness contest: these are the phrases that, in a headline about a
// name that just fell hard, mean the drop is NOT an overreaction. Structural is
// checked first and wins outright — buying into a fraud probe because an analyst
// also downgraded the stock is exactly the mistake this module exists to prevent.

const STRUCTURAL: [RegExp, string][] = [
  [/\bfraud|\bfraudulent\b/i, 'fraud'],
  [/\binvestigat(?:ion|ing|es|ed)\b|\bprobe[sd]?\b|\bsubpoena|\bindict(?:ed|ment)?\b/i, 'investigation'],
  [/\bclass[- ]action\b|\blawsuit alleging\b/i, 'class-action suit'],
  [/\baccounting (?:scandal|irregular|error|issue)|\brestat(?:es|ed|ing|ement)\b/i, 'accounting restatement'],
  [/\bbankrupt(?:cy)?\b|\bchapter 11\b|\binsolven(?:cy|t)\b|\bdefaults? on\b/i, 'bankruptcy'],
  [/\bgoing concern\b|\bcovenant breach\b|\bemergency (?:financing|fundraising)\b/i, 'going concern'],
  [/\bdelist(?:ing|ed)?\b|\btrading (?:suspended|halted) (?:indefinitely|pending)\b/i, 'delisting'],
  [
    /\b(?:cuts?|slash(?:es|ed)?|withdraw[sn]?|scraps?|pulls?|lowers)\b[^.|]{0,30}\b(?:guidance|outlook|forecast)\b|\bguidance (?:cut|withdrawn|pulled|slashed)\b/i,
    'guidance cut',
  ],
  [/\bprofit warning\b|\bwarns on profits?\b/i, 'profit warning'],
  [/\b(?:ceo|cfo|chief executive|finance chief) (?:resigns|steps down|ousted|fired|departs)\b/i, 'executive departure'],
  [/\blicen[cs]e revoked\b|\bapproval (?:rejected|denied)\b|\btrial fail(?:s|ed|ure)\b|\bloses (?:its )?(?:patent|monopoly)\b/i, 'franchise loss'],
]

const TRANSIENT: [RegExp, string][] = [
  [/\bmiss(?:es|ed)?\b[^.|]{0,25}\b(?:estimates?|expectations?|forecasts?|consensus)\b/i, 'a missed quarter'],
  [/\bdowngrade[sd]?\b|\bprice target (?:cut|lowered|trimmed)\b|\banalysts? (?:cut|lower|trim)\b/i, 'an analyst downgrade'],
  [/\bsympathy\b|\bin line with peers\b|\bpeers? (?:slide|fall|drop|slump|sink)\b/i, 'a sympathy move'],
  [/\bsector[- ](?:wide|selloff|sell-off|rout|slump)\b|\b(?:chip|tech|energy|bank|retail) (?:selloff|sell-off|rout)\b/i, 'a sector selloff'],
  [/\bbroad(?:er|-based)? (?:market )?(?:selloff|sell-off|rout|decline)\b|\bmarket[- ]wide\b|\brisk[- ]off\b/i, 'a broad selloff'],
  [/\bprofit[- ]taking\b|\boverbought\b|\bpullback after\b|\bcools after (?:a )?rally\b/i, 'profit-taking'],
  [/\brotation out of\b|\bvaluation concerns?\b/i, 'a rotation'],
]

// Table order is priority order, so the FIRST rule with any hit wins — and the
// hit is returned with the headline that produced it. Matching per headline
// rather than against one joined blob also means a rule can never span two
// unrelated stories.
const firstMatch = (table: [RegExp, string][], headlines: string[]): { rule: string; headline: string } | null => {
  for (const [re, rule] of table) {
    const headline = headlines.find(h => re.test(h))
    if (headline) return { rule, headline }
  }
  return null
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s)

/** The fallback that always has an answer. No LLM, no network, no throw.
 * The reason quotes the HEADLINE that tripped the rule, not just the rule word:
 * "structural — guidance cut" is unarguable and unauditable, while "guidance
 * cut: 'ACME pulls full-year outlook'" lets the reader see the evidence and
 * disagree with it. */
export function heuristicDipVerdict(headlines: string[]): DipNewsVerdict {
  const heads = headlines.filter(h => h && h.trim())
  if (!heads.length) return { verdict: 'unclear', reason: 'no recent headlines', via: 'heuristic' }
  const cited = (hit: { rule: string; headline: string }) => clip(`${hit.rule}: "${hit.headline.trim()}"`, MAX_REASON_CHARS)
  const structural = firstMatch(STRUCTURAL, heads)
  if (structural) return { verdict: 'structural', reason: cited(structural), via: 'heuristic' }
  const transient = firstMatch(TRANSIENT, heads)
  if (transient) return { verdict: 'transient', reason: cited(transient), via: 'heuristic' }
  return { verdict: 'unclear', reason: 'headlines name no clear cause', via: 'heuristic' }
}

/** Non-null when the news source cannot serve this symbol AT ALL: Finnhub's
 * company-news endpoint is US-listed only, so any dotted ticker (RR.L, BT-A.L,
 * 3LAL.L…) is a guaranteed-empty read, not an inconclusive one. Returns the
 * venue to name in the reason. exchangeFor() reads a DASH first and would call
 * BT-A.L crypto, so the suffix is read directly here. */
export function unservedVenue(sym: string): string | null {
  const dot = sym.lastIndexOf('.')
  if (dot === -1) return null
  const suffix = sym.slice(dot + 1).toUpperCase()
  return ({ L: 'LSE' } as Record<string, string>)[suffix] ?? `.${suffix}`
}

/** Tolerantly pull {verdict, reason} out of whatever the router handed back —
 * an object, a bare JSON string, or JSON fenced in ```json inside prose. Null
 * when there is no usable verdict in there, which sends the caller to the
 * heuristic. Never throws. */
function parseVerdict(raw: unknown): DipNewsVerdict | null {
  try {
    let obj: unknown = raw
    if (typeof raw === 'string') {
      const unfenced = raw.replace(/```(?:json)?/gi, '')
      const start = unfenced.indexOf('{')
      if (start === -1) return null
      let depth = 0
      let end = -1
      for (let i = start; i < unfenced.length; i++) {
        if (unfenced[i] === '{') depth++
        else if (unfenced[i] === '}' && --depth === 0) {
          end = i
          break
        }
      }
      if (end === -1) return null
      obj = JSON.parse(unfenced.slice(start, end + 1))
    }
    if (!obj || typeof obj !== 'object') return null
    const rec = obj as Record<string, unknown>
    const verdict = typeof rec.verdict === 'string' ? rec.verdict.trim().toLowerCase() : ''
    if (!VERDICTS.has(verdict)) return null
    const reason = (rec.reason == null ? '' : String(rec.reason)).trim().replace(/\s+/g, ' ').slice(0, MAX_REASON_CHARS)
    return { verdict: verdict as DipNewsVerdict['verdict'], reason: reason || 'no reason given', via: 'llm' }
  } catch {
    return null
  }
}

export function dipNewsPrompt(sym: string, headlines: string[]): string {
  return `${sym} dropped hard recently. Given ONLY these headlines, classify the cause:
${headlines.map(h => `- ${h}`).join('\n')}

- transient: overreaction, sector sympathy move, a priced-in miss, an analyst downgrade — the thesis is intact.
- structural: fraud, an investigation, a guidance collapse, financing or going-concern trouble, a permanent loss of business.
- unclear: the headlines do not say.
Return ONLY JSON: {"verdict":"transient|structural|unclear","reason":"under 20 words"} — no prose, no markdown.`
}

/** Ask the LLM, and mean it: a well-formed verdict is taken at its word. A
 * malformed answer or a thrown call falls through to the keyword table, so this
 * function always returns a verdict. No headlines → no LLM call at all. */
export async function classifyDipNews(
  sym: string,
  headlines: string[],
  llmJson: (prompt: string) => Promise<unknown>,
): Promise<DipNewsVerdict> {
  const heads = headlines.filter(h => h && h.trim()).slice(0, MAX_HEADLINES)
  if (!heads.length) return heuristicDipVerdict([])
  try {
    return parseVerdict(await llmJson(dipNewsPrompt(sym, heads))) ?? heuristicDipVerdict(heads)
  } catch {
    return heuristicDipVerdict(heads)
  }
}

/** Finnhub company-news headlines for one symbol over a date window. Fail-soft
 * to [] on every path — no key, a dead endpoint, a 429, a shape we didn't
 * expect. De-duplicated, because the wire repeats the same story across
 * syndicators and twelve copies of one headline is not twelve pieces of news. */
export async function fetchCompanyNews(
  sym: string,
  fromISO: string,
  toISO: string,
  key: string,
  fetchFn: typeof fetch = fetch,
): Promise<string[]> {
  if (!key) return []
  try {
    const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(sym)}&from=${fromISO}&to=${toISO}&token=${key}`
    const res = await fetchFn(url)
    if (res.ok === false) return []
    const j = (await res.json()) as unknown
    if (!Array.isArray(j)) return []
    const seen = new Set<string>()
    const out: string[] = []
    for (const item of j as { headline?: unknown }[]) {
      const h = typeof item?.headline === 'string' ? item.headline.trim() : ''
      if (!h || seen.has(h)) continue
      seen.add(h)
      out.push(h)
      if (out.length >= MAX_HEADLINES) break
    }
    return out
  } catch {
    return []
  }
}

/** The whole uncached read: headlines → verdict. The engine's default dep wraps
 * this in the three-day `dip-news:{sym}` blob cache; nothing here touches a
 * cache, so tests and scripts can call it directly. */
export async function readDipNews(
  sym: string,
  finnhubKey: string,
  nowSec: number = Math.floor(Date.now() / 1000),
  fetchFn: typeof fetch = fetch,
  env: Partial<LlmEnv> = {},
): Promise<DipNewsVerdict> {
  const iso = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10)
  const headlines = await fetchCompanyNews(sym, iso(nowSec - DIP_NEWS_WINDOW_DAYS * 86_400), iso(nowSec), finnhubKey, fetchFn)
  // maxTokens is deliberately small: the answer is two fields. callLlm throws
  // 'no-llm-provider-configured' when the deployment has no key at all, which
  // classifyDipNews turns into the heuristic read — the lane still works.
  return classifyDipNews(sym, headlines, async prompt => (await callLlm(prompt, { ...env, maxTokens: 200 }, fetchFn)).text)
}
