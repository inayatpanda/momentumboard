import { describe, expect, it, vi } from 'vitest'
import { classifyDipNews, DIP_NEWS_BUDGET, DIP_NEWS_TTL_SEC, fetchCompanyNews, heuristicDipVerdict, readDipNews } from './dipNews'

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
    expect(heuristicDipVerdict([])).toEqual({ verdict: 'unclear', reason: expect.stringContaining('no recent headlines') })
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

  it('takes a well-formed LLM verdict at its word', async () => {
    const llm = vi.fn(async () => JSON.stringify({ verdict: 'transient', reason: 'sector sympathy move, thesis intact' }))
    expect(await classifyDipNews('ACME', headlines, llm)).toEqual({ verdict: 'transient', reason: 'sector sympathy move, thesis intact' })
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
    expect(await classifyDipNews('ACME', headlines, llm)).toEqual({ verdict: 'structural', reason: 'guidance withdrawn' })
  })

  it('accepts an already-parsed object from the router', async () => {
    const llm = async () => ({ verdict: 'transient', reason: 'priced-in miss' })
    expect(await classifyDipNews('ACME', headlines, llm)).toEqual({ verdict: 'transient', reason: 'priced-in miss' })
  })

  it('falls back to the heuristic when the answer is malformed', async () => {
    const llm = async () => 'no idea mate'
    const v = await classifyDipNews('ACME', ['SEC opens investigation into ACME'], llm)
    expect(v.verdict).toBe('structural') // the keyword table, not the LLM
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

  it('trims a rambling LLM reason instead of printing an essay on the card', async () => {
    const llm = async () => JSON.stringify({ verdict: 'transient', reason: 'word '.repeat(80) })
    const v = await classifyDipNews('ACME', headlines, llm)
    expect(v.verdict).toBe('transient')
    expect(v.reason.length).toBeLessThanOrEqual(140)
  })
})

describe('fetchCompanyNews', () => {
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

  it('never calls out without a key', async () => {
    const fetchFn = vi.fn(async (_url: string) => new Response(body))
    expect(await fetchCompanyNews('ACME', '2026-08-04', '2026-08-11', '', fetchFn as unknown as typeof fetch)).toEqual([])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('fails soft on a dead endpoint, a non-2xx and a shape it did not expect', async () => {
    const dead = async () => {
      throw new Error('ECONNRESET')
    }
    expect(await fetchCompanyNews('ACME', 'a', 'b', 'key', dead as unknown as typeof fetch)).toEqual([])
    const rateLimited = async () => new Response('{"error":"limit"}', { status: 429 })
    expect(await fetchCompanyNews('ACME', 'a', 'b', 'key', rateLimited as unknown as typeof fetch)).toEqual([])
    const wrongShape = async () => new Response('{"s":"no_data"}')
    expect(await fetchCompanyNews('ACME', 'a', 'b', 'key', wrongShape as unknown as typeof fetch)).toEqual([])
  })
})

describe('readDipNews', () => {
  it('reads the tape and classifies it — no key means unclear, never a wrong verdict', async () => {
    const v = await readDipNews('ACME', '', 1_800_000_000, (async () => new Response('[]')) as unknown as typeof fetch, {})
    expect(v.verdict).toBe('unclear')
  })

  it('classifies the fetched headlines with the heuristic when no LLM provider is configured', async () => {
    const fetchFn = async () => new Response(JSON.stringify([{ headline: 'SEC opens investigation into ACME', datetime: 1 }]))
    // strict:true with no keys → callLlm throws no-llm-provider-configured → heuristic
    const v = await readDipNews('ACME', 'key', 1_800_000_000, fetchFn as unknown as typeof fetch, { strict: true })
    expect(v.verdict).toBe('structural')
  })
})

describe('the lane budget', () => {
  it('is five fresh reads a run, cached for three days', () => {
    expect(DIP_NEWS_BUDGET).toBe(5)
    expect(DIP_NEWS_TTL_SEC).toBe(3 * 86_400)
  })
})
