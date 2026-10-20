import { canonicalVideoUrl, videoKey } from '../../../shared/youtubeCaptions.mjs'

export type YouTubeAvailability = { state: 'unknown' | 'upcoming' | 'live' | 'ready' | 'unavailable'; durationSeconds?: number }

/** Structured page metadata can remain available when player details are absent.
 * Bind it to the page's canonical video, never a recommendation's duration. */
function pageDuration(html: string, id: string): YouTubeAvailability {
  const tags = html.match(/<(?:link|meta)\b[^>]*>/gi) ?? []
  const attrs = tags.map(tag => Object.fromEntries([...tag.matchAll(/([\w-]+)=["']([^"']*)["']/g)].map(m => [m[1].toLowerCase(), m[2]])))
  const canonical = attrs.find(a => a.rel === 'canonical')?.href
  if (!canonical || videoKey(canonical) !== id) return { state: 'unknown' }
  const duration = attrs.find(a => a.itemprop === 'duration')?.content
  const match = duration?.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/)
  const seconds = match ? Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0) : 0
  return Number.isFinite(seconds) && seconds > 0 ? { state: 'ready', durationSeconds: seconds } : { state: 'unknown' }
}

/** Parse only the main player's JSON, never recommendation cards or script code. */
export function parseYouTubeAvailability(html: string, id: string): YouTubeAvailability {
  const match = /(?:var\s+)?ytInitialPlayerResponse\s*=\s*(\{)/.exec(html)
  if (!match) return pageDuration(html, id)
  const start = match.index + match[0].length - 1
  let depth = 0, quoted = false, escaped = false
  for (let i = start; i < Math.min(html.length, start + 2_000_000); i++) {
    const c = html[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') quoted = false
    } else if (c === '"') quoted = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      try {
        const data = JSON.parse(html.slice(start, i + 1))
        const details = data.videoDetails ?? {}
        if (details.videoId && details.videoId !== id) return { state: 'unknown' }
        const live = data.microformat?.playerMicroformatRenderer?.liveBroadcastDetails
        if (details.isUpcoming || data.playabilityStatus?.status === 'LIVE_STREAM_OFFLINE') return { state: 'upcoming' }
        if (details.isLive || live?.isLiveNow === true) return { state: 'live' }
        const seconds = Number(details.lengthSeconds)
        return Number.isFinite(seconds) && seconds > 0
          ? { state: 'ready', durationSeconds: seconds } : pageDuration(html, id)
      } catch { return { state: 'unknown' } }
    }
  }
  return { state: 'unknown' }
}

export async function youtubeAvailability(url: string, fetchFn = fetch): Promise<YouTubeAvailability> {
  const canonical = canonicalVideoUrl(url)
  if (!canonical) return { state: 'unknown' }
  try {
    const response = await fetchFn(canonical, {
      headers: { 'user-agent': 'Mozilla/5.0', 'accept-language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(15_000),
    })
    if (response.ok) {
      const state = parseYouTubeAvailability(await response.text(), videoKey(url))
      if (state.state !== 'unknown') return state
    }
  } catch { /* The metadata endpoint may still work when watch pages are blocked. */ }
  try {
    const response = await fetchFn(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(canonical)}`, { signal: AbortSignal.timeout(15_000) })
    if (response.status === 404) return { state: 'unavailable' }
    if (!response.ok) return { state: 'unknown' }
    const data = await response.json()
    // Scheduled broadcasts can expose only an iframe, without the ordinary
    // title/author metadata. Defer these incomplete sources, without asserting
    // that every such response is an upcoming broadcast.
    if (data.type === 'video' && (!data.title || !data.author_name)) return { state: 'unavailable' }
  } catch { /* Unknown is not proof of unavailable content. */ }
  return { state: 'unknown' }
}
