import { describe, expect, it } from 'vitest'
import { fetchSparkCloses, parseSpark } from './spark'

const sparkJson = {
  AAPL: { timestamp: [1, 2, 3], close: [230.1, null, 232.5] },
  glw: { timestamp: [1, 2, 3], close: [48.2, 41.9, 42.7] },
  BAD: 'not-a-series',
}

describe('parseSpark', () => {
  it('maps symbols to close series, upper-cased, dropping nulls and junk', () => {
    const m = parseSpark(sparkJson)
    expect(m.get('AAPL')).toEqual([230.1, 232.5])
    expect(m.get('GLW')).toEqual([48.2, 41.9, 42.7])
    expect(m.has('BAD')).toBe(false)
  })
  it('returns empty map on garbage', () => {
    expect(parseSpark(null).size).toBe(0)
    expect(parseSpark({ finance: {} }).size).toBe(0)
  })
})

describe('fetchSparkCloses', () => {
  it('chunks at 20, each chunk carries the right symbols, dedupes input', async () => {
    const urls: string[] = []
    const fetchFn = (async (url: string) => {
      urls.push(url)
      return { ok: true, json: async () => ({}) }
    }) as unknown as typeof fetch
    const syms = [...Array.from({ length: 44 }, (_, i) => `s${i}`), 'S0', 'S1'] // dupes of s0/s1
    await fetchSparkCloses(syms, fetchFn)
    expect(urls).toHaveLength(3)
    const symsOf = (u: string) => decodeURIComponent(u.split('symbols=')[1].split('&')[0]).split(',')
    expect(symsOf(urls[0])).toHaveLength(20)
    expect(symsOf(urls[1])).toHaveLength(20)
    expect(symsOf(urls[2])).toEqual(['S40', 'S41', 'S42', 'S43']) // 44 unique after dedupe
    expect(new Set(urls.flatMap(symsOf)).size).toBe(44)
  })
  it('fails soft: a rejected chunk is skipped, others survive', async () => {
    let call = 0
    const fetchFn = (async () => {
      call += 1
      if (call === 1) throw new Error('boom')
      return { ok: true, json: async () => ({ B2: { close: [3] } }) }
    }) as unknown as typeof fetch
    const m = await fetchSparkCloses(Array.from({ length: 25 }, (_, i) => `s${i}`), fetchFn)
    expect(m.get('B2')).toEqual([3])
  })
})
