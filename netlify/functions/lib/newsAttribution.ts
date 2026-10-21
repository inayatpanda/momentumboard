import { loadUniverseSeed } from '../../../shared/engine/discovery/universeSeed'

const names = new Map(loadUniverseSeed().map(row => [row.sym, row.name]))
const generic = new Set(['inc', 'corp', 'corporation', 'company', 'group', 'holdings', 'limited', 'ltd', 'plc', 'class', 'ordinary', 'shares', 'the'])

/** The requested company endpoint is not evidence that a story is about it. */
export function attributedHeadline(headline: string, symbol: string, companyName?: string, related?: unknown): boolean {
  const ticker = symbol.toUpperCase()
  const tags = typeof related === 'string' ? related.split(/[,;\s]+/).map(s => s.toUpperCase()) : []
  if (tags.length && !tags.includes(ticker)) return false
  // Short ticker words (A, IT, ON...) need explicit financial punctuation.
  const mentionsTicker = ticker.length > 2
    ? headline.split(/[^A-Za-z0-9.-]+/).some(word => word.toUpperCase() === ticker)
    : headline.includes(`$${ticker}`) || headline.includes(`(${ticker})`)
  const words = (companyName || names.get(ticker) || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter(word => word.length > 2 && !generic.has(word))
  const normalized = ` ${headline.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ')} `
  const mentionsName = words.length > 0 && words.slice(0, 2).every(word => normalized.includes(` ${word} `))
  return mentionsTicker || mentionsName
}
