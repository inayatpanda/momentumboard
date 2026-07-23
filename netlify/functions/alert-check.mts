import type { Config } from '@netlify/functions'
import { cachedQuote, cachedCandles } from './lib/marketCache'
import { blobAppStore } from './lib/store'
import { fetchNews } from './lib/news'
import { fetchVideos } from './lib/youtube'
import { withDefaults } from '../../shared/channels'
import { sendTelegram } from './lib/telegram'
import { evaluateAlerts, flushBatch, emptyAlertState, type AlertState, type TickerSnapshot, type StopWatch, type AlertEvent } from '../../shared/alerts'
import type { AppConfig } from '../../shared/config'
import type { Prediction } from '../../shared/engine/types'
import { rsi } from '../../shared/indicators'
import { avgDailyVolume, relativeVolume, sessionElapsedFraction, isMarketOpen } from '../../shared/rvol'
import { detectSetups, regimeFromCandles } from '../../shared/setups'
import { exchangeFor } from '../../shared/symbols'
import type { FlagCandidate, IntradayFlagsBlob } from './lib/intradayFlags'

export default async (req: Request) => {
  // Public URL, no secret cron signal (audit C-1). Reject requests that are
  // neither the scheduler (its body carries next_run) nor admin, AND rate-BOUND
  // whatever passes to the ~5-min cadence (4-min window) so a flood can't burn
  // LLM/market quota. Admin token bypasses.
  const body = await req.text().catch(() => '')
  const admin = req.headers?.get('x-app-token') === process.env.APP_TOKEN
  if (!admin && !body.includes('next_run')) return new Response('forbidden', { status: 401 })
  const { claimScheduleSlot } = await import('./lib/schedule')
  if (!(await claimScheduleSlot('alert-check', 240, admin))) return new Response('throttled', { status: 429 })
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
    fetchVideos(withDefaults(cfg.ytChannels), nowSec).catch(e => {
      errors.push(`videos: ${e}`)
      return []
    }),
  ])

  // A virgin state means this is the first ever run: record everything as seen
  // but deliver nothing, or the first configured run would blast 30+ messages.
  const seeding = state.seenItems.length === 0 && state.lastBatchAt === 0 && Object.keys(state.lastSetups).length === 0

  const regime = spy && qqq ? regimeFromCandles(spy, qqq) : null
  const { events, state: afterEval, freshNews } = evaluateAlerts(
    { rules: cfg.rules, watchlist: symbols },
    { tickers: snapshots.filter((s): s is TickerSnapshot => s !== null), regime, news, videos, nowSec, positions },
    state,
  )

  // News desk: EVERY fresh headline is analysed and stored for the app; only
  // what the triage scores as genuinely important comes back to the reader —
  // top few as instant pings, the notable middle into the batched digest, the
  // rest desk-only. Raw feed → Telegram is over (the 2026-07-11 flood).
  if (freshNews.length) {
    try {
      const { triageNews, NEWS_PING_MIN, NEWS_DIGEST_MIN, NEWS_PING_CAP } = await import('./lib/newsTriage')
      const triaged = await triageNews(freshNews, nowSec)
      const desk = (await store.read<unknown[]>('news-desk')) ?? []
      await store.write('news-desk', [...desk, ...triaged].slice(-300))
      const ranked = [...triaged].sort((a, b) => b.score - a.score)
      let seq = 9000
      for (const t of ranked.filter(x => x.score >= NEWS_PING_MIN).slice(0, NEWS_PING_CAP)) {
        events.push({ id: `${nowSec}-news-${seq++}`, tier: 'instant', text: `📰 ${t.title}${t.syms.length ? ` [${t.syms.join(', ')}]` : ''} — ${t.why} ${t.url}`, symbol: t.syms[0], at: nowSec })
      }
      for (const t of ranked.filter(x => x.score >= NEWS_DIGEST_MIN && x.score < NEWS_PING_MIN).slice(0, 12)) {
        afterEval.queue.push({ id: `${nowSec}-news-${seq++}`, tier: 'batched', text: `📰 ${t.title}${t.syms.length ? ` [${t.syms.join(', ')}]` : ''}`, symbol: t.syms[0], at: nowSec })
      }
    } catch (e) {
      errors.push(`news-triage: ${e}`)
    }
  }

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
  // Work items for the GitHub Actions queue worker (scripts/bg/drain-queue.mts,
  // every 15 min) — the long jobs left Netlify when the plan dropped background
  // functions. Same store, so enqueue here is one blob write; the worker calls
  // the very same handler modules the HTTP kick used to reach.
  const enqueueWork = async (kind: 'video' | 'dossier' | 'compose', body: unknown) => {
    try {
      const q = (await store.read<unknown[]>('work-queue')) ?? []
      q.push({ id: crypto.randomUUID(), kind, body, at: nowSec, attempts: 0 })
      await store.write('work-queue', q.slice(-100))
    } catch {
      errors.push(`${kind}-enqueue`)
    }
  }
  const dispatch = (v: { url: string; title: string; channel: string }, mode: 'watch' | 'extract') =>
    enqueueWork('video', { url: v.url, title: v.title, channel: v.channel, mode })
  // depth tier: Gemini fully watches the few videos that earn it (202 returns instantly)
  for (const v of worthWatching) await dispatch(v, 'watch')
  // breadth tier: EVERY new video gets transcript+extraction for the consensus maths
  // (free caption scrape needs no key; Supadata is the fallback when keyed)
  for (const v of newVideos.slice(0, 8)) await dispatch(v, 'extract')

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
      sent += await sendPushAll(store, { VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY }, { title: 'StreetSignal', body: text })
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
        await enqueueWork('dossier', evt)
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

  // intraday level watch on OPEN ENGINE CALLS: the published stop/target is
  // hard execution advice, so a touch pings immediately — the close-based
  // grade still lands with the morning paper (openTrace owns that story).
  // Once per (call, level), keys persisted in `call-cross-alerts` and pruned.
  // Snapshot prices are reused; only calls off the watchlist cost extra
  // cachedQuote lookups (60s cache), capped so the quote budget can't blow up.
  try {
    const { checkCallCrossings } = await import('../../shared/engine/callCross')
    const index = ((await store.read<string[]>('predictions-index')) ?? []).slice(-10)
    const open: Prediction[] = []
    for (const date of index) {
      for (const p of (await store.read<Prediction[]>(`predictions:${date}`)) ?? []) {
        // watch-only calls carry levels for reference, not execution — no pings
        if (!p.shadow && !p.watchOnly && !p.outcome5) open.push(p)
      }
    }
    // only markets currently trading: outside hours the last trade is stale
    // and would just re-report yesterday's session
    const live = open.filter(p => isMarketOpen(exchangeFor(p.sym), nowSec))
    const priceBySym = new Map(snapshots.filter((s): s is TickerSnapshot => s !== null && s.price != null).map(s => [s.symbol, s.price!]))
    const missing = [...new Set(live.map(p => p.sym))].filter(s => !priceBySym.has(s)).slice(0, 60)
    await Promise.all(
      missing.map(async sym => {
        const q = await cachedQuote(sym, finnhubKey)
        if (q?.price != null) priceBySym.set(sym, q.price)
      }),
    )
    const firedBefore = (await store.read<Record<string, number>>('call-cross-alerts')) ?? {}
    const { alerts, fired } = checkCallCrossings(live, priceBySym, firedBefore, nowSec)
    if (alerts.length) console.log('CALL-CROSS:', alerts.map(a => a.key).join('; '))
    for (const a of alerts) {
      await deliver(a.text)
      const history = (await store.read<unknown[]>('alert-history')) ?? []
      history.push({ text: a.text, tier: 'instant', at: nowSec })
      await store.write('alert-history', history.slice(-200))
    }
    if (alerts.length || Object.keys(fired).length !== Object.keys(firedBefore).length) await store.write('call-cross-alerts', fired)
  } catch (e) {
    errors.push(`CALL-CROSS: ${e}`)
  }

  // intraday ENTRY FLAGS: the morning's setups re-checked live, so an obvious
  // entry gets surfaced at least once during the session. Two 15-min windows on
  // the reader's clock (London ~15:30 after the US open, ~19:30 into power hour),
  // deduped per window, one push a day. Mirrors the call-cross section: pure
  // detection lives in lib/intradayFlags; this owns the data-gathering, the blob
  // and the single notification. Never a new call — just the board's own levels.
  try {
    const { scanWindowAt, scanIntradayFlags, foldScan } = await import('./lib/intradayFlags')
    const window = scanWindowAt(Date.now())
    if (window && isMarketOpen('US', nowSec)) {
      const londonDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(nowSec * 1000))
      const prior = await store.read<IntradayFlagsBlob>('intraday-flags')
      // an already-swept window this session is a no-op — the cron fires ~3× per slot
      if (!(prior?.date === londonDate && prior.scans.some(s => s.window === window))) {
        const { technicalStage } = await import('../../shared/technicals')
        const board = (await store.read<{ date: string; board: Prediction[] }>('engine-board'))?.board ?? []
        const snapBySym = new Map(snapshots.filter((s): s is TickerSnapshot => s !== null).map(s => [s.symbol, s]))
        const todayISO = new Date(nowSec * 1000).toISOString().slice(0, 10)

        // one candidate = live quote + daily candles + (for board rows) engine levels.
        // Quotes are 60s-cached and candles 900s-cached, so most are already warm.
        const build = async (sym: string, lv: Partial<Pick<FlagCandidate, 'side' | 'entry' | 'stage' | 'watchOnly' | 'published' | 'name'>> = {}): Promise<FlagCandidate | null> => {
          const exch = exchangeFor(sym)
          const snap = snapBySym.get(sym)
          const [quote, candles] = await Promise.all([cachedQuote(sym, finnhubKey), cachedCandles(sym)])
          const price = quote?.price ?? snap?.price ?? null
          if (price == null || !Number.isFinite(price)) return null
          let rvol = snap?.rvol ?? null
          let high20: number | null = null
          let sessionHigh: number | null = null
          let sessionLow: number | null = null
          let stage = lv.stage ?? null
          if (candles && candles.length > 25) {
            const avg = avgDailyVolume(candles)
            const todayVol = quote?.todayVolume ?? candles[candles.length - 1].v
            if (avg != null && rvol == null) rvol = relativeVolume(todayVol, avg, sessionElapsedFraction(exch, nowSec))
            // 20-session high with TODAY'S forming bar excluded — the breakout level
            high20 = Math.max(...candles.slice(0, -1).slice(-20).map(c => c.h))
            // today's range so far, only if the last bar really is today's
            const last = candles[candles.length - 1]
            if (new Date(last.t * 1000).toISOString().slice(0, 10) === todayISO) {
              sessionHigh = last.h
              sessionLow = last.l
            }
            if (stage == null) stage = technicalStage(sym, candles)?.stage ?? null
          }
          return { sym, name: lv.name ?? quote?.name ?? null, price, changePct: quote?.changePct ?? snap?.changePct ?? null, rvol, side: lv.side, entry: lv.entry, stage, watchOnly: lv.watchOnly, published: lv.published, sessionHigh, sessionLow, high20 }
        }

        const candidates: FlagCandidate[] = []
        const boardSyms = new Set<string>()
        for (const p of board.slice(0, 40)) {
          boardSyms.add(p.sym)
          const c = await build(p.sym, {
            side: p.side,
            entry: p.entry,
            stage: p.stage,
            name: p.name ?? null,
            watchOnly: p.watchOnly === true,
            published: !p.watchOnly && (p.grade === 'A' || p.grade === 'B'),
          })
          if (c) candidates.push(c)
        }
        // watchlist names the board never published — breakout only (no engine levels)
        for (const sym of symbols.filter(s => !boardSyms.has(s)).slice(0, 20)) {
          const c = await build(sym)
          if (c) candidates.push(c)
        }

        const flags = scanIntradayFlags(candidates, nowSec)
        const { blob, accepted } = foldScan(prior ?? null, londonDate, { at: nowSec, window, flags })
        if (accepted) {
          // push once a day, only when a scan actually found something
          if (flags.length && !blob.pushedAt) {
            const lead = flags[0]
            const extra = flags.length > 1 ? ` (+${flags.length - 1} more)` : ''
            await deliver(`👀 ${lead.sym} ${lead.detail}${extra} — the morning setup at today's prices, not a new call.`)
            blob.pushedAt = nowSec
            const history = (await store.read<unknown[]>('alert-history')) ?? []
            history.push({ text: `👀 Intraday flags: ${flags.map(f => f.sym).join(', ')}`, tier: 'instant', at: nowSec })
            await store.write('alert-history', history.slice(-200))
          }
          await store.write('intraday-flags', blob)
        }
      }
    }
  } catch (e) {
    errors.push(`intraday-flags: ${e}`)
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

  // pundit call bridge: auto-poll pundit Reddit accounts + tag feeds and append
  // their fresh calls to the same `video-extracts` store the engine grades.
  // Deduped by url so the 5-min cadence never double-logs a post.
  try {
    const { fetchRedditPunditPosts, fetchPunditTagFeed, DEFAULT_PUNDIT_REDDITS, DEFAULT_PUNDIT_FEEDS } = await import('./lib/punditCalls')
    const sinceSec = nowSec - 26 * 3600
    const fresh = [
      ...(await fetchRedditPunditPosts(DEFAULT_PUNDIT_REDDITS, sinceSec)),
      ...(await Promise.all(DEFAULT_PUNDIT_FEEDS.map(f => fetchPunditTagFeed(f.url, f.name, sinceSec)))).flat(),
    ]
    if (fresh.length) {
      const extracts = (await store.read<{ url: string }[]>('video-extracts')) ?? []
      const known = new Set(extracts.map(e => e.url))
      const added: unknown[] = []
      for (const e of fresh) {
        if (known.has(e.url)) continue
        known.add(e.url)
        added.push(e)
      }
      if (added.length) await store.write('video-extracts', [...extracts, ...added].slice(-400))
    }
  } catch (e) {
    errors.push(`pundit-bridge: ${e}`)
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
