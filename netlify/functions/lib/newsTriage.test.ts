import { describe, expect, it } from 'vitest'
import { heuristicScore, parseTriage, NEWS_DIGEST_MIN, NEWS_PING_MIN, triageNews } from './newsTriage'

describe('heuristicScore', () => {
  it('routine coverage scores low — never near the ping bar', () => {
    const r = heuristicScore('5 stocks to watch this week', [])
    expect(r.score).toBeLessThan(NEWS_DIGEST_MIN)
    expect(r.why).toBe('routine coverage')
  })
  it('company-changing keywords on a named ticker clear the digest bar', () => {
    const r = heuristicScore('ACME halted after SEC fraud investigation', ['ACME'])
    expect(r.score).toBeGreaterThanOrEqual(NEWS_DIGEST_MIN)
    expect(r.why).toContain('ACME')
  })
  it('a symbol mention alone is NOT important — that was the firehose', () => {
    const r = heuristicScore('What NVDA investors should know', ['NVDA'])
    expect(r.score).toBeLessThan(NEWS_PING_MIN)
  })
  it('score is clamped to 0..100', () => {
    const r = heuristicScore('merger acquisition buyout halted fraud SEC probe recall lawsuit warns', ['A', 'B'])
    expect(r.score).toBeLessThanOrEqual(100)
  })
})

describe('parseTriage', () => {
  it('parses a plain JSON array and clamps scores', () => {
    expect(parseTriage('[{"i":0,"score":140,"why":"x"},{"i":1,"score":30,"why":"y"}]', 2)).toEqual([
      { i: 0, score: 100, why: 'x' },
      { i: 1, score: 30, why: 'y' },
    ])
  })
  it('tolerates code fences and surrounding prose', () => {
    const raw = 'Sure! Here you go:\n```json\n[{"i":0,"score":80,"why":"halt"}]\n```'
    expect(parseTriage(raw, 1)).toEqual([{ i: 0, score: 80, why: 'halt' }])
  })
  it('drops out-of-range indices and junk items; garbage → []', () => {
    expect(parseTriage('[{"i":5,"score":50},{"i":"a"},null,{"i":0,"score":60}]', 2)).toEqual([{ i: 0, score: 60, why: '' }])
    expect(parseTriage('no json here', 3)).toEqual([])
  })
})

describe('triageNews', () => {
  it('empty in → empty out, no throw', async () => {
    expect(await triageNews([], 1000)).toEqual([])
  })
  it('falls back to the heuristic when no LLM provider is configured (test env)', async () => {
    const out = await triageNews([{ title: 'ACME wins FDA approval', url: 'u1', syms: ['ACME'] }], 1234)
    expect(out).toHaveLength(1)
    expect(out[0].at).toBe(1234)
    expect(out[0].score).toBeGreaterThan(0) // scored by the heuristic — desk still ranks with no provider
  })
})
