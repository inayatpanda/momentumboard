// Below the observed free project's 500 requests/day and Google's 8 video
// hours/day. The remaining hour leaves room for the other app sharing it.
export const NATIVE_CHUNK_SECONDS = 10 * 60
export const NATIVE_DAILY_SECONDS = 7 * 3600
export const NATIVE_DAILY_REQUESTS = 400
export const NATIVE_REQUEST_SPACING_SECONDS = 65
export const NATIVE_MAX_CALLS_PER_RUN = 6
// Market commentary goes stale. A video that is still unread this long after
// it was published is retired: no more retries and no daily reading slot.
export const NATIVE_MAX_VIDEO_AGE_SECONDS = 2 * 86400

export function nativeQuotaDay(now: number): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now * 1000))
  const part = (type: string) => parts.find(p => p.type === type)!.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function nativeQuotaReset(now: number): number {
  const day = nativeQuotaDay(now)
  let next = (Math.floor(now / 3600) + 1) * 3600
  while (nativeQuotaDay(next) === day) next += 3600
  return next
}
