// The transcript store (owner directive, 2026-08-16: "we need the transcript
// thats all from all videos"). Transcripts arrive from whichever rung got them
// — the Mac runner ('local', a residential IP the caption endpoint actually
// answers), the in-worker scrape ('free'), or Supadata — and land here once,
// deduped by url. `video-transcripts` is the rolling recent window the
// pipeline reads; `video-transcripts:YYYY-MM` keeps everything.

import type { AppStore } from './storeProvider'

export interface VideoTranscript {
  url: string
  title: string
  channel: string
  text: string
  source: 'local' | 'free' | 'supadata'
  at: number
}

export interface InboxVideo {
  url: string
  title: string
  channel: string
  at: number
}

const RECENT_KEY = 'video-transcripts'
const INBOX_KEY = 'video-inbox'
const RECENT_CAP = 200

/** Record every discovered video in the inbox the Mac runner polls. alert-check
 * calls this with ALL of a cycle's new videos — unlike the extract queue there
 * is no per-cycle slice, because "all videos" is the whole point of the list.
 * Returns how many were actually new; an empty or fully-known batch costs no
 * store write at all (alert-check runs inside a 50-subrequest budget). */
export async function recordInboxVideos(store: AppStore, videos: { url: string; title: string; channel: string }[], nowSec: number): Promise<number> {
  // YouTube only: the pundit bridge's video list can carry article links
  // (seen live: stockmarketloop.com), and a url the runner can never
  // transcribe would occupy a pending slot on every poll, forever
  const eligible = videos.filter(v => /youtube\.com|youtu\.be/.test(v.url))
  if (!eligible.length) return 0
  const inbox = (await store.read<InboxVideo[]>(INBOX_KEY)) ?? []
  const known = new Set(inbox.map(v => v.url))
  const fresh = eligible.filter(v => !known.has(v.url))
  if (!fresh.length) return 0
  for (const v of fresh) inbox.push({ url: v.url, title: v.title, channel: v.channel, at: nowSec })
  await store.write(INBOX_KEY, inbox.slice(-RECENT_CAP))
  return fresh.length
}

export async function readStoredTranscript(store: AppStore, url: string): Promise<VideoTranscript | null> {
  const rows = (await store.read<VideoTranscript[]>(RECENT_KEY)) ?? []
  return rows.find(r => r.url === url) ?? null
}

/** First writer wins: a re-submit of a url we already hold is a no-op, so a
 * runner retry can never clobber the transcript the pipeline already used. */
export async function saveTranscript(store: AppStore, rec: VideoTranscript): Promise<'stored' | 'already'> {
  const rows = (await store.read<VideoTranscript[]>(RECENT_KEY)) ?? []
  if (rows.some(r => r.url === rec.url)) return 'already'
  rows.push(rec)
  await store.write(RECENT_KEY, rows.slice(-RECENT_CAP))
  const monthKey = `${RECENT_KEY}:${new Date(rec.at * 1000).toISOString().slice(0, 7)}`
  const archive = (await store.read<VideoTranscript[]>(monthKey)) ?? []
  archive.push(rec)
  await store.write(monthKey, archive)
  return 'stored'
}
