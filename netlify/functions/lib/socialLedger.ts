import { acquireLease, releaseLease, type AppStore } from './storeProvider'
import { registerSocialClaims, type SocialOutcomeRecord } from '../../../shared/engine/socialOutcomes'
import type { VideoExtract } from './videoTrends'

export const SOCIAL_LEDGER_KEY = 'social-outcomes:v1'
/** The outcome ledger is independent of the rolling video display. No pending
 * record is evicted by age, feed length or a failed market-data request. */
export async function updateSocialLedger(store: AppStore, update: (rows: SocialOutcomeRecord[]) => SocialOutcomeRecord[]): Promise<SocialOutcomeRecord[]> {
  const key = 'lease:social-outcomes'
  const token = await acquireLease(store, key, Math.floor(Date.now() / 1000), 90)
  if (!token) throw new Error('social-ledger-busy')
  try {
    const rows = await store.read<SocialOutcomeRecord[]>(SOCIAL_LEDGER_KEY) ?? []
    const next = update(rows)
    await store.write(SOCIAL_LEDGER_KEY, next)
    return next
  } finally { await releaseLease(store, key, token) }
}
/** Called only after publication succeeds. If recovery finds published evidence
 * but no ledger entry, begin tracking NOW instead of backdating a missed write.
 * Existing ids preserve their original confirmed capture time. */
export const registerExtractOutcomes = (store: AppStore, extract: VideoExtract) =>
  updateSocialLedger(store, rows => registerSocialClaims(rows, { ...extract, at: Math.max(extract.at, Math.floor(Date.now() / 1000)) }))
