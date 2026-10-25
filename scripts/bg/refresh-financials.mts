// Free SEC reports fetched on GitHub, where long public-data downloads are
// reliable, then shared with Cloudflare. No AI calls or paid data providers.
import { configureStoreForScript } from '../lib/configureStore'
import { appStore } from '../../netlify/functions/lib/storeProvider'
import { fetchBusinessHealth, businessHealthCacheKey } from '../../netlify/functions/lib/businessHealth'
import { setCached } from '../../netlify/functions/lib/cache'
import { HISTORY_SECTORS } from '../lib/historicalFundamentals'
import { financialRefreshSymbols, publishFinancialReports } from '../lib/financialRefresh'
import type { AppConfig } from '../../shared/config'
import { mkdir, writeFile } from 'node:fs/promises'

// Public SEC facts stay on this ephemeral runner for the following strategy
// scan. Reuse the download; no new paid source or persistent raw-data cache.
await mkdir('.strategy-input', { recursive: true })
const fetchForScan = (sym: string) => async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const response = await fetch(input, init)
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (response.ok && url.startsWith('https://data.sec.gov/api/xbrl/companyfacts/')) {
    const body = await response.clone().json()
    await writeFile(`.strategy-input/financial-${sym}.json`, JSON.stringify({ sym, fetchedAt: Math.floor(Date.now() / 1000), body }))
  }
  return response
}

await configureStoreForScript()
const config = await appStore.read<AppConfig>('config')
const symbols = financialRefreshSymbols(Object.keys(HISTORY_SECTORS).map(symbol => ({ symbol })), (config?.watchlist ?? []).map(row => row.symbol.toUpperCase()))
const result = await publishFinancialReports(symbols, sym => fetchBusinessHealth(sym, fetchForScan(sym)),
  (sym, snapshot) => setCached(businessHealthCacheKey(sym), snapshot, 48 * 3600),
  () => new Promise(resolve => setTimeout(resolve, 300)))
console.log(JSON.stringify(result))
if (!result.published) throw new Error('No usable financial reports were published; previous cached reports were preserved.')
