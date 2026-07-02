import type { Config } from '@netlify/functions'
import { fetchYahooChart } from './lib/yahoo'
import { fetchFinnhubQuote } from './lib/finnhub'
import { getCached, setCached } from './lib/cache'
import { blobAppStore } from './lib/store'
import { fetchNews } from './lib/news'
import { fetchVideos } from './lib/youtube'
import { sendTelegram } from './lib/telegram'
import { evaluateAlerts, flushBatch, emptyAlertState, type AlertState, type TickerSnapshot } from '../../shared/alerts'
import type { AppConfig } from '../../shared/config'
import type { Candle, Quote } from '../../shared/types'
import { rsi } from '../../shared/indicators'
import { avgDailyVolume, relativeVolume, sessionElapsedFraction, isMarketOpen } from '../../shared/rvol'
import { detectSetups, regimeFromCandles } from '../../shared/setups'
import { exchangeFor, isYahooSymbol as isYahoo } from '../../shared/symbols'

async function cachedQuote(sym: string, finnhubKey: string): Promise<Quote | null> {
  const key = `quote:${sym}`
  const hit = await getCached<Quote>(key)
  if (hit) return hit
  try {
    const q = isYahoo(sym) ? (await fetchYahooChart(sym, '3mo')).quote : await fetchFinnhubQuote(sym, finnhubKey)
    await setCached(key, q, 60)
    return q
  } catch {
    return null
  }
}

async function cachedCandles(sym: string): Promise<Candle[] | null> {
  const key = `candles:${sym}:1y`
  const hit = await getCached<{ candles: Candle[] }>(key)
  if (hit) return hit.candles
  try {
    const data = await fetchYahooChart(sym, '1y')
    await setCached(key, data, 900)
    return data.candles
  } catch {
    return null
  }
}

export default async () => {
  const nowSec = Math.floor(Date.now() / 1000)
  const errors: string[] = []
  const store = blobAppStore

  const cfg = await store.read<AppConfig>('config')
  if (!cfg || !cfg.watchlist.length) {
    await appendRunlog(store, { at: nowSec, events: 0, sent: 0, errors: ['no-config'] })
    return new Response('no-config')
  }

  const state = (await store.read<AlertState>('alert-state')) ?? emptyAlertState()
  const finnhubKey = process.env.FINNHUB_API_KEY ?? ''
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID

  // gather market data in parallel; every branch is failure-isolated
  const symbols = cfg.watchlist.map(w => w.symbol)
  const [snapshots, spy, qqq, news, videos] = await Promise.all([
    Promise.all(
      symbols.map(async (symbol): Promise<TickerSnapshot | null> => {
        try {
          const exchange = exchangeFor(symbol)
          const open = isMarketOpen(exchange, nowSec)
          const [quote, candles] = await Promise.all([cachedQuote(symbol, finnhubKey), cachedCandles(symbol)])
          let rvol: number | null = null
          let rsiVal: number | null = null
          let setups: TickerSnapshot['setups'] = []
          if (candles && candles.length > 25) {
            const avg = avgDailyVolume(candles)
            const todayVol = quote?.todayVolume ?? candles[candles.length - 1].v
            if (avg) rvol = relativeVolume(todayVol, avg, sessionElapsedFraction(exchange, nowSec))
            const r = rsi(candles.map(c => c.c))
            rsiVal = r[r.length - 1]
            setups = detectSetups(candles, rvol)
          }
          return { symbol, price: quote?.price ?? null, rvol, rsi: rsiVal, setups, marketOpen: open }
        } catch (e) {
          errors.push(`${symbol}: ${e}`)
          return null
        }
      }),
    ),
    cachedCandles('SPY'),
    cachedCandles('QQQ'),
    fetchNews(symbols, finnhubKey, nowSec).catch(e => {
      errors.push(`news: ${e}`)
      return []
    }),
    fetchVideos(cfg.ytChannels, nowSec).catch(e => {
      errors.push(`videos: ${e}`)
      return []
    }),
  ])

  // A virgin state means this is the first ever run: record everything as seen
  // but deliver nothing, or the first configured run would blast 30+ messages.
  const seeding = state.seenItems.length === 0 && state.lastBatchAt === 0 && Object.keys(state.lastSetups).length === 0

  const regime = spy && qqq ? regimeFromCandles(spy, qqq) : null
  const { events, state: afterEval } = evaluateAlerts(
    { rules: cfg.rules, watchlist: symbols },
    { tickers: snapshots.filter((s): s is TickerSnapshot => s !== null), regime, news, videos, nowSec },
    state,
  )

  let sent = 0
  const deliver = async (text: string) => {
    if (!botToken || !chatId) {
      if (!errors.includes('telegram-unconfigured')) errors.push('telegram-unconfigured')
      return
    }
    try {
      await sendTelegram(botToken, chatId, text)
      sent++
    } catch (e) {
      errors.push(`telegram: ${e}`)
    }
  }

  if (seeding) {
    afterEval.queue = []
    afterEval.lastBatchAt = nowSec
    await store.write('alert-state', afterEval)
    await appendRunlog(store, { at: nowSec, events: events.length, sent: 0, errors: [...errors, 'seeded-quietly'] })
    return new Response(JSON.stringify({ seeded: true, events: events.length }))
  }

  for (const e of events.filter(e => e.tier === 'instant')) await deliver(`🔔 ${e.text}`)

  const { digest, state: finalState } = flushBatch(afterEval, nowSec)
  if (digest) await deliver(digest)

  await store.write('alert-state', finalState)
  await appendRunlog(store, { at: nowSec, events: events.length, sent, errors })
  return new Response(JSON.stringify({ events: events.length, sent, errors }))
}

async function appendRunlog(store: typeof blobAppStore, entry: { at: number; events: number; sent: number; errors: string[] }) {
  const runlog = (await store.read<unknown[]>('runlog')) ?? []
  runlog.push(entry)
  await store.write('runlog', runlog.slice(-50))
}

export const config: Config = { schedule: '*/5 * * * *' }
