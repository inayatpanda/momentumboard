import { describe, it, expect, vi } from 'vitest'
import { videoIdFrom, canonicalVideoUrl, pickTrack, parseTimedText, fetchTranscript, fetchTranscriptAny } from './transcripts'

describe('videoIdFrom', () => {
  it('extracts ids from watch, short and shorts urls', () => {
    expect(videoIdFrom('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
    expect(videoIdFrom('https://youtu.be/dQw4w9WgXcQ?t=1')).toBe('dQw4w9WgXcQ')
    expect(videoIdFrom('https://example.com/nope')).toBeNull()
  })
  it('supports live/embed/mobile URLs and rejects hostname spoofing and partial IDs', () => {
    for (const url of ['https://www.youtube.com/live/dQw4w9WgXcQ', 'https://youtube.com/embed/dQw4w9WgXcQ', 'https://m.youtube.com/shorts/dQw4w9WgXcQ?si=foo']) {
      expect(canonicalVideoUrl(url)).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    }
    for (const url of ['https://evil.test/youtube.com?v=dQw4w9WgXcQ', 'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ', 'https://youtube.com/watch?v=dQw4w9WgXcQextra', 'javascript:youtube.com/watch?v=dQw4w9WgXcQ']) expect(videoIdFrom(url)).toBeNull()
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
  it('reads the legacy text-element format and numeric entities', () => {
    expect(parseTimedText('<transcript><text start="0">CoreWeave&#32;is &#x24;100 &amp; rising.</text><text>Next<br/>ticker.</text></transcript>')).toBe('CoreWeave is $100 & rising. Next ticker.')
  })
  it('reads JSON3 caption segments without treating HTML or errors as speech', () => {
    expect(parseTimedText(JSON.stringify({ events: [{ segs: [{ utf8: 'NVDA ' }, { utf8: 'support 180' }] }, { segs: [{ utf8: ' next level' }] }] }))).toBe('NVDA support 180 next level')
    expect(parseTimedText('<html><pseudotext>error</pseudotext></html>')).toBe('')
  })
})

describe('Supadata asynchronous transcripts', () => {
  it('polls 202 jobs, reads nested results, and requests native captions to bound costs', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(Response.json({ jobId: 'job-1' }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ status: 'active' }))
      .mockResolvedValueOnce(Response.json({ status: 'completed', result: { content: [{ text: 'NVDA support' }, { text: 'is 180.' }] } }))
    const wait = vi.fn(async () => {})
    expect(await fetchTranscript('https://youtu.be/dQw4w9WgXcQ', 'key', fetchFn, { wait })).toBe('NVDA support is 180.')
    expect(fetchFn.mock.calls[0][0]).toContain('mode=native')
    expect(fetchFn.mock.calls[1][0]).toBe('https://api.supadata.ai/v1/transcript/job-1')
    expect(wait).toHaveBeenCalledTimes(2)
  })
  it('bounds polling for jobs that never complete', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(Response.json({ jobId: 'job-1' }, { status: 202 }))
      .mockImplementation(async () => Response.json({ status: 'queued' }))
    expect(await fetchTranscript('https://youtu.be/dQw4w9WgXcQ', 'key', fetchFn, { attempts: 2, wait: async () => {} })).toBeNull()
    expect(fetchFn).toHaveBeenCalledTimes(3)
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
