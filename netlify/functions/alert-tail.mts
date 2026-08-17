import type { Config } from '@netlify/functions'
import { cachedCandles, cachedQuote } from './lib/marketCache'
import { appStore as blobAppStore } from './lib/storeProvider'
import { buildSnapshots } from './lib/snapshots'
import { sendTelegram } from './lib/telegram'
import type { AlertState } from '../../shared/alerts'
import type { AppConfig } from '../../shared/config'
import type { EconEvent } from './lib/econCalendar'
import type { InboxVideo } from './lib/videoTranscriptStore'

// THE LONG TAIL, IN ITS OWN INVOCATION (2026-08-17).
//
// alert-check delivered its alerts and then did seven more things in the SAME
// invocation. On the free plan an invocation has FIFTY subrequests, spent by
// every fetch AND every D1 binding call alike — and the production runlog shows
// 33 of 50 runs ending on 'Too many subrequests', with the trending snapshot
// never reached and two Telegram sends lost inside eight hours.
//
// The five-minute job now keeps only what is time-critical: the rule/setup
// alerts, the news triage, the call-cross level touches and the intraday flags.
// Everything whose value does not decay in ten minutes lives here, on the
// quarter-hour trigger, with its OWN fresh fifty: the macro shock sentinel, the
// economic-calendar warnings, the video work queue, the trending snapshot and
// the pundit bridge.
//
// WHAT THIS HANDLER DELIBERATELY DOES NOT TOUCH
// ---------------------------------------------
//   • `alert-state` — alert-check owns it, and two invocations read-modify-
//     writing the same blob would lose whichever wrote first. The idempotency
//     keys these legs used to keep in `seenItems` live in `alert-tail-fired`
//     instead, seeded ONCE from the keys alert-check already recorded so the
//     changeover cannot re-fire a warning that already went out.
//   • `runlog` — same race (watchdog.mts:35 documents it). The dispatcher
//     records every job's status and body, which is where this run's outcome
//     is legible.

const FIRED_KEY = 'alert-tail-fired'
const FIRED_CAP = 300
/** Urls already queued for the video worker. The queue itself is capped and
 * drains, so it cannot be the memory of what has been dispatched. */
const DISPATCHED_KEY = 'video-dispatched'
const DISPATCHED_CAP = 300
/** Keys this handler owns, for the one-time hand-over from alert-state. */
const OWNED_KEY = /^(macro|shock|stretch):/

export default async (req: Request) => {
  // The same door alert-check has (audit C-1): the scheduler's body marker or an
  // admin token, then a slot claim that bounds whatever gets through. 14 minutes,
  // so the quarter-hour trigger always passes and a flood cannot.
  const body = await req.text().catch(() => '')
  const admin = req.headers?.get('x-app-token') === process.env.APP_TOKEN
  if (!admin && !body.includes('next_run')) return new Response('forbidden', { status: 401 })
  const { claimScheduleSlot } = await import('./lib/schedule')
  if (!(await claimScheduleSlot('alert-tail', 840, admin))) return new Response('throttled', { status: 429 })

  const nowSec = Math.floor(Date.now() / 1000)
  const errors: string[] = []
  const store = blobAppStore

  const cfg = await store.read<AppConfig>('config')
  if (!cfg || !cfg.watchlist.length) return new Response('no-config')
  const symbols = [...new Set(cfg.watchlist.map(w => w.symbol))].slice(0, 40)
  const finnhubKey = process.env.FINNHUB_API_KEY ?? ''
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID

  // THE HAND-OVER, ONCE. Before the split these keys lived in alert-state's
  // `seenItems`; inheriting them on the first run is the difference between a
  // silent changeover and re-sending this morning's macro warnings.
  const stored = await store.read<string[]>(FIRED_KEY)
  const fired: string[] = Array.isArray(stored) ? stored : ((await store.read<AlertState>('alert-state'))?.seenItems ?? []).filter(k => OWNED_KEY.test(k))
  let firedDirty = !Array.isArray(stored)

  let sent = 0
  const muteUntil = (await store.read<number>('mute-until')) ?? 0
  const deliver = async (text: string) => {
    if (nowSec < muteUntil) return // /mute via the Telegram bot silences both channels
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

  const recordHistory = async (text: string) => {
    const history = (await store.read<unknown[]>('alert-history')) ?? []
    history.push({ text, tier: 'instant', at: nowSec })
    await store.write('alert-history', history.slice(-200))
  }

  // Work items for the GitHub Actions queue worker (scripts/bg/drain-queue.mts,
  // every 15 min) — the long jobs left Netlify when the plan dropped background
  // functions. BATCHED: the old per-item enqueue was a read AND a write EACH, so
  // one cycle's eight extract jobs cost sixteen subrequests on their own.
  const enqueueWork = async (items: { kind: 'video' | 'dossier' | 'compose'; body: unknown }[]) => {
    if (!items.length) return
    try {
      const q = (await store.read<unknown[]>('work-queue')) ?? []
      for (const it of items) q.push({ id: crypto.randomUUID(), kind: it.kind, body: it.body, at: nowSec, attempts: 0 })
      await store.write('work-queue', q.slice(-100))
    } catch {
      errors.push('work-enqueue')
    }
  }

  // macro SHOCK sentinel: oil/gold/VIX/dollar/natgas one-day shocks and stretches
  try {
    const { MACRO_ASSETS, detectShock, detectStretch } = await import('./lib/macroEvents')
    const dossiers: { kind: 'dossier'; body: unknown }[] = []
    for (const asset of MACRO_ASSETS) {
      const candles = await cachedCandles(asset.sym)
      if (!candles) continue
      const today = new Date(nowSec * 1000).toISOString().slice(0, 10)
      const shock = detectShock(asset, candles)
      const stretch = detectStretch(asset, candles)
      const isoWeek = `${new Date(nowSec * 1000).getUTCFullYear()}-w${Math.ceil(new Date(nowSec * 1000).getUTCDate() / 7)}${new Date(nowSec * 1000).getUTCMonth()}`
      const fire = async (evt: object, key: string, ping: string) => {
        if (fired.includes(key)) return
        fired.push(key)
        firedDirty = true
        await deliver(ping)
        dossiers.push({ kind: 'dossier', body: evt })
      }
      if (shock) await fire(shock, `shock:${asset.sym}:${today}`, `⚡ ${asset.name} ${shock.movePct > 0 ? '+' : ''}${shock.movePct}% today — building the event assessment now`)
      else if (stretch) await fire(stretch, `stretch:${asset.sym}:${isoWeek}`, `🎈 ${asset.name} stretched to ${stretch.zScore}σ (RSI ${stretch.rsi}) — reversion assessment incoming`)
    }
    await enqueueWork(dossiers)
  } catch (e) {
    errors.push(`macro-sentinel: ${e}`)
  }

  // macro-event warnings: FOMC/CPI/NFP morning-of + 1h before (idempotent via the
  // fired-key list this handler owns)
  try {
    const { fetchEconCalendar, dueMacroWarnings } = await import('./lib/econCalendar')
    const { getCached, setCached } = await import('./lib/cache')
    let econ = await getCached<EconEvent[]>('econ-calendar')
    if (!econ) {
      // WHAT A FAILURE IS WORTH, IN SECONDS (verified live 2026-08-17). This
      // used to cache whatever came back for six hours, and every failure came
      // back as `[]` — so one refused request pinned an empty calendar in place
      // and the macro sentinel went blind for six hours while the feed served
      // ninety-six events. Real data keeps the full TTL; a failure (null) and a
      // genuinely quiet week (empty) are both re-asked in ten minutes.
      const fetched = await fetchEconCalendar()
      econ = fetched ?? []
      await setCached('econ-calendar', econ, econ.length ? 21_600 : 600)
    }
    for (const w of dueMacroWarnings(econ, nowSec, fired)) {
      fired.push(w.key)
      firedDirty = true
      await deliver(w.text)
      await recordHistory(w.text)
    }
  } catch (e) {
    errors.push(`econ: ${e}`)
  }

  // THE VIDEO WORK QUEUE. alert-check records every discovered video in
  // `video-inbox` (the list the Mac transcript runner polls); this decides which
  // of them the paid rungs get, and remembers what it has already queued in its
  // own list — the work queue drains, so it cannot be that memory. Two tiers,
  // unchanged: Gemini fully watches the few that earn it, everything else gets
  // transcript+extraction for the consensus maths. A video beyond the per-run
  // cap is picked up on the next run instead of being dropped for good.
  try {
    const inbox = (await store.read<InboxVideo[]>('video-inbox')) ?? []
    const dispatched = (await store.read<string[]>(DISPATCHED_KEY)) ?? []
    const known = new Set(dispatched)
    const fresh = inbox.filter(v => v && typeof v.url === 'string' && !known.has(v.url))
    if (fresh.length) {
      // depth tier: Josh always, others only when the title names a watchlist ticker
      const worthWatching = fresh.filter(v => v.channel === 'Stocks with Josh' || symbols.some(s => (v.title ?? '').toUpperCase().includes(s.split('.')[0].split('-')[0]))).slice(0, 2)
      const extract = fresh.slice(0, 8)
      const queued = [
        ...worthWatching.map(v => ({ kind: 'video' as const, body: { url: v.url, title: v.title, channel: v.channel, mode: 'watch' } })),
        ...extract.map(v => ({ kind: 'video' as const, body: { url: v.url, title: v.title, channel: v.channel, mode: 'extract' } })),
      ]
      await enqueueWork(queued)
      const urls = [...new Set([...worthWatching, ...extract].map(v => v.url))]
      await store.write(DISPATCHED_KEY, [...dispatched, ...urls].slice(-DISPATCHED_CAP))
    }
  } catch (e) {
    errors.push(`video-dispatch: ${e}`)
  }

  // intraday trending: watchlist movers + market-wide (Yahoo trending), snapshotted
  // through the day. The snapshots are rebuilt here from ONE batched cache read
  // (lib/snapshots.ts) — at the quarter hour alert-check has just run, so the
  // 60s quotes and 900s candles are warm and this costs a fraction of a read.
  try {
    const { getCached, setCached } = await import('./lib/cache')
    const { snapshots } = await buildSnapshots(symbols, finnhubKey, nowSec, { onError: e => errors.push(e) })
    let market = await getCached<{ sym: string; changePct: number | null }[]>('mkt-trending')
    if (!market) {
      const res = await fetch('https://query1.finance.yahoo.com/v1/finance/trending/US?count=8', { headers: { 'User-Agent': 'Mozilla/5.0 (MomentumBoard)' } })
      const j = (await res.json()) as { finance?: { result?: { quotes?: { symbol: string }[] }[] } }
      const syms = (j.finance?.result?.[0]?.quotes ?? []).map(q => q.symbol).slice(0, 8)
      market = await Promise.all(syms.map(async sym => ({ sym, changePct: (await cachedQuote(sym, finnhubKey))?.changePct ?? null })))
      await setCached('mkt-trending', market, 600)
    }
    const watchlistMovers = snapshots
      .filter(s => s.changePct != null)
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
  // Deduped by url so the cadence never double-logs a post.
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

  if (firedDirty) await store.write(FIRED_KEY, fired.slice(-FIRED_CAP))
  return new Response(JSON.stringify({ sent, errors }))
}

// A quarter of an hour: nothing in this handler decays in ten minutes, and the
// five-minute job needs its fifty subrequests for the alerts that do.
export const config: Config = { schedule: '*/15 * * * *' }
