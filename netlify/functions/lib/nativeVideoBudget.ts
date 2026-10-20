import { acquireLease, releaseLease, type AppStore } from './storeProvider'
import { NATIVE_DAILY_REQUESTS, NATIVE_DAILY_SECONDS, NATIVE_REQUEST_SPACING_SECONDS, nativeQuotaDay, nativeQuotaReset } from '../../../shared/nativeVideoPolicy'

export interface NativeBudget { day: string; requests: number; seconds: number; nextRequestAt: number; pauseUntil: number; pauseReason?: string }
export const nativeBudgetKey = (now: number) => `native-video-budget:${nativeQuotaDay(now)}`

export async function readNativeBudget(store: AppStore, now: number): Promise<NativeBudget> {
  const existing = await store.read<NativeBudget>(nativeBudgetKey(now))
  if (existing) return existing
  // Carry forward attempts from the previous release rather than resetting
  // today's consumption on deployment. Its largest request was 90 minutes.
  const dates = [...new Set([nativeQuotaDay(now), new Date(now * 1000).toISOString().slice(0, 10)])]
  let requests = 0, seconds = 0
  for (const date of dates) {
    const old = await store.read<Record<string, number>>(`social-budget:${date.slice(0, 7)}`)
    const count = old?.[`${date}:github-native-free`] ?? 0
    requests += count; seconds += count * 5400
    if (await store.read(`github-native-free-proof:${date}:gemini-3.5-flash-lite`)) { requests++; seconds += 600 }
  }
  return { day: nativeQuotaDay(now), requests, seconds, nextRequestAt: 0, pauseUntil: 0 }
}

export async function reserveNativeRead(store: AppStore, now: number, seconds: number): Promise<{ allowed: boolean; reason?: string; retryAt?: number; budget: NativeBudget }> {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > NATIVE_DAILY_SECONDS) throw new Error('native-invalid-reservation')
  const lock = 'lease:native-video-budget', lease = await acquireLease(store, lock, now, 60)
  if (!lease) return { allowed: false, reason: 'busy', retryAt: now + 60, budget: await readNativeBudget(store, now) }
  try {
    const budget = await readNativeBudget(store, now)
    if (budget.pauseUntil > now) return { allowed: false, reason: budget.pauseReason ?? 'provider-quota', retryAt: budget.pauseUntil, budget }
    if (budget.requests >= NATIVE_DAILY_REQUESTS) return { allowed: false, reason: 'daily-allowance', retryAt: nativeQuotaReset(now), budget }
    if (budget.seconds + seconds > NATIVE_DAILY_SECONDS) return { allowed: false, reason: 'video-allowance', retryAt: nativeQuotaReset(now), budget }
    if (budget.nextRequestAt > now) return { allowed: false, reason: 'pacing', retryAt: budget.nextRequestAt, budget }
    budget.requests++; budget.seconds += Math.ceil(seconds); budget.nextRequestAt = now + NATIVE_REQUEST_SPACING_SECONDS
    await store.write(nativeBudgetKey(now), budget)
    return { allowed: true, budget }
  } finally { await releaseLease(store, lock, lease) }
}

export async function pauseNativeReads(store: AppStore, now: number, until: number, reason: string): Promise<void> {
  const lock = 'lease:native-video-budget', lease = await acquireLease(store, lock, now, 60)
  if (!lease) throw new Error('native-budget-busy')
  try {
    const budget = await readNativeBudget(store, now)
    budget.pauseUntil = Math.max(budget.pauseUntil, until); budget.pauseReason = reason
    await store.write(nativeBudgetKey(now), budget)
  } finally { await releaseLease(store, lock, lease) }
}

/** One-time repair of the old global pause caused by a video-specific 400.
 * Compare the exact recorded pause under a lease; never reset usage or quota. */
export async function repairVideoSpecificPause(store: AppStore, now: number, expectedUntil: number): Promise<void> {
  const lock = 'lease:native-video-budget', lease = await acquireLease(store, lock, now, 60)
  if (!lease) return
  try {
    const budget = await readNativeBudget(store, now)
    if (budget.pauseReason === 'provider-configuration' && budget.pauseUntil === expectedUntil) {
      budget.pauseUntil = 0; delete budget.pauseReason
      await store.write(nativeBudgetKey(now), budget)
    }
  } finally { await releaseLease(store, lock, lease) }
}
