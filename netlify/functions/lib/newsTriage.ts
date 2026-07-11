import { anyProviderAvailable, callLlm } from './llm'
import { NEG, POS } from '../../../shared/engine/factors'

// News triage: EVERY fresh headline gets analysed and lands in the app's news
// desk; only what scores as genuinely market-important may ping the reader.
// Raw feed → Telegram was a firehose (every Finnhub company-news item for a
// watchlist name pinged instantly). The triage is LLM-first — one small batch
// call per run — and fails soft to a deterministic keyword heuristic, so the
// desk still fills and importance still ranks with no provider configured.

export interface TriagedNews {
  title: string
  url: string
  syms: string[]
  score: number // 0..100 market importance
  why: string // one short line: why it matters (or doesn't)
  at: number // epoch sec triaged
}

/** Ping the reader at or above this score — reserved for company-changing or
 * tape-moving news, not routine coverage. */
export const NEWS_PING_MIN = 75
/** Between this and NEWS_PING_MIN: worth the thrice-daily digest, not a ping. */
export const NEWS_DIGEST_MIN = 55
/** Hard flood-stop: however loud the day, at most this many news pings per run. */
export const NEWS_PING_CAP = 3

// Words that make a headline company-changing rather than coverage. Kept
// deliberately blunt — the LLM pass owns nuance; this only ranks the desk
// when no provider is up.
const HIGH_IMPACT = [
  'halt', 'halted', 'bankrupt', 'bankruptcy', 'chapter 11', 'merger', 'acquire', 'acquires', 'acquisition', 'buyout', 'takeover',
  'fda', 'approval', 'approved', 'rejects', 'guidance', 'downgrade', 'upgrade', 'investigation', 'sec', 'doj', 'fraud', 'probe',
  'recall', 'lawsuit', 'settle', 'settlement', 'resigns', 'resignation', 'ceo', 'cfo', 'dividend', 'split', 'buyback',
  'earnings', 'beats', 'misses', 'warns', 'warning', 'delisting', 'short seller', 'activist', 'stake', 'tariff', 'sanction',
]

/** Deterministic fallback scorer — same inputs, same answer, no network. */
export function heuristicScore(title: string, syms: string[]): { score: number; why: string } {
  const lower = title.toLowerCase()
  let score = 15 // base: it exists
  const hits: string[] = []
  if (syms.length) {
    score += 20
    hits.push(`names ${syms.slice(0, 3).join('/')}`)
  }
  const impact = HIGH_IMPACT.filter(w => lower.includes(w))
  if (impact.length) {
    score += Math.min(40, 22 * impact.length)
    hits.push(impact.slice(0, 2).join(', '))
  }
  let polarity = 0
  for (const w of lower.split(/\W+/)) {
    if (POS.has(w)) polarity++
    else if (NEG.has(w)) polarity--
  }
  if (polarity !== 0) {
    score += Math.min(15, 5 * Math.abs(polarity))
    hits.push(polarity > 0 ? 'positive tone' : 'negative tone')
  }
  return { score: Math.max(0, Math.min(100, Math.round(score))), why: hits.length ? hits.join(' · ') : 'routine coverage' }
}

// PURE: tolerant parse of the LLM's scored array (mirrors parseNewsCatalysts).
export function parseTriage(raw: string, count: number): { i: number; score: number; why: string }[] {
  try {
    const unfenced = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '')
    const start = unfenced.indexOf('[')
    if (start === -1) return []
    let depth = 0
    let end = -1
    for (let k = start; k < unfenced.length; k++) {
      const ch = unfenced[k]
      if (ch === '[') depth++
      else if (ch === ']') {
        depth--
        if (depth === 0) {
          end = k
          break
        }
      }
    }
    if (end === -1) return []
    const arr = JSON.parse(unfenced.slice(start, end + 1)) as unknown
    if (!Array.isArray(arr)) return []
    const out: { i: number; score: number; why: string }[] = []
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue
      const { i, score, why } = item as { i?: unknown; score?: unknown; why?: unknown }
      if (typeof i !== 'number' || i < 0 || i >= count || typeof score !== 'number') continue
      out.push({ i: Math.floor(i), score: Math.max(0, Math.min(100, Math.round(score))), why: typeof why === 'string' ? why.slice(0, 120) : '' })
    }
    return out
  } catch {
    return []
  }
}

const PROMPT_HEAD = `You are the news editor of a swing-trading paper. Score each headline 0-100 for MARKET importance to a US-equities swing trader (multi-day horizon):
- 90+: tape-moving (major geopolitical/macro shock, megacap-changing event)
- 75-89: company-changing for a traded name (M&A, guidance change, FDA/regulatory ruling, halt, fraud, activist stake)
- 55-74: notable but not urgent (analyst moves, meaningful product/contract news)
- <55: routine coverage, incremental takes, listicles, previews
Respond with ONLY a JSON array: [{"i":<index>,"score":<0-100>,"why":"<≤12 words>"}] covering every index.

HEADLINES:
`

/** Triage a batch of fresh headlines. LLM-first (one call for the whole
 * batch), deterministic heuristic when no provider or the call fails. Never
 * throws; always returns one entry per input item. */
export async function triageNews(
  items: { title: string; url: string; syms: string[] }[],
  nowSec: number,
): Promise<TriagedNews[]> {
  if (!items.length) return []
  const base = items.map(n => ({ ...n, ...heuristicScore(n.title, n.syms), at: nowSec }))
  if (!anyProviderAvailable()) return base
  try {
    const prompt = PROMPT_HEAD + items.map((n, i) => `${i}. ${n.title}${n.syms.length ? ` [${n.syms.join(', ')}]` : ''}`).join('\n')
    const res = await callLlm(prompt)
    const scored = parseTriage(res.text, items.length)
    if (!scored.length) return base
    const byIdx = new Map(scored.map(s => [s.i, s]))
    return base.map((b, i) => {
      const s = byIdx.get(i)
      return s ? { ...b, score: s.score, why: s.why || b.why } : b
    })
  } catch {
    return base // provider down → the heuristic desk still publishes
  }
}
