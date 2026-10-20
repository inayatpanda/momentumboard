// Default followed YouTube channels (user-requested list, resolved 2026-07-02).
// Editable in Settings from stage 5; ids are stable channel IDs, not handles.
export const DEFAULT_CHANNELS: { id: string; name: string }[] = [
  { id: 'UCNttUtm9vloDjo-a2jqkoNQ', name: 'Stocks with Josh' },
  { id: 'UCUvvj5lwue7PspotMDjk5UA', name: 'Meet Kevin' },
  { id: 'UCnMn36GT_H0X-w5_ckLtlgQ', name: 'Financial Education' },
  { id: 'UChBVf9YnourrEDTsbbwJPRA', name: 'Everything Money' },
  { id: 'UCORi3Jj7kSHcdHdckrjhOsg', name: 'Tom Nash' },
  { id: 'UCwMoQEGc4IqkuGLhJUkLwYQ', name: 'Humbled Trader' },
  // "Gareth Holloway" resolved to a dead ghost channel (RSS 404) — the intended
  // channel is Gareth SOLOWAY (Verified Investing). Both his channels upload
  // daily; each is credibility-scored separately. Resolved 2026-07-10 from
  // YouTube search initial data + RSS title verification.
  { id: 'UCwTu6kD2igaLMpxswtcdxlg', name: 'Gareth Soloway' },
  { id: 'UCZ-J2m1AUSLnifUEKam5_dA', name: 'Verified Investing' },
  // resolved 2026-07-10 from the channel page source (canonical link + og:url,
  // title "Grandmaster-OBI", @EARLYSEATOBI, 42.7k subs)
  { id: 'UCddkjtql4LIVLct3tD4-3SQ', name: 'Grandmaster Obi' },
]

/** Stored config unioned with the code defaults, deduped by channel id. The
 * config blob is seeded ONCE — channels added to DEFAULT_CHANNELS later never
 * reach it on their own (Gareth Holloway and Grandmaster Obi sat unwatched for
 * exactly this reason). User-added channels always survive; new defaults always
 * join. Apply at every point of consumption, never persist the union back. */
export function withDefaults(channels: { id: string; name: string }[] | undefined | null): { id: string; name: string }[] {
  const out = [...(channels ?? [])]
  const seen = new Set(out.map(c => c.id))
  for (const d of DEFAULT_CHANNELS) {
    if (!seen.has(d.id)) {
      seen.add(d.id)
      out.push(d)
    }
  }
  return out
}

/** Stable IDs take precedence. Exact names support older saved inbox entries. */
export function isFollowedChannel(video: { channelId?: string; channel?: string }, channels: { id: string; name: string }[]): boolean {
  if (video.channelId) return channels.some(c => c.id === video.channelId)
  const name = video.channel?.trim().toLowerCase()
  return !!name && channels.some(c => c.name.trim().toLowerCase() === name)
}
