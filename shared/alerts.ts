import type { RegimeColor, SetupKind } from './types'

export interface AlertRule {
  id: string
  symbol: string
  kind: 'priceAbove' | 'priceBelow'
  level: number
}

export interface AlertEvent {
  id: string
  tier: 'instant' | 'batched'
  text: string
  symbol?: string
  at: number
  meta?: { kind: 'setup'; setup: SetupKind; price: number | null }
}

/** An open journal position whose stop should be watched. */
export interface StopWatch {
  symbol: string
  entryPrice: number
  stop: number
}

export interface TickerSnapshot {
  symbol: string
  price: number | null
  changePct?: number | null
  rvol: number | null
  rsi: number | null
  setups: SetupKind[]
  marketOpen: boolean
}

export interface NewsItem {
  title: string
  url: string
  symbols: string[]
  /** the publisher — finnhub's own `source` field, an outlet feed's hard
   * tag, or a Google News item's `<source>`; absent on legacy rows */
  source?: string
}

export interface VideoItem {
  title: string
  url: string
  channel: string
}

export interface AlertState {
  ruleArmed: Record<string, boolean>
  seenItems: string[]
  rsiZone: Record<string, 'low' | 'mid' | 'high'>
  rvolHot: Record<string, boolean>
  lastSetups: Record<string, SetupKind[]>
  lastRegime: RegimeColor | null
  queue: AlertEvent[]
  lastBatchAt: number
  stopFired: Record<string, boolean>
}

export interface AlertsConfig {
  rules: AlertRule[]
  watchlist: string[]
}

export interface AlertsInput {
  tickers: TickerSnapshot[]
  regime: RegimeColor | null
  news: NewsItem[]
  videos: VideoItem[]
  nowSec: number
  positions?: StopWatch[]
}

export const emptyAlertState = (): AlertState => ({
  ruleArmed: {},
  seenItems: [],
  rsiZone: {},
  rvolHot: {},
  lastSetups: {},
  lastRegime: null,
  queue: [],
  lastBatchAt: 0,
  stopFired: {},
})

const INSTANT_SETUPS: SetupKind[] = ['reclaim', 'breakoutLive']
const SETUP_LABEL: Record<SetupKind, string> = {
  basing: 'Basing',
  divergence: 'Divergence',
  reclaim: 'Reclaim',
  pullbackZone: 'Pullback zone',
  breakoutWatch: 'Breakout watch',
  breakoutLive: 'Breakout live',
  overextended: 'Overextended',
  fallingKnife: 'Falling knife',
}

const REARM_PCT = 0.005
// Must comfortably exceed one day's news+video volume across the whole
// watchlist: when items fall off this list while still in the feed window,
// they come back as "new" every run — that recycling is what produced the
// thousand-message Telegram flood of 2026-07-11.
const SEEN_CAP = 2000

const mentions = (title: string, watchlist: string[]): string[] => {
  const upper = title.toUpperCase()
  return watchlist.filter(sym => {
    const bare = sym.split('.')[0]
    return new RegExp(`(^|[^A-Z0-9])\\$?${bare}([^A-Z0-9]|$)`).test(upper)
  })
}

export function evaluateAlerts(
  cfg: AlertsConfig,
  input: AlertsInput,
  prev: AlertState,
): { events: AlertEvent[]; state: AlertState; freshNews: (NewsItem & { syms: string[] })[] } {
  const state: AlertState = {
    ...prev,
    ruleArmed: { ...prev.ruleArmed },
    seenItems: [...prev.seenItems],
    rsiZone: { ...prev.rsiZone },
    rvolHot: { ...prev.rvolHot },
    lastSetups: { ...prev.lastSetups },
    queue: [...prev.queue],
    stopFired: { ...(prev.stopFired ?? {}) }, // older persisted states lack this field
  }
  const events: AlertEvent[] = []
  let seq = 0
  const emit = (tier: 'instant' | 'batched', text: string, symbol?: string) => {
    const e: AlertEvent = { id: `${input.nowSec}-${seq++}`, tier, text, symbol, at: input.nowSec }
    events.push(e)
    if (tier === 'batched') state.queue.push(e)
  }

  for (const t of input.tickers) {
    // user price rules
    for (const rule of cfg.rules.filter(r => r.symbol === t.symbol)) {
      const armed = state.ruleArmed[rule.id] ?? true
      if (t.price == null) continue
      const crossed = rule.kind === 'priceAbove' ? t.price >= rule.level : t.price <= rule.level
      if (armed && crossed && t.marketOpen) {
        emit('instant', `${t.symbol} ${rule.kind === 'priceAbove' ? 'above' : 'below'} ${rule.level} (now ${t.price})`, t.symbol)
        state.ruleArmed[rule.id] = false
      } else if (!armed) {
        const retreated = rule.kind === 'priceAbove' ? t.price < rule.level * (1 - REARM_PCT) : t.price > rule.level * (1 + REARM_PCT)
        if (retreated) state.ruleArmed[rule.id] = true
      }
    }

    // RVOL > 2x with hysteresis
    if (t.rvol != null && t.marketOpen) {
      const hot = state.rvolHot[t.symbol] ?? false
      if (!hot && t.rvol >= 2) {
        emit('batched', `${t.symbol} relative volume ${t.rvol.toFixed(1)}x`, t.symbol)
        state.rvolHot[t.symbol] = true
      } else if (hot && t.rvol < 1.5) {
        state.rvolHot[t.symbol] = false
      }
    }

    // RSI zone entries
    if (t.rsi != null) {
      const zone = t.rsi > 70 ? 'high' : t.rsi < 30 ? 'low' : 'mid'
      const prevZone = state.rsiZone[t.symbol]
      if (prevZone && prevZone !== zone && zone !== 'mid') {
        emit('batched', `${t.symbol} RSI ${zone === 'high' ? 'above 70' : 'below 30'} (${t.rsi.toFixed(0)})`, t.symbol)
      }
      state.rsiZone[t.symbol] = zone
    }

    // setup transitions (additions only)
    const before = state.lastSetups[t.symbol] ?? []
    const added = t.setups.filter(s => !before.includes(s))
    for (const s of added) {
      const knifeToBase = s === 'basing' && before.includes('fallingKnife')
      const tier = INSTANT_SETUPS.includes(s) || knifeToBase ? 'instant' : 'batched'
      const e: AlertEvent = { id: `${input.nowSec}-${seq++}`, tier, text: `${t.symbol}: ${SETUP_LABEL[s]}${knifeToBase ? ' (knife stabilising)' : ''}`, symbol: t.symbol, at: input.nowSec, meta: { kind: 'setup', setup: s, price: t.price } }
      events.push(e)
      if (tier === 'batched') state.queue.push(e)
    }
    state.lastSetups[t.symbol] = t.setups
  }

  // journaled stop breaches — the highest-priority alert in the app
  for (const p of input.positions ?? []) {
    const key = `${p.symbol}:${p.stop}`
    if (state.stopFired[key]) continue
    const t = input.tickers.find(x => x.symbol === p.symbol)
    if (!t || t.price == null || !t.marketOpen) continue
    const breached = p.stop < p.entryPrice ? t.price <= p.stop : t.price >= p.stop
    if (breached) {
      emit('instant', `🛑 ${p.symbol} hit your stop ${p.stop} (now ${t.price}) — thesis invalidated, exit per plan`, p.symbol)
      state.stopFired[key] = true
    }
  }

  // regime flips
  if (input.regime && state.lastRegime && input.regime !== state.lastRegime) {
    emit('instant', `Regime ${state.lastRegime.toUpperCase()} → ${input.regime.toUpperCase()}`)
  }
  if (input.regime) state.lastRegime = input.regime

  // news is COLLECTED here, never alerted: raw headlines used to ping
  // instantly per watchlist mention — a firehose, not a signal. Fresh items
  // (deduped by url against seenItems) are returned for the caller to triage:
  // everything analysed lands in the app's news desk, and only what the
  // triage scores as genuinely important comes back as a ping (alert-check).
  const freshNews: (NewsItem & { syms: string[] })[] = []
  for (const n of input.news) {
    if (state.seenItems.includes(n.url)) continue
    state.seenItems.push(n.url)
    const syms = n.symbols.length ? n.symbols : mentions(n.title, cfg.watchlist)
    freshNews.push({ ...n, syms })
  }
  for (const v of input.videos) {
    if (state.seenItems.includes(v.url)) continue
    state.seenItems.push(v.url)
    const syms = mentions(v.title, cfg.watchlist)
    emit(syms.length ? 'instant' : 'batched', `▶️ ${v.channel}: ${v.title} ${v.url}`, syms[0])
  }
  if (state.seenItems.length > SEEN_CAP) state.seenItems = state.seenItems.slice(-SEEN_CAP)

  return { events, state, freshNews }
}

// ---- batching ----

const BOUNDARIES_MIN = [7 * 60, 14 * 60 + 30, 21 * 60] // 07:00, 14:30, 21:00 local

function londonParts(epochSec: number): { minutes: number; seconds: number } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  const parts = Object.fromEntries(fmt.formatToParts(new Date(epochSec * 1000)).map(p => [p.type, p.value]))
  return { minutes: Number(parts.hour) * 60 + Number(parts.minute), seconds: Number(parts.second) }
}

export function flushBatch(prev: AlertState, nowSec: number): { digest: string | null; state: AlertState } {
  const { minutes, seconds } = londonParts(nowSec)
  const passed = BOUNDARIES_MIN.filter(b => b <= minutes)
  // Minutes since the most recent boundary (previous day's 21:00 if before 07:00)
  const deltaMin = passed.length ? minutes - passed[passed.length - 1] : minutes + (24 * 60 - BOUNDARIES_MIN[2])
  const boundaryEpoch = nowSec - deltaMin * 60 - seconds
  if (prev.lastBatchAt >= boundaryEpoch) return { digest: null, state: prev }
  const state: AlertState = { ...prev, lastBatchAt: nowSec }
  if (!prev.queue.length) return { digest: null, state }
  state.queue = []
  const digest = `📋 Digest (${prev.queue.length} items)\n` + prev.queue.map(e => `• ${e.text}`).join('\n')
  return { digest, state }
}
