import { callLlm, anyProviderAvailable, type LlmEnv } from './llm'

// Turns the day's market headlines into a shortlist of tradable "news
// catalysts" — the most liquid, most DIRECT beneficiaries AND victims likely
// to make an outsized move over the next 1-3 sessions BECAUSE of the news.
// Deliberately sector-agnostic: geopolitics, the Fed, oil, a major IPO/listing,
// M&A, a regulatory ruling — any big market-moving story, large or small cap.

export interface NewsCatalyst {
  sym: string // US-exchange ticker, UPPERCASE
  side: 'long' | 'short' | null // long = benefits, short = hurt, null = "in play", no clear direction
  reason: string // <= ~90 chars, why this name moves on the news
  strength: number // 0..100 how direct/material the catalyst is
}

const TICKER_RE = /^[A-Z][A-Z.\-]{0,5}$/ // US-listed-ticker heuristic, max 6 chars

// PURE, no network. Tolerantly parse an LLM response that may be fenced in
// ```json or wrapped in prose: strip code fences, grab the first top-level JSON
// array, validate/normalise each item. Never throws — returns [] on any error.
export function parseNewsCatalysts(raw: string): NewsCatalyst[] {
  try {
    if (typeof raw !== 'string') return []
    const unfenced = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '')
    const start = unfenced.indexOf('[')
    if (start === -1) return []
    // find the matching ']' for the first '[' (top-level array boundary)
    let depth = 0
    let end = -1
    for (let i = start; i < unfenced.length; i++) {
      const ch = unfenced[i]
      if (ch === '[') depth++
      else if (ch === ']') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) return []
    const arr = JSON.parse(unfenced.slice(start, end + 1)) as unknown
    if (!Array.isArray(arr)) return []

    const out: NewsCatalyst[] = []
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue
      const rec = item as Record<string, unknown>

      if (typeof rec.sym !== 'string') continue
      const sym = rec.sym.toUpperCase()
      if (!TICKER_RE.test(sym)) continue

      const side: NewsCatalyst['side'] = rec.side === 'long' || rec.side === 'short' ? rec.side : null

      const reason = rec.reason == null ? '' : String(rec.reason).trim().slice(0, 90)

      let strength = Number(rec.strength)
      if (Number.isNaN(strength)) strength = 50
      strength = Math.round(Math.min(100, Math.max(0, strength)))

      out.push({ sym, side, reason, strength })
    }

    // dedupe by sym, keeping the higher strength
    const bySym = new Map<string, NewsCatalyst>()
    for (const c of out) {
      const prev = bySym.get(c.sym)
      if (!prev || c.strength > prev.strength) bySym.set(c.sym, c)
    }

    return [...bySym.values()].slice(0, 8)
  } catch {
    return []
  }
}

// Ask the LLM to nominate the tradable beneficiaries/victims of today's news.
// Fail-soft: no titles or no provider → [] with no LLM call; any error → [].
export async function extractNewsCatalysts(
  titles: string[],
  env: Partial<LlmEnv> = {},
  fetchFn: typeof fetch = fetch,
): Promise<NewsCatalyst[]> {
  if (titles.length === 0 || !anyProviderAvailable(env)) return []

  try {
    const headlines = titles.slice(0, 30).join(' | ')
    const prompt = `You are a seasoned macro-equity strategist scanning today's market headlines:
${headlines}

Identify up to 8 US-exchange-listed stocks (any sector, large OR small cap) most likely to make an outsized move over the NEXT 1-3 SESSIONS *because of* this news. For each, pick the most liquid, most DIRECT beneficiary or victim — e.g. an oil-price spike → integrated majors & E&Ps; a geopolitical escalation → prime defense contractors; a chipmaker's US listing → sector peers and suppliers; a rate cut → rate-sensitive names.
- side: "long" if the news benefits it, "short" if it is hurt, null if it is just in play with no clear direction.
- reason: <= 90 chars, why this specific name moves on the news.
- strength: 0-100, how DIRECT and MATERIAL the catalyst is — a first-order, obvious beneficiary is high; a vague second-order link is low.
Return ONLY a JSON array of {"sym","side","reason","strength"} — no prose, no markdown.`

    const { text } = await callLlm(prompt, { ...env, maxTokens: 700 }, fetchFn)
    return parseNewsCatalysts(text)
  } catch {
    return []
  }
}
