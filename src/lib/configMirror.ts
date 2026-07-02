import { db, getCapital, getChannels } from './db'
import { putConfig } from './api'

let timer: ReturnType<typeof setTimeout> | undefined

/** Debounced push of the local watchlist + rules + settings to the server config (read by the alert checker). */
export function mirrorConfig(delayMs = 1500) {
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
