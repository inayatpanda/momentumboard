import type { Candle } from '../../../shared/types'
import type { AppStore } from './store'
import { validateConfig, type AppConfig } from '../../../shared/config'
import { atr, swingCapacity } from '../../../shared/indicators'
import { technicalStage } from '../../../shared/technicals'
import { regimeFromCandles } from '../../../shared/setups'
import { seasonalitySummary } from '../../../shared/seasonality'
import {
  channelsFactor,
  insiderFactor,
  momentumFactor,
  newsFactor,
  seasonalityFactor,
  sectorFactor,
  socialFactor,
  technicalFactor,
} from '../../../shared/engine/factors'
import { composeCall } from '../../../shared/engine/composite'
import {
  brierPoint,
  gradeFor,
  gradePrediction,
  maybeNudgeWeights,
  probabilityFor,
  updateCalibration,
  updateIcStats,
  type CalibrationState,
  type WeightsState,
} from '../../../shared/engine/calibration'
import { credibilityOf, gradeChannelStances, type ChannelCredState, type ExtractLike } from '../../../shared/engine/channelCred'
import { computeRung, initRisk, mapInstrument, RUNG_RISK_PCT, type RiskState } from '../../../shared/engine/riskLadder'
import { avgDollarVol20, updateRoster, type RosterCandidate, type RosterEntry } from '../../../shared/engine/roster'
import type { FactorName, FactorScore, PredOutcome, Prediction } from '../../../shared/engine/types'
import type { OutcomeLite } from '../../../shared/engine/riskLadder'
import { SECTOR_MEMBERS, computeSectorRows } from './sectors'
import type { SocialPulseRow } from './social'
import type { InsiderSummary } from './insiders'
import type { ScreenRow } from './screener'
import seed from '../../../shared/engine/seed.json'

// The daily brain: grade what matured, learn from it, curate the roster,
// score the board. All maths lives in shared/engine — this file is plumbing.

export interface EngineDeps {
  candles: (sym: string) => Promise<Candle[] | null>
  candles5y: (sym: string) => Promise<Candle[] | null>
  capUsdM: (sym: string) => Promise<number | null>
  screens: () => Promise<{ row: ScreenRow; source: string }[]>
  social: (watchSyms: string[]) => Promise<SocialPulseRow[]>
  insiders: (symbols: string[]) => Promise<InsiderSummary[]>
  mediaTitles: () => Promise<string[]>
  earningsSyms: () => Promise<Set<string>>
}

const londonDate = (nowSec: number) => new Date(nowSec * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })

// headline RSS: titles are real signal even from hard-paywalled outlets
export const MEDIA_FEEDS: [string, string][] = [
  ['FT', 'https://www.ft.com/markets?format=rss'],
  ['MarketWatch', 'https://feeds.content.dowjones.io/public/rss/mw_topstories'],
  ['CNBC', 'https://www.cnbc.com/id/100003114/device/rss/rss.html'],
  ["Barron's", 'https://www.barrons.com/xml/rss/3_7510.xml'],
  ['Bloomberg', 'https://feeds.bloomberg.com/markets/news.rss'],
]

export async function fetchMediaTitles(fetchFn: typeof fetch = fetch): Promise<string[]> {
  const out: string[] = []
  await Promise.all(
    MEDIA_FEEDS.map(async ([src, feedUrl]) => {
      try {
        const xml = await (await fetchFn(feedUrl, { headers: { 'user-agent': 'StreetSignal research inayatc2002@gmail.com' } })).text()
        for (const m of [...xml.matchAll(/<title>(?:<!\[CDATA\[)?([^<\]]{15,140})/g)].slice(1, 7)) out.push(`[${src}] ${m[1].trim()}`)
      } catch {
        /* one dead feed must not matter */
      }
    }),
  )
  return out.slice(0, 30)
}

export function defaultDeps(env: { FINNHUB_API_KEY?: string }): EngineDeps {
  return {
    candles: async sym => {
      const { cachedCandles } = await import('./marketCache')
      return cachedCandles(sym)
    },
    candles5y: async sym => {
      const { cachedCandles5y } = await import('./marketCache')
      return cachedCandles5y(sym)
    },
    capUsdM: async sym => {
      const { cachedCapUsdM } = await import('./marketCache')
      return cachedCapUsdM(sym, env.FINNHUB_API_KEY ?? '')
    },
    screens: async () => {
      const { fetchScreen, fetchTrending } = await import('./screener')
      const kinds = [
        ['day_gainers', 'screener:gainers'],
        ['most_actives', 'screener:actives'],
        ['small_cap_gainers', 'screener:smallcap'],
      ] as const
      const results = await Promise.all(kinds.map(async ([kind, source]) => (await fetchScreen(kind)).map(row => ({ row, source }))))
      const flat = results.flat()
      if (flat.length) return flat
      return (await fetchTrending()).map(row => ({ row, source: 'trending' })) // screeners refused — fall back
    },
    social: async watchSyms => {
      const { fetchRedditTrends, fetchStocktwitsTrending, combineSocialPulse } = await import('./social')
      const [r, st] = await Promise.all([fetchRedditTrends(), fetchStocktwitsTrending()])
      return combineSocialPulse(r, st, [], watchSyms)
    },
    insiders: async symbols => {
      const { fetchInsiderBuys } = await import('./insiders')
      return fetchInsiderBuys(symbols, env.FINNHUB_API_KEY ?? '')
    },
    mediaTitles: () => fetchMediaTitles(),
    earningsSyms: async () => {
      try {
        const from = new Date().toISOString().slice(0, 10)
        const to = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)
        const res = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${env.FINNHUB_API_KEY ?? ''}`)
        const j = (await res.json()) as { earningsCalendar?: { symbol?: string }[] }
        return new Set((j.earningsCalendar ?? []).map(e => e.symbol ?? '').filter(Boolean))
      } catch {
        return new Set<string>()
      }
    },
  }
}

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T

async function loadState(store: AppStore) {
  const weights = (await store.read<WeightsState>('engine-weights')) ?? clone(seed.weights as unknown as WeightsState)
  const calibration = (await store.read<CalibrationState>('engine-calibration')) ?? clone(seed.calibration as unknown as CalibrationState)
  const channelCred = (await store.read<ChannelCredState>('channel-credibility')) ?? {}
  return { weights, calibration, channelCred }
}

const mapLimit = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = []
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))))
  }
  return out
}

// ---- step 0: grade what matured, update every learning store ----

export async function gradeOutstanding(store: AppStore, deps: EngineDeps, nowSec: number, cfg?: AppConfig | null): Promise<{ graded: number }> {
  const today = londonDate(nowSec)
  const spy = await deps.candles('SPY')
  if (!spy) return { graded: 0 }
  const { weights, calibration, channelCred } = await loadState(store)
  let w = weights

  const index = ((await store.read<string[]>('predictions-index')) ?? []).slice(-30)
  const candleCache = new Map<string, Candle[] | null>([['SPY', spy]])
  const getCandles = async (sym: string) => {
    if (!candleCache.has(sym)) candleCache.set(sym, await deps.candles(sym))
    return candleCache.get(sym) ?? null
  }

  let graded = 0
  const newlyGraded: { probability: number; outcome5?: PredOutcome }[] = []
  const allOutcomes: OutcomeLite[] = []
  for (const date of index) {
    const preds = (await store.read<Prediction[]>(`predictions:${date}`)) ?? []
    let changed = false
    for (const pred of preds) {
      const candles = await getCandles(pred.sym)
      if (!candles) continue
      if (!pred.outcome5) {
        const o = gradePrediction(pred, candles, spy, 5)
        if (o) {
          pred.outcome5 = o
          updateCalibration(calibration, pred, o)
          w = updateIcStats(w, pred, o)
          newlyGraded.push({ probability: pred.probability, outcome5: o })
          graded++
          changed = true
        }
      }
      if (!pred.outcome10) {
        const o = gradePrediction(pred, candles, spy, 10)
        if (o) {
          pred.outcome10 = o
          changed = true
        }
      }
      // shadows feed calibration/IC above but never the risk ladder — the rung
      // is earned on calls the reader could actually take
      if (pred.outcome5 && !pred.shadow) allOutcomes.push({ hit: pred.outcome5.hit, stopped: pred.outcome5.stopped, leveraged: !!pred.instrument })
    }
    if (changed) await store.write(`predictions:${date}`, preds)
  }

  if (newlyGraded.length) {
    const mean = brierPoint(newlyGraded)
    if (mean != null) calibration.brier = [...calibration.brier, { date: today, mean: Math.round(mean * 1000) / 1000, n: newlyGraded.length }].slice(-250)
  }
  w = maybeNudgeWeights(w, today)

  const b = calibration.brier
  const brierImproving =
    b.length >= 10
      ? b.slice(-5).reduce((s, x) => s + x.mean, 0) / 5 <= b.slice(-10, -5).reduce((s, x) => s + x.mean, 0) / 5
      : true
  const risk = (await store.read<RiskState>('risk-state')) ?? initRisk(today)
  const nextRisk = computeRung(risk, allOutcomes.slice(-60), graded, brierImproving, cfg?.riskRungOverride ?? null, today)

  // channels: their calls get graded by the same yardstick as ours
  const extracts = ((await store.read<ExtractLike[]>('video-extracts')) ?? []).slice(-120)
  const stanceSyms = [...new Set(extracts.flatMap(e => e.tickers.map(t => t.sym)))].slice(0, 25)
  for (const sym of stanceSyms) await getCandles(sym)
  const credResult = gradeChannelStances(
    extracts,
    new Map([...candleCache.entries()].filter((e): e is [string, Candle[]] => e[1] !== null)),
    spy,
    channelCred,
    nowSec,
  )

  // scorecard: the rolled-up honesty pane
  const byGrade: Record<string, { n: number; hits: number; sumExcess: number }> = {}
  const byRegime: Record<string, { n: number; hits: number }> = {}
  const overlays: Record<string, { n: number; hits: number }> = {}
  for (const date of index) {
    const preds = (await store.read<Prediction[]>(`predictions:${date}`)) ?? []
    for (const p of preds) {
      if (!p.outcome5) continue
      const g = (byGrade[p.shadow ? 'shadow' : p.grade] ??= { n: 0, hits: 0, sumExcess: 0 })
      g.n++
      if (p.outcome5.hit) g.hits++
      g.sumExcess += p.outcome5.excessPct
      if (!p.shadow) {
        const r = (byRegime[p.regime] ??= { n: 0, hits: 0 })
        r.n++
        if (p.outcome5.hit) r.hits++
      }
      if (p.overlay) {
        const o = (overlays[p.overlay.flag] ??= { n: 0, hits: 0 })
        o.n++
        // a veto "hits" when it dodged a loser; boost/caution graded straight
        if (p.overlay.flag === 'veto' ? !p.outcome5.hit : p.outcome5.hit) o.hits++
      }
    }
  }
  await store.write('engine-scorecard', {
    byGrade,
    byRegime,
    overlays,
    brierTail: calibration.brier.slice(-30),
    totalGraded: Object.values(byGrade).reduce((s, g) => s + g.n, 0),
    updatedAt: nowSec,
  })

  await store.write('engine-weights', w)
  await store.write('engine-calibration', calibration)
  await store.write('channel-credibility', credResult.state)
  await store.write('risk-state', nextRisk)
  return { graded }
}

// ---- the daily board ----

const symToSector = (() => {
  const m = new Map<string, string>()
  for (const [etf, members] of Object.entries(SECTOR_MEMBERS)) for (const sym of members) m.set(sym, etf)
  return m
})()

const baseSym = (sym: string) => sym.split('.')[0].split('-')[0]

export async function buildBoard(
  store: AppStore,
  deps: EngineDeps,
  nowSec: number,
): Promise<{ board: Prediction[]; rosterSize: number; regime: string }> {
  const today = londonDate(nowSec)
  const cfg = validateConfig(await store.read('config')) ?? { watchlist: [], rules: [], ytChannels: [], capital: 5000 }
  const watchSyms = cfg.watchlist.map(w => w.symbol)
  const favourites = cfg.favouriteChannels ?? ['Stocks with Josh']

  const [spy, qqq] = await Promise.all([deps.candles('SPY'), deps.candles('QQQ')])
  if (!spy) throw new Error('no SPY candles — engine cannot run')
  const regime = qqq ? regimeFromCandles(spy, qqq) : ('unknown' as const)
  const spyCloses = spy.map(c => c.c)

  // discovery inflows → roster candidates
  const [screens, social] = await Promise.all([deps.screens(), deps.social(watchSyms)])
  const sectorPairs = await mapLimit(Object.keys(SECTOR_MEMBERS), 6, async etf => [etf, await deps.candles(etf)] as const)
  const sectorRows = computeSectorRows(new Map(sectorPairs.filter((p): p is [string, Candle[]] => p[1] !== null)), spy)
  const topSectorMembers = sectorRows.slice(0, 2).flatMap(r => SECTOR_MEMBERS[r.sym] ?? [])

  const sources = new Map<string, { source: string; capUsdM: number | null }>()
  const addSource = (sym: string, source: string, capUsdM: number | null = null) => {
    const key = sym.toUpperCase()
    if (!sources.has(key)) sources.set(key, { source, capUsdM })
    else if (capUsdM != null && sources.get(key)!.capUsdM == null) sources.get(key)!.capUsdM = capUsdM
  }
  for (const { row, source } of screens) addSource(row.sym, source, row.capUsdM)
  for (const s of social.slice(0, 12)) addSource(s.sym, 'social')
  for (const sym of topSectorMembers) addSource(sym, 'rotation')
  for (const sym of watchSyms) addSource(sym, 'watchlist')

  const currentRoster = (await store.read<RosterEntry[]>('engine-roster')) ?? []
  for (const e of currentRoster) addSource(e.sym, e.source, e.capUsdM) // members get re-examined daily

  const candidateSyms = [...sources.keys()].slice(0, 110)
  const candleMap = new Map<string, Candle[]>()
  await mapLimit(candidateSyms, 8, async sym => {
    const c = await deps.candles(sym)
    if (c && c.length >= 30) candleMap.set(sym, c)
  })

  // cap lookups are budgeted: screener caps ride along free, the rest rotate
  const noCap = candidateSyms.filter(s => sources.get(s)!.capUsdM == null && candleMap.has(s)).slice(0, 15)
  await mapLimit(noCap, 5, async sym => {
    const cap = await deps.capUsdM(sym)
    if (cap != null) sources.get(sym)!.capUsdM = cap
  })

  const candidates: RosterCandidate[] = candidateSyms
    .filter(s => candleMap.has(s))
    .map(sym => {
      const candles = candleMap.get(sym)!
      const closes = candles.map(c => c.c)
      return {
        sym,
        source: sources.get(sym)!.source,
        capUsdM: sources.get(sym)!.capUsdM,
        capacityPct: swingCapacity(closes),
        dollarVol20d: avgDollarVol20(candles),
        price: closes[closes.length - 1] ?? null,
      }
    })
  const { roster, joined, dropped } = updateRoster(currentRoster, candidates, watchSyms, today)
  await store.write('engine-roster', roster)
  const rosterLog = ((await store.read<unknown[]>('engine-roster-log')) ?? []) as { date: string }[]
  await store.write('engine-roster-log', [...rosterLog.filter(l => l.date !== today), { date: today, joined, dropped }].slice(-60))

  // shared context for factor computation
  const { weights, calibration, channelCred } = await loadState(store)
  const risk = (await store.read<RiskState>('risk-state')) ?? initRisk(today)
  const [insiderList, mediaTitles, earningsSet] = await Promise.all([
    watchSyms.length ? deps.insiders(watchSyms) : Promise.resolve([]),
    deps.mediaTitles(),
    deps.earningsSyms(),
  ])
  const insidersBySym = new Map(insiderList.map(i => [i.symbol, i]))
  const socialBySym = new Map(social.map(s => [s.sym, s]))
  const weekAgo = nowSec - 7 * 86_400
  const extracts = ((await store.read<ExtractLike[]>('video-extracts')) ?? []).filter(e => e.at > weekAgo)
  const stancesBySym = new Map<string, { channel: string; stance: 'bull' | 'bear' | 'neutral' }[]>()
  for (const e of extracts) {
    for (const t of e.tickers) {
      const arr = stancesBySym.get(t.sym) ?? []
      arr.push({ channel: e.channel, stance: t.stance })
      stancesBySym.set(t.sym, arr)
    }
  }
  const credOf = (ch: string) => credibilityOf(channelCred, ch, favourites)
  const sectorRankPct = (sym: string): number | null => {
    const etf = symToSector.get(baseSym(sym))
    if (!etf || sectorRows.length < 2) return null
    const idx = sectorRows.findIndex(r => r.sym === etf)
    return idx === -1 ? null : 1 - idx / (sectorRows.length - 1)
  }
  const titleMatches = (sym: string) => {
    const base = baseSym(sym)
    if (base.length < 2) return []
    const re = new RegExp(`\\b${base.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'i')
    return mediaTitles.filter(t => re.test(t))
  }

  const board: Prediction[] = []
  for (const entry of roster) {
    const candles = candleMap.get(entry.sym) ?? (await deps.candles(entry.sym).then(c => (c && c.length >= 30 ? c : null)))
    if (!candles) continue
    const closes = candles.map(c => c.c)
    const read = technicalStage(entry.sym, candles)
    if (!read) continue

    const factors: Record<FactorName, FactorScore> = {
      technical: technicalFactor(read),
      momentum: momentumFactor(closes, spyCloses),
      sector: sectorFactor(sectorRankPct(entry.sym)),
      social: socialFactor(
        socialBySym.has(entry.sym)
          ? { redditRank: socialBySym.get(entry.sym)!.redditRank, surgeMultiple: socialBySym.get(entry.sym)!.surgeMultiple, sources: socialBySym.get(entry.sym)!.sources }
          : null,
        read.rsi,
      ),
      channels: channelsFactor(stancesBySym.get(entry.sym) ?? stancesBySym.get(baseSym(entry.sym)) ?? [], credOf),
      insiders: insiderFactor(watchSyms.includes(entry.sym) ? (insidersBySym.get(entry.sym) ?? null) : undefined),
      news: newsFactor(titleMatches(entry.sym)),
      seasonality: { score: null, detail: 'checked only for candidates' },
    }
    const composeInput = {
      sym: entry.sym,
      factors,
      weights: weights.current,
      regime,
      capacityPct: swingCapacity(closes),
      atr: atr(candles)[candles.length - 1],
      lastClose: closes[closes.length - 1],
      entryQuality: read.entryQuality,
      stage: read.stage,
      earningsWithinHorizon: earningsSet.has(baseSym(entry.sym)),
      capUsdM: entry.capUsdM,
    }
    let call = composeCall(composeInput)
    if (call) {
      // the 5y fetch is earned, not default: only names that already made a call
      const c5 = await deps.candles5y(entry.sym)
      if (c5 && c5.length >= 500) {
        const month = Number(today.slice(5, 7))
        factors.seasonality = seasonalityFactor(seasonalitySummary(c5), month)
        call = composeCall({ ...composeInput, factors }) // seasonality may push it either way — honest both ways
      }
    }
    if (!call) continue

    const { p, provisional } = probabilityFor(calibration, call.side, regime, Math.abs(call.composite))
    const grade = gradeFor(p, provisional, call.capacityPct)
    // grade null = calibration sees no edge in this bucket. The call stays off
    // the paper — but it MUST enter the ledger as a shadow, or buckets below
    // 50% can never earn their way back up (nothing would ever get graded).
    const shadow = !grade

    const instrument = shadow ? null : mapInstrument(call.side, call.sym, grade!, risk.rung, cfg.levMap ?? {})
    board.push({
      ...call,
      id: `${today}:${call.sym}:${call.side}`,
      date: today,
      regime,
      priceAtPrediction: call.entry,
      shadow: shadow || undefined,
      probability: Math.round(p * 100) / 100,
      provisional,
      grade: grade ?? 'C',
      riskRung: risk.rung,
      riskPct: shadow ? 0 : RUNG_RISK_PCT[risk.rung] * (call.earningsRisk ? 0.5 : 1),
      instrument,
      paperOnly: call.side === 'short' && !instrument,
    })
  }

  const pick = (side: 'long' | 'short', shadow: boolean, cap: number) =>
    board
      .filter(b => b.side === side && !!b.shadow === shadow)
      .sort((a, b) => Math.abs(b.composite) - Math.abs(a.composite))
      .slice(0, cap)
  const live = [...pick('long', false, 12), ...pick('short', false, 12)].sort((a, b) => Math.abs(b.composite) - Math.abs(a.composite))
  const shadows = [...pick('long', true, 5), ...pick('short', true, 5)]
  const final = [...live, ...shadows]

  // reruns preserve overlays and outcomes already earned today
  const existing = (await store.read<Prediction[]>(`predictions:${today}`)) ?? []
  const byId = new Map(existing.map(p => [p.id, p]))
  for (const p of final) {
    const prev = byId.get(p.id)
    if (prev?.overlay) p.overlay = prev.overlay
    if (prev?.outcome5) p.outcome5 = prev.outcome5
    if (prev?.outcome10) p.outcome10 = prev.outcome10
  }
  await store.write(`predictions:${today}`, final)
  const index = (await store.read<string[]>('predictions-index')) ?? []
  if (!index.includes(today)) await store.write('predictions-index', [...index, today].slice(-250))
  // the paper and the app see only live calls; shadows exist to be graded
  await store.write('engine-board', { date: today, generatedAt: nowSec, regime, board: live })

  return { board: live, rosterSize: roster.length, regime }
}
