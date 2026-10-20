import type { AppStore } from './storeProvider'
export const PROVIDER_HEALTH_KEY = 'video-transcript-provider'
export interface TranscriptProviderHealth {
  checkedAt: number; status: 'available' | 'exhausted' | 'unauthorized' | 'unavailable'
  plan?: string; maxCredits?: number; usedCredits?: number; remainingCredits?: number
}
/** Account metadata only. Never persist the API key or organisation identifier. */
export async function refreshTranscriptProviderHealth(store: AppStore, key: string, fetchFn: typeof fetch = fetch, now = Math.floor(Date.now() / 1000)) {
  const prior = await store.read<TranscriptProviderHealth>(PROVIDER_HEALTH_KEY)
  if (prior && now - prior.checkedAt < 3600) return prior
  let health: TranscriptProviderHealth = { checkedAt: now, status: 'unavailable' }
  try {
    const res = await fetchFn('https://api.supadata.ai/v1/me', { headers: { 'x-api-key': key }, redirect: 'error', signal: AbortSignal.timeout(20_000) })
    if (res.status === 401 || res.status === 403) health.status = 'unauthorized'
    if (res.ok) {
      const data = await res.json() as { plan?: unknown; maxCredits?: unknown; usedCredits?: unknown }
      if (typeof data.maxCredits === 'number' && Number.isFinite(data.maxCredits) && data.maxCredits >= 0 && typeof data.usedCredits === 'number' && Number.isFinite(data.usedCredits) && data.usedCredits >= 0) {
        const remainingCredits = Math.max(0, data.maxCredits - data.usedCredits)
        health = { ...health, status: remainingCredits > 0 ? 'available' : 'exhausted', maxCredits: data.maxCredits, usedCredits: data.usedCredits, remainingCredits, ...(typeof data.plan === 'string' ? { plan: data.plan.slice(0, 80) } : {}) }
      }
    }
  } catch { /* Keep the health failure separate from free/local capture. */ }
  await store.write(PROVIDER_HEALTH_KEY, health)
  return health
}
