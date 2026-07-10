import type { Context } from '@netlify/functions'
import { blobAppStore } from './lib/store'
import { getCached, setCached } from './lib/cache'
import { accumulateCongressHistory, fetchCongressTrades, resolveCongressSectors, type CongressTrade } from './lib/congress'
import { cachedIndustry } from './lib/marketCache'

// Keeps congressional data fresh on the SERVER'S clock, not the reader's.
// Without this, the sweep only runs when someone opens Intel after the cache
// expires — days without a visit would leave holes in the rolling history the
// aggregates are built from. Twice on weekdays (disclosures land in bursts
// around filing deadlines); the cache logic makes an already-fresh run a no-op.

type CongressBlob = { trades: CongressTrade[]; source: string; asOf: number }

export default async (_req: Request, _context: Context) => {
  // Unlike the lazy on-request path, the warm FORCES a sweep (2 cheap upstream
  // calls) so the evening run catches same-day filings the morning one missed —
  // a 24h-valid cache must not turn it into a no-op. Only a sweep from the last
  // two hours (organic traffic just refilled it) makes this a skip.
  const hit = await getCached<CongressBlob>('congress:v1')
  if (hit && Math.floor(Date.now() / 1000) - hit.asOf < 2 * 3600) return new Response('fresh')

  const { trades, source } = await fetchCongressTrades({
    QUIVER_API_KEY: process.env.QUIVER_API_KEY,
    FMP_API_KEY: process.env.FMP_API_KEY,
    FINNHUB_API_KEY: process.env.FINNHUB_API_KEY,
  })
  await setCached('congress:v1', { trades, source, asOf: Math.floor(Date.now() / 1000) }, trades.length ? 86_400 : 3600)
  if (trades.length) {
    const history = await accumulateCongressHistory(blobAppStore, trades)
    // bulk sector resolution belongs here, on the scheduled clock (~30 profile2
    // calls max, each cached 24h) — request paths only trickle
    await resolveCongressSectors(blobAppStore, history, s => cachedIndustry(s, process.env.FINNHUB_API_KEY ?? ''), 40)
  }
  return new Response(`swept: ${source} ${trades.length}`)
}

// 06:10 and 18:10 UTC on weekdays — before the morning paper composes, and
// after the US session opens (when the previous day's filings have landed).
export const config = { schedule: '10 6,18 * * 1-5' }
