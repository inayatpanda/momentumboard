// The transcript store (owner directive, 2026-08-16: "we need the transcript
// thats all from all videos"). Transcripts arrive from whichever rung got them
// — the Mac runner ('local', a residential IP the caption endpoint actually
// answers), the in-worker scrape ('free'), or Supadata — and land here once,
// deduped by video identity. Full transcripts have individual durable keys;
// compact recent/monthly indexes track them. Legacy aggregates stay read-only.

import { acquireLease, releaseLease, type AppStore } from './storeProvider'
import { canonicalVideoUrl, videoKey, type CaptionSegment } from '../../../shared/youtubeCaptions.mjs'

export interface VideoTranscript {
  url: string
  title: string
  channel: string
  text: string
  source: 'local' | 'free' | 'supadata'
  at: number
  publishedAt?: number
  channelId?: string
  segments?: CaptionSegment[]
  language?: string
  automatic?: boolean
  method?: 'captions' | 'speech'
  version?: number
}

export interface InboxVideo {
  url: string
  title: string
  channel: string
  at: number
  publishedAt?: number
  channelId?: string
}

const RECENT_KEY = 'video-transcripts'
export const TRANSCRIPT_INDEX_KEY = 'video-transcript-index:v2'
export type TranscriptIndexRow = Omit<VideoTranscript, 'text' | 'segments'> & { characters: number }
const indexRow = ({ text, segments: _segments, ...meta }: VideoTranscript): TranscriptIndexRow => ({ ...meta, characters: text?.length ?? 0 })
const INBOX_KEY = 'video-inbox'
const RECENT_CAP = 200

/** Full words live under one key per video. Legacy archives remain intact.
 * Never rewrite a month's worth of transcripts on a small caption upload. */
export async function readTranscriptIndex(store: AppStore): Promise<TranscriptIndexRow[]> {
  const index = await store.read<TranscriptIndexRow[]>(TRANSCRIPT_INDEX_KEY)
  if (index) return index
  return ((await store.read<VideoTranscript[]>(RECENT_KEY)) ?? []).map(indexRow)
}

/** Record every discovered video in the inbox the Mac runner polls. alert-check
 * calls this with ALL of a cycle's new videos — unlike the extract queue there
 * is no per-cycle slice, because "all videos" is the whole point of the list.
 * Returns how many were actually new; an empty or fully-known batch costs no
 * store write at all (alert-check runs inside a 50-subrequest budget). */
export async function recordInboxVideos(store: AppStore, videos: Omit<InboxVideo, 'at'>[], nowSec: number): Promise<number> {
  // YouTube only: the pundit bridge's video list can carry article links
  // (seen live: stockmarketloop.com), and a url the runner can never
  // transcribe would occupy a pending slot on every poll, forever
  const eligible = videos.filter(v => canonicalVideoUrl(v.url))
  if (!eligible.length) return 0
  const inbox = (await store.read<InboxVideo[]>(INBOX_KEY)) ?? []
  const known = new Set(inbox.map(v => videoKey(v.url)))
  const fresh = eligible.filter(v => {
    const key = videoKey(v.url)
    if (known.has(key)) return false
    known.add(key)
    return true
  })
  if (!fresh.length) return 0
  for (const v of fresh) inbox.push({ ...v, url: canonicalVideoUrl(v.url)!, at: nowSec })
  await store.write(INBOX_KEY, inbox.slice(-RECENT_CAP))
  return fresh.length
}

export async function readStoredTranscript(store: AppStore, url: string): Promise<VideoTranscript | null> {
  const saved = await store.read<VideoTranscript>(`video-transcript:${videoKey(url)}`)
  if (saved) return saved
  const rows = (await store.read<VideoTranscript[]>(RECENT_KEY)) ?? []
  return rows.find(r => videoKey(r.url) === videoKey(url)) ?? null
}

/** Keep the original revision and permit a timing upgrade of the same words.
 * A changed transcript cannot silently rewrite evidence already published. */
export async function saveTranscript(store: AppStore, rec: VideoTranscript): Promise<'stored' | 'already'> {
  const lockKey = 'lease:video-transcripts'
  const token = await acquireLease(store, lockKey, Math.floor(Date.now() / 1000), 90)
  if (!token) throw new Error('transcript-store-busy')
  try {
    const rows = await readTranscriptIndex(store)
    const key = `video-transcript:${videoKey(rec.url)}`
    const old = await readStoredTranscript(store, rec.url)
    const upgrade = old && !old.segments?.some(s => s.startSec != null) && rec.segments?.some(s => s.startSec != null)
      && old.text.replace(/\s+/g, ' ').trim() === rec.text.replace(/\s+/g, ' ').trim()
    const saved = old && !upgrade ? old : upgrade ? { ...old, segments: rec.segments, language: rec.language, automatic: rec.automatic, version: 2 } : rec
    if (old && upgrade) await store.write(`${key}:v1`, old)
    await store.write(key, saved)
    // Repair both indexes even on an idempotent retry after a partial write.
    const meta = indexRow(saved)
    await store.write(TRANSCRIPT_INDEX_KEY, [...rows.filter(r => videoKey(r.url) !== videoKey(rec.url)), meta].sort((a, b) => a.at - b.at).slice(-RECENT_CAP))
    const monthKey = `${TRANSCRIPT_INDEX_KEY}:${new Date(saved.at * 1000).toISOString().slice(0, 7)}`
    const archive = (await store.read<TranscriptIndexRow[]>(monthKey)) ?? []
    await store.write(monthKey, [...archive.filter(r => videoKey(r.url) !== videoKey(rec.url)), meta])
    return old && !upgrade ? 'already' : 'stored'
  } finally { await releaseLease(store, lockKey, token) }
}

/** Accept only truthful segment/text alignment. Otherwise retain the words
 * without timestamps rather than attaching a quote to a made-up point. */
export function validatedSegments(value: unknown, text: string): CaptionSegment[] {
  if (!Array.isArray(value) || value.length > 30_000) return []
  const segments: CaptionSegment[] = []
  let previous = -1
  for (const row of value) {
    if (!row || typeof row.text !== 'string' || !row.text.trim()) return []
    if (row.startSec == null && row.endSec == null) { segments.push({ text: row.text.trim() }); continue }
    if (!Number.isFinite(row.startSec) || !Number.isFinite(row.endSec) || row.startSec < previous || row.startSec < 0 || row.endSec < row.startSec || row.endSec > 7 * 86400) return []
    previous = row.startSec
    segments.push({ text: row.text.trim(), startSec: row.startSec, endSec: row.endSec })
  }
  const normal = (s: string) => s.replace(/\s+/g, ' ').trim()
  return normal(segments.map(s => s.text).join(' ')) === normal(text) ? segments : []
}
