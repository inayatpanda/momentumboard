// /api/video-transcripts — the Mac runner's two doors: `GET ?pending=1` lists
// inbox videos still missing a transcript, `POST` submits one. Guarded by its
// OWN token (TRANSCRIPT_TOKEN): the shared free-tier licence must never be able
// to write transcripts, and the runner must not need the admin master.

import { beforeEach, describe, expect, it } from 'vitest'
import { memoryStore } from './lib/store'
import type { AppStore } from './lib/storeProvider'
import type { VideoTranscript } from './lib/videoTranscriptStore'
import { routeVideoTranscripts } from './video-transcripts.mts'

const ENV = { TRANSCRIPT_TOKEN: 'runner-secret' }
const auth = new Headers({ 'x-transcript-token': 'runner-secret' })
const Y = (id: string) => `https://www.youtube.com/watch?v=${id}`

let store: AppStore
beforeEach(() => {
  store = memoryStore()
})

const get = (qs: string, headers = auth, env: Record<string, string | undefined> = ENV) =>
  routeVideoTranscripts(headers, 'GET', new URLSearchParams(qs), null, env, store)
const post = (body: unknown, headers = auth, env: Record<string, string | undefined> = ENV) =>
  routeVideoTranscripts(headers, 'POST', new URLSearchParams(), JSON.stringify(body), env, store)

describe('auth', () => {
  it('401s a wrong token, a missing token, and — critically — an UNSET server secret', async () => {
    expect((await get('pending=1', new Headers({ 'x-transcript-token': 'wrong' }))).status).toBe(401)
    expect((await get('pending=1', new Headers())).status).toBe(401)
    // no TRANSCRIPT_TOKEN configured ⇒ the door does not exist, it is not open
    expect((await get('pending=1', auth, {})).status).toBe(401)
  })
})

describe('GET ?pending=1', () => {
  it('lists inbox videos missing a transcript, newest first, capped at 20', async () => {
    const inbox = Array.from({ length: 25 }, (_, i) => ({ url: Y(`v${String(i).padStart(10, '0')}`), title: `t${i}`, channel: 'c', at: 1000 + i }))
    await store.write('video-inbox', inbox)
    await store.write('video-transcripts', [{ url: inbox[24].url, title: '', channel: '', text: 'x'.repeat(200), source: 'local', at: 2000 }])
    const res = await get('pending=1')
    const j = (await res.json()) as { ok: boolean; data: { url: string }[] }
    expect(j.ok).toBe(true)
    expect(j.data).toHaveLength(20)
    // newest first, and the transcribed one (index 24) is not offered again
    expect(j.data[0].url).toBe(inbox[23].url)
    expect(j.data.some(v => v.url === inbox[24].url)).toBe(false)
  })

  it('an empty inbox answers with an empty list, not an error', async () => {
    const j = (await (await get('pending=1')).json()) as { ok: boolean; data: unknown[] }
    expect(j).toEqual({ ok: true, data: [] })
  })
})

describe('POST', () => {
  const sub = { url: Y('abcdefghijk'), title: 'NVDA levels', channel: 'Josh', text: 'word '.repeat(60), source: 'local' }

  it('stores a submission and reports which door it came in by', async () => {
    const res = await post(sub)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('stored')
    const rows = (await store.read<VideoTranscript[]>('video-transcripts'))!
    expect(rows[0].url).toBe(sub.url)
    expect(rows[0].source).toBe('local')
    expect(rows[0].at).toBeGreaterThan(1_700_000_000)
  })

  it('is idempotent: a duplicate url answers already and stores once', async () => {
    await post(sub)
    const res = await post(sub)
    expect(await res.text()).toBe('already')
    expect((await store.read<VideoTranscript[]>('video-transcripts'))!).toHaveLength(1)
  })

  it('rejects a non-YouTube url and a transcript too short to be one', async () => {
    expect((await post({ ...sub, url: 'https://evil.example/x' })).status).toBe(400)
    expect((await post({ ...sub, text: 'too short' })).status).toBe(400)
    expect((await post(null)).status).toBe(400)
  })

  it('only the runner source is accepted over this door', async () => {
    // 'free'/'supadata' are written by the worker directly — a POST claiming
    // them would fake the health line's rung attribution
    const res = await post({ ...sub, source: 'supadata' })
    const rows = (await store.read<VideoTranscript[]>('video-transcripts'))!
    expect(res.status).toBe(200)
    expect(rows[0].source).toBe('local')
  })
})
