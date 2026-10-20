import { describe, expect, it, vi } from 'vitest'
import { parseYouTubeAvailability, youtubeAvailability } from './youtubeAvailability'

const html = (player: unknown) => `<script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script>`
describe('YouTube availability before spending a read', () => {
  it('defers upcoming and live videos, but accepts completed livestreams', () => {
    expect(parseYouTubeAvailability(html({ playabilityStatus: { status: 'LIVE_STREAM_OFFLINE' } }), 'abcdefghijk')).toEqual({ state: 'upcoming' })
    expect(parseYouTubeAvailability(html({ videoDetails: { isUpcoming: true } }), 'abcdefghijk').state).toBe('upcoming')
    expect(parseYouTubeAvailability(html({ microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: true } } } }), 'abcdefghijk').state).toBe('live')
    expect(parseYouTubeAvailability(html({ videoDetails: { videoId: 'abcdefghijk', isLiveContent: true, lengthSeconds: '117' } }), 'abcdefghijk')).toEqual({ state: 'ready', durationSeconds: 117 })
  })
  it('ignores recommendations, other videos and braces within JSON strings', () => {
    const page = html({ videoDetails: { videoId: 'abcdefghijk', lengthSeconds: '52', title: 'A } brace and "quote"' } }) + '{"isUpcoming":true}'
    expect(parseYouTubeAvailability(page, 'abcdefghijk')).toEqual({ state: 'ready', durationSeconds: 52 })
    expect(parseYouTubeAvailability(page, 'zzzzzzzzzzz')).toEqual({ state: 'unknown' })
    expect(parseYouTubeAvailability('Sign in to continue', 'abcdefghijk')).toEqual({ state: 'unknown' })
  })
  it('treats blocked metadata as unknown without fabricating readiness', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 403 }))
    expect(await youtubeAvailability('https://youtu.be/abcdefghijk', fetcher as typeof fetch)).toEqual({ state: 'unknown' })
  })
})
