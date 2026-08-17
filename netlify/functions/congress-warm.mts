import type { Context } from '@netlify/functions'
import { appStore as blobAppStore } from './lib/storeProvider'
import { getCached, setCached } from './lib/cache'
import { accumulateCongressHistory, computeCongressScorecard, fetchCongressTrades, resolveCongressSectors, type CongressTrade } from './lib/congress'
import { cachedIndustry } from './lib/marketCache'
import { fetchYahooChart } from './lib/yahoo'

// Slim [isoDate, close] series for the scorecard, cache-first. Yahoo has no
// caching of its own, so we wrap it under a dedicated key holding ONLY the pairs
// the scorer reads (not raw chart payloads), 6h TTL. `fetched` marks a network
// hit — the compute budget only counts those; `allowFetch` goes false once the
// budget is spent, so a symbol may still come from cache but never re-fetches.
const fetchCloses = async (sym: string, allowFetch: boolean): Promise<{ series: [string, number][] | null; fetched: boolean }> => {
  const key = `congress:chart:${sym}`
  const cached = await getCached<[string, number][]>(key)
  if (cached) return { series: cached, fetched: false }
  if (!allowFetch) return { series: null, fetched: false }
  try {
    const { candles } = await fetchYahooChart(sym, '1y')
    const series: [string, number][] = candles.map(c => [new Date(c.t * 1000).toISOString().slice(0, 10), c.c])
    await setCached(key, series, 21_600)
    return { series, fetched: true }
  } catch {
    return { series: null, fetched: true } // a failed attempt still counts, so a run of dead symbols can't blow the budget
  }
}

// Keeps congressional data fresh on the SERVER'S clock, not the reader's.
// Without this, the sweep only runs when someone opens Intel after the cache
// expires — days without a visit would leave holes in the rolling history the
// aggregates are built from. Twice on weekdays (disclosures land in bursts
// around filing deadlines); the cache logic makes an already-fresh run a no-op.

type CongressBlob = { trades: CongressTrade[]; source: string; asOf: number }

export default async (req: Request, _context: Context) => {
  // Public URL, no secret cron signal (audit C-1). Reject non-scheduler /
  // non-admin requests, and rate-bound whatever passes; admin bypasses. Low harm
  // anyway (cache warming), already bounded by the 2h cache check below.
  const body = await req.text().catch(() => '')
  const admin = req?.headers?.get('x-app-token') === process.env.APP_TOKEN
  if (!admin && !body.includes('next_run')) return new Response('forbidden', { status: 401 })
  const { claimScheduleSlot } = await import('./lib/schedule')
  if (!(await claimScheduleSlot('congress-warm', 7200, admin))) return new Response('throttled', { status: 429 })
  // Unlike the lazy on-request path, the warm FORCES a sweep (2 cheap upstream
  // calls) so the evening run catches same-day filings the morning one missed —
  // a 24h-valid cache must not turn it into a no-op. Only a sweep from the last
  // two hours (organic traffic just refilled it) makes this a skip.
  //
  // A SKIPPED SWEEP IS NOT A SKIPPED INVOCATION (2026-08-17). This check used to
  // `return` from the whole handler, and the grading block below it therefore
  // never ran on a warm invocation. On a site with readers the lazy on-request
  // refresh keeps `congress:v1` under two hours old around the clock, so EVERY
  // scheduled run took that exit and the scorecard froze (73h stale in
  // production). Grading reads history and charts, not the disclosure feeds; it
  // has nothing to do with how fresh the trades cache is, and it must run daily
  // because buys age into eligibility and every exit moves with the tape.
  const hit = await getCached<CongressBlob>('congress:v1')
  const sweepFresh = !!hit && Math.floor(Date.now() / 1000) - hit.asOf < 2 * 3600

  let source = 'cached'
  let swept = 0
  let history: CongressTrade[] | null = null
  if (!sweepFresh) {
    const fetched = await fetchCongressTrades({
      QUIVER_API_KEY: process.env.QUIVER_API_KEY,
      FMP_API_KEY: process.env.FMP_API_KEY,
      FINNHUB_API_KEY: process.env.FINNHUB_API_KEY,
    })
    source = fetched.source
    swept = fetched.trades.length
    await setCached('congress:v1', { trades: fetched.trades, source, asOf: Math.floor(Date.now() / 1000) }, fetched.trades.length ? 86_400 : 3600)
    if (fetched.trades.length) {
      history = await accumulateCongressHistory(blobAppStore, fetched.trades)
      // bulk sector resolution belongs here, on the scheduled clock (~30 profile2
      // calls max, each cached 24h) — request paths only trickle
      await resolveCongressSectors(blobAppStore, history, s => cachedIndustry(s, process.env.FINNHUB_API_KEY ?? ''), 40)
    }
  }
  // The scorecard grades disclosed buys vs SPY on the server clock. Run it every
  // sweep even when nothing new landed — buys age into eligibility (≥5d old) and
  // exits move day to day. Reads history if this sweep didn't refresh it.
  // Fail-soft: a broken scorecard must never taint the congress payload.
  let graded = 0
  try {
    const hist = history ?? (await blobAppStore.read<CongressTrade[]>('congress-history')) ?? []
    if (Array.isArray(hist) && hist.length) graded = (await computeCongressScorecard(blobAppStore, hist, fetchCloses)).gradedBuys
  } catch {
    /* grading is best-effort — the trades + aggregates already shipped */
  }
  return new Response(sweepFresh ? `fresh; graded ${graded}` : `swept: ${source} ${swept}; graded ${graded}`)
}

// 06:10 and 18:10 UTC on weekdays — before the morning paper composes, and
// after the US session opens (when the previous day's filings have landed).
export const config = { schedule: '10 6,18 * * 1-5' }
