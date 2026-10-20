import { describe, expect, it, vi } from 'vitest'
import { memoryStore } from '../../netlify/functions/lib/store'
import { discoverFollowedVideos } from './discoverFollowedVideos'
import { videoIngestionHealth } from '../../netlify/functions/lib/videoIngestion'
import { withDefaults } from '../../shared/channels'

const now = Date.parse('2026-10-20T20:00:00Z') / 1000
const entry = (id: string, days: number) => `<entry><title>A stock update</title><link rel="alternate" href="https://www.youtube.com/watch?v=${id}"/><published>${new Date((now-days*86400)*1000).toISOString()}</published></entry>`
describe('selected channel discovery', () => {
  it('repairs only the two known bad defaults and retains custom subscriptions', () => {
    const channels = withDefaults([{ id: 'UCORi3Jj7kSHcdHdckrjhOsg', name: 'Tom Nash' }, { id: 'UCwMoQEGc4IqkuGLhJUkLwYQ', name: 'Humbled Trader' }, { id: 'custom', name: 'Custom' }])
    expect(channels.find(c => c.name === 'Tom Nash')?.id).toBe('UCJwKCyEIFHwUOPQQ-4kC1Zw')
    expect(channels.find(c => c.name === 'Humbled Trader')?.id).toBe('UCcIvNGMBSQWwo1v3n-ZRBCw')
    expect(channels.filter(c => c.name === 'Tom Nash')).toHaveLength(1)
    expect(channels).toContainEqual({ id: 'custom', name: 'Custom' })
    expect(withDefaults([{ id: 'UCORi3Jj7kSHcdHdckrjhOsg', name: 'Another person' }])).toContainEqual({ id: 'UCORi3Jj7kSHcdHdckrjhOsg', name: 'Another person' })
  })
  it('discovers uploads without a Mac, repairs metadata and reports failed feeds separately from quiet channels', async () => {
    const store = memoryStore()
    await store.write('config', { ytChannels: [{ id: 'UCORi3Jj7kSHcdHdckrjhOsg', name: 'Tom Nash' }] })
    await store.write('video-inbox', [{ url: 'https://youtu.be/abcdefghijk', title: 'Saved', channel: 'Tom Nash', at: now - 10 }])
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      const id = new URL(String(url)).searchParams.get('channel_id')
      if (id === 'UCJwKCyEIFHwUOPQQ-4kC1Zw') return new Response(`<feed>${entry('abcdefghijk',1)}${entry('abcdefghijl',2)}</feed>`)
      if (id === 'UCcIvNGMBSQWwo1v3n-ZRBCw') return new Response(`<feed>${entry('abcdefghijm',10)}</feed>`)
      if (id === 'UCddkjtql4LIVLct3tD4-3SQ') return new Response(`<feed>${entry('abcdefghijn',100)}</feed>`)
      return new Response('Unavailable', { status: 503 })
    })
    expect(await discoverFollowedVideos(store, now, fetcher)).toMatchObject({ added: 2, discovered: 3, checkedChannels: 9, unavailableChannels: 6 })
    const inbox = await store.read<any[]>('video-inbox')
    expect(inbox).toHaveLength(3)
    expect(inbox![0]).toMatchObject({ at: now - 10, publishedAt: now - 86400, channelId: 'UCJwKCyEIFHwUOPQQ-4kC1Zw' })
    expect((await discoverFollowedVideos(store, now + 60, fetcher)).added).toBe(0)
    const health = await videoIngestionHealth(store, [], now)
    expect(health.channels.find(c => c.name === 'Humbled Trader')).toMatchObject({ discovered: 1, awaitingCapture: 1, feed: { status: 'ok' } })
    expect(health.channels.find(c => c.name === 'Stocks with Josh')).toMatchObject({ feed: { status: 'unavailable' } })
    expect(health.channels.find(c => c.name === 'Grandmaster Obi')).toMatchObject({ discovered: 0, feed: { status: 'ok', latestPublishedAt: now - 100*86400 } })
  })
})
