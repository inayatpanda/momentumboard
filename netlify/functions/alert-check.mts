import type { Config } from '@netlify/functions'
import { cachedQuote, cachedCandles } from './lib/marketCache'
import { blobAppStore } from './lib/store'
import { fetchNews } from './lib/news'
import { fetchVideos } from './lib/youtube'
import { sendTelegram } from './lib/telegram'
import { evaluateAlerts, flushBatch, emptyAlertState, type AlertState, type TickerSnapshot, type StopWatch, type AlertEvent } from '../../shared/alerts'
import type { AppConfig } from '../../shared/config'
import { rsi } from '../../shared/indicators'
import { avgDailyVolume, relativeVolume, sessionElapsedFraction, isMarketOpen } from '../../shared/rvol'
import { detectSetups, regimeFromCandles } from '../../shared/setups'
import { exchangeFor } from '../../shared/symbols'

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

  // open journal positions: their stops are watched even if off the watchlist
  const portfolio = await store.read<{ openPositions?: { symbol: string; entryPrice: number; stop: number }[] }>('portfolio')
  const positions: StopWatch[] = (portfolio?.openPositions ?? []).map(p => ({ symbol: p.symbol, entryPrice: p.entryPrice, stop: p.stop }))

  // gather market data in parallel; every branch is failure-isolated
  const symbols = [...new Set([...cfg.watchlist.map(w => w.symbol), ...positions.map(p => p.symbol)])].slice(0, 40)
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
          return { symbol, price: quote?.price ?? null, changePct: quote?.changePct ?? null, rvol, rsi: rsiVal, setups, marketOpen: open }
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
    { tickers: snapshots.filter((s): s is TickerSnapshot => s !== null), regime, news, videos, nowSec, positions },
    state,
  )

  // Signal outcome log — the raw material for long-horizon learning.
  // Context (regime, rvol) is recorded so lessons can be conditioned on it;
  // a rolling copy feeds the live scoreboard, monthly archives keep everything.
  const setupEvents = events.filter(e => e.meta?.kind === 'setup' && e.meta.price != null)
  if (setupEvents.length) {
    const snapBySym = new Map(snapshots.filter((s): s is TickerSnapshot => s !== null).map(s => [s.symbol, s]))
    const entries = setupEvents.map(e => ({
      symbol: e.symbol,
      setup: e.meta!.setup,
      price: e.meta!.price,
      at: e.at,
      regime,
      rvol: snapBySym.get(e.symbol ?? '')?.rvol ?? null,
    }))
    const log = (await store.read<unknown[]>('signal-log')) ?? []
    log.push(...entries)
    await store.write('signal-log', log.slice(-500))
    const monthKey = `signal-log:${new Date(nowSec * 1000).toISOString().slice(0, 7)}`
    const archive = (await store.read<unknown[]>(monthKey)) ?? []
    archive.push(...entries)
    await store.write(monthKey, archive)
  }

  // queue AI video-watching for NEW videos worth the credits: Josh always,
  // others only when the title names a watchlist ticker (cap enforced downstream)
  const newVideos = videos.filter(v => !state.seenItems.includes(v.url))
  const worthWatching = newVideos
    .filter(v => v.channel === 'Stocks with Josh' || symbols.some(s => v.title.toUpperCase().includes(s.split('.')[0].split('-')[0])))
    .slice(0, 2)
  const dispatch = (v: { url: string; title: string; channel: string }, mode: 'watch' | 'extract') =>
    fetch(`${process.env.URL ?? 'https://momentumboard-inayat.netlify.app'}/.netlify/functions/video-analyze-background`, {
      method: 'POST',
      headers: { 'x-app-token': process.env.APP_TOKEN ?? '', 'content-type': 'application/json' },
      body: JSON.stringify({ url: v.url, title: v.title, channel: v.channel, mode }),
    }).catch(() => errors.push(`video-${mode}-dispatch`))
  // depth tier: Gemini fully watches the few videos that earn it (202 returns instantly)
  for (const v of worthWatching) await dispatch(v, 'watch')
  // breadth tier: EVERY new video gets transcript+extraction for the consensus maths
  if (process.env.SUPADATA_API_KEY) for (const v of newVideos.slice(0, 8)) await dispatch(v, 'extract')

  // alert history for the in-app screen
  if (events.length) {
    const history = (await store.read<unknown[]>('alert-history')) ?? []
    for (const e of events) history.push({ text: e.text, tier: e.tier, at: e.at })
    await store.write('alert-history', history.slice(-200))
  }

  let sent = 0
  const muteUntil = (await store.read<number>('mute-until')) ?? 0
  const deliver = async (text: string) => {
    if (nowSec < muteUntil) return // /mute via the Telegram bot silences both channels
    // native app push (installed PWA devices)
    try {
      const { sendPushAll } = await import('./lib/pushSend')
      sent += await sendPushAll(store, { VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY }, { title: 'MomentumBoard', body: text })
    } catch (e) {
      errors.push(`push: ${e}`)
    }
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

  for (const e of events.filter((e: AlertEvent) => e.tier === 'instant')) await deliver(e.text.startsWith('🛑') ? e.text : `🔔 ${e.text}`)

  // macro SHOCK sentinel: oil/gold/VIX/dollar/natgas one-day shocks and stretches
  try {
    const { MACRO_ASSETS, detectShock, detectStretch } = await import('./lib/macroEvents')
    for (const asset of MACRO_ASSETS) {
      const candles = await cachedCandles(asset.sym)
      if (!candles) continue
      const today = new Date(nowSec * 1000).toISOString().slice(0, 10)
      const shock = detectShock(asset, candles)
      const stretch = detectStretch(asset, candles)
      const isoWeek = `${new Date(nowSec * 1000).getUTCFullYear()}-w${Math.ceil(new Date(nowSec * 1000).getUTCDate() / 7)}${new Date(nowSec * 1000).getUTCMonth()}`
      const fire = async (evt: object, key: string, ping: string) => {
        if (afterEval.seenItems.includes(key)) return
        afterEval.seenItems.push(key)
        await deliver(ping)
        await fetch(`${process.env.URL ?? 'https://momentumboard-inayat.netlify.app'}/.netlify/functions/event-dossier-background`, {
          method: 'POST',
          headers: { 'x-app-token': process.env.APP_TOKEN ?? '', 'content-type': 'application/json' },
          body: JSON.stringify(evt),
        }).catch(() => errors.push('dossier-dispatch'))
      }
      if (shock) await fire(shock, `shock:${asset.sym}:${today}`, `⚡ ${asset.name} ${shock.movePct > 0 ? '+' : ''}${shock.movePct}% today — building the event assessment now`)
      else if (stretch) await fire(stretch, `stretch:${asset.sym}:${isoWeek}`, `🎈 ${asset.name} stretched to ${stretch.zScore}σ (RSI ${stretch.rsi}) — reversion assessment incoming`)
    }
  } catch (e) {
    errors.push(`macro-sentinel: ${e}`)
  }

  // macro-event warnings: FOMC/CPI/NFP morning-of + 1h before (idempotent via seenItems keys)
  try {
    const { fetchEconCalendar, dueMacroWarnings } = await import('./lib/econCalendar')
    const { getCached, setCached } = await import('./lib/cache')
    let econ = await getCached<Awaited<ReturnType<typeof fetchEconCalendar>>>('econ-calendar')
    if (!econ) {
      econ = await fetchEconCalendar()
      await setCached('econ-calendar', econ, 21_600)
    }
    for (const w of dueMacroWarnings(econ, nowSec, afterEval.seenItems)) {
      afterEval.seenItems.push(w.key)
      await deliver(w.text)
      const history = (await store.read<unknown[]>('alert-history')) ?? []
      history.push({ text: w.text, tier: 'instant', at: nowSec })
      await store.write('alert-history', history.slice(-200))
    }
  } catch (e) {
    errors.push(`econ: ${e}`)
  }

  // intraday trending: watchlist movers + market-wide (Yahoo trending), snapshotted through the day
  try {
    const { getCached, setCached } = await import('./lib/cache')
    let market = await getCached<{ sym: string; changePct: number | null }[]>('mkt-trending')
    if (!market) {
      const res = await fetch('https://query1.finance.yahoo.com/v1/finance/trending/US?count=8', { headers: { 'User-Agent': 'Mozilla/5.0 (MomentumBoard)' } })
      const j = (await res.json()) as { finance?: { result?: { quotes?: { symbol: string }[] }[] } }
      const syms = (j.finance?.result?.[0]?.quotes ?? []).map(q => q.symbol).slice(0, 8)
      market = await Promise.all(syms.map(async sym => ({ sym, changePct: (await cachedQuote(sym, finnhubKey))?.changePct ?? null })))
      await setCached('mkt-trending', market, 600)
    }
    const watchlistMovers = snapshots
      .filter((s): s is TickerSnapshot => s !== null && s.changePct != null)
      .sort((a, b) => Math.abs(b.changePct!) - Math.abs(a.changePct!))
      .slice(0, 8)
      .map(s => ({ sym: s.symbol, changePct: s.changePct!, rvol: s.rvol, setups: s.setups }))
    await store.write('trending', { at: nowSec, watchlist: watchlistMovers, market })
    const timeline = (await store.read<{ at: number }[]>('trending-timeline')) ?? []
    if (!timeline.length || nowSec - timeline[timeline.length - 1].at > 1700) {
      timeline.push({ at: nowSec, watchlist: watchlistMovers.slice(0, 3), market: market.slice(0, 3) } as never)
      await store.write('trending-timeline', timeline.slice(-30))
    }
  } catch (e) {
    errors.push(`trending: ${e}`)
  }

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
