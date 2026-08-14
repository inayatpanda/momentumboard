import { db, getCapital, getChannels } from './db'
import { isSharedFreeToken, putConfig } from './api'

let timer: ReturnType<typeof setTimeout> | undefined

// If the app is being hidden/closed with a pending mirror, flush immediately.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && timer) {
      clearTimeout(timer)
      mirrorConfig(0)
    }
  })
}

/** Debounced push of the local watchlist + rules + settings to the server config (read by the alert checker). */
export function mirrorConfig(delayMs = 400) {
  // Free-tier DMG devices never push: they share one server namespace, and a
  // push from any install would clobber every other one's (sync.ts's twin).
  if (isSharedFreeToken()) return
  clearTimeout(timer)
  timer = setTimeout(async () => {
    const [watch, ruleItems, capital, ytChannels, noteItems] = await Promise.all([db.watchlist.toArray(), db.rules.toArray(), getCapital(), getChannels(), db.notes.toArray()])
    putConfig({
      watchlist: watch.map(w => ({ symbol: w.symbol, riskClass: w.riskClass, category: w.category })),
      rules: ruleItems.map(({ id, symbol, kind, level }) => ({ id, symbol, kind, level })),
      ytChannels,
      capital,
      notes: noteItems.map(({ id, text, kind, ticker, at }) => ({ id, text, kind, ticker, at })),
    }).catch(() => {
      /* offline is fine; next change retries */
    })
  }, delayMs)
}
