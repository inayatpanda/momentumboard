import { acquireLease, releaseLease, type AppStore } from './storeProvider'
import { videoKey } from '../../../shared/youtubeCaptions.mjs'

/** All display-feed producers share the extraction publisher's short lease.
 * The durable per-video evidence and outcome ledger live outside this window. */
export async function appendSocialDisplay(store: AppStore, incoming: { url: string }[]): Promise<void> {
  if (!incoming.length) return
  const key = 'lease:video-extract-publish'
  const token = await acquireLease(store, key, Math.floor(Date.now() / 1000), 90)
  if (!token) throw new Error('social-publication-busy')
  try {
    const rows = await store.read<{ url: string }[]>('video-extracts') ?? []
    const seen = new Set(rows.map(row => videoKey(row.url)))
    const additions = incoming.filter(row => { const id = videoKey(row.url); if (seen.has(id)) return false; seen.add(id); return true })
    if (additions.length) await store.write('video-extracts', [...rows, ...additions].slice(-400))
  } finally { await releaseLease(store, key, token) }
}
