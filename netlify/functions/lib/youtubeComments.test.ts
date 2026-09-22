import { describe, expect, it, vi } from 'vitest'
import { audiencePrompt, fetchYouTubeCommentSample } from './youtubeComments'

describe('YouTube comment sampling', () => {
  it('uses the official endpoint and keeps only bounded text plus aggregates', async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ items: [
      { snippet: { totalReplyCount: 3, topLevelComment: { snippet: { textDisplay: '  Bullish   setup ', likeCount: 7 } } } },
      { snippet: { totalReplyCount: 1, topLevelComment: { snippet: { textDisplay: 'What invalidates it?', likeCount: 2 } } } },
    ] })))
    const sample = await fetchYouTubeCommentSample('https://youtube.com/watch?v=abcdefghijk', 'yt-key', fetchFn as unknown as typeof fetch)
    expect(sample).toEqual({ texts: ['Bullish setup', 'What invalidates it?'], sampled: 2, likes: 9, replies: 4 })
    expect(fetchFn.mock.calls[0][0]).toContain('commentThreads')
    expect(audiencePrompt(sample)).toContain('untrusted reported content')
  })
})
