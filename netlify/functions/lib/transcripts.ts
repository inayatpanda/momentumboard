/** Transcript chain: free scrape first (the same caption track the YouTube
 * player loads — what browser extensions like Glasp read), Supadata as the
 * paid fallback, null → callers degrade to titles. YouTube blocks datacenter
 * IPs unpredictably, so the free tier is best-effort by design. */

export function videoIdFrom(url: string): string | null {
  return url.match(/(?:v=|youtu\.be\/|\/shorts\/)([A-Za-z0-9_-]{11})/)?.[1] ?? null
}

/** Pick the best caption track: human english > auto english > first. */
export function pickTrack<T extends { languageCode?: string; kind?: string }>(tracks: T[]): T | null {
  const en = tracks.find(t => t.languageCode?.startsWith('en') && t.kind !== 'asr')
  const enAuto = tracks.find(t => t.languageCode?.startsWith('en'))
  return en ?? enAuto ?? tracks[0] ?? null
}

/** Parse YouTube timedtext XML (<p t="..">text</p>) into clean plain text. */
export function parseTimedText(xml: string): string {
  const parts: string[] = []
  for (const m of xml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)) {
    const text = m[1].replace(/<[^>]+>/g, '')
    if (text.trim()) parts.push(text)
  }
  return parts
    .join(' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

const log = (why: string): null => {
  console.log(`TRANSCRIPT: ${why}`)
  return null
}

/** Free tier: the InnerTube ANDROID player endpoint hands out caption URLs that
 * work without a proof-of-origin token (the watch-page route returns empty
 * bodies since YouTube's 2024 POT enforcement — verified). Best-effort: if
 * YouTube closes this too, the chain falls through to Supadata. */
export async function fetchTranscriptFree(videoUrl: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  try {
    const id = videoIdFrom(videoUrl)
    if (!id) return null
    const ANDROID_UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip'
    const res = await fetchFn('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': ANDROID_UA },
      body: JSON.stringify({ context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en' } }, videoId: id }),
    })
    // each failure mode logs one line — from the queue worker these land in the
    // Actions log, the only place a silent-null chain can ever be diagnosed
    if (!res.ok) return log(`innertube ${res.status}`)
    const j = (await res.json()) as { captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: { baseUrl: string; languageCode?: string; kind?: string }[] } } }
    const track = pickTrack(j.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [])
    if (!track) return log('no caption tracks (blocked IP or captions not generated yet)')
    const cap = await fetchFn(track.baseUrl, { headers: { 'user-agent': ANDROID_UA } })
    if (!cap.ok) return log(`timedtext ${cap.status}`)
    const text = parseTimedText(await cap.text())
    return text.length > 100 ? text : log(`caption body too short (${text.length} chars)`)
  } catch (e) {
    return log(`threw: ${String(e).slice(0, 120)}`)
  }
}

/** Supadata (paid fallback; free tier 100/mo). Absent key → callers skip gracefully. */
export async function fetchTranscript(videoUrl: string, apiKey: string, fetchFn: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchFn(`https://api.supadata.ai/v1/transcript?url=${encodeURIComponent(videoUrl)}&text=true`, {
      headers: { 'x-api-key': apiKey },
    })
    if (!res.ok) return null
    const j = (await res.json()) as { content?: string | { text: string }[] }
    if (typeof j.content === 'string') return j.content
    if (Array.isArray(j.content)) return j.content.map(c => c.text).join(' ')
    return null
  } catch {
    return null
  }
}

/** The chain: free scrape → Supadata (if keyed) → null. */
export async function fetchTranscriptAny(videoUrl: string, supadataKey: string | undefined, fetchFn: typeof fetch = fetch): Promise<{ text: string; source: 'free' | 'supadata' } | null> {
  const free = await fetchTranscriptFree(videoUrl, fetchFn)
  if (free) return { text: free, source: 'free' }
  if (supadataKey) {
    const paid = await fetchTranscript(videoUrl, supadataKey, fetchFn)
    if (paid) return { text: paid, source: 'supadata' }
  }
  return null
}
