import { describe, it, expect, vi } from 'vitest'
import { routeVideoAnalyze, type VideoAnalysis } from '../video-analyze-background.mts'
import { memoryStore } from './store'

const env = { APP_TOKEN: 'app', REPORT_TOKEN: 'rep' }
const auth = new Headers({ 'x-app-token': 'app' })
const body = (url: string) => JSON.stringify({ url, title: 'TSLA levels', channel: 'Stocks with Josh' })

describe('video analysis', () => {
  it('requires a token and a youtube url', async () => {
    expect((await routeVideoAnalyze(new Headers(), body('https://youtube.com/watch?v=x'), env, memoryStore())).status).toBe(401)
    expect((await routeVideoAnalyze(auth, JSON.stringify({ url: 'https://evil.com/v' }), env, memoryStore())).status).toBe(400)
  })

  it('analyzes, stores, and dedupes', async () => {
    const store = memoryStore()
    const watch = vi.fn(async () => 'TSLA discussed; support drawn at 180; bullish.')
    const first = await routeVideoAnalyze(auth, body('https://youtube.com/watch?v=a1'), env, store, watch)
    expect(first.status).toBe(200)
    const list = (await store.read<VideoAnalysis[]>('video-analyses'))!
    expect(list[0].analysis).toContain('support drawn at 180')
    // same url again: no second Gemini call
    await routeVideoAnalyze(auth, body('https://youtube.com/watch?v=a1'), env, store, watch)
    expect(watch).toHaveBeenCalledTimes(1)
  })

  it('enforces the daily cap', async () => {
    const store = memoryStore()
    const now = Math.floor(Date.now() / 1000)
    await store.write('video-analyses', [1, 2, 3].map(i => ({ url: `u${i}`, title: '', channel: '', analysis: 'x', at: now - 100 })))
    const watch = vi.fn(async () => 'y')
    const res = await routeVideoAnalyze(auth, body('https://youtube.com/watch?v=new'), env, store, watch)
    expect(await res.text()).toBe('daily-cap')
    expect(watch).not.toHaveBeenCalled()
  })
})
