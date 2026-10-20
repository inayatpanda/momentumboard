import { describe, expect, it, vi } from 'vitest'
import { readFreeVideoText } from './freeVideoText'

describe('free caption analysis response contract', () => {
  it('requests structured stock claims and accepts an honest empty analysis', async () => {
    const fetcher=vi.fn(async (_url: string | URL | Request, _opts?: RequestInit)=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:'{"tickers":[],"themes":[]}'}]}}]}))
    expect(await readFreeVideoText('public caption section','key',fetcher)).toBe('{"tickers":[],"themes":[]}')
    const body=JSON.parse(String(fetcher.mock.calls[0][1]!.body))
    expect(body.generationConfig.responseSchema.required).toEqual(['tickers','themes'])
    expect(body.generationConfig.responseSchema.properties.tickers.items.required).toContain('evidenceQuote')
    expect(body.generationConfig.responseSchema.properties.tickers.items.properties).toHaveProperty('facts')
  })
  it('rejects truncated output instead of claiming the transcript was covered', async () => {
    await expect(readFreeVideoText('caption','key',async()=>Response.json({candidates:[{finishReason:'MAX_TOKENS'}]}))).rejects.toThrow('native-incomplete-text')
  })
})
