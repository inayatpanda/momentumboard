import { describe, expect, it, vi } from 'vitest'
import {
  classifyDipNews,
  DIP_NEWS_BUDGET,
  DIP_NEWS_HEURISTIC_TTL_SEC,
  DIP_NEWS_TTL_SEC,
  fetchCompanyNews,
  heuristicDipVerdict,
  readDipNews,
  unservedVenue,
} from './dipNews'

describe('heuristicDipVerdict', () => {
  // The keyword table is the floor the lane can never fall through: no LLM
  // provider, a malformed answer or a thrown call all land here.
  it.each([
    ['SEC opens investigation into ACME accounting', 'investigat'],
    ['ACME discloses accounting fraud at its cloud unit', 'fraud'],
    ['ACME cuts guidance for the full year', 'guidance'],
    ['ACME files for Chapter 11 bankruptcy protection', 'bankrupt'],
    ['NYSE begins delisting proceedings for ACME', 'delist'],
    ['Auditors flag going concern doubt at ACME', 'going concern'],
    ['ACME issues profit warning as orders collapse', 'profit warning'],
  ])('reads a broken thesis as structural: %s', (headline, term) => {
    const v = heuristicDipVerdict([headline])
    expect(v.verdict).toBe('structural')
    expect(v.reason.toLowerCase()).toContain(term)
  })

  it.each([
    'ACME misses estimates as margins hold',
    'Analyst downgrade sends ACME lower',
    'ACME slides in sympathy with the chip selloff',
    'Sector-wide selloff drags ACME down with its peers',
    'Broad market rout hits ACME',
  ])('reads an overreaction as transient: %s', headline => {
    expect(heuristicDipVerdict([headline]).verdict).toBe('transient')
  })

  it('has no verdict without headlines — silence is not evidence', () => {
    expect(heuristicDipVerdict([])).toEqual({ verdict: 'unclear', reason: expect.stringContaining('no recent headlines'), via: 'heuristic' })
  })

  it('quotes the HEADLINE it matched, not just the rule that fired', () => {
    // "structural — guidance cut" is unauditable; the reader cannot tell whether
    // the lane read a real profit warning or tripped over the word 'guidance' in
    // a story about a new CFO. The evidence goes on the record with the verdict.
    const v = heuristicDipVerdict(['ACME opens new plant in Ohio', 'ACME cuts guidance for the full year'])
    expect(v.verdict).toBe('structural')
    expect(v.reason).toContain('ACME cuts guidance for the full year')
    expect(v.reason).not.toContain('Ohio') // the headline that fired, not the whole tape
  })

  it('stamps every keyword verdict as heuristic, decisive or not', () => {
    for (const heads of [[], ['ACME names new head of European sales'], ['SEC opens investigation into ACME'], ['Analyst downgrade sends ACME lower']]) {
      expect(heuristicDipVerdict(heads).via).toBe('heuristic')
    }
  })

  it('clips a runaway headline instead of printing a paragraph on the card', () => {
    const v = heuristicDipVerdict([`SEC opens investigation into ACME ${'and its many subsidiaries '.repeat(20)}`])
    expect(v.verdict).toBe('structural')
    expect(v.reason.length).toBeLessThanOrEqual(140)
  })

  it('is unclear when nothing in the headlines is either signature', () => {
    expect(heuristicDipVerdict(['ACME names new head of European sales']).verdict).toBe('unclear')
  })

  it('a broken thesis outranks an overreaction when both are in the tape', () => {
    // "downgrade" is transient, "investigation" is not. Buying into a fraud probe
    // because an analyst also cut the stock is the exact mistake this lane exists
    // to prevent, so structural must win the tie.
    const v = heuristicDipVerdict(['Analyst downgrade sends ACME lower', 'SEC opens investigation into ACME'])
    expect(v.verdict).toBe('structural')
  })

  it('keeps its reason short enough to print on a card', () => {
    const v = heuristicDipVerdict(['SEC opens investigation into ACME accounting practices'])
    expect(v.reason.split(/\s+/).length).toBeLessThan(20)
  })
})

describe('classifyDipNews', () => {
  const headlines = ['ACME names new head of European sales'] // heuristic reads this as unclear

  it('takes a well-formed LLM verdict at its word, stamped as the model’s own', async () => {
    const llm = vi.fn(async () => JSON.stringify({ verdict: 'transient', reason: 'sector sympathy move, thesis intact' }))
    expect(await classifyDipNews('ACME', headlines, llm)).toEqual({ verdict: 'transient', reason: 'sector sympathy move, thesis intact', via: 'llm' })
    expect(llm).toHaveBeenCalledTimes(1)
  })

  it('names the ticker and every headline in the prompt, and asks for JSON only', async () => {
    const llm = vi.fn(async (_prompt: string) => '{"verdict":"structural","reason":"fraud probe"}')
    await classifyDipNews('ACME', ['ACME halted', 'ACME probed'], llm)
    const prompt = llm.mock.calls[0][0]
    expect(prompt).toContain('ACME')
    expect(prompt).toContain('ACME halted')
    expect(prompt).toContain('ACME probed')
    expect(prompt.toLowerCase()).toContain('transient')
    expect(prompt.toLowerCase()).toContain('structural')
    expect(prompt.toLowerCase()).toContain('json')
  })

  it('digs the JSON out of a fenced or chatty answer', async () => {
    const llm = async () => '```json\n{"verdict": "structural", "reason": "guidance withdrawn"}\n```\nHope that helps!'
    expect(await classifyDipNews('ACME', headlines, llm)).toEqual({ verdict: 'structural', reason: 'guidance withdrawn', via: 'llm' })
  })

  it('accepts an already-parsed object from the router', async () => {
    const llm = async () => ({ verdict: 'transient', reason: 'priced-in miss' })
    expect(await classifyDipNews('ACME', headlines, llm)).toEqual({ verdict: 'transient', reason: 'priced-in miss', via: 'llm' })
  })

  it('falls back to the heuristic when the answer is malformed — and says so', async () => {
    const llm = async () => 'no idea mate'
    const v = await classifyDipNews('ACME', ['SEC opens investigation into ACME'], llm)
    expect(v.verdict).toBe('structural') // the keyword table, not the LLM
    expect(v.via).toBe('heuristic') // …and the record shows which one answered
  })

  it('falls back to the heuristic when the verdict is not one of the three', async () => {
    const llm = async () => '{"verdict":"maybe","reason":"hedging"}'
    const v = await classifyDipNews('ACME', ['Analyst downgrade sends ACME lower'], llm)
    expect(v.verdict).toBe('transient')
  })

  it('falls back to the heuristic when the call throws', async () => {
    const llm = async () => {
      throw new Error('no-llm-provider-configured')
    }
    const v = await classifyDipNews('ACME', ['ACME files for Chapter 11 bankruptcy protection'], llm)
    expect(v.verdict).toBe('structural')
  })

  it('never spends an LLM call on no headlines', async () => {
    const llm = vi.fn(async () => '{"verdict":"transient","reason":"x"}')
    expect((await classifyDipNews('ACME', [], llm)).verdict).toBe('unclear')
    expect(llm).not.toHaveBeenCalled()
  })

  it('caps the prompt at twelve headlines — the cheap input is the tape, not the tokens', async () => {
    const llm = vi.fn(async (_prompt: string) => '{"verdict":"transient","reason":"sector selloff"}')
    const twenty = Array.from({ length: 20 }, (_, i) => `ACME headline number ${i}`)
    await classifyDipNews('ACME', twenty, llm)
    const prompt = llm.mock.calls[0][0]
    expect(prompt.split('\n').filter(l => l.startsWith('- ACME headline number '))).toHaveLength(12)
    expect(prompt).toContain('ACME headline number 11') // the twelfth, kept
    expect(prompt).not.toContain('ACME headline number 12') // the thirteenth, dropped
  })

  it('trims a rambling LLM reason instead of printing an essay on the card', async () => {
    const llm = async () => JSON.stringify({ verdict: 'transient', reason: 'word '.repeat(80) })
    const v = await classifyDipNews('ACME', headlines, llm)
    expect(v.verdict).toBe('transient')
    expect(v.reason.length).toBeLessThanOrEqual(140)
  })
})

describe('fetchCompanyNews', () => {
  it('rejects an unrelated earnings story returned on another company feed', async () => {
    const fetcher = async () => Response.json([
      {headline:'GPC Q3 Earnings Miss Estimates on Automotive Margin Pressure',related:'GPC'},
      {headline:'GPC Q3 Earnings Miss Estimates on Automotive Margin Pressure',related:'LCID'},
      {headline:'Lucid cuts its outlook',related:'LCID'},
      {headline:'LCID reports quarterly deliveries'},
    ])
    expect(await fetchCompanyNews('LCID','2026-10-14','2026-10-21','key',fetcher,'Lucid Group Inc')).toEqual(['Lucid cuts its outlook','LCID reports quarterly deliveries'])
  })
  const body = JSON.stringify([
    { headline: 'ACME cuts guidance', datetime: 1 },
    { headline: 'ACME cuts guidance', datetime: 2 }, // wire duplicate
    { headline: '', datetime: 3 },
    { headline: 'ACME names new CFO', datetime: 4 },
  ])

  it('returns de-duplicated, non-empty headlines for the window asked for', async () => {
    const fetchFn = vi.fn(async (_url: string) => new Response(body))
    const out = await fetchCompanyNews('ACME', '2026-08-04', '2026-08-11', 'key', fetchFn as unknown as typeof fetch)
    expect(out).toEqual(['ACME cuts guidance', 'ACME names new CFO'])
    const url = fetchFn.mock.calls[0][0]
    expect(url).toContain('company-news')
    expect(url).toContain('symbol=ACME')
    expect(url).toContain('from=2026-08-04')
    expect(url).toContain('to=2026-08-11')
  })

  it('never calls out without a key — and reports that as UNAVAILABLE, not as empty', async () => {
    const fetchFn = vi.fn(async (_url: string) => new Response(body))
    expect(await fetchCompanyNews('ACME', '2026-08-04', '2026-08-11', '', fetchFn as unknown as typeof fetch)).toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('an answering wire with no stories is [] — a genuine, reportable emptiness', async () => {
    const empty = async () => new Response('[]')
    expect(await fetchCompanyNews('ACME', 'a', 'b', 'key', empty as unknown as typeof fetch)).toEqual([])
  })

  it('fails soft to NULL on a dead endpoint, a non-2xx and a shape it did not expect', async () => {
    const dead = async () => {
      throw new Error('ECONNRESET')
    }
    expect(await fetchCompanyNews('ACME', 'a', 'b', 'key', dead as unknown as typeof fetch)).toBeNull()
    const rateLimited = async () => new Response('{"error":"limit"}', { status: 429 })
    expect(await fetchCompanyNews('ACME', 'a', 'b', 'key', rateLimited as unknown as typeof fetch)).toBeNull()
    const wrongShape = async () => new Response('{"s":"no_data"}')
    expect(await fetchCompanyNews('ACME', 'a', 'b', 'key', wrongShape as unknown as typeof fetch)).toBeNull()
  })
})

describe('readDipNews', () => {
  it('reads the tape and classifies it — no key means unclear, never a wrong verdict', async () => {
    const v = await readDipNews('ACME', '', 1_800_000_000, (async () => new Response('[]')) as unknown as typeof fetch, {})
    expect(v.verdict).toBe('unclear')
  })

  // The two 'unclear's the card must never confuse: one is a fact about the NAME,
  // the other is a fact about our plumbing.
  it('a 429 says the LOOKUP was unavailable — not that the name had no headlines', async () => {
    const rateLimited = async () => new Response('{"error":"limit"}', { status: 429 })
    const v = await readDipNews('ACME', 'key', 1_800_000_000, rateLimited as unknown as typeof fetch, { strict: true })
    expect(v).toEqual({ verdict: 'unclear', reason: 'news lookup unavailable' })
    expect(v.via).toBeUndefined() // nothing decided it, so nothing caches it
  })

  it('a wire that answers with no stories says NO RECENT HEADLINES', async () => {
    const quiet = async () => new Response('[]')
    const v = await readDipNews('ACME', 'key', 1_800_000_000, quiet as unknown as typeof fetch, { strict: true })
    expect(v.verdict).toBe('unclear')
    expect(v.reason).toBe('no recent headlines')
  })

  it('classifies the fetched headlines with the heuristic when no LLM provider is configured', async () => {
    const fetchFn = async () => new Response(JSON.stringify([{ headline: 'SEC opens investigation into ACME', datetime: 1 }]))
    // strict:true with no keys → callLlm throws no-llm-provider-configured → heuristic
    const v = await readDipNews('ACME', 'key', 1_800_000_000, fetchFn as unknown as typeof fetch, { strict: true })
    expect(v.verdict).toBe('structural')
    expect(v.via).toBe('heuristic') // the provenance the engine's cache TTL reads
    expect(v.reason).toContain('SEC opens investigation into ACME')
  })
})

describe('unservedVenue', () => {
  it('names the venue the news source cannot reach, and stays quiet about US tickers', () => {
    // Finnhub company-news is US-listed only. A .L read is guaranteed empty, not
    // inconclusive — the engine skips it rather than spending a budget slot.
    expect(unservedVenue('RR.L')).toBe('LSE')
    expect(unservedVenue('BT-A.L')).toBe('LSE') // the dash must not send this down the crypto path
    expect(unservedVenue('AAPL')).toBeNull()
    expect(unservedVenue('BRK-B')).toBeNull()
    expect(unservedVenue('ASML.AS')).toBe('.AS') // an unmapped suffix still names itself
  })

  it('reads a crypto pair as unserved, and a share-class dash as the US equity it is', () => {
    // A Yahoo crypto pair sent to Finnhub's US company-news endpoint is another
    // guaranteed-empty read — it must not burn a budget slot a checkable name
    // could have used. The tell is the QUOTE CURRENCY after the dash, never the
    // dash itself: BRK-B and BF-B are share classes, not currency pairs, and
    // writing them off as crypto would cost them a read they would have answered.
    expect(unservedVenue('BTC-USD')).toBe('crypto')
    expect(unservedVenue('ETH-USD')).toBe('crypto')
    expect(unservedVenue('SOL-GBP')).toBe('crypto')
    expect(unservedVenue('ETH-BTC')).toBe('crypto')
    expect(unservedVenue('BTC-CAD')).toBe('crypto') // codex cross-check: Yahoo lists CAD/AUD pairs too
    expect(unservedVenue('BTC-AUD')).toBe('crypto')
    expect(unservedVenue('BF-B')).toBeNull()
    expect(unservedVenue('BRK-A')).toBeNull()
  })
})

describe('the lane budget', () => {
  it('is five fresh reads a run; a model verdict freezes for three days, a keyword verdict for one', () => {
    expect(DIP_NEWS_BUDGET).toBe(5)
    expect(DIP_NEWS_TTL_SEC).toBe(3 * 86_400)
    expect(DIP_NEWS_HEURISTIC_TTL_SEC).toBe(86_400)
    expect(DIP_NEWS_HEURISTIC_TTL_SEC).toBeLessThan(DIP_NEWS_TTL_SEC) // thinner evidence, shorter freeze
  })
})
