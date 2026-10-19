import { loadUniverseSeedFile } from './engine/discovery/universeSeed'
import type { CaptionSegment } from './youtubeCaptions.mjs'
import { normaliseTradableMention, symbolForKnownCompany } from './marketEntities'
import type { BusinessHealthMetric, BusinessHealthSnapshot } from './businessHealth'

export const SOCIAL_EVIDENCE_VERSION = 'quoted-claims-v1'
export interface SocialFact {
  metric: BusinessHealthMetric; value: number; unit: string; periodStart: string; periodEnd: string; quote: string
}
export interface SocialClaim {
  id: string; sym: string; company?: string; stance: 'bull' | 'bear' | 'neutral'
  quote: string; rationale?: string; sourceMatch: 'matched' | 'unmatched' | 'visual-unchecked'
  identityMatched: boolean; startSec?: number; endSec?: number
  horizon?: string; condition?: string; unconditional: boolean
  levels: { kind: 'support' | 'resistance' | 'entry' | 'target' | 'stop'; value: number; quote: string }[]
  facts: SocialFact[]
  verification: { status: 'supported' | 'contradicted' | 'unknown'; checks: { status: 'supported' | 'contradicted' | 'unknown'; detail: string; sourceUrl?: string; availableAt?: number }[] }
}
export interface SocialCoverage {
  textChars: number; chunks: number; analysedChunks: number; timedSegments: number; totalSegments: number
  language: string; complete: boolean; visual: 'not-reviewed' | 'model-reviewed-unverified'
}

export const normaliseEvidence = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const textOf = (s: unknown, max = 400): string => typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : ''
const hash = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0).toString(36) }
const contains = (source: string, quote: string) => quote.length >= 12 && normaliseEvidence(source).includes(normaliseEvidence(quote))
const companyKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(?:incorporated|corporation|inc|corp|plc|limited|ltd)$/, '')
const listedCompanies = new Map<string, Set<string>>()
for (const row of loadUniverseSeedFile().rows) {
  const key = companyKey(row.name), symbols = listedCompanies.get(key) ?? new Set<string>()
  symbols.add(row.sym); listedCompanies.set(key, symbols)
}
const boundedWords = (text: string, term: string) => ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `.includes(` ${term.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `)
const numberPresent = (quote: string, value: number) => [...quote.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)].some(m => Number(m[0].replace(/,/g, '')) === value)

/** A quotation is admitted only when it occurs in the source. Timestamps are
 * looked up in caption segments, never accepted from model output. This proves
 * wording, not the model's interpretation or the creator's factual accuracy. */
export function parseSocialClaims(raw: unknown, source: string | undefined, segments: CaptionSegment[], sourceId: string): SocialClaim[] {
  if (!Array.isArray(raw)) return []
  const claims: SocialClaim[] = []
  for (const item of raw.slice(0, 40)) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const requested = normaliseTradableMention(textOf(row.sym, 20))
    if (!requested) continue
    const quote = textOf(row.evidenceQuote), company = textOf(row.company, 120)
    const matched = source != null && contains(source, quote)
    const candidates = listedCompanies.get(companyKey(company))
    const known = company ? symbolForKnownCompany(company) ?? (candidates?.has(requested) ? requested : candidates?.size === 1 ? [...candidates][0] : null) : null
    const symbolQuoted = requested.length >= 4 ? quote.split(/[^A-Za-z0-9.-]+/).includes(requested) : quote.includes(`$${requested}`) || quote.includes(`ticker ${requested}`)
    const identityMatched = matched && (symbolQuoted || !!(known && boundedWords(quote, company)))
    const sym = matched && known && boundedWords(quote, company) ? known : requested
    // Find the quote's position in the original combined caption text. Missing
    // timing remains missing; repeated identical quotes are not guessed.
    let startSec: number | undefined, endSec: number | undefined
    const joined = segments.map(s => normaliseEvidence(s.text)).join(' ')
    const needle = normaliseEvidence(quote), index = needle ? joined.indexOf(needle) : -1
    if (matched && index >= 0 && joined.indexOf(needle, index + 1) < 0) {
      let cursor = 0
      const touched = segments.filter(segment => {
        const end = cursor + normaliseEvidence(segment.text).length
        const overlap = end > index && cursor < index + needle.length
        cursor = end + 1
        return overlap
      })
      if (touched.length && touched.every(s => s.startSec != null && s.endSec != null)) {
        startSec = touched[0].startSec; endSec = touched.at(-1)!.endSec
      }
    }
    const condition = textOf(row.condition, 240)
    // An explicit null plus no conditional words is required. Omission means
    // unknown, not an unconditional prediction.
    const conditionalWords = /\b(if|unless|provided|assuming|once|when|above|below|breaks?|holds?|reclaims?)\b/i.test(quote)
    const unconditional = matched && row.condition === null && !conditionalWords
    const horizon = textOf(row.horizon, 120)
    const levels: SocialClaim['levels'] = []
    if (matched && Array.isArray(row.priceLevels)) for (const level of row.priceLevels.slice(0, 8)) {
      if (!level || !['support', 'resistance', 'entry', 'target', 'stop'].includes(level.kind) || !Number.isFinite(level.value) || level.value <= 0) continue
      const evidence = textOf(level.quote)
      if (contains(source!, evidence) && numberPresent(evidence, level.value) && boundedWords(evidence, level.kind)) levels.push({ kind: level.kind, value: level.value, quote: evidence })
    }
    const facts: SocialFact[] = []
    const metrics = ['revenue', 'netIncome', 'freeCashFlow', 'cash', 'totalDebt', 'revenueGrowthPct', 'netMarginPct']
    if (matched && Array.isArray(row.facts)) for (const fact of row.facts.slice(0, 5)) {
      if (!fact || !metrics.includes(fact.metric) || !Number.isFinite(fact.value)) continue
      const evidence = textOf(fact.quote)
      if (!contains(source!, evidence)) continue
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fact.periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(fact.periodEnd)) continue
      facts.push({ metric: fact.metric, value: fact.value, unit: textOf(fact.unit, 20), periodStart: fact.periodStart, periodEnd: fact.periodEnd, quote: evidence })
    }
    const stance = row.stance === 'bull' || row.stance === 'bear' ? row.stance : 'neutral'
    claims.push({ id: `${sourceId}:${hash([sym, stance, quote, condition, horizon].join('|'))}`, sym, ...(company ? { company } : {}), stance,
      quote, rationale: textOf(row.thesis, 240), sourceMatch: source == null ? 'visual-unchecked' : matched ? 'matched' : 'unmatched', identityMatched,
      ...(startSec != null ? { startSec, endSec } : {}), ...(condition ? { condition } : {}), ...(horizon && source && normaliseEvidence(source).includes(normaliseEvidence(horizon)) ? { horizon } : {}),
      unconditional, levels, facts, verification: { status: 'unknown', checks: [{ status: 'unknown', detail: 'Creator view; independent factual verification is unavailable.' }] },
    })
  }
  return [...new Map(claims.map(c => [c.id, c])).values()]
}

const metricWords: Partial<Record<BusinessHealthMetric, RegExp>> = {
  revenue: /\brevenue\b/i, netIncome: /\bnet income\b/i, freeCashFlow: /\bfree cash flow\b/i,
  cash: /\bcash\b/i, totalDebt: /\btotal debt\b/i, revenueGrowthPct: /\brevenue\b.*\b(grew|growth|increase)/i, netMarginPct: /\bnet margin\b/i,
}

/** Deliberately narrow fact checker. Require the literal metric, number, unit
 * and exact period in the quoted statement before comparing a dated filing.
 * Ambiguous periods, forecasts and rounded/scaled numbers remain unknown. */
export function verifySocialClaim(claim: SocialClaim, snapshot: BusinessHealthSnapshot | null, availableAt: number): SocialClaim {
  if (claim.sourceMatch !== 'matched' || !claim.identityMatched || !claim.facts.length) return claim
  const checks = claim.facts.map(fact => {
    const evidence = snapshot?.sym === claim.sym ? snapshot.evidence[fact.metric] : undefined
    const literal = metricWords[fact.metric]?.test(fact.quote) && numberPresent(fact.quote, fact.value)
      && fact.quote.includes(fact.periodEnd) && fact.quote.includes(fact.periodStart)
      && (fact.unit === 'USD' ? /\bUSD\b|\$/.test(fact.quote) : fact.unit === '%' && /%|percent/i.test(fact.quote))
    if (!literal || !evidence || evidence.availableAt > availableAt || evidence.periodEnd !== fact.periodEnd || evidence.periodStart !== fact.periodStart || evidence.unit !== fact.unit) {
      return { status: 'unknown' as const, detail: `${fact.metric}: no unambiguous, comparable filing available at capture.` }
    }
    const supported = Math.abs(evidence.value - fact.value) <= Math.max(0.01, Math.abs(evidence.value) * 0.005)
    return { status: supported ? 'supported' as const : 'contradicted' as const, detail: `${fact.metric}: creator ${fact.value} ${fact.unit}; filing ${evidence.value} ${evidence.unit}, ${evidence.periodStart} to ${evidence.periodEnd}.`, ...(snapshot?.sourceUrl ? { sourceUrl: snapshot.sourceUrl } : {}), availableAt: evidence.availableAt }
  })
  return { ...claim, verification: { status: checks.some(c => c.status === 'contradicted') ? 'contradicted' : checks.every(c => c.status === 'supported') ? 'supported' : 'unknown', checks } }
}
