import { db, getCapital, getChannels } from './db'
import { putConfig } from './api'

let timer: ReturnType<typeof setTimeout> | undefined

/** Debounced push of the local watchlist + rules + settings to the server config (read by the alert checker). */
export function mirrorConfig(delayMs = 1500) {
  clearTimeout(timer)
  timer = setTimeout(async () => {
    const [watch, ruleItems, capital, ytChannels] = await Promise.all([db.watchlist.toArray(), db.rules.toArray(), getCapital(), getChannels()])
    putConfig({
      watchlist: watch.map(w => ({ symbol: w.symbol, riskClass: w.riskClass })),
      rules: ruleItems.map(({ id, symbol, kind, level }) => ({ id, symbol, kind, level })),
      ytChannels,
      capital,
    }).catch(() => {
      /* offline is fine; next change retries */
    })
  }, delayMs)
}
