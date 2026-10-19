// The transcript store: the durable "we have the words" record the owner asked
// for (2026-08-16: "we need the transcript thats all from all videos"). One
// rolling recent list + monthly archives, deduped by url — the same shape
// video-extracts settled on.

import { describe, expect, it } from 'vitest'
import { memoryStore } from './store'
import { readStoredTranscript, recordInboxVideos, saveTranscript, type VideoTranscript } from './videoTranscriptStore'

const rec = (url: string, over: Partial<VideoTranscript> = {}): VideoTranscript => ({
  url,
  title: 'NVDA breakout',
  channel: 'Test Channel',
  text: 'x'.repeat(200),
  source: 'local',
  at: 1_760_000_000,
  ...over,
})

describe('videoTranscriptStore', () => {
  it('saves, reads back by url, and archives by month', async () => {
    const store = memoryStore()
    await saveTranscript(store, rec('https://youtube.com/watch?v=abcdefghijk'))
    const got = await readStoredTranscript(store, 'https://youtube.com/watch?v=abcdefghijk')
    expect(got?.text).toHaveLength(200)
    expect(got?.source).toBe('local')
    const month = new Date(1_760_000_000 * 1000).toISOString().slice(0, 7)
    const archive = (await store.read<VideoTranscript[]>(`video-transcripts:${month}`))!
    expect(archive).toHaveLength(1)
  })

  it('dedupes by url — a second save neither duplicates nor overwrites', async () => {
    const store = memoryStore()
    await saveTranscript(store, rec('https://youtube.com/watch?v=abcdefghijk', { text: 'first '.repeat(40) }))
    await saveTranscript(store, rec('https://youtube.com/watch?v=abcdefghijk', { text: 'second '.repeat(40) }))
    const rows = (await store.read<VideoTranscript[]>('video-transcripts'))!
    expect(rows).toHaveLength(1)
    expect(rows[0].text).toContain('first')
  })
  it('uses video identity across share, live and watch URLs', async () => {
    const store = memoryStore()
    await saveTranscript(store, rec('https://youtube.com/watch?v=abcdefghijk'))
    expect(await saveTranscript(store, rec('https://youtu.be/abcdefghijk?t=90'))).toBe('already')
    expect((await readStoredTranscript(store, 'https://www.youtube.com/live/abcdefghijk'))?.text).toHaveLength(200)
    expect(await recordInboxVideos(store, [{ url: 'https://youtu.be/abcdefghijk', title: '', channel: '' }, { url: 'https://youtube.com/watch?v=abcdefghijk', title: '', channel: '' }], 500)).toBe(1)
  })

  it('misses return null', async () => {
    expect(await readStoredTranscript(memoryStore(), 'https://youtube.com/watch?v=nope0000000')).toBeNull()
  })

  it('the rolling list is capped at 200, oldest dropped first', async () => {
    const store = memoryStore()
    for (let i = 0; i < 203; i++) await saveTranscript(store, rec(`https://youtube.com/watch?v=v${String(i).padStart(10, '0')}`, { at: 1_760_000_000 + i }))
    const rows = (await store.read<VideoTranscript[]>('video-transcripts'))!
    expect(rows).toHaveLength(200)
    expect(rows[0].url).toContain('v0000000003')
  })
})

describe('recordInboxVideos — the canonical "all videos" list', () => {
  const v = (url: string) => ({ url, title: 't', channel: 'c' })

  it('appends every new video ONCE, stamped, and returns how many were new', async () => {
    const store = memoryStore()
    const n = await recordInboxVideos(store, [v('https://youtube.com/watch?v=aaaaaaaaaaa'), v('https://youtube.com/watch?v=bbbbbbbbbbb')], 5000)
    expect(n).toBe(2)
    // a re-run with one repeat and one fresh url appends only the fresh one
    const n2 = await recordInboxVideos(store, [v('https://youtube.com/watch?v=aaaaaaaaaaa'), v('https://youtube.com/watch?v=ccccccccccc')], 6000)
    expect(n2).toBe(1)
    const inbox = (await store.read<{ url: string; at: number }[]>('video-inbox'))!
    expect(inbox.map(x => x.url.slice(-11))).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'])
    expect(inbox[0].at).toBe(5000)
    expect(inbox[2].at).toBe(6000)
  })

  it('an empty batch never touches the store', async () => {
    const store = memoryStore()
    let writes = 0
    const counting = { ...store, write: async (k: string, val: unknown) => (writes++, store.write(k, val)) }
    await recordInboxVideos(counting, [], 5000)
    expect(writes).toBe(0)
  })

  it('rolls at 200 like the transcripts themselves', async () => {
    const store = memoryStore()
    await recordInboxVideos(store, Array.from({ length: 205 }, (_, i) => v(`https://youtube.com/watch?v=n${String(i).padStart(10, '0')}`)), 5000)
    expect((await store.read<unknown[]>('video-inbox'))!).toHaveLength(200)
  })

  it('only YouTube urls enter the inbox — anything else would sit pending forever', async () => {
    // seen live on the first runner pass (2026-08-16): two stockmarketloop.com
    // articles rode the pundit bridge into the video list, the runner can never
    // transcribe them, and each occupied a pending slot on every poll
    const store = memoryStore()
    const n = await recordInboxVideos(store, [v('https://stockmarketloop.com/some-alert/'), v('https://youtube.com/watch?v=ddddddddddd')], 5000)
    expect(n).toBe(1)
    const inbox = (await store.read<{ url: string }[]>('video-inbox'))!
    expect(inbox).toHaveLength(1)
    expect(inbox[0].url).toContain('youtube')
  })
})
