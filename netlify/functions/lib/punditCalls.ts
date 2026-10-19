// Pundit call bridge: reported social views for the display feed. Third-party
// coverage and manual forwards carry explicit provenance and do not contribute
// automated consensus or teach the source-verified outcome study.

import type { ExtractLike } from '../../../shared/engine/channelCred'
import { parseFeed } from './rss'

export type Stance = 'bull' | 'bear' | 'neutral'
export interface TickerCall {
  sym: string
  stance: Stance
}

// What we append is a superset of ExtractLike that ALSO satisfies
// videoTrends.VideoExtract (title/themes, tickers[].levels), because the same
// `video-extracts` blob is read both by the engine (ExtractLike) and by
// computeConsensus — which iterates `e.themes`. A record missing `themes` would
// crash that reader, so every record carries the full VideoExtract shape.
export interface PunditExtract extends ExtractLike {
  provenance?: 'first-party' | 'third-party' | 'manual'
  title: string
  themes: string[]
  tickers: { sym: string; stance: Stance; levels: number[] }[]
}

// Telegram /call alias → exact channel name (verified against shared/channels.ts).
export const ALIASES: Record<string, string> = {
  obi: 'Grandmaster Obi',
  gareth: 'Gareth Soloway',
  josh: 'Stocks with Josh',
}

const BULL = new Set(['bull', 'bullish', 'long', 'longs', 'buy', 'buys', 'buying', 'call', 'calls', 'moon', 'moons', 'mooning'])
const BEAR = new Set(['bear', 'bearish', 'short', 'shorts', 'shorting', 'sell', 'sells', 'selling', 'put', 'puts'])

const stanceOfWord = (w: string): Stance | null => {
  const lc = w.toLowerCase()
  return BULL.has(lc) ? 'bull' : BEAR.has(lc) ? 'bear' : null
}

// Bull-precedence stance over a blob of prose (spec: default bull if it contains
// buy/long/calls/moon; bear if short/sell/puts; else neutral).
const stanceFromText = (text: string): Stance | null => {
  let bull = false
  let bear = false
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (BULL.has(w)) bull = true
    else if (BEAR.has(w)) bear = true
  }
  return bull ? 'bull' : bear ? 'bear' : null
}

const EXPLICIT_TICKER = /^\$?[A-Z][A-Z.\-]{0,5}$/ // structured command token (upper only)
const TICKER_OK = /^[A-Z][A-Z.\-]{0,5}$/ // canonical shape after uppercasing

const dedupeTickers = (tickers: TickerCall[]): TickerCall[] => {
  const seen = new Set<string>()
  const out: TickerCall[] = []
  for (const t of tickers) {
    if (seen.has(t.sym)) continue
    seen.add(t.sym)
    out.push(t)
  }
  return out
}

/** Free-form: extract $TAGGED tickers only, stance from words NEAR each tag,
 * falling back to the whole-message stance (bull precedence), else neutral. */
export function parseFreeForm(body: string): TickerCall[] {
  const global = stanceFromText(body) ?? 'neutral'
  const out: TickerCall[] = []
  const re = /\$([A-Za-z][A-Za-z.\-]{0,5})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const sym = m[1].toUpperCase()
    if (!TICKER_OK.test(sym)) continue
    const near = stanceFromText(body.slice(Math.max(0, m.index - 30), Math.min(body.length, re.lastIndex + 30)))
    out.push({ sym, stance: near ?? global })
  }
  return dedupeTickers(out)
}

/** Parses BOTH `/call obi $TSLA long PLTR short` (explicit ticker+stance list,
 * $-prefix optional, bare tickers must be UPPERCASE) and `/call obi <forwarded
 * prose>` (free-form, $-tagged tickers only). Pass the RAW message text so
 * uppercase tickers survive — never a lowercased copy. */
export function parseCallText(raw: string): { name: string | null; tickers: TickerCall[] } {
  const m = raw.trim().match(/^\/call\s+(\S+)\s*([\s\S]*)$/i)
  if (!m) return { name: null, tickers: [] }
  const name = ALIASES[m[1].toLowerCase()] ?? null
  const body = m[2] ?? ''
  const tokens = body.split(/\s+/).filter(Boolean)

  // Explicit iff every token is a ticker candidate or a stance word (no prose).
  const isExplicit =
    tokens.length > 0 &&
    tokens.some(t => EXPLICIT_TICKER.test(t) && stanceOfWord(t) === null) &&
    tokens.every(t => EXPLICIT_TICKER.test(t) || stanceOfWord(t) !== null)

  if (isExplicit) {
    const out: TickerCall[] = []
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i]
      // a token that is also a stance word (e.g. "CALLS") counts as stance, not ticker
      if (stanceOfWord(tok) !== null || !EXPLICIT_TICKER.test(tok)) continue
      const sym = tok.replace(/^\$/, '').toUpperCase()
      if (!TICKER_OK.test(sym)) continue
      const next = tokens[i + 1]
      out.push({ sym, stance: (next && stanceOfWord(next)) || 'neutral' })
    }
    return { name, tickers: dedupeTickers(out) }
  }
  return { name, tickers: parseFreeForm(body) }
}

/** Wrap a parsed call in the graded-record shape. `url` defaults to a synthetic
 * bridge key; pass the real permalink / feed link when polling (it is also the
 * dedupe key). */
export function toExtract(
  name: string,
  tickers: TickerCall[],
  at: number,
  source: 'telegram-bridge' | 'reddit' | 'feed',
  url?: string,
): PunditExtract {
  return {
    url: url ?? `bridge:${source === 'telegram-bridge' ? 'telegram' : source}:${at}`,
    channel: name,
    at,
    title: `${source} call`,
    provenance: source === 'feed' ? 'third-party' : source === 'telegram-bridge' ? 'manual' : 'first-party',
    themes: [],
    tickers: tickers.map(t => ({ sym: t.sym, stance: t.stance, levels: [] })),
  }
}

// ── Auto-pollers ───────────────────────────────────────────────────────────

// Reddit accounts to auto-poll. Left EMPTY by default: a username must be
// CONFIDENTLY verified before it is trusted to write graded stance records.
// Candidate (NOT enabled — unverified): u/Major_Access2321 is *speculated* by
// SEO/newsletter sites to be Grandmaster Obi's Reddit alias, but the link is
// circumstantial (alert timing/style correlation, "according to Redditors"),
// never confirmed by Obi. Add { user: 'Major_Access2321', name: 'Grandmaster
// Obi' } here once verified.
export const DEFAULT_PUNDIT_REDDITS: { user: string; name: string }[] = []

// Dedicated pundit tag feeds — WordPress RSS whose item titles name the tickers.
export const DEFAULT_PUNDIT_FEEDS: { url: string; name: string }[] = [
  { url: 'https://stockmarketloop.com/tag/grandmaster-obi/feed/', name: 'Grandmaster Obi' },
]

interface RedditChild {
  data?: { title?: string; selftext?: string; created_utc?: number; permalink?: string; id?: string }
}

/** Poll each Reddit user's recent submissions; emit a record per post (newer
 * than sinceSec) that carries ≥1 $tagged ticker. Fail-soft per user. */
export async function fetchRedditPunditPosts(
  users: { user: string; name: string }[],
  sinceSec: number,
  fetchFn: typeof fetch = fetch,
): Promise<PunditExtract[]> {
  const out: PunditExtract[] = []
  for (const { user, name } of users) {
    try {
      const res = await fetchFn(`https://www.reddit.com/user/${encodeURIComponent(user)}/submitted.json?limit=10`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (MomentumBoard)' },
      })
      if (!res.ok) continue
      const j = (await res.json()) as { data?: { children?: RedditChild[] } }
      for (const child of j.data?.children ?? []) {
        const p = child.data
        if (!p) continue
        const at = Math.floor(p.created_utc ?? 0)
        if (at < sinceSec) continue
        const tickers = parseFreeForm(`${p.title ?? ''} ${p.selftext ?? ''}`)
        if (!tickers.length) continue
        const url = p.permalink ? `https://www.reddit.com${p.permalink}` : `reddit:${user}:${p.id ?? at}`
        out.push({ ...toExtract(name, tickers, at, 'reddit', url), title: p.title ?? '' })
      }
    } catch {
      // fail-soft: bad JSON / network → skip this user, keep the rest
    }
  }
  return out
}

// Conservative stopword set for BARE uppercase tokens in RSS titles: common
// caps words that are not tickers. NOTE: GMM is a real ticker (kept OUT); OBI is
// the pundit's name, not a ticker (kept IN).
const TICKER_STOPWORDS = new Set([
  'STOCK', 'STOCKS', 'SHARES', 'ALERT', 'ALERTS', 'NEWS', 'NYSE', 'NASDAQ', 'AMEX', 'CEO', 'CFO', 'COO', 'CTO',
  'AI', 'US', 'USA', 'UK', 'EU', 'ETF', 'ETFS', 'IPO', 'SEC', 'FDA', 'FED', 'GDP', 'CPI', 'PPI', 'EPS', 'PE',
  'PT', 'PR', 'PM', 'AM', 'ET', 'EST', 'PST', 'HOT', 'BUY', 'SELL', 'NEW', 'TOP', 'WOW', 'OBI', 'AFTER', 'HOURS',
  'NOW', 'THE', 'AND', 'FOR', 'WITH', 'ATH', 'YTD', 'USD', 'Q1', 'Q2', 'Q3', 'Q4', 'YOY', 'QOQ', 'WSB',
])

/** Extract BARE uppercase tickers (/^[A-Z]{2,5}$/) from feed-title text, minus
 * stopwords. Whitespace tokenisation keeps embedded names like "Grandmaster-OBI"
 * intact so the "OBI" inside is never picked up. */
export function extractBareTickers(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const rawTok of text.split(/\s+/)) {
    const tok = rawTok.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '') // strip edge punctuation
    if (!/^[A-Z]{2,5}$/.test(tok) || TICKER_STOPWORDS.has(tok) || seen.has(tok)) continue
    seen.add(tok)
    out.push(tok)
  }
  return out
}

/** Poll a pundit's dedicated RSS tag feed (e.g. stockmarketloop.com's
 * Grandmaster Obi tag). Titles carry BARE tickers; this outlet writes up only
 * his LONG alerts, so every record defaults to 'bull'. url = item link (dedupe
 * key). Reuses parseFeed; fail-soft on non-XML/network. */
export async function fetchPunditTagFeed(
  feedUrl: string,
  name: string,
  sinceSec: number,
  fetchFn: typeof fetch = fetch,
): Promise<PunditExtract[]> {
  try {
    const res = await fetchFn(feedUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (MomentumBoard)' } })
    if (!res.ok) return []
    const xml = await res.text()
    const out: PunditExtract[] = []
    for (const item of parseFeed(xml)) {
      if (item.publishedSec < sinceSec) continue
      const syms = extractBareTickers(item.title)
      if (!syms.length) continue
      const tickers: TickerCall[] = syms.map(sym => ({ sym, stance: 'bull' }))
      out.push({ ...toExtract(name, tickers, item.publishedSec, 'feed', item.url), title: item.title })
    }
    return out
  } catch {
    return [] // fail-soft: non-XML / network
  }
}
