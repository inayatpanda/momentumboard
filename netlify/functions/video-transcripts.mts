import { enqueueSocialJobs } from './lib/socialJobs'
// /api/video-transcripts — the free-transcript door (owner directive,
// 2026-08-16). The caption scrape works fine from a residential IP and almost
// never from a datacenter one (30 days of EXTRACT-HEALTH: free=0), so a tiny
// runner on the owner's Mac does the fetching and this endpoint is its two
// doors: `GET ?pending=1` for "which videos still need words", `POST` to hand
// a transcript in. The pipeline (video-analyze-background.mts) reads the store
// FIRST, which is what starves the Gemini video-watch rung down to a fallback.
//
// Auth is a DEDICATED secret. The shared free-tier licence must never write
// transcripts, and the runner should hold neither the admin master nor the
// publish token — a leaked runner token can, at worst, feed us captions.

import { appStore as blobAppStore, type AppStore } from './lib/storeProvider'
import { readTranscriptIndex, saveTranscript, validatedSegments } from './lib/videoTranscriptStore'
import { canonicalVideoUrl, videoKey } from '../../shared/youtubeCaptions.mjs'

export interface InboxVideo {
  url: string
  title: string
  channel: string
  at: number
}

interface Env {
  TRANSCRIPT_TOKEN?: string
}

const PENDING_CAP = 20
const MIN_TEXT_CHARS = 100
interface LocalAttempt { id: string; at: number; attempts: number; nextAt: number }
const LOCAL_ATTEMPTS = 'video-local-capture-attempts'

export async function routeVideoTranscripts(
  headers: Headers,
  method: string,
  query: URLSearchParams,
  bodyText: string | null,
  env: Env,
  store: AppStore,
): Promise<Response> {
  // an UNSET secret means the door does not exist — never an open door
  if (!env.TRANSCRIPT_TOKEN || headers.get('x-transcript-token') !== env.TRANSCRIPT_TOKEN) {
    return new Response('unauthorized', { status: 401 })
  }

  if (method === 'GET' && query.get('pending') === '1') {
    const inbox = (await store.read<InboxVideo[]>('video-inbox')) ?? []
    // The inbox is a recent display window; unfinished durable jobs must remain
    // capture candidates even after 200 newer videos have arrived.
    const jobs = await store.read<import('./lib/socialJobs').SocialJob[]>('social-jobs:v1') ?? []
    const candidates = [...new Map([...inbox, ...jobs.filter(j => j.mode === 'extract' && j.stage !== 'complete')].map(v => [videoKey(v.url), v])).values()]
    const done = new Set((await readTranscriptIndex(store)).map(t => videoKey(t.url)))
    const attempts = new Map((await store.read<LocalAttempt[]>(LOCAL_ATTEMPTS) ?? []).map(a => [a.id, a]))
    const now = Math.floor(Date.now() / 1000)
    const candidatesDue = candidates
      .filter(v => canonicalVideoUrl(v.url) && !done.has(videoKey(v.url)) && (attempts.get(videoKey(v.url))?.nextAt ?? 0) <= now)
      .sort((a, b) => (attempts.get(videoKey(a.url))?.at ?? 0) - (attempts.get(videoKey(b.url))?.at ?? 0) || b.at - a.at)
      .slice(0, 35)
    const pending: InboxVideo[] = []
    for (const video of candidatesDue) {
      // Old words may have rolled out of the lightweight index. Do not
      // download them again; the analysis worker can read the durable key.
      if (!await store.read(`video-transcript:${videoKey(video.url)}`)) pending.push(video)
      if (pending.length === PENDING_CAP) break
    }
    return Response.json({ ok: true, data: pending })
  }

  if (method === 'POST') {
    let body: { url?: string; title?: string; channel?: string; text?: string; status?: string; segments?: unknown; language?: string; automatic?: boolean; method?: string; saved?: number; unavailable?: number; buffered?: number; running?: boolean } | null
    try { body = bodyText ? JSON.parse(bodyText) : null } catch { return new Response('bad-json', { status: 400 }) }
    if (body?.status === 'runner-status') {
      const count = (n: unknown) => typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(10000, Math.floor(n))) : 0
      await store.write('video-local-runner', { at: Math.floor(Date.now() / 1000), running: body.running === true, saved: count(body.saved), unavailable: count(body.unavailable), buffered: count(body.buffered) })
      return new Response('runner-status-recorded')
    }
    const url = canonicalVideoUrl(body?.url)
    if (!body || !url) return new Response('bad-url', { status: 400 })
    if (body.status === 'unavailable') {
      const rows = await store.read<LocalAttempt[]>(LOCAL_ATTEMPTS) ?? []
      const id = videoKey(url), prior = rows.find(row => row.id === id), attempts = (prior?.attempts ?? 0) + 1
      const at = Math.floor(Date.now() / 1000)
      await store.write(LOCAL_ATTEMPTS, [...rows.filter(row => row.id !== id), { id, at, attempts, nextAt: at + Math.min(6 * 3600, 1800 * 2 ** Math.min(attempts - 1, 4)) }].slice(-400))
      return new Response('caption-retry-recorded')
    }
    if (typeof body.text !== 'string' || body.text.trim().length < MIN_TEXT_CHARS) return new Response('text-too-short', { status: 400 })
    if (body.text.length > 300_000) return new Response('text-too-long', { status: 413 })
    const outcome = await saveTranscript(store, {
      url,
      title: typeof body.title === 'string' ? body.title.slice(0, 500) : '',
      channel: typeof body.channel === 'string' ? body.channel.slice(0, 200) : '',
      text: body.text.trim(),
      segments: validatedSegments(body.segments, body.text),
      language: typeof body.language === 'string' ? body.language.slice(0, 20) : 'und',
      automatic: body.automatic === true,
      method: body.method === 'speech' ? 'speech' : 'captions',
      // this door only ever admits the Mac runner — a client-claimed source
      // would let a POST fake the health line's rung attribution
      source: 'local',
      at: Math.floor(Date.now() / 1000),
    })
    const inbox = await store.read<InboxVideo[]>('video-inbox') ?? []
    const discovered = inbox.find(v => videoKey(v.url) === videoKey(url))
    const jobs = await store.read<import('./lib/socialJobs').SocialJob[]>('social-jobs:v1') ?? []
    const needsWake = outcome === 'stored' || jobs.some(j => videoKey(j.url) === videoKey(url) && j.stage !== 'complete')
    await enqueueSocialJobs(store, [{ ...(discovered ?? {}), url, title: typeof body.title === 'string' ? body.title.slice(0, 500) : '', channel: typeof body.channel === 'string' ? body.channel.slice(0, 200) : '', mode: 'extract' }], Math.floor(Date.now() / 1000), needsWake)
    return new Response(outcome, { status: 200 })
  }

  return new Response('method-not-allowed', { status: 405 })
}

export default async (req: Request) => {
  const url = new URL(req.url)
  return routeVideoTranscripts(
    req.headers,
    req.method,
    url.searchParams,
    req.method === 'POST' ? await req.text() : null,
    { TRANSCRIPT_TOKEN: process.env.TRANSCRIPT_TOKEN },
    blobAppStore,
  )
}
