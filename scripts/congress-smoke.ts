// throwaway smoke test: run the real congress ladder with the local .env key
import { readFileSync } from 'node:fs'
import { fetchCongressTrades } from '../netlify/functions/lib/congress'

const env: Record<string, string> = {}
for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) env[m[1]] = m[2]
}

const logFetch: typeof fetch = async (url, init) => {
  try {
    const res = await fetch(url, init)
    console.log('[fetch]', res.status, String(url).replace(/apikey=[^&]+/, 'apikey=***'))
    return res
  } catch (e) {
    console.log('[fetch ERR]', (e as Error).name, String(url).replace(/apikey=[^&]+/, 'apikey=***'))
    throw e
  }
}
const noCache = { cacheGet: async () => null, cacheSet: async () => {}, fetchFn: logFetch }
fetchCongressTrades(env, ['AAPL', 'NVDA', 'LNG', 'NI', 'CCI'], noCache).then(r => {
  console.log('source:', r.source, '| trades:', r.trades.length)
  for (const t of r.trades.slice(0, 5)) console.log(t.chamber, t.politician, t.side, t.symbol, t.amountRange, t.traded)
})
