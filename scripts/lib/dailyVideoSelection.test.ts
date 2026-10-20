import { describe, expect, it } from 'vitest'
import { memoryStore } from '../../netlify/functions/lib/store'
import { selectDailyVideos } from './dailyVideoSelection'
import type { NativeVideoWork } from './nativeVideoQueue'

const now = Date.parse('2026-10-21T10:00:00Z') / 1000
const work = (n: number, channel = `Channel ${n}`, publishedAt = now - n * 60): NativeVideoWork => ({
  video: { url: `https://youtu.be/abcdefgh${String(n).padStart(3, '0')}`, channel, channelId: channel, title: `Video ${n}`, publishedAt, at: now },
  nextOffset: 0, parts: [], stage: 'pending', attempts: 0, failures: 0, lastAttemptAt: 0, nextAttemptAt: 0, updatedAt: now,
})
describe('five recent videos from distinct channels', () => {
  it('selects at most five, rejects old/unknown/future uploads and parks the archive honestly', async () => {
    const store = memoryStore(), rows = [work(1), work(2,'Channel 1'), ...[3,4,5,6,7].map(n=>work(n)), work(8,'Old',now-90000), work(9,'Future',now+100), work(10)]
    rows.at(-1)!.video.publishedAt = undefined
    expect(await selectDailyVideos(store,rows,now)).toMatchObject({selectedToday:5,dailyVideoLimit:5})
    expect(rows.filter(w=>!w.parked).map(w=>w.video.title)).toEqual(['Video 1','Video 3','Video 4','Video 5','Video 6'])
    expect(rows.filter(w=>w.parked).every(w=>w.stage==='pending')).toBe(true)
    expect(await selectDailyVideos(store,rows,now+3600)).toMatchObject({selectedToday:5})
    expect(rows.filter(w=>!w.parked)).toHaveLength(5)
  })
  it('finishes selected videos across midnight without reopening old unselected partial reads', async () => {
    const store = memoryStore(), rows = [1,2,3,4,5].map(n=>work(n))
    await selectDailyVideos(store,rows,now)
    const oldPartial=work(7,'Other',now-90000);oldPartial.stage='partial';oldPartial.nextOffset=600
    rows.push(oldPartial,work(8,'New',now+86000))
    await selectDailyVideos(store,rows,now+86400)
    expect(rows.filter(w=>!w.parked)).toHaveLength(5)
    expect(rows.find(w=>w.video.title==='Video 8')!.parked).toBe(true)
    expect(oldPartial.parked).toBe(true)
  })
  it('rotates previously unserved channels ahead of yesterday’s channels', async () => {
    const store=memoryStore(), rows=[1,2,3,4,5].map(n=>work(n))
    await selectDailyVideos(store,rows,now)
    rows.forEach(w=>w.stage='complete')
    rows.push(work(11,'Channel 1',now+86399),work(12,'Channel 6',now+86000))
    await selectDailyVideos(store,rows,now+86400)
    const plan=await store.read<{ids:string[]}>('video-reading-plan:v1')
    expect(plan!.ids.slice(0,2)).toEqual(['abcdefgh012','abcdefgh011'])
  })
})
