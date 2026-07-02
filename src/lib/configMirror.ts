import { db } from './db'
import { putConfig } from './api'
import { DEFAULT_CHANNELS } from '../../shared/channels'

let timer: ReturnType<typeof setTimeout> | undefined

/** Debounced push of the local watchlist + rules to the server config (read by the alert checker). */
export function mirrorConfig(delayMs = 1500) {
  clearTimeout(timer)
  timer = setTimeout(async () => {
    const [watch, ruleItems] = await Promise.all([db.watchlist.toArray(), db.rules.toArray()])
    putConfig({
      watchlist: watch.map(w => ({ symbol: w.symbol, riskClass: w.riskClass })),
      rules: ruleItems.map(({ id, symbol, kind, level }) => ({ id, symbol, kind, level })),
      ytChannels: DEFAULT_CHANNELS,
      capital: 5000,
    }).catch(() => {
      /* offline is fine; next change retries */
    })
  }, delayMs)
}
