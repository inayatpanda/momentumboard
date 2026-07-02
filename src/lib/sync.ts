import { db } from './db'
import { apiGet, getToken } from './api'
import type { AppConfig } from '../../shared/config'
import type { Trade } from '../../shared/journal'

// Cross-device sync: every change PUSHES immediately (configMirror/portfolioMirror);
// this PULLS on app launch so a second device starts from the server state.
// Single-user-per-licence, so last-push-wins is the honest, simple model.

export async function syncFromServer(): Promise<boolean> {
  if (!getToken()) return false
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
  return changed
}
