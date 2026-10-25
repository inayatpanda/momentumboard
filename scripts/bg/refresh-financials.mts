// Free SEC reports fetched on GitHub, where long public-data downloads are
// reliable, then shared with Cloudflare. No AI calls or paid data providers.
import { configureStoreForScript } from '../lib/configureStore'
import { appStore } from '../../netlify/functions/lib/storeProvider'
import { fetchBusinessHealth, businessHealthCacheKey } from '../../netlify/functions/lib/businessHealth'
import { setCached } from '../../netlify/functions/lib/cache'
import { HISTORY_SECTORS } from '../lib/historicalFundamentals'
import { financialRefreshSymbols, publishFinancialReports } from '../lib/financialRefresh'
import type { AppConfig } from '../../shared/config'

await configureStoreForScript()
const config = await appStore.read<AppConfig>('config')
const symbols = financialRefreshSymbols(config?.watchlist ?? [], Object.keys(HISTORY_SECTORS))
const result = await publishFinancialReports(symbols, fetchBusinessHealth,
  (sym, snapshot) => setCached(businessHealthCacheKey(sym), snapshot, 48 * 3600),
  () => new Promise(resolve => setTimeout(resolve, 300)))
console.log(JSON.stringify(result))
if (!result.published) throw new Error('No usable financial reports were published; previous cached reports were preserved.')
