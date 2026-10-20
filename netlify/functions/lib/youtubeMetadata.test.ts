import { describe, expect, it, vi } from 'vitest'
import { memoryStore } from './store'
import { parseVideoDuration, publicVideoMetadata } from './youtubeMetadata'

describe('public source duration', () => {
  it('parses durations without confusing zero or malformed input with an ending', () => {
    expect(parseVideoDuration('PT17M42S')).toBe(1062)
    expect(parseVideoDuration('P1DT2H3M4S')).toBe(93784)
    expect(parseVideoDuration('PT0S')).toBeUndefined()
    expect(parseVideoDuration('20 minutes')).toBeUndefined()
  })
  it('binds metadata to requested IDs, distinguishes streams and caches known durations', async () => {
    const store = memoryStore(), fetcher = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => Response.json({ items: [
      { id: 'abcdefghijk', contentDetails: { duration: 'PT27M' }, snippet: { liveBroadcastContent: 'none' } },
      { id: 'abcdefghijl', contentDetails: { duration: 'PT0S' }, snippet: { liveBroadcastContent: 'live' } },
      { id: 'zzzzzzzzzzz', contentDetails: { duration: 'PT3M' } },
    ] }))
    const urls = ['https://youtu.be/abcdefghijk', 'https://youtu.be/abcdefghijl']
    expect((await publicVideoMetadata(store, urls, 'test-key', 100, fetcher)).metadata).toMatchObject({ abcdefghijk: {state:'ready', durationSeconds:1620}, abcdefghijl: {state:'live'} })
    expect((await publicVideoMetadata(store, urls, 'test-key', 200, fetcher)).metadata).not.toHaveProperty('zzzzzzzzzzz')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(String(fetcher.mock.calls[0][0])).not.toContain('test-key')
  })
  it('does not mark an API setup failure as missing videos', async () => {
    const result = await publicVideoMetadata(memoryStore(), ['https://youtu.be/abcdefghijk'], 'key', 100, async () => new Response('', {status:403}))
    expect(result).toEqual({metadata:{},unavailable:true})
  })
})
