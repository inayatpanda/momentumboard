import { describe, expect, it } from 'vitest'
import { parseSocialClaims, verifySocialClaim } from './socialEvidence'
import { emptyBusinessHealth } from './businessHealth'

const quote = 'Tesla is bullish for the next year.'
const base = { sym: 'TSLA', company: 'Tesla', evidenceQuote: quote, stance: 'bull', condition: null, horizon: 'next year' }

describe('source-grounded social claims', () => {
  it('resolves exact timecodes from captions, preserving the stated horizon', () => {
    const claim = parseSocialClaims([base], quote, [{ text: quote, startSec: 64.2, endSec: 68 }], 'video')[0]
    expect(claim).toMatchObject({ sym: 'TSLA', sourceMatch: 'matched', identityMatched: true, startSec: 64.2, endSec: 68, horizon: 'next year', unconditional: true })
    expect(claim.verification.status).toBe('unknown')
  })
  it('joins a quotation across segments and rejects repeated ambiguous timecodes', () => {
    const segments = [{ text: 'Tesla is bullish', startSec: 5, endSec: 7 }, { text: 'for the next year.', startSec: 7, endSec: 10 }]
    expect(parseSocialClaims([base], quote, segments, 'v')[0]).toMatchObject({ startSec: 5, endSec: 10 })
    expect(parseSocialClaims([base], `${quote} ${quote}`, [...segments, ...segments], 'v')[0].startSec).toBeUndefined()
  })
  it('rejects paraphrases, invented identities and missing evidence for learning', () => {
    expect(parseSocialClaims([{ ...base, evidenceQuote: 'Tesla will certainly double.' }], quote, [], 'v')[0].sourceMatch).toBe('unmatched')
    expect(parseSocialClaims([{ ...base, sym: 'AAPL', company: 'Apple', evidenceQuote: 'It looks bullish over the next year.' }], 'It looks bullish over the next year.', [], 'v')[0].identityMatched).toBe(false)
    expect(parseSocialClaims([base], undefined, [], 'v')[0]).toMatchObject({ sourceMatch: 'visual-unchecked', identityMatched: false, unconditional: false })
  })
  it('does not collapse conditional, opposing or different-horizon views', () => {
    const short = 'Tesla is bearish for the next week.'
    const conditional = 'Tesla is bullish if it holds 200.'
    const rows = parseSocialClaims([base, { ...base, stance: 'bear', evidenceQuote: short, horizon: 'next week' }, { ...base, evidenceQuote: conditional, condition: 'if it holds 200' }], [quote, short, conditional].join(' '), [], 'v')
    expect(rows).toHaveLength(3)
    expect(rows[2].unconditional).toBe(false)
    expect(parseSocialClaims([{ ...base, condition: undefined }], quote, [], 'v')[0].unconditional).toBe(false)
    expect(parseSocialClaims([{ ...base, evidenceQuote: conditional }], conditional, [], 'v')[0].unconditional).toBe(false)
  })
  it('admits only typed levels whose type and number both occur in source words', () => {
    const source = quote + ' Tesla support is 180. Tesla target is 250.'
    const claim = parseSocialClaims([{ ...base, priceLevels: [{ kind: 'support', value: 180, quote: 'Tesla support is 180.' }, { kind: 'stop', value: 180, quote: 'Tesla support is 180.' }, { kind: 'target', value: 500, quote: 'Tesla target is 250.' }] }], source, [], 'v')[0]
    expect(claim.levels).toEqual([{ kind: 'support', value: 180, quote: 'Tesla support is 180.' }])
  })
  it('checks only literal period-matched numerical assertions against available filings', () => {
    const factQuote = 'Tesla revenue from 2025-01-01 to 2025-12-31 was USD 100.'
    const claim = parseSocialClaims([{ ...base, facts: [{ metric: 'revenue', value: 100, unit: 'USD', periodStart: '2025-01-01', periodEnd: '2025-12-31', quote: factQuote }] }], quote + ' ' + factQuote, [], 'v')[0]
    const snapshot = emptyBusinessHealth('TSLA', 200, '')
    snapshot.evidence.revenue = { value: 100, unit: 'USD', periodStart: '2025-01-01', periodEnd: '2025-12-31', availableAt: 100, filed: '2026-02-01', tags: [], accessions: [] }
    expect(verifySocialClaim(claim, snapshot, 200).verification.status).toBe('supported')
    expect(verifySocialClaim(claim, snapshot, 50).verification.status).toBe('unknown')
    snapshot.evidence.revenue.value = 200
    expect(verifySocialClaim(claim, snapshot, 200).verification.status).toBe('contradicted')
    snapshot.evidence.revenue.periodStart = '2025-10-01'
    expect(verifySocialClaim(claim, snapshot, 200).verification.status).toBe('unknown')
  })
})
