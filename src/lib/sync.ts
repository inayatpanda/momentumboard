import { db } from './db'
import { apiGet, getToken, isSharedFreeToken } from './api'
import { invalidateSlices } from './store'
import type { AppConfig } from '../../shared/config'
import type { Trade } from '../../shared/journal'

// Cross-device sync: every change PUSHES immediately (configMirror/portfolioMirror);
// this PULLS on app launch so a second device starts from the server state.
// Single-user-per-licence, so last-push-wins is the honest, simple model.
//
// AND IT INVALIDATES (DS-10/CX-22, wired here at the final wave). A pull that
// changed the watchlist changed what the engine's board is ABOUT — the server
// scans the synced universe — and what the learning slice has graded. The old
// shell answered that with App.tsx's `syncTick`, which remounts legacy screens
// and means nothing at all to a v2 `useSlice`: a phone that just inherited its
// desktop's watchlist would have sat on the previous device's board for the
// slice's full TTL. The invalidation lives INSIDE the sync, not in one caller's
// effect, so both shells are served by the one hook and neither can forget it.

/** The slices a config/journal pull can invalidate. Deliberately short: these
 * two are the only ones whose CONTENT is a function of the synced state. */
const SYNC_INVALIDATES = ['board', 'learning']

export async function syncFromServer(): Promise<boolean> {
  if (!getToken()) return false
  // Free-tier DMG devices share ONE server namespace — pulling it would hand
  // this device another install's watchlist. They stay purely local.
  if (isSharedFreeToken()) return false
  let changed = false
  try {
    const cfg = await apiGet<AppConfig | null>('/api/config')
    if (cfg) {
      if (cfg.watchlist?.length) {
        const existing = new Set((await db.watchlist.toArray()).map(w => w.symbol))
        for (const w of cfg.watchlist) {
          if (!existing.has(w.symbol)) {
            await db.watchlist.put({ symbol: w.symbol, riskClass: w.riskClass, category: w.category, addedAt: Date.now() })
            changed = true
          }
        }
      }
      if (cfg.rules?.length) {
        await db.rules.bulkPut(cfg.rules.map(r => ({ ...r, createdAt: Date.now() })))
        changed = true
      }
      if (cfg.notes?.length) {
        const localIds = new Set((await db.notes.toArray()).map(n => n.id))
        for (const n of cfg.notes) {
          if (!localIds.has(n.id)) {
            await db.notes.put(n)
            changed = true
          }
        }
      }
      if (cfg.capital) await db.settings.put({ key: 'capital', value: String(cfg.capital) })
      if (cfg.ytChannels?.length) await db.settings.put({ key: 'ytChannels', value: JSON.stringify(cfg.ytChannels) })
    }
    const backup = await apiGet<{ trades?: Trade[] } | null>('/api/backup')
    if (backup?.trades?.length) {
      const localIds = new Set((await db.trades.toArray()).map(t => t.id))
      const missing = backup.trades.filter(t => !localIds.has(t.id))
      if (missing.length) {
        await db.trades.bulkPut(missing)
        changed = true
      }
    }
  } catch {
    /* offline start is fine — local data stands */
  }
  // outside the try: an invalidation must still fire for the writes that DID
  // land before a later call threw.
  if (changed) invalidateSlices(SYNC_INVALIDATES)
  return changed
}
