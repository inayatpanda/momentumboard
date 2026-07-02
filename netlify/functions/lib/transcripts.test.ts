import { describe, it, expect, vi } from 'vitest'
import { videoIdFrom, pickTrack, parseTimedText, fetchTranscriptAny } from './transcripts'

describe('videoIdFrom', () => {
  it('extracts ids from watch, short and shorts urls', () => {
    expect(videoIdFrom('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
    expect(videoIdFrom('https://youtu.be/dQw4w9WgXcQ?t=1')).toBe('dQw4w9WgXcQ')
    expect(videoIdFrom('https://example.com/nope')).toBeNull()
  })
})

describe('pickTrack', () => {
  it('prefers human english captions over auto-generated', () => {
    const tracks = [
      { baseUrl: 'a', languageCode: 'en', kind: 'asr' },
      { baseUrl: 'b', languageCode: 'en' },
    ]
    expect(pickTrack(tracks)).toEqual(tracks[1])
    expect(pickTrack([])).toBeNull()
  })
})

describe('parseTimedText', () => {
  it('parses timedtext xml into clean text with entities decoded', () => {
    const xml = `<?xml version="1.0"?><timedtext format="3"><body><p t="0" d="100">NVDA&#39;s base is</p><p t="100"><s>holding &amp;</s> building</p></body></timedtext>`
    expect(parseTimedText(xml)).toBe("NVDA's base is holding & building")
  })
})

describe('fetchTranscriptAny', () => {
  it('falls back to supadata when the free scrape finds nothing', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('youtubei')) return new Response('{}') // no captions from the free route
      if (url.includes('supadata')) return new Response(JSON.stringify({ content: 'paid transcript text' }))
      return new Response('', { status: 404 })
    })
    const got = await fetchTranscriptAny('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'sk-key', fetchFn as never)
    expect(got).toEqual({ text: 'paid transcript text', source: 'supadata' })
  })
  it('returns null with no captions and no key', async () => {
    const fetchFn = vi.fn(async () => new Response('<html></html>'))
    expect(await fetchTranscriptAny('https://youtu.be/dQw4w9WgXcQ', undefined, fetchFn as never)).toBeNull()
  })
})
