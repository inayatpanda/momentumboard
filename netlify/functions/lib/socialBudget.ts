import { acquireLease, releaseLease, type AppStore } from './storeProvider'

/** Reserve attempts, not successes: provider timeouts can still be billable. */
export async function reserveSocialBudget(store: AppStore, kind: 'native' | 'gemini-extract' | 'gemini-watch' | 'github-text' | 'github-native-free', nowSec: number): Promise<boolean> {
  const lock = 'lease:social-budget', token = await acquireLease(store, lock, nowSec, 60)
  if (!token) return false
  try {
    const date = new Date(nowSec * 1000).toISOString().slice(0, 10)
    const key = `social-budget:${date.slice(0, 7)}`
    const counts = await store.read<Record<string, number>>(key) ?? {}
    const dailyKey = `${date}:${kind}`, cap = kind === 'native' ? 8 : kind === 'gemini-extract' || kind === 'github-text' || kind === 'github-native-free' ? 2 : 1
    if ((counts[dailyKey] ?? 0) >= cap || (kind === 'native' && (counts.nativeTotal ?? 0) >= 90)) return false
    counts[dailyKey] = (counts[dailyKey] ?? 0) + 1
    if (kind === 'native') counts.nativeTotal = (counts.nativeTotal ?? 0) + 1
    await store.write(key, counts)
    return true
  } finally { await releaseLease(store, lock, token) }
}
