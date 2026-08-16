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
import { saveTranscript, type VideoTranscript } from './lib/videoTranscriptStore'

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
    const done = new Set(((await store.read<VideoTranscript[]>('video-transcripts')) ?? []).map(t => t.url))
    const pending = inbox
      .filter(v => !done.has(v.url))
      .sort((a, b) => b.at - a.at)
      .slice(0, PENDING_CAP)
    return Response.json({ ok: true, data: pending })
  }

  if (method === 'POST') {
    const body = bodyText ? (JSON.parse(bodyText) as { url?: string; title?: string; channel?: string; text?: string } | null) : null
    if (!body?.url || !/youtube\.com|youtu\.be/.test(body.url)) return new Response('bad-url', { status: 400 })
    if (typeof body.text !== 'string' || body.text.trim().length < MIN_TEXT_CHARS) return new Response('text-too-short', { status: 400 })
    const outcome = await saveTranscript(store, {
      url: body.url,
      title: body.title ?? '',
      channel: body.channel ?? '',
      text: body.text.trim(),
      // this door only ever admits the Mac runner — a client-claimed source
      // would let a POST fake the health line's rung attribution
      source: 'local',
      at: Math.floor(Date.now() / 1000),
    })
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
