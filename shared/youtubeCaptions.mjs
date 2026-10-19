// Shared by the server and the dependency-free Mac runner. Keep format and
// URL handling identical: the runner used to carry a second, stale parser.
export function videoIdFrom(value) {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null
    const host = url.hostname.toLowerCase()
    let id = null
    if (host === 'youtu.be') id = url.pathname.split('/')[1]
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'www.youtube-nocookie.com', 'youtube-nocookie.com'].includes(host)) {
      id = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)\/?$/)?.[1]
    }
    return typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null
  } catch { return null }
}

export const canonicalVideoUrl = value => {
  const id = videoIdFrom(value)
  return id ? `https://www.youtube.com/watch?v=${id}` : null
}

export const videoKey = value => videoIdFrom(value) ?? value

export function pickTrack(tracks) {
  return tracks.find(t => t.languageCode?.toLowerCase().startsWith('en') && t.kind !== 'asr')
    ?? tracks.find(t => t.languageCode?.toLowerCase().startsWith('en')) ?? tracks[0] ?? null
}

const decode = text => text.replace(/&(?:amp|quot|apos|lt|gt|nbsp|#\d+|#x[\da-f]+);/gi, entity => {
  const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' }
  if (named[entity.toLowerCase()] != null) return named[entity.toLowerCase()]
  const n = entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1))
  return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ''
})

/** Preserve provider timecodes. Missing/invalid timestamps stay missing. */
export function parseCaptionSegments(body) {
  const rows = []
  const add = (text, startSec, durationSec) => {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean) return
    const timed = Number.isFinite(startSec) && startSec >= 0
    rows.push({ text: clean, ...(timed ? { startSec, endSec: startSec + (Number.isFinite(durationSec) && durationSec >= 0 ? durationSec : 0) } : {}) })
  }
  if (body.trimStart().startsWith('{')) {
    try {
      const data = JSON.parse(body)
      for (const event of Array.isArray(data.events) ? data.events : []) {
        const text = (Array.isArray(event.segs) ? event.segs : []).map(s => typeof s.utf8 === 'string' ? s.utf8 : '').join('')
        add(text, typeof event.tStartMs === 'number' ? event.tStartMs / 1000 : NaN, event.dDurationMs / 1000)
      }
    } catch { return [] }
  } else {
    for (const match of body.matchAll(/<(p|text)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
      const attr = name => {
        const value = match[2].match(new RegExp('\\b' + name + '=["\']([^"\']+)["\']'))?.[1]
        return value == null ? NaN : Number(value)
      }
      const ms = match[1].toLowerCase() === 'p'
      add(decode(match[3].replace(/<br\s*\/?\s*>/gi, ' ').replace(/<[^>]+>/g, '')), attr(ms ? 't' : 'start') / (ms ? 1000 : 1), attr(ms ? 'd' : 'dur') / (ms ? 1000 : 1))
    }
  }
  return rows
}

export function parseTimedText(body) {
  return parseCaptionSegments(body).map(s => s.text).join(' ')
}

export async function fetchCaptionTranscript(videoUrl, fetchFn = fetch) {
  const id = videoIdFrom(videoUrl)
  if (!id) return { fail: 'bad-url' }
  const ua = 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip'
  try {
    const res = await fetchFn('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json', 'user-agent': ua },
      body: JSON.stringify({ context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en' } }, videoId: id }),
    })
    if (!res.ok) return { fail: `innertube HTTP ${res.status}` }
    const data = await res.json()
    const tracks = data.captions?.playerCaptionsTracklistRenderer?.captionTracks
    const track = pickTrack(Array.isArray(tracks) ? tracks : [])
    if (!track?.baseUrl) return { fail: 'no-caption-tracks' }
    const cap = await fetchFn(track.baseUrl, { headers: { 'user-agent': ua }, signal: AbortSignal.timeout(15_000) })
    if (!cap.ok) return { fail: `timedtext HTTP ${cap.status}` }
    const segments = parseCaptionSegments(await cap.text())
    const text = segments.map(s => s.text).join(' ')
    return text.length >= 100 ? { text, segments, language: track.languageCode ?? 'und', automatic: track.kind === 'asr' } : { fail: 'caption-body-too-short' }
  } catch (error) {
    return { fail: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'caption-timeout' : 'caption-fetch-failed' }
  }
}
