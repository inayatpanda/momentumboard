// Default followed YouTube channels (user-requested list, resolved 2026-07-02).
// Editable in Settings from stage 5; ids are stable channel IDs, not handles.
export const DEFAULT_CHANNELS: { id: string; name: string }[] = [
  { id: 'UCNttUtm9vloDjo-a2jqkoNQ', name: 'Stocks with Josh' },
  { id: 'UCUvvj5lwue7PspotMDjk5UA', name: 'Meet Kevin' },
  { id: 'UCnMn36GT_H0X-w5_ckLtlgQ', name: 'Financial Education' },
  { id: 'UChBVf9YnourrEDTsbbwJPRA', name: 'Everything Money' },
  { id: 'UCORi3Jj7kSHcdHdckrjhOsg', name: 'Tom Nash' },
  { id: 'UCwMoQEGc4IqkuGLhJUkLwYQ', name: 'Humbled Trader' },
  // resolved 2026-07-10 from the channel page source (externalId, title "gareth holloway")
  { id: 'UCOg_HWm16bs0WTYTg8yFOtA', name: 'Gareth Holloway' },
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
