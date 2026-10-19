import { describe, expect, it, vi } from 'vitest'
import { extractTranscriptFacts, transcriptChunks } from './videoTranscriptAnalysis'

const meta = { url: 'https://youtu.be/abcdefghijk', title: 'Market', channel: 'Source', at: 100 }

describe('complete transcript analysis', () => {
  it('includes a ticker discussed after the old 24000-character cutoff and merges repeats', async () => {
    const text = 'NVDA support is 180. '.repeat(1300) + 'Rocket Lab is bullish at 20.'
    const call = vi.fn(async (prompt: string) => JSON.stringify({ tickers: prompt.includes('Rocket Lab is bullish at 20.')
      ? [{ sym: 'RDW', company: 'Rocket Lab', stance: 'bull', levels: [20] }, { sym: 'NVDA', stance: 'bear', levels: [190] }]
      : [{ sym: 'NVDA', stance: 'bull', levels: [180] }], themes: ['space'] }))
    const got = await extractTranscriptFacts(text, meta, '', call)
    expect(call).toHaveBeenCalledTimes(2)
    expect(got?.tickers.find(t => t.sym === 'RKLB')?.levels).toEqual([20])
    expect(got?.tickers.filter(t => t.sym === 'NVDA')).toHaveLength(1)
    expect(got?.tickers.find(t => t.sym === 'NVDA')).toMatchObject({ stance: 'neutral', levels: [180, 190] })
  })
  it('never publishes an incomplete read if any chunk is malformed', async () => {
    const call = vi.fn().mockResolvedValueOnce('{"tickers":[],"themes":[]}').mockResolvedValueOnce('truncated json')
    expect(await extractTranscriptFacts('a'.repeat(25000), meta, '', call)).toBeNull()
  })
  it('covers all characters with overlapping chunks', () => {
    const input = 'a'.repeat(60000) + 'last word'
    const chunks = transcriptChunks(input)
    expect(chunks.at(-1)).toMatch(/last word$/)
    expect(chunks.every(c => c.length <= 24000)).toBe(true)
  })
})
