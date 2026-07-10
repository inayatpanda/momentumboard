import type { Candle } from '../../../shared/types'
import type { AppStore } from './store'
import { validateConfig, type AppConfig } from '../../../shared/config'
import { atr, swingCapacity } from '../../../shared/indicators'
import { technicalStage } from '../../../shared/technicals'
import { breadthAbove50, refineRegime, regimeFromCandles } from '../../../shared/setups'
import { seasonalitySummary } from '../../../shared/seasonality'
import {
  catalystFactor,
  channelsFactor,
  insiderFactor,
  momentumFactor,
  newsFactor,
  seasonalityFactor,
  sectorFactor,
  smartMoneyFactor,
  socialFactor,
  technicalFactor,
  type SmartMoneyInput,
} from '../../../shared/engine/factors'
import { composeCall } from '../../../shared/engine/composite'
import { gatesFor, type CatalystTag } from '../../../shared/engine/catalyst'
import { extractNewsCatalysts, type NewsCatalyst } from './newsCatalysts'
import { newsTone, worldMult, worldTone, VIX_SYMBOL, WORLD_SYMBOLS, type WorldRead } from '../../../shared/engine/worldTape'
import {
  baseHitRate,
  brierPoint,
  CALIB_DEF_VERSION,
  gradeFor,
  gradePrediction,
  maybeNudgeWeights,
  migrateWeights,
  probabilityFor,
  updateCalibration,
  updateIcStats,
  type CalibrationState,
  type WeightsState,
} from '../../../shared/engine/calibration'
import { pickDiverse } from '../../../shared/engine/select'
import { credibilityOf, gradeChannelStances, type ChannelCredState, type ExtractLike } from '../../../shared/engine/channelCred'
import { computeRung, initRisk, mapInstrument, RUNG_RISK_PCT, type RiskState } from '../../../shared/engine/riskLadder'
import { avgDollarVol20, ROSTER_MAX, updateRoster, type RosterCandidate, type RosterEntry } from '../../../shared/engine/roster'
import type { T212Position } from './t212lib'
import type { FactorName, FactorScore, PredOutcome, Prediction } from '../../../shared/engine/types'
import type { OutcomeLite } from '../../../shared/engine/riskLadder'
import { primaryThemeOf, themeCandidates, themeHeat, themesOf } from '../../../shared/engine/themes'
import { SECTOR_MEMBERS, computeSectorRows } from './sectors'
import type { SocialPulseRow } from './social'
import type { InsiderSummary } from './insiders'
import { matchSmartMoney, type FundMoves } from './edgar'
import type { ScreenRow } from './screener'
import seed from '../../../shared/engine/seed.json'

// The daily brain: grade what matured, learn from it, curate the roster,
// score the board. All maths lives in shared/engine — this file is plumbing.

export interface EngineDeps {
  candles: (sym: string) => Promise<Candle[] | null>
  candles5y: (sym: string) => Promise<Candle[] | null>
  capUsdM: (sym: string) => Promise<number | null>
  companyName: (sym: string) => Promise<string | null>
  screens: () => Promise<{ row: ScreenRow; source: string }[]>
  social: (watchSyms: string[]) => Promise<SocialPulseRow[]>
  // roster-wide insider coverage: watchlist every run + a rotating cached slice
  // of the rest. Map value: summary → buys; null → checked-empty; absent → never checked.
  insiderCoverage: (rosterSyms: string[], watchSyms: string[], dateISO: string) => Promise<Map<string, InsiderSummary | null>>
  smartMoney: () => Promise<FundMoves[]>
  mediaTitles: () => Promise<string[]>
  // the day's market-moving news → tradable beneficiaries/victims (newsCatalysts.ts).
  // LLM-backed; fail-soft to [] when no provider is configured, so the engine still
  // runs deterministically without it. Called once per run with the media titles.
  newsCatalysts: (titles: string[]) => Promise<NewsCatalyst[]>
  // recently-listed US names (Finnhub IPO calendar, cached ~6h). A post-IPO name
  // the momentum scanner would never surface — it has no price history to screen
  // on — joins the candidate pool as a GATED fresh-listing source. Fail-soft: no
  // key / a Finnhub outage → [] → the engine is unchanged.
  recentIpos: () => Promise<{ sym: string; date: string }[]>
  earningsSyms: () => Promise<Set<string>>
  // overnight world tape: latest daily % change for the Asia/Europe indices, US
  // futures and VIX (^VIX carried in the same list, split out in buildBoard).
  // Fail-soft: any read the source can't supply is null — a vote it cannot cast.
  worldReads: () => Promise<WorldRead[]>
  // the reader's REAL Trading 212 book, or null when T212 is unconfigured / down.
  // Fail-soft: a broker outage must never stop the board building.
  holdings: () => Promise<T212Position[] | null>
}

const londonDate = (nowSec: number) => new Date(nowSec * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })

// headline RSS: titles are real signal even from hard-paywalled outlets
export const MEDIA_FEEDS: [string, string][] = [
  ['FT', 'https://www.ft.com/markets?format=rss'],
  ['MarketWatch', 'https://feeds.content.dowjones.io/public/rss/mw_topstories'],
  ['CNBC', 'https://www.cnbc.com/id/100003114/device/rss/rss.html'],
  ["Barron's", 'https://www.barrons.com/xml/rss/3_7510.xml'],
  ['Bloomberg', 'https://feeds.bloomberg.com/markets/news.rss'],
  // India watch — context only (NSE/BSE aren't tradeable in the user's ISA); verified 2026-07-02
  ['ET India', 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms'],
  ['LiveMint', 'https://www.livemint.com/rss/markets'],
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
  // 7 feeds × ≤6 titles can exceed 30 — raised modestly so the 2 India feeds
  // don't crowd out FT/MarketWatch/CNBC/Barron's/Bloomberg on a busy morning.
  return out.slice(0, 40)
}

export function defaultDeps(env: { FINNHUB_API_KEY?: string; T212_API_KEY?: string; T212_SECRET_KEY?: string; T212_HOST?: string }): EngineDeps {
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
    companyName: async sym => {
      const { cachedCompanyName } = await import('./marketCache')
      return cachedCompanyName(sym, env.FINNHUB_API_KEY ?? '')
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
    insiderCoverage: async (rosterSyms, watchSyms, dateISO) => {
      const { collectInsiderCoverage } = await import('./insiders')
      return collectInsiderCoverage(rosterSyms, watchSyms, dateISO, env.FINNHUB_API_KEY ?? '')
    },
    smartMoney: async () => {
      const { cachedFundMoves } = await import('./edgar')
      return cachedFundMoves()
    },
    mediaTitles: () => fetchMediaTitles(),
    // non-strict: callLlm/anyProviderAvailable merge the server's own process.env
    // keys (GROQ/GEMINI/…), so this uses whatever provider the deployment has and
    // returns [] when none is set — the board never depends on the LLM being up.
    newsCatalysts: titles => extractNewsCatalysts(titles),
    // fresh listings: pull the IPO calendar (90d back → 7d ahead, one cached
    // fetch shared with the market-data endpoint) and keep the recently-priced
    // names that now carry some price history. Fail-soft to [].
    recentIpos: async () => {
      const { fetchIpoCalendar, recentListings } = await import('./ipoCalendar')
      const iso = (d: Date) => d.toISOString().slice(0, 10)
      const now = new Date()
      const rows = await fetchIpoCalendar(
        env.FINNHUB_API_KEY ?? '',
        iso(new Date(now.getTime() - 90 * 86_400_000)),
        iso(new Date(now.getTime() + 7 * 86_400_000)),
      )
      return recentListings(rows, iso(now)).map(r => ({ sym: r.sym, date: r.date }))
    },
    // ^N225/^HSI/^GDAXI/^FTSE/ES=F/NQ=F/^VIX are index & futures symbols Finnhub's
    // free quote endpoint won't serve, and isYahooSymbol() routes them to Finnhub
    // (no '.'/'-' → treated as US). So derive the daily change from the last two
    // Yahoo candle closes instead — cachedCandles always hits Yahoo directly and
    // handles the ^/=F symbols fine. Any missing series → null (an uncast vote).
    worldReads: async () => {
      const { cachedCandles } = await import('./marketCache')
      const symbols = [...WORLD_SYMBOLS, VIX_SYMBOL]
      return Promise.all(
        symbols.map(async ({ sym, name }) => {
          const c = await cachedCandles(sym)
          const changePct =
            c && c.length >= 2 && c[c.length - 2].c ? ((c[c.length - 1].c - c[c.length - 2].c) / c[c.length - 2].c) * 100 : null
          return { sym, name, changePct: changePct == null ? null : Math.round(changePct * 100) / 100 }
        }),
      )
    },
    holdings: async () => {
      const { fetchT212Positions } = await import('./t212lib')
      return fetchT212Positions({ T212_API_KEY: env.T212_API_KEY, T212_SECRET_KEY: env.T212_SECRET_KEY, T212_HOST: env.T212_HOST })
    },
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
  // migrateWeights backfills factors added after a snapshot was stored/seeded
  // (seed.json predates smartMoney) so an old blob never silently zeroes them.
  const weights = migrateWeights((await store.read<WeightsState>('engine-weights')) ?? clone(seed.weights as unknown as WeightsState))
  let calibration = (await store.read<CalibrationState>('engine-calibration')) ?? clone(seed.calibration as unknown as CalibrationState)
  // the outcome definition changed → stored buckets counted a different thing
  // and their hit rates aren't probabilities anymore. Swap in the reseeded
  // calibration — but only when the committed seed itself is on the current
  // definition; never regress live state to a stale seed.
  const seedCal = seed.calibration as unknown as CalibrationState
  if (calibration.defVersion !== CALIB_DEF_VERSION && seedCal.defVersion === CALIB_DEF_VERSION) calibration = clone(seedCal)
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
  const newlyGraded: { probability: number; outcome5?: PredOutcome; shadow: boolean }[] = []
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
          newlyGraded.push({ probability: pred.probability, outcome5: o, shadow: !!pred.shadow })
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
  // LIFETIME counters: the by-grade/by-regime panes rebuild from the last 30
  // dates, but "is this tool accurate?" is a months-scale question — these
  // accumulate forever (live calls and shadows separately) and never reset.
  const priorCard = await store.read<{ lifetime?: { live: { graded: number; hits: number; sumExcess: number }; shadow: { graded: number; hits: number; sumExcess: number }; since: string } }>('engine-scorecard')
  const lifetime = priorCard?.lifetime ?? { live: { graded: 0, hits: 0, sumExcess: 0 }, shadow: { graded: 0, hits: 0, sumExcess: 0 }, since: today }
  for (const g of newlyGraded) {
    const side = g.shadow ? lifetime.shadow : lifetime.live
    side.graded++
    if (g.outcome5!.hit) side.hits++
    side.sumExcess += g.outcome5!.excessPct
  }
  await store.write('engine-scorecard', {
    byGrade,
    byRegime,
    overlays,
    brierTail: calibration.brier.slice(-30),
    totalGraded: Object.values(byGrade).reduce((s, g) => s + g.n, 0),
    lifetime,
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
): Promise<{ board: Prediction[]; rosterSize: number; regime: string; holdingsCount: number }> {
  const today = londonDate(nowSec)
  const cfg = validateConfig(await store.read('config')) ?? { watchlist: [], rules: [], ytChannels: [], capital: 5000 }
  const watchSyms = cfg.watchlist.map(w => w.symbol)
  const favourites = cfg.favouriteChannels ?? ['Stocks with Josh']
  const gates = gatesFor(cfg.riskAppetite) // 'aggressive' widens the dead zone / capacity floors (catalyst.ts)

  const [spy, qqq] = await Promise.all([deps.candles('SPY'), deps.candles('QQQ')])
  if (!spy) throw new Error('no SPY candles — engine cannot run')
  const baseRegime = qqq ? regimeFromCandles(spy, qqq) : ('unknown' as const)
  const spyCloses = spy.map(c => c.c)

  // discovery inflows → roster candidates. Media titles come first: theme
  // heat ("chips are in the news") decides which theme members join today's
  // candidate pool, and the same titles later feed the news factor + tone.
  const [screens, social, mediaTitles] = await Promise.all([deps.screens(), deps.social(watchSyms), deps.mediaTitles()])
  const sectorPairs = await mapLimit(Object.keys(SECTOR_MEMBERS), 6, async etf => [etf, await deps.candles(etf)] as const)
  const sectorRows = computeSectorRows(new Map(sectorPairs.filter((p): p is [string, Candle[]] => p[1] !== null)), spy)
  const topSectorMembers = sectorRows.slice(0, 2).flatMap(r => SECTOR_MEMBERS[r.sym] ?? [])

  // Pundit stances, read EARLY so a high-credibility off-roster call can NOMINATE
  // a name into the candidate pool below — not merely re-score one already on the
  // roster. loadState (weights/calibration/channelCred) is hoisted here too so the
  // per-channel credibility gate is available; the SAME stancesBySym + credOf are
  // reused for the channels factor later, so there is one read and no regression.
  // Fail-soft: missing extracts → empty map → no injection.
  const { weights, calibration, channelCred } = await loadState(store)
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

  const sources = new Map<string, { source: string; capUsdM: number | null }>()
  const addSource = (sym: string, source: string, capUsdM: number | null = null) => {
    const key = sym.toUpperCase()
    if (!sources.has(key)) sources.set(key, { source, capUsdM })
    else if (capUsdM != null && sources.get(key)!.capUsdM == null) sources.get(key)!.capUsdM = capUsdM
  }
  for (const { row, source } of screens) addSource(row.sym, source, row.capUsdM)
  for (const s of social.slice(0, 12)) addSource(s.sym, 'social')
  for (const sym of topSectorMembers) addSource(sym, 'rotation')
  // focus themes (energy/chips/data centres/robotics/drones): hottest-in-the-news
  // first, every theme scanned a little even on quiet days. Same gates as everyone.
  for (const { sym, theme } of themeCandidates(mediaTitles)) addSource(sym, `theme:${theme}`)
  // market-moving news → tradable names (newsCatalysts.ts). The LLM reads today's
  // headlines and nominates the most liquid beneficiaries/victims of ANY big story
  // (geopolitics, rates, oil, a major listing, M&A). They join the pool as one more
  // GATED candidate source — never a call by fiat — and each carries a CatalystTag
  // that (a) casts a strength-scaled catalyst-factor vote and (b) relaxes the
  // trailing capacity gate, so a big liquid name in the news gets a fair look on
  // the very day it breaks. Fail-soft: no LLM provider → [] → engine is unchanged.
  const newsCats = await deps.newsCatalysts(mediaTitles).catch(() => [] as NewsCatalyst[])
  const catalystBySym = new Map<string, CatalystTag>()
  for (const nc of newsCats) {
    const key = nc.sym.toUpperCase()
    if (!catalystBySym.has(key)) catalystBySym.set(key, { kind: 'news', side: nc.side, reason: nc.reason, strength: nc.strength })
    addSource(key, 'catalyst:news')
  }
  // Fresh listings: a company that just debuted on a US exchange (SK Hynix, say)
  // has no price history the momentum scanner could find it on. The IPO calendar
  // nominates recently-priced names as one more GATED candidate source, each with
  // an 'ipo' catalyst carrying side:null — the relaxed capacity gate, but NO free
  // directional vote (catalystFactor casts nothing when side is null). Names
  // younger than ~30 sessions still fail the 30-candle floor below, and that is
  // correct: the engine will not call a name it cannot yet read. Fail-soft: no
  // key → [] → the engine is unchanged.
  const recentIpos = await deps.recentIpos().catch(() => [] as { sym: string; date: string }[])
  for (const ipo of recentIpos) {
    const key = ipo.sym.toUpperCase()
    if (!catalystBySym.has(key)) catalystBySym.set(key, { kind: 'ipo', side: null, reason: `listed ${ipo.date}`, strength: 40 })
    addSource(key, 'catalyst:ipo')
  }
  for (const sym of watchSyms) addSource(sym, 'watchlist')
  // AI roster nominations: the paper's analyst nominated these for the engine to
  // EXAMINE — one more candidate source, never a call by fiat; it faces the same
  // capacity/liquidity gates and full factor stack. Unexpired only (7-day TTL
  // mirrors mergeNominations in newspaper.ts — a safety net over the writer's own expiry).
  const nominations = (await store.read<{ sym: string; at: number }[]>('ai-nominations')) ?? []
  const nomCutoff = nowSec - 7 * 86_400
  for (const n of nominations) {
    if (n && typeof n.sym === 'string' && typeof n.at === 'number' && n.at >= nomCutoff) addSource(n.sym, 'ai-nomination')
  }
  // Pundit → candidate: a tracked YouTube channel's non-neutral call can NOMINATE a
  // name into the pool even when it is not already on the roster. It qualifies when
  // a channel with EARNED credibility (credibilityOf ≥ 0.55) voices a side, OR when
  // ≥2 channels agree on a side (crowd consensus stands in for single-name trust).
  // Like every source this is a GATED candidate — it still faces the full capacity/
  // liquidity/factor/calibration stack, never a call by fiat. Fail-soft: no extracts
  // → stancesBySym empty → nothing injected.
  for (const [sym, arr] of stancesBySym) {
    const voiced = arr.filter(s => s.stance !== 'neutral')
    if (!voiced.length) continue
    const credible = voiced.some(s => credOf(s.channel) >= 0.55)
    const bulls = voiced.filter(s => s.stance === 'bull').length
    const bears = voiced.filter(s => s.stance === 'bear').length
    const agree = bulls >= 2 || bears >= 2
    if (credible || agree) addSource(sym, 'channel:consensus')
  }

  const currentRoster = (await store.read<RosterEntry[]>('engine-roster')) ?? []
  for (const e of currentRoster) addSource(e.sym, e.source, e.capUsdM) // members get re-examined daily

  // The reader's REAL Trading 212 book. Fetched fail-soft (a broker outage never
  // stops the board). Held names join the CANDIDATE pool with source 'holding' —
  // gated exactly like any mover, so they must EARN their roster slot and are NOT
  // watchlist-immortal. Added LAST so a large book never evicts the movers from the
  // 110-candidate evaluation cap. The engine's per-holding opinion (holdings-reads)
  // is written separately below, after the board is scored.
  const holdings = await deps.holdings().catch(() => null)
  if (holdings) {
    await store.write('holdings', { at: nowSec, positions: holdings })
    for (const p of holdings.slice(0, ROSTER_MAX)) addSource(p.symbol, 'holding')
  }

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

  // regime, refined: the SPY+QQQ slope read is checked against market breadth
  // (share of today's candidate pool above its 50-SMA) and the VIX LEVEL —
  // ^VIX candles come from Yahoo like every index symbol. Null inputs leave
  // the base read untouched; 'unknown' (no QQQ) stays unknown.
  const vixCandles = await deps.candles(VIX_SYMBOL.sym).catch(() => null)
  const vixLevel = vixCandles?.length ? vixCandles[vixCandles.length - 1].c : null
  const breadth = breadthAbove50([...candleMap.values()].map(cs => cs.map(c => c.c)))
  const regime = baseRegime === 'unknown' ? baseRegime : refineRegime(baseRegime, breadth, vixLevel)

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

  // shared context for factor computation (weights/calibration/channelCred loaded
  // above with the pundit stances, so a high-credibility call could nominate names)
  const engineBaseRate = baseHitRate(calibration).rate
  const risk = (await store.read<RiskState>('risk-state')) ?? initRisk(today)
  const rosterSyms = roster.map(e => e.sym)
  const [insiderCoverage, earningsSet, fundMoves, worldReads] = await Promise.all([
    deps.insiderCoverage(rosterSyms, watchSyms, today),
    deps.earningsSyms(),
    deps.smartMoney(),
    deps.worldReads(),
  ])
  // World tape read once for the whole board: Asia/Europe indices + US futures
  // vote on direction; ^VIX votes on fear at a wider threshold. tone → a bounded
  // per-side conviction nudge (worldMult), NEVER a change to the calibration bucket.
  const vixRead = worldReads.find(r => r.sym === VIX_SYMBOL.sym)
  const tone = worldTone(
    worldReads.filter(r => r.sym !== VIX_SYMBOL.sym),
    vixRead?.changePct ?? null,
  )
  // 13F overlap: match each roster name (via its cap: company name, else alias map)
  // against the tracked funds' latest moves. Cheap and cached; skipped if no filings.
  const smartMoneyBySym = new Map<string, SmartMoneyInput | null>()
  if (fundMoves.length) {
    await Promise.all(
      rosterSyms.map(async sym => {
        smartMoneyBySym.set(sym, matchSmartMoney(sym, await deps.companyName(sym), fundMoves))
      }),
    )
  }
  const socialBySym = new Map(social.map(s => [s.sym, s]))
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
    const cat = catalystBySym.get(entry.sym.toUpperCase()) ?? null

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
      // coverage.get: summary → scored, null → checked-empty (0), undefined (absent) → not checked (null)
      insiders: insiderFactor(insiderCoverage.get(entry.sym)),
      news: newsFactor(titleMatches(entry.sym)),
      seasonality: { score: null, detail: 'checked only for candidates' },
      smartMoney: smartMoneyFactor(smartMoneyBySym.get(entry.sym) ?? null),
      catalyst: catalystFactor(cat),
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
      gates,
      catalyst: cat,
    }
    let call = composeCall(composeInput)
    if (call) {
      // the 5y fetch is earned, not default: only names that already made a call
      const c5 = await deps.candles5y(entry.sym)
      if (c5 && c5.length >= 500) {
        const month = Number(today.slice(5, 7))
        factors.seasonality = seasonalityFactor(seasonalitySummary(c5), month)
      }
      // now the side is known → apply the overnight world-tape nudge for it and
      // re-score. The mult is > 0 so the side never flips, but it can push a
      // marginal call under the dead zone (→ null, correctly suppressed).
      // seasonality (if it loaded) rides the same re-score — honest both ways.
      call = composeCall({ ...composeInput, factors, worldMult: worldMult(tone.tone, call.side) })
    }
    if (!call) continue

    const { p, provisional } = probabilityFor(calibration, call.side, regime, Math.abs(call.composite))
    const grade = gradeFor(p, provisional, call.capacityPct, engineBaseRate)
    // grade null = calibration sees no edge in this bucket. The call stays off
    // the paper — but it MUST enter the ledger as a shadow, or buckets below
    // 50% can never earn their way back up (nothing would ever get graded).
    // An earnings print inside the horizon also forces shadow: a binary coin
    // flip has no place on the live board, but its outcome is kept (earningsRisk
    // stays on the record) so the ledger can later show whether the engine has
    // any edge INTO prints — half-sizing a coin flip just pollutes the buckets.
    const shadow = !grade || call.earningsRisk

    const instrument = shadow ? null : mapInstrument(call.side, call.sym, grade!, risk.rung, cfg.levMap ?? {})
    const callThemes = themesOf(entry.sym)
    board.push({
      ...call,
      id: `${today}:${call.sym}:${call.side}`,
      date: today,
      regime,
      priceAtPrediction: call.entry,
      themes: callThemes.length ? callThemes : undefined,
      catalyst: cat ? { kind: cat.kind, reason: cat.reason } : undefined,
      capUsdM: entry.capUsdM,
      shadow: shadow || undefined,
      probability: Math.round(p * 100) / 100,
      provisional,
      grade: grade ?? 'C',
      riskRung: risk.rung,
      riskPct: shadow ? 0 : RUNG_RISK_PCT[risk.rung],
      instrument,
      paperOnly: call.side === 'short' && !instrument,
      worldTape: { tone: tone.tone, mult: worldMult(tone.tone, call.side) },
    })
  }

  // one outstanding shadow per sym+side: skip a shadow candidate whose sym+side
  // already has an ungraded (no outcome5) prediction on a recent prior date —
  // three correlated CEG shorts in three weeks teach nothing while starving the
  // tiny shadow budget of fresh names. Live (non-shadow) calls are never deduped.
  const priorDates = ((await store.read<string[]>('predictions-index')) ?? []).filter(d => d !== today).slice(-10)
  const outstandingShadowKeys = new Set<string>()
  for (const date of priorDates) {
    for (const p of (await store.read<Prediction[]>(`predictions:${date}`)) ?? []) {
      if (!p.outcome5) outstandingShadowKeys.add(`${p.sym}:${p.side}`)
    }
  }
  const pick = (side: 'long' | 'short', shadow: boolean, cap: number) =>
    board
      .filter(b => b.side === side && !!b.shadow === shadow && (!shadow || !outstandingShadowKeys.has(`${b.sym}:${b.side}`)))
      .sort((a, b) => Math.abs(b.composite) - Math.abs(a.composite))
      .slice(0, cap)
  // live picks pass diversity gates: max 3 per group per side, and no name
  // moving in lockstep (60d return corr > 0.75) with one already picked —
  // twelve correlated bets are one bet. Grouping: sector-ETF mapping where it
  // exists (the S&P megacaps), theme otherwise — so five drone small caps the
  // sector map has never heard of still count as ONE crowd. Shadows keep the
  // plain top-N (they exist to feed calibration; their dedup is handled above).
  const pickLive = (side: 'long' | 'short', cap: number) => {
    const { picked, skipped } = pickDiverse(
      board.filter(b => b.side === side && !b.shadow),
      cap,
      sym => symToSector.get(baseSym(sym)) ?? primaryThemeOf(sym),
      sym => candleMap.get(sym)?.map(c => c.c) ?? null,
    )
    if (skipped.length) console.log(`BOARD: diversity gates (${side}):`, skipped.map(s => `${s.sym} — ${s.why}`).join('; '))
    return picked
  }
  const live = [...pickLive('long', 12), ...pickLive('short', 12)].sort((a, b) => Math.abs(b.composite) - Math.abs(a.composite))
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
  // Global news tone: DISPLAY / LOG ONLY, explicitly NOT a factor. It rides the
  // board blob and accumulates its own bounded history — factor status must be
  // EARNED from that logged history before it may ever enter a composite/multiplier.
  const globalNews = newsTone(mediaTitles)
  const newsHist = ((await store.read<{ date: string; score: number; label: string }[]>('news-tone-history')) ?? []).filter(h => h.date !== today)
  await store.write('news-tone-history', [...newsHist, { date: today, score: globalNews.score, label: globalNews.label }].slice(-250))

  // the paper and the app see only live calls; shadows exist to be graded
  await store.write('engine-board', {
    date: today,
    generatedAt: nowSec,
    regime,
    board: live,
    worldTape: { tone: tone.tone, votes: tone.votes, detail: tone.detail },
    newsTone: globalNews,
    // focus themes ranked by headline heat — identification for the UI, never a score
    themes: themeHeat(mediaTitles).filter(t => t.hits > 0).slice(0, 3),
  })

  // ---- the engine's daily opinion on every REAL holding ----
  // For each held name (cap 80): where is it in its move (technicalStage) and can
  // it travel (swingCapacity)? Candles are reused from candleMap when the name was
  // already a candidate, else fetched fresh (cachedCandles dedupes). This is the
  // Desk's read-only tracking pane and the paper's portfolioDesk input. Per-holding
  // fail-soft: a name the engine can't read gets null stage, not a thrown run.
  let holdingsCount = 0
  if (holdings) {
    const held = holdings.slice(0, ROSTER_MAX)
    holdingsCount = held.length
    const reads = await mapLimit(held, 8, async p => {
      const candles = candleMap.get(p.symbol) ?? (await deps.candles(p.symbol).catch(() => null))
      const readable = candles != null && candles.length >= 30
      const read = readable ? technicalStage(p.symbol, candles!) : null
      return {
        sym: p.symbol,
        stage: read?.stage ?? null,
        entryQuality: read?.entryQuality ?? null,
        note: read?.note ?? null,
        capacityPct: readable ? swingCapacity(candles!.map(c => c.c)) : null,
        pplPct: p.pplPct,
        quantity: p.quantity,
      }
    })
    await store.write('holdings-reads', reads)
  }

  return { board: live, rosterSize: roster.length, regime, holdingsCount }
}
