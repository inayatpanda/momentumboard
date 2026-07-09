import { describe, it, expect, vi } from 'vitest'
import { parseNewsCatalysts, extractNewsCatalysts } from './newsCatalysts'

// build a groq-shaped chat/completions response (see llm.ts groq provider)
const groqResponse = (content: string) =>
  ({ json: async () => ({ choices: [{ message: { content } }] }) }) as unknown as Response

describe('parseNewsCatalysts', () => {
  it('parses a clean JSON array', () => {
    const out = parseNewsCatalysts('[{"sym":"XOM","side":"long","reason":"oil spike","strength":90}]')
    expect(out).toEqual([{ sym: 'XOM', side: 'long', reason: 'oil spike', strength: 90 }])
  })

  it('parses a ```json-fenced array', () => {
    const raw = '```json\n[{"sym":"CVX","side":"long","reason":"crude up","strength":80}]\n```'
    expect(parseNewsCatalysts(raw)).toEqual([{ sym: 'CVX', side: 'long', reason: 'crude up', strength: 80 }])
  })

  it('parses an array wrapped in leading/trailing prose', () => {
    const raw = 'Here are my picks:\n[{"sym":"LMT","side":"long","reason":"defense","strength":70}]\nHope that helps.'
    expect(parseNewsCatalysts(raw)).toEqual([{ sym: 'LMT', side: 'long', reason: 'defense', strength: 70 }])
  })

  it('drops invalid tickers (lowercase junk, too long, non-string)', () => {
    const raw = JSON.stringify([
      { sym: 'lower', side: 'long', reason: 'x', strength: 50 }, // lowercase → uppercases to LOWER (5 chars, valid) — use real junk below
      { sym: 'TOOLONG', side: 'long', reason: 'x', strength: 50 }, // 7 chars → drop
      { sym: '123', side: 'long', reason: 'x', strength: 50 }, // starts with digit → drop
      { sym: 42, side: 'long', reason: 'x', strength: 50 }, // non-string → drop
      { sym: 'AAPL', side: 'long', reason: 'ok', strength: 60 }, // valid
    ])
    const out = parseNewsCatalysts(raw)
    const syms = out.map(c => c.sym)
    expect(syms).toContain('AAPL')
    expect(syms).toContain('LOWER') // 'lower' uppercased is a valid 5-char ticker shape
    expect(syms).not.toContain('TOOLONG')
    expect(syms).not.toContain('123')
    expect(out.every(c => typeof c.sym === 'string')).toBe(true)
  })

  it('coerces bad strength to 50 and clamps out-of-range values', () => {
    const raw = JSON.stringify([
      { sym: 'AAA', side: 'long', reason: 'a', strength: 'notnum' },
      { sym: 'BBB', side: 'long', reason: 'b', strength: 150 },
      { sym: 'CCC', side: 'long', reason: 'c', strength: -20 },
    ])
    const out = parseNewsCatalysts(raw)
    expect(out.find(c => c.sym === 'AAA')!.strength).toBe(50)
    expect(out.find(c => c.sym === 'BBB')!.strength).toBe(100)
    expect(out.find(c => c.sym === 'CCC')!.strength).toBe(0)
  })

  it("maps 'neutral' / missing side to null", () => {
    const raw = JSON.stringify([
      { sym: 'AAA', side: 'neutral', reason: 'a', strength: 50 },
      { sym: 'BBB', reason: 'b', strength: 50 },
    ])
    const out = parseNewsCatalysts(raw)
    expect(out.find(c => c.sym === 'AAA')!.side).toBeNull()
    expect(out.find(c => c.sym === 'BBB')!.side).toBeNull()
  })

  it('dedupes the same sym keeping the higher strength', () => {
    const raw = JSON.stringify([
      { sym: 'XOM', side: 'long', reason: 'weak', strength: 30 },
      { sym: 'XOM', side: 'long', reason: 'strong', strength: 85 },
    ])
    const out = parseNewsCatalysts(raw)
    expect(out).toHaveLength(1)
    expect(out[0].strength).toBe(85)
    expect(out[0].reason).toBe('strong')
  })

  it('caps the result at 8', () => {
    const raw = JSON.stringify(
      // distinct letter-only tickers (digits fail the US-ticker heuristic)
      Array.from({ length: 12 }, (_, i) => ({ sym: `A${String.fromCharCode(65 + i)}`, side: 'long', reason: 'x', strength: 50 })),
    )
    expect(parseNewsCatalysts(raw)).toHaveLength(8)
  })

  it('slices reason to 90 chars', () => {
    const long = 'z'.repeat(200)
    const out = parseNewsCatalysts(JSON.stringify([{ sym: 'AAA', side: 'long', reason: long, strength: 50 }]))
    expect(out[0].reason).toHaveLength(90)
  })

  it('returns [] on garbage input', () => {
    expect(parseNewsCatalysts('not json at all')).toEqual([])
    expect(parseNewsCatalysts('[ this is { broken json ]')).toEqual([])
    expect(parseNewsCatalysts('')).toEqual([])
  })
})

describe('extractNewsCatalysts', () => {
  it('returns [] for empty titles without calling fetch', async () => {
    const fetchFn = vi.fn()
    const out = await extractNewsCatalysts([], { GROQ_API_KEY: 'x' }, fetchFn as unknown as typeof fetch)
    expect(out).toEqual([])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('returns [] when no provider is configured (env {})', async () => {
    const fetchFn = vi.fn()
    const out = await extractNewsCatalysts(['Oil surges 8%'], {}, fetchFn as unknown as typeof fetch)
    expect(out).toEqual([])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('parses catalysts from a groq-shaped response', async () => {
    const content = '```json\n[{"sym":"XOM","side":"long","reason":"crude spike","strength":88}]\n```'
    const fetchFn = vi.fn(async () => groqResponse(content))
    const out = await extractNewsCatalysts(
      ['Oil surges 8% on Middle East escalation'],
      { GROQ_API_KEY: 'x' },
      fetchFn as unknown as typeof fetch,
    )
    expect(fetchFn).toHaveBeenCalledOnce()
    expect(out).toEqual([{ sym: 'XOM', side: 'long', reason: 'crude spike', strength: 88 }])
  })
})
