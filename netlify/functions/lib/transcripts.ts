/** Supadata transcript fetch — the one paid-tier dependency in the trend
 * pipeline (free tier: 100/mo). Absent key → callers skip gracefully. */
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
