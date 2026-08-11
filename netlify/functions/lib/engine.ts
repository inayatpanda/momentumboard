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
import { rankSleeve, sleeveWithDefaults } from '../../../shared/engine/coreSleeve'
import { classifyDip, dipCall, type DipRead } from '../../../shared/engine/dipLane'
import { DIP_CATALYST_KIND, gatesFor, type CatalystTag } from '../../../shared/engine/catalyst'
import { extractNewsCatalysts, type NewsCatalyst } from './newsCatalysts'
import { DIP_NEWS_BUDGET, unservedVenue, type DipNewsVerdict } from './dipNews'
import { newsTone, worldMult, worldTone, VIX_SYMBOL, WORLD_SYMBOLS, type WorldRead } from '../../../shared/engine/worldTape'
import {
  baseHitRate,
  brierPoint,
  CALIB_DEF_VERSION,
  gradeFor,
  gradePrediction,
  ENGINE_MODEL_VERSION,
  migrateCalibration,
  maybeNudgeWeights,
  migrateWeights,
  probabilityFor,
  updateCalibration,
  updateIcStats,
  type CalibrationState,
  type WeightsState,
} from '../../../shared/engine/calibration'
import { pickDiverse } from '../../../shared/engine/select'
import { horizonOf } from '../../../shared/engine/horizon'
import { credibilityOf, gradeChannelStances, type ChannelCredState, type ExtractLike } from '../../../shared/engine/channelCred'
import { computeCohortRung, computeRung, cohortRungOf, initRisk, isRouteEtp, mapInstrument, migrateRisk, RUNG_RISK_PCT, type RiskState } from '../../../shared/engine/riskLadder'
import { capCohortOf, type CapCohortOrUnknown } from '../../../shared/engine/capClass'
import { avgDollarVol20, ROSTER_MAX, updateRoster, type RosterCandidate, type RosterEntry } from '../../../shared/engine/roster'
import type { T212Position } from './t212lib'
import type { EngineCall, FactorName, FactorScore, PredOutcome, Prediction } from '../../../shared/engine/types'
import type { OutcomeLite } from '../../../shared/engine/riskLadder'
import { primaryThemeOf, themeCandidates, themeHeat, themesOf } from '../../../shared/engine/themes'
import { traceOpenCall, type OpenTraceEntry } from '../../../shared/engine/openTrace'
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
  // Batched daily closes for the core sleeve (spark.ts) — ~7 calls cover 130
  // famous names. The sleeve's cheap eye: this is what lets the engine notice
  // that GLW fell 15% on a day no screener surfaced it. Fail-soft: an empty map
  // turns EVERY sleeve behaviour off, so the run is a sleeve-less run.
  sparkCloses: (syms: string[]) => Promise<Map<string, number[]>>
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
  // one narrow question per dip candidate: do this name's recent headlines read
  // overreaction or broken thesis? (dipNews.ts). Structural stands the dip trade
  // down; anything else trades. Budgeted to DIP_NEWS_BUDGET calls per run,
  // deepest dip first, and cached three days behind the default impl. Fail-soft:
  // a rejection is an 'unclear' — the lane never blocks on a lookup it couldn't make.
  dipNews: (sym: string) => Promise<DipNewsVerdict>
  // recently-listed US names (Finnhub IPO calendar, cached ~6h). A post-IPO name
  // the momentum scanner would never surface — it has no price history to screen
  // on — joins the candidate pool as a GATED fresh-listing source. Fail-soft: no
  // key / a Finnhub outage → [] → the engine is unchanged.
  recentIpos: () => Promise<{ sym: string; date: string }[]>
  earningsSyms: () => Promise<Set<string>>
  // the SAME earnings calendar as earningsSyms but DATED — every name reporting in
  // the next fortnight with its print date/hour, for the event radar (buildBoard).
  // In defaultDeps both share ONE Finnhub call; earningsSyms derives its Set from
  // this. Fail-soft: any error → [] (the radar just goes empty, the board is fine).
  earningsCalendar: () => Promise<{ sym: string; date: string; hour?: string }[]>
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
  // one dated earnings-calendar fetch (next 14 days), memoised so earningsSyms and
  // earningsCalendar share a SINGLE Finnhub call per run rather than hitting the
  // free-tier limit twice for the identical window. Fail-soft to [].
  let earningsOnce: Promise<{ sym: string; date: string; hour?: string }[]> | null = null
  const fetchEarnings = () => {
    if (!earningsOnce)
      earningsOnce = (async () => {
        try {
          const from = new Date().toISOString().slice(0, 10)
          const to = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)
          const res = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${env.FINNHUB_API_KEY ?? ''}`)
          const j = (await res.json()) as { earningsCalendar?: { symbol?: string; date?: string; hour?: string }[] }
          return (j.earningsCalendar ?? [])
            .filter(e => e.symbol)
            .map(e => ({ sym: e.symbol as string, date: e.date ?? '', hour: e.hour || undefined }))
        } catch {
          return []
        }
      })()
    return earningsOnce
  }
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
        ['day_losers', 'screener:losers'],
        ['most_actives', 'screener:actives'],
        ['small_cap_gainers', 'screener:smallcap'],
      ] as const
      const results = await Promise.all(kinds.map(async ([kind, source]) => (await fetchScreen(kind)).map(row => ({ row, source }))))
      const flat = results.flat()
      if (flat.length) return flat
      return (await fetchTrending()).map(row => ({ row, source: 'trending' })) // screeners refused — fall back
    },
    sparkCloses: async syms => {
      const { fetchSparkCloses } = await import('./spark')
      return fetchSparkCloses(syms)
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
    // Dip corroboration, cached. The read itself (Finnhub headlines → LLM →
    // keyword fallback) lives in dipNews.ts; the ONLY thing added here is the
    // `dip-news:{sym}` blob. Deliberately, only a DECISIVE verdict is cached:
    // freezing an 'unclear' would let one LLM outage or one quiet news window
    // silence the check on a name all week, and 'unclear' is the answer we most
    // want to improve on tomorrow. How LONG a decisive verdict freezes depends on
    // WHO decided it: a model that read the whole headline set holds for three
    // days, a single keyword hit thaws overnight so tomorrow's run can ask a
    // provider that may be back up. Unknown provenance takes the shorter freeze —
    // the cheap error is re-reading, not standing a name down on a stale regex.
    // Cache faults are swallowed both ways: a blob hiccup must never cost the
    // lane its verdict.
    dipNews: async sym => {
      const key = `dip-news:${sym.toUpperCase()}`
      const { getCached, setCached } = await import('./cache')
      const hit = await getCached<DipNewsVerdict>(key).catch(() => null)
      if (hit?.verdict) return hit
      const { readDipNews, DIP_NEWS_TTL_SEC, DIP_NEWS_HEURISTIC_TTL_SEC } = await import('./dipNews')
      const verdict = await readDipNews(sym, env.FINNHUB_API_KEY ?? '')
      const ttl = verdict.via === 'llm' ? DIP_NEWS_TTL_SEC : DIP_NEWS_HEURISTIC_TTL_SEC
      if (verdict.verdict !== 'unclear') await setCached(key, verdict, ttl).catch(() => {})
      return verdict
    },
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
    // both derive from the same memoised fetch above — one HTTP call, two shapes
    earningsSyms: async () => new Set((await fetchEarnings()).map(e => e.sym)),
    earningsCalendar: () => fetchEarnings(),
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
  calibration = migrateCalibration(calibration)
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

  const fullIndex = (await store.read<string[]>('predictions-index')) ?? []
  // `predictions-pending` is durable work, not a display window. On first run
  // after migration scan the bounded index once; afterwards only unresolved
  // dates are revisited, even when they are older than 30 dates.
  const storedPending = await store.read<string[]>('predictions-pending')
  const pendingDates = storedPending ?? fullIndex
  const index = [...new Set([...fullIndex.slice(-30), ...pendingDates])].sort()
  const candleCache = new Map<string, Candle[] | null>([['SPY', spy]])
  const getCandles = async (sym: string) => {
    if (!candleCache.has(sym)) candleCache.set(sym, await deps.candles(sym))
    return candleCache.get(sym) ?? null
  }

  let graded = 0
  // per-cohort tally of NON-shadow calls graded THIS run — feeds each sleeve's
  // graded-at-rung counter so it stays honest even while a young cohort pools.
  const newByCohort: Record<CapCohortOrUnknown, number> = { large: 0, small: 0, unknown: 0 }
  const newlyGraded: { probability: number; outcome10?: PredOutcome; shadow: boolean }[] = []
  // each non-shadow outcome carries its cohort so the risk ladder can split large
  // vs small; unknown-cap calls stay in the combined stream but neither sleeve.
  const allOutcomes: (OutcomeLite & { cohort: CapCohortOrUnknown })[] = []
  const stillPending: string[] = []
  // Reuse the records graded in this invocation when building the scorecard.
  // Netlify Blobs can briefly return the pre-write version after a write, which
  // otherwise makes a successful grading run publish an empty scorecard.
  const predictionsByDate = new Map<string, Prediction[]>()
  for (const date of index) {
    const preds = (await store.read<Prediction[]>(`predictions:${date}`)) ?? []
    predictionsByDate.set(date, preds)
    let changed = false
    for (const pred of preds) {
      const candles = await getCandles(pred.sym)
      if (!candles) continue
      // grading stores all three lenses (5/10/21d); only the 10-session outcome
      // — the CALIBRATED horizon (reader holds 1-2wk+) — feeds the learning loop.
      if (!pred.outcome5) {
        const o = gradePrediction(pred, candles, spy, 5)
        if (o) {
          pred.outcome5 = o
          changed = true
        }
      }
      if (!pred.outcome10) {
        const o = gradePrediction(pred, candles, spy, 10)
        if (o) {
          pred.outcome10 = o
          // THE calibrated grade: calibration buckets, factor-IC weights, the
          // Brier trail and the risk-ladder counters all learn here, at 10d.
          updateCalibration(calibration, pred, o) // cohort read off pred.capUsdM inside
          // …but NOT factor IC for a lane call. A dip call carries a constant
          // technical +40 placeholder (dipLane.ts) rather than a measured factor
          // vote, so booking its outcome would train the technical factor's IC on
          // the dip lane's P&L — a signal it never cast. Calibration buckets and
          // setup buckets above still accrue: only factor-IC is excluded.
          if (pred.catalyst?.kind !== DIP_CATALYST_KIND) w = updateIcStats(w, pred, o)
          newlyGraded.push({ probability: pred.probability, outcome10: o, shadow: !!pred.shadow })
          graded++
          if (!pred.shadow && !pred.watchOnly) newByCohort[capCohortOf(pred.capUsdM)]++
          changed = true
        }
      }
      // ~a month — the reader's stated holding period tops out around 4 weeks,
      // so the ledger keeps the month-scale truth alongside the 5d/10d reads
      if (!pred.outcome21) {
        const o = gradePrediction(pred, candles, spy, 21)
        if (o) {
          pred.outcome21 = o
          changed = true
        }
      }
      // shadows and watch-only calls feed calibration/IC above but never the
      // risk ladder — the rung is earned on calls the reader could actually take,
      // on the same 10d outcome the ladder learns from (the calibrated horizon)
      if (pred.outcome10 && !pred.shadow && !pred.watchOnly)
        allOutcomes.push({ hit: pred.outcome10.hit, stopped: pred.outcome10.stopped, leveraged: !!pred.instrument, cohort: capCohortOf(pred.capUsdM) })
    }
    if (changed) await store.write(`predictions:${date}`, preds)
    if (preds.some(p => !p.outcome5 || !p.outcome10 || !p.outcome21)) stillPending.push(date)
  }
  await store.write('predictions-pending', stillPending.slice(-250))

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
  // Risk ladder: the COMBINED rung stays the full non-shadow stream (top-level,
  // exactly as before — back-compat for every app screen reading riskState.rung),
  // and each cap-class sleeve earns its own rung from its own outcomes, pooling to
  // the combined rung while thin. migrateRisk seeds cohorts from a legacy blob.
  const risk = migrateRisk((await store.read<RiskState>('risk-state')) ?? initRisk(today))
  const override = cfg?.riskRungOverride ?? null
  // the combined graded-at-rung counter counts what the cohort counters count:
  // actionable calls only (no shadows, no watch-only) — the same stream that
  // feeds allOutcomes, so counter and evidence window can never drift apart
  const newActionable = newByCohort.large + newByCohort.small + newByCohort.unknown
  const combinedNext = computeRung(risk, allOutcomes.slice(-60), newActionable, brierImproving, override, today)
  const cohortRecent = (c: CapCohortOrUnknown) => allOutcomes.filter(o => o.cohort === c).slice(-60)
  const nextRisk: RiskState = {
    ...combinedNext,
    cohorts: {
      large: computeCohortRung(risk.cohorts!.large, cohortRecent('large'), newByCohort.large, combinedNext, brierImproving, override, today),
      small: computeCohortRung(risk.cohorts!.small, cohortRecent('small'), newByCohort.small, combinedNext, brierImproving, override, today),
    },
  }

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

  // scorecard: the rolled-up honesty pane. Aggregates the 10d outcome — the
  // calibrated horizon the grades are earned on — so the pane measures the same
  // thing the engine learned from (the per-row ledger still shows 5d + 10d).
  const byGrade: Record<string, { n: number; hits: number; sumExcess: number }> = {}
  const byRegime: Record<string, { n: number; hits: number }> = {}
  const bySetup: Record<string, { n: number; hits: number; sumExcess: number }> = {}
  const overlays: Record<string, { n: number; hits: number }> = {}
  for (const date of fullIndex.slice(-30)) {
    const preds = predictionsByDate.get(date) ?? (await store.read<Prediction[]>(`predictions:${date}`)) ?? []
    for (const p of preds) {
      if (!p.outcome10) continue
      const g = (byGrade[p.shadow ? 'shadow' : p.grade] ??= { n: 0, hits: 0, sumExcess: 0 })
      g.n++
      if (p.outcome10.hit) g.hits++
      g.sumExcess += p.outcome10.excessPct
      if (p.setup) {
        // per-setup honesty (shadows included — the panes ask "does this SHAPE
        // of call work?", and shadows are exactly the shapes being auditioned)
        const s = (bySetup[p.setup] ??= { n: 0, hits: 0, sumExcess: 0 })
        s.n++
        if (p.outcome10.hit) s.hits++
        s.sumExcess += p.outcome10.excessPct
      }
      if (!p.shadow) {
        const r = (byRegime[p.regime] ??= { n: 0, hits: 0 })
        r.n++
        if (p.outcome10.hit) r.hits++
      }
      if (p.overlay) {
        const o = (overlays[p.overlay.flag] ??= { n: 0, hits: 0 })
        o.n++
        // a veto "hits" when it dodged a loser; boost/caution graded straight
        if (p.overlay.flag === 'veto' ? !p.outcome10.hit : p.outcome10.hit) o.hits++
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
    if (g.outcome10!.hit) side.hits++
    side.sumExcess += g.outcome10!.excessPct
  }
  await store.write('engine-scorecard', {
    byGrade,
    byRegime,
    bySetup,
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
  // The core sleeve: famous names evaluated every day. One spark batch ranks them
  // by unusualness (each name's move vs its OWN typical move); the top movers join
  // full evaluation. sleeveActive gates EVERY sleeve behaviour below, so a failed
  // fetch runs exactly like a sleeve-less engine. [R7]
  const sleeveSyms = sleeveWithDefaults(cfg.coreSleeve)
  const [screens, social, mediaTitles, sleeveCloses] = await Promise.all([
    deps.screens(),
    deps.social(watchSyms),
    deps.mediaTitles(),
    deps.sparkCloses(sleeveSyms).catch(() => new Map<string, number[]>()),
  ])
  const sleeveActive = sleeveCloses.size > 0
  const sleeveTop = sleeveActive ? rankSleeve(sleeveCloses, 40) : []
  const sleeveSet = new Set(sleeveActive ? sleeveSyms : [])
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
    // leveraged/inverse ETPs are ROUTES, never underlyings — a held 3CON.L
    // (bought as the route of an earlier short) must not circle back in as a
    // fresh candidate through the holdings/watchlist doors (see isRouteEtp)
    if (isRouteEtp(key, cfg.levMap ?? {})) return
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

  // ETPs that slipped in before the route guard existed get purged here — the
  // filtered roster is what updateRoster writes back, so they stay gone
  const currentRoster = ((await store.read<RosterEntry[]>('engine-roster')) ?? []).filter(e => !isRouteEtp(e.sym, cfg.levMap ?? {}))
  for (const e of currentRoster) addSource(e.sym, e.source, e.capUsdM) // members get re-examined daily

  // The reader's REAL Trading 212 book. Fetched fail-soft (a broker outage never
  // stops the board). Held names join the CANDIDATE pool with source 'holding' —
  // gated exactly like any mover, so they must EARN their roster slot and are NOT
  // watchlist-immortal. Added late so a large book never evicts the movers from the
  // 180-candidate evaluation cap. The engine's per-holding opinion (holdings-reads)
  // is written separately below, after the board is scored.
  const holdings = await deps.holdings().catch(() => null)
  if (holdings) {
    await store.write('holdings', { at: nowSec, positions: holdings })
    for (const p of holdings.slice(0, ROSTER_MAX)) addSource(p.symbol, 'holding')
  }

  // The sleeve door, added LAST on purpose: addSource keeps the FIRST source, so
  // this stamps 'sleeve' ONLY on a name no other door claimed. That makes the
  // source string an exact test for "sleeve-only" (used by the roster filter
  // below) and leaves every other door's attribution — holding, watchlist,
  // roster, catalyst — untouched when a famous name also happens to be moving.
  // Sleeve BEHAVIOUR is keyed off sleeveSet, never off the source string. [R1]
  for (const r of sleeveTop) addSource(r.sym, 'sleeve')

  // The evaluation budget is explicit: real holdings/watchlist first, then the
  // established roster, live catalysts, the core sleeve and earned channel
  // nominations, then discovery feeds. Insertion order must never decide what
  // the engine sees.
  const watchSet = new Set(watchSyms.map(s => s.toUpperCase()))
  const holdingSet = new Set((holdings ?? []).map(p => p.symbol.toUpperCase()))
  const rosterSet = new Set(currentRoster.map(e => e.sym.toUpperCase()))
  const candidatePriority = (sym: string): number => {
    if (holdingSet.has(sym)) return 0
    if (watchSet.has(sym)) return 1
    if (rosterSet.has(sym)) return 2
    if (catalystBySym.has(sym)) return 3
    if (sleeveSet.has(sym)) return 4 // the SET, not the source string — a sleeve name found by the losers screen is still a sleeve name
    if (sources.get(sym)?.source.startsWith('channel:')) return 5
    if (sources.get(sym)?.source.startsWith('theme:') || sources.get(sym)?.source === 'rotation') return 6
    if (sources.get(sym)?.source === 'social') return 7
    return 8
  }
  // 180, not 110: the sleeve adds up to 40 permanent candidates and the losers
  // screen another slice, and neither may crowd out discovery. Worst case is
  // +70 candle fetches, bounded by the mapLimit(8) below — noted, accepted. [R16]
  const candidateSyms = [...sources.keys()]
    .sort((a, b) => candidatePriority(a) - candidatePriority(b) || a.localeCompare(b))
    .slice(0, 180)
  const candleMap = new Map<string, Candle[]>()
  await mapLimit(candidateSyms, 8, async sym => {
    const c = await deps.candles(sym)
    if (c && c.length >= 30) candleMap.set(sym, c)
  })

  // cap lookups are budgeted: screener caps ride along free, the rest rotate.
  // The sleeve must not EAT the budget. Sleeve names always start capUsdM null
  // (the spark batch carries closes, not fundamentals) and they sort ahead of
  // discovery in candidatePriority, so a full sleeve would take all 15 slots and
  // every discovery name would go the day unpriced — no cap cohort, no >$10B
  // quality read, no small-cap stop widening. Non-sleeve names therefore fill the
  // budget FIRST (keeping their own priority order among themselves) and sleeve-only
  // names take whatever is left. A sleeve name needs the cap least: its dip-lane
  // quality is already granted by sleeveSet, never by its cap. [R17]
  const noCapAll = candidateSyms.filter(s => sources.get(s)!.capUsdM == null && candleMap.has(s))
  const sleeveOnly = (s: string) => sources.get(s)?.source === 'sleeve' // exact test — the sleeve door is stamped LAST
  const noCap = [...noCapAll.filter(s => !sleeveOnly(s)), ...noCapAll.filter(sleeveOnly)].slice(0, 15)
  await mapLimit(noCap, 5, async sym => {
    const cap = await deps.capUsdM(sym)
    if (cap != null) sources.get(sym)!.capUsdM = cap
  })

  // Dip lane: a quality name (sleeve member, or > $10B) hit hard but HOLDING is a
  // LONG candidate — via its own call constructor, because composeCall reads that
  // same chart as a short and context may never flip a side (dipLane.ts). Read
  // AFTER the cap-enrichment pass above, so the >$10B quality test sees the caps
  // that pass actually fetched. [R5]
  const dipReads = new Map<string, DipRead>()
  for (const sym of candidateSyms) {
    const candles = candleMap.get(sym)
    if (!candles) continue
    const quality = sleeveSet.has(sym) || (sources.get(sym)?.capUsdM ?? 0) > 10_000
    if (!quality) continue
    const read = classifyDip(candles)
    if (read?.triggered && read.holding) dipReads.set(sym, read)
  }

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
  // The sleeve is watched, not enrolled: a name whose ONLY door was the sleeve is
  // evaluated every day (see evalRows below) but never joins the roster — the
  // roster is the engine's earned hunting ground and must not fill with 130
  // permanent members. A sleeve name that ALSO came through an ordinary door
  // (screener, holding, watchlist…) keeps that source and competes normally. [R2]
  const rosterCandidates = candidates.filter(c => !(sleeveSet.has(c.sym) && sources.get(c.sym)?.source === 'sleeve'))
  const { roster, joined, dropped } = updateRoster(currentRoster, rosterCandidates, watchSyms, today, Object.keys(cfg.levMap ?? {}))
  await store.write('engine-roster', roster)
  const rosterLog = ((await store.read<unknown[]>('engine-roster-log')) ?? []) as { date: string }[]
  await store.write('engine-roster-log', [...rosterLog.filter(l => l.date !== today), { date: today, joined, dropped }].slice(-60))

  // shared context for factor computation (weights/calibration/channelCred loaded
  // above with the pundit stances, so a high-credibility call could nominate names)
  const engineBaseRate = baseHitRate(calibration).rate
  // per-cohort rungs (migrated from a legacy blob if needed) — each call below
  // trades at its OWN sleeve's rung; unknown-cap names pool to the combined rung.
  const risk = migrateRisk((await store.read<RiskState>('risk-state')) ?? initRisk(today))
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

  // What actually gets SCORED today: the roster, plus every sleeve candidate the
  // roster doesn't already carry. The sleeve reaches evaluation through this
  // append regardless of which door discovered the name — membership of
  // sleeveSet is the test, never the source string, so a sleeve name found by
  // the losers screen and rejected by the roster's join gate is still read. [R1]
  const rosterSymSet = new Set(roster.map(e => e.sym.toUpperCase())) // the NEW roster: a sleeve name that just joined must not be scored twice
  const evalRows = [
    ...roster.map(e => ({ sym: e.sym, capUsdM: e.capUsdM })),
    ...candidateSyms
      .filter(sym => sleeveSet.has(sym) && !rosterSymSet.has(sym) && candleMap.has(sym))
      .map(sym => ({ sym, capUsdM: sources.get(sym)?.capUsdM ?? null })),
  ]

  const board: Prediction[] = []
  // The ONE publication path. Both the composite loop and the dip-lane merge below
  // push through here, so calibration, grading, the shadow/watch/belowBase flags,
  // routing and sizing can never drift between the two lanes.
  // forceShadow: the caller has evidence this call must not be traded, but it
  // still has to publish so the ledger can grade the veto. Today's only user is
  // the dip lane's news check (a dip into a broken thesis); it deliberately goes
  // through the shadow flag rather than a new one, so sizing, routing and the
  // shadow/watch exclusivity below stay in exactly one place.
  const publishCall = (call: EngineCall, capUsdM: number | null, cat: CatalystTag | null, forceShadow = false) => {
    // cap-class cohort drives BOTH the calibration lookup (its own buckets first,
    // then pooled) and the risk rung below. Unknown cap pools to the cohortless
    // path and the combined rung — never guessed into a sleeve.
    const cohort = capCohortOf(capUsdM)
    const { p, provisional } = probabilityFor(calibration, call.side, regime, Math.abs(call.composite), cohort)
    const grade = gradeFor(p, provisional, call.capacityPct, engineBaseRate)
    // grade null = calibration sees no edge in this bucket. The call stays off
    // the paper — but it MUST enter the ledger as a shadow, or buckets below
    // 50% can never earn their way back up (nothing would ever get graded).
    // An earnings print inside the horizon also forces shadow: a binary coin
    // flip has no place on the live board, but its outcome is kept (earningsRisk
    // stays on the record) so the ledger can later show whether the engine has
    // any edge INTO prints — half-sizing a coin flip just pollutes the buckets.
    // A graded-null call that nonetheless clears the FULL evidence contract is a
    // real, well-evidenced setup the calibration simply rates below its own base
    // rate — classically a strong LONG in a mixed/amber tape, where the seed says
    // that side underperforms. Hiding it as a shadow produced the "big names
    // moved, the board showed nothing" experience (2026-07-15, user). Surface it
    // as WATCH (no size) instead of burying it: the reader sees the engine IS
    // tracking META/AVGO, with an honest "below our base rate — tape-dependent"
    // read. Still shadow: a coin-flip into an earnings print, or a null grade on
    // thin evidence (contract failed) — those genuinely don't belong on the board.
    // A SHORT the reader can't ROUTE is not a takeable call — an ISA is long-only,
    // so a short is placeable only through an inverse ETP mapped in levMap.
    // Small-caps never have one; most single large-caps (IBM, ORCL…) don't
    // either. A short with no levMap short route therefore never reaches the
    // board: keep it as a SHADOW (still graded, so the cohort learns) but off the
    // reader-facing engine-board. A name WITH a route stays visible even when the
    // risk ladder hasn't unlocked it yet (that's the honest paper-only case).
    // Longs are untouched. (user 2026-07-24: only show shorts I can place.)
    const shortRoute = (cfg.levMap ?? {})[call.sym]
    const unshortable = call.side === 'short' && !(shortRoute?.short2x || shortRoute?.short3x)
    const belowBase = !grade && call.evidence.contract && !call.earningsRisk && !unshortable && !forceShadow
    const shadow = call.earningsRisk || (!grade && !call.evidence.contract) || unshortable || forceShadow
    // Only A/B calls that pass the core-data contract are trades. Grade C, thin
    // evidence, or a below-base setup are watchlist observations (riskPct 0) —
    // "barely passed the gate" reads differently from a genuinely strong setup.
    const watchOnly = !shadow && (grade == null || grade === 'C' || !call.evidence.contract)

    const rung = cohortRungOf(risk, cohort)
    const instrument = shadow || watchOnly ? null : mapInstrument(call.side, call.sym, grade!, rung, cfg.levMap ?? {})
    const callThemes = themesOf(call.sym)
    board.push({
      ...call,
      id: `${today}:${call.sym}:${call.side}`,
      date: today,
      modelVersion: ENGINE_MODEL_VERSION,
      regime,
      priceAtPrediction: call.entry,
      themes: callThemes.length ? callThemes : undefined,
      catalyst: cat ? { kind: cat.kind, reason: cat.reason } : undefined,
      capUsdM,
      shadow: shadow || undefined,
      watchOnly: watchOnly || undefined,
      belowBase: belowBase || undefined,
      // 'week' for actionable trades; 'developing' for watch rows whose SHAPE is a
      // 2-4 week build (horizon.ts) — pure, tested, never inlined here
      horizon: horizonOf({ watchOnly, belowBase, stage: call.stage, setup: call.setup, evidence: call.evidence }),
      probability: Math.round(p * 100) / 100,
      provisional,
      grade: grade ?? 'C',
      riskRung: rung,
      riskPct: shadow || watchOnly ? 0 : RUNG_RISK_PCT[rung],
      instrument,
      paperOnly: call.side === 'short' && !watchOnly && !instrument,
      // The stamp must describe what the call ACTUALLY got. The composite loop
      // re-scores with worldMult before publishing; the dip lane's composite is
      // structural (depth-derived, dipLane.ts) and never sees the nudge at all.
      // Printing 1.1 on a dip row would advertise a conviction adjustment that
      // was never applied — so a dip row records the multiplier it truly ran at: 1.
      worldTape: { tone: tone.tone, mult: cat?.kind === DIP_CATALYST_KIND ? 1 : worldMult(tone.tone, call.side) },
    })
  }

  for (const entry of evalRows) {
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
      // a core-sleeve name earns the lowest capacity floor (composite.ts). Gated on
      // sleeveActive so a failed spark fetch changes nothing about this call. [R7]
      sleeve: sleeveActive && sleeveSet.has(entry.sym.toUpperCase()),
      volumeConfirmed: read.volumeConfirmed,
      breadthKnown: breadth != null,
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
    publishCall(call, entry.capUsdM, cat)
  }

  // ---- the dip lane's own calls, merged into the same board ----
  // A quality name hit hard but holding gets a LONG the composite could never
  // produce (dipLane.ts). Merged AFTER the loop so a name that already earned an
  // ordinary long keeps it — one row per name per side. The lane's structural
  // levels and composite come from dipCall; everything downstream (calibration,
  // grade, shadow rules, sizing) is the SAME publishCall path as every other call.
  const alreadyLong = new Set(board.filter(b => b.side === 'long').map(b => b.sym.toUpperCase()))
  const dipCandidates: { sym: string; read: DipRead; call: EngineCall; capUsdM: number | null }[] = []
  for (const [sym, read] of dipReads) {
    if (alreadyLong.has(sym.toUpperCase())) continue
    const candles = candleMap.get(sym)
    if (!candles) continue
    const capUsdM = sources.get(sym)?.capUsdM ?? null
    const raw = dipCall(sym, candles, read, capUsdM)
    if (!raw) continue
    // dipCall is pure and has no calendar — earnings honesty is applied here, so a
    // dip into a print shadows exactly like any other call.
    dipCandidates.push({ sym, read, call: { ...raw, earningsRisk: earningsSet.has(baseSym(sym)) }, capUsdM })
  }

  // ---- a dip only trades when the news reads overreaction, not broken thesis ----
  // The price signature cannot tell the two apart, and the difference is the whole
  // trade: a −14% sympathy move is this lane's bread and butter, a −14% move on a
  // fraud probe is a name that keeps falling. So each dip that would actually
  // publish gets ONE narrow news question (dipNews.ts). The budget is deliberately
  // tiny — DIP_NEWS_BUDGET reads a run, spent on the DEEPEST dips first, because a
  // deeper drop is both the more dangerous trade and the more likely to have a
  // real story behind it. The list is built AFTER dipCall so a read is never spent
  // on a name that was never going to reach the board. Beyond the budget: honestly
  // 'unclear' with reason 'budget' — unchecked, and labelled unchecked, never
  // silently vetoed. A rejecting dep is the same: 'unclear', and the dip trades.
  // Names the source cannot serve at all (the sleeve's twenty .L tickers — the
  // company-news endpoint is US-listed only) are settled BEFORE the budget is cut
  // and never touch it: spending a slot on a call guaranteed to return nothing
  // would let five UK names starve five checkable US ones. They land on 'unclear'
  // naming the coverage gap, which trades, exactly as they did before this lane.
  const dipVerdicts = new Map<string, DipNewsVerdict>()
  const byDepth = [...dipCandidates].sort((a, b) => b.read.dropPct - a.read.dropPct)
  const servable: typeof byDepth = []
  for (const c of byDepth) {
    const venue = unservedVenue(c.sym)
    if (venue) dipVerdicts.set(c.sym, { verdict: 'unclear', reason: `no news source for ${venue} names yet` })
    else servable.push(c)
  }
  await Promise.all(
    servable.slice(0, DIP_NEWS_BUDGET).map(async ({ sym }) => {
      const raw = await deps.dipNews(sym).catch(() => null)
      const ok = raw && (raw.verdict === 'transient' || raw.verdict === 'structural' || raw.verdict === 'unclear')
      dipVerdicts.set(sym, ok ? raw : { verdict: 'unclear', reason: 'lookup failed' })
    }),
  )
  for (const { sym } of servable.slice(DIP_NEWS_BUDGET)) dipVerdicts.set(sym, { verdict: 'unclear', reason: 'budget' })

  // Only an EXPLICIT structural verdict frees the composite short below, so the
  // set is built from what was actually read, never from what was skipped.
  const structuralVetoes = new Set<string>()
  for (const { sym, read, call, capUsdM } of dipCandidates) {
    const v = dipVerdicts.get(sym) ?? { verdict: 'unclear' as const, reason: 'not checked' }
    const why = v.reason ?? 'no reason given' // a dep may hand back a verdict with no reason at all
    const note =
      v.verdict === 'structural' ? `news: broken thesis — ${why}` : v.verdict === 'transient' ? `news: overreaction — ${why}` : `news unchecked — ${why}`
    if (v.verdict === 'structural') {
      structuralVetoes.add(sym.toUpperCase())
      console.log(`BOARD: dip on ${sym} stands down — ${why}`)
    }
    // Structural → the row publishes as a SHADOW: off the reader's board, still
    // graded, so the ledger can eventually answer whether standing down was right.
    publishCall(call, capUsdM, { kind: DIP_CATALYST_KIND, side: 'long', reason: `${read.detail} · ${note}`, strength: 40 }, v.verdict === 'structural')
  }

  // ---- dip evidence outranks the composite's read of the SAME chart ----
  // A triggered-and-holding dip is the tape saying this name is being BOUGHT: a
  // measured drop, the knife guard passed, a volume-PAID reclaim. The composite
  // reading the identical candles sees only deep negative momentum and calls a
  // short (dipLane.ts explains why it must). Publishing both live would put the
  // board on both sides of one name on one morning — an unreadable card, and a
  // hedge the reader never asked for. Ratified 2026-08-11: the dip read wins the
  // reader-facing row and the short is DEMOTED to a shadow. Demotion, not
  // deletion — the short still publishes and still grades, so the ledger can
  // eventually answer "when the two lanes disagreed, who was right?". Longs need
  // no rule: an ordinary long is the same side and simply won the merge above.
  //
  // Run AFTER the news pass, because news can dissolve the disagreement: when the
  // headlines say the thesis BROKE, the dip long has already been stood down to a
  // shadow and the two lanes no longer contradict each other — the news corroborates
  // the short. Demoting it then would leave the reader with nothing on a name where
  // the engine has real, agreeing evidence to short. That release is keyed on an
  // EXPLICIT structural verdict only: a dip that was never examined (never a
  // candidate, over budget, a dead dep, a venue with no source) leaves the price
  // evidence standing unopposed, and unopposed dip evidence still wins.
  for (const row of board) {
    if (row.side !== 'short' || row.shadow || !dipReads.has(row.sym.toUpperCase())) continue
    if (structuralVetoes.has(row.sym.toUpperCase())) {
      console.log(`BOARD: structural news on ${row.sym} frees the composite short — both lanes now read the same way`)
      continue
    }
    row.shadow = true
    row.watchOnly = undefined // shadow and watch are exclusive in publishCall — keep them so
    row.belowBase = undefined
    row.riskPct = 0
    row.instrument = null
    row.paperOnly = true // a short with no instrument, exactly as publishCall stamps one
    row.horizon = horizonOf({ watchOnly: false, stage: row.stage, setup: row.setup, evidence: row.evidence })
    console.log(`BOARD: dip read on ${row.sym} demotes the composite short to a shadow`)
  }

  // one outstanding shadow per sym+side: skip a shadow candidate whose sym+side
  // still has a shadow that hasn't reached its calibrated grade (no outcome10) on
  // a recent prior date — three correlated CEG shorts teach nothing while starving
  // the tiny shadow budget of fresh names. Gated on outcome10 (not outcome5) so a
  // slot frees only once its evidence has actually fed the learning loop, at 10d.
  // Live (non-shadow) calls are never deduped — on EITHER side of the comparison.
  // The set is built from prior SHADOW rows only: an ungraded LIVE call from
  // yesterday holds no shadow slot, and counting it used to make today's shadow of
  // that name vanish from the ledger entirely — which silently swallowed exactly
  // the rows the shadow budget exists to collect (a structural-news veto on a name
  // the engine called live the day before).
  const priorDates = ((await store.read<string[]>('predictions-index')) ?? []).filter(d => d !== today).slice(-10)
  const outstandingShadowKeys = new Set<string>()
  for (const date of priorDates) {
    for (const p of (await store.read<Prediction[]>(`predictions:${date}`)) ?? []) {
      if (p.shadow && !p.outcome10) outstandingShadowKeys.add(`${p.sym}:${p.side}`)
    }
  }
  const pickShadow = (side: 'long' | 'short', cap: number) =>
    board
      .filter(b => b.side === side && !!b.shadow && !outstandingShadowKeys.has(`${b.sym}:${b.side}`))
      .sort((a, b) => Math.abs(b.composite) - Math.abs(a.composite))
      .slice(0, cap)
  // live picks pass diversity gates: max 3 per group per side, and no name
  // moving in lockstep (60d return corr > 0.75) with one already picked —
  // correlated bets are one bet. Grouping: sector-ETF mapping where it exists
  // (the S&P megacaps), theme otherwise — so five drone small caps the sector
  // map has never heard of still count as ONE crowd. Shadows keep the plain
  // top-N (they exist to feed calibration; their dedup is handled above).
  const pickDiverseSide = (pool: Prediction[], side: 'long' | 'short', cap: number, label: string) => {
    const { picked, skipped } = pickDiverse(
      pool.filter(b => b.side === side),
      cap,
      sym => symToSector.get(baseSym(sym)) ?? primaryThemeOf(sym),
      sym => candleMap.get(sym)?.map(c => c.c) ?? null,
    )
    if (skipped.length) console.log(`BOARD: diversity gates (${label} ${side}):`, skipped.map(s => `${s.sym} — ${s.why}`).join('; '))
    return picked
  }
  // The actionable board is SMALL by design: at most 3 trades per side, A/B
  // contract-passing only. The watch list carries the rest of the ranked
  // read (grade C / low evidence) so a day with no qualified trades still
  // publishes what the engine is looking at — as observations, not calls.
  const actionablePool = board.filter(b => !b.shadow && !b.watchOnly)
  const watchPool = board.filter(b => !b.shadow && b.watchOnly)
  const trades = [...pickDiverseSide(actionablePool, 'long', 3, 'trade'), ...pickDiverseSide(actionablePool, 'short', 3, 'trade')]
  const watch = [...pickDiverseSide(watchPool, 'long', 6, 'watch'), ...pickDiverseSide(watchPool, 'short', 6, 'watch')]
  const live = [...trades, ...watch].sort((a, b) => (a.watchOnly ? 1 : 0) - (b.watchOnly ? 1 : 0) || Math.abs(b.composite) - Math.abs(a.composite))
  const shadows = [...pickShadow('long', 5), ...pickShadow('short', 5)]
  const final = [...live, ...shadows]

  // Company names ride the published rows so the board, ledger, open book and
  // paper all print "SOC — Sable Offshore" without their own enrichment pass.
  // cachedCompanyName reads the cap: blob the capUsdM lookups already warmed,
  // so this is near-free; a miss just leaves the row ticker-only.
  await mapLimit(final, 8, async p => {
    const name = await deps.companyName(p.sym).catch(() => null)
    if (name) p.name = name
  })

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
  const pending = (await store.read<string[]>('predictions-pending')) ?? []
  if (final.length && !pending.includes(today)) await store.write('predictions-pending', [...pending, today].slice(-250))
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

  // ---- pattern scorecard sweep ----
  // Every candidate with candles gets pattern-scanned (pure CPU — the candles
  // are already in candleMap), sightings logged once and graded at +5/+10
  // sessions vs SPY, exactly like calls. Patterns remain display-only; this
  // ledger exists so "do the shapes pay?" gets a measured answer before the
  // badges are ever trusted with anything. Fail-soft: a scorecard hiccup must
  // never touch the board.
  try {
    const { detectPatterns } = await import('../../../shared/patterns')
    const { recordSightings, gradeSightings } = await import('../../../shared/engine/patternScore')
    const prevSightings = (await store.read<import('../../../shared/engine/patternScore').PatternSighting[]>('pattern-sightings')) ?? []
    const todaysHits = [...candleMap.entries()]
      .filter(([sym, cs]) => sym !== 'SPY' && sym !== 'QQQ' && cs.length >= 30)
      .map(([sym, cs]) => ({ date: today, sym, price: cs[cs.length - 1].c, hits: detectPatterns(cs) }))
      .filter(t => t.hits.length > 0)
    const gradedSightings = gradeSightings(recordSightings(prevSightings, todaysHits), candleMap, spy ?? [])
    await store.write('pattern-sightings', gradedSightings)
    if (todaysHits.length) console.log('PATTERNS:', todaysHits.map(t => `${t.sym} ${t.hits.map(h => `${h.kind}:${h.status}`).join('+')}`).join(' · '))
  } catch (e) {
    console.log('PATTERNS: scorecard sweep failed —', String(e).slice(0, 160))
  }

  // ---- event radar: dated earnings binaries the engine already tracks ----
  // The engine REFUSES to bet an earnings print — earningsRisk still shadows those
  // trades (a coin-flip has no place on the live board). The radar is the opposite
  // service: for every roster/candidate name reporting in the next fortnight, here
  // is the SHAPE going into the print (stage, RS, one-line read). So a 26%-overnight
  // surprise (IBM post-print, say) is never a name the reader had never heard of —
  // it's "IBM reports Thursday, chart weak, RS deteriorating" days beforehand. NOT a
  // call. Fail-soft like the pattern sweep: a radar hiccup must never touch the board.
  try {
    const earningsCal = await deps.earningsCalendar().catch(() => [] as { sym: string; date: string; hour?: string }[])
    const todayMs = Date.parse(today)
    const ret21 = (xs: number[]): number | null =>
      xs.length >= 22 && xs[xs.length - 22] ? ((xs[xs.length - 1] - xs[xs.length - 22]) / xs[xs.length - 22]) * 100 : null
    const spyRet21 = ret21(spyCloses) // reuse the momentumFactor maths — 21d return vs SPY
    // base ticker → the actual candidate/roster sym we already hold candles for.
    // candleMap only holds candidate/roster names, so membership here IS the
    // "on the roster OR in today's candidate pool AND has candles" gate.
    const radarSymOf = new Map<string, string>()
    for (const sym of candleMap.keys()) {
      const key = baseSym(sym).toUpperCase()
      if (!radarSymOf.has(key)) radarSymOf.set(key, sym)
    }
    const seen = new Set<string>()
    const radarRaw = earningsCal
      .map(e => {
        const sym = radarSymOf.get(baseSym(e.sym).toUpperCase())
        if (!sym || seen.has(sym) || !e.date) return null
        const daysToPrint = Math.round((Date.parse(e.date) - todayMs) / 86_400_000)
        if (!Number.isFinite(daysToPrint) || daysToPrint < 0) return null
        seen.add(sym)
        const candles = candleMap.get(sym)!
        const read = technicalStage(sym, candles)
        const r = ret21(candles.map(c => c.c))
        const rs21 = r != null && spyRet21 != null ? Math.round((r - spyRet21) * 10) / 10 : null
        return { sym, date: e.date, hour: e.hour, daysToPrint, stage: read?.stage ?? null, entryQuality: read?.entryQuality ?? null, rs21, note: read?.note ?? null }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.daysToPrint - b.daysToPrint)
      .slice(0, 12)
    // company names ride the radar like the board — near-free from the cap cache, fail-soft
    const entries = await mapLimit(radarRaw, 8, async r => ({ ...r, name: await deps.companyName(r.sym).catch(() => null) }))
    await store.write('event-radar', { date: today, generatedAt: nowSec, entries })
    if (entries.length) console.log('RADAR:', entries.map(e => `${e.sym} in ${e.daysToPrint}d (${e.stage})`).join(' · '))
  } catch (e) {
    console.log('RADAR: event-radar sweep failed —', String(e).slice(0, 160))
  }

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

// ---- the open book: every live call traced until its grade lands ----
// Runs AFTER buildBoard so "re-qualified" can be read off today's fresh board.
// Each not-yet-graded live call from a previous session is walked through the
// daily closes (openTrace.ts) and stamped with an opinion. Writes only the
// display blob — the prediction blobs and grading are never touched.
export async function traceOpenIdeas(store: AppStore, deps: EngineDeps, nowSec: number): Promise<{ traced: number }> {
  const today = londonDate(nowSec)
  const index = ((await store.read<string[]>('predictions-index')) ?? []).slice(-10).filter(d => d < today)
  const open: Prediction[] = []
  for (const date of index) {
    for (const p of (await store.read<Prediction[]>(`predictions:${date}`)) ?? []) {
      // watch-only calls aren't positions — the open book traces trades. Open
      // until the CALIBRATED (10d) grade lands, matching openTrace's GRADE_HORIZON
      // so "grades in N sessions" stays truthful (a call no longer vanishes at 5d).
      if (!p.shadow && !p.watchOnly && !p.outcome10) open.push(p)
    }
  }
  const board = await store.read<{ date: string; board: Prediction[] }>('engine-board')
  const todayLive = new Set((board?.date === today ? board.board : []).map(b => `${b.sym}:${b.side}`))
  const syms = [...new Set(open.map(p => p.sym))].slice(0, 80)
  const candleMap = new Map<string, Candle[] | null>()
  await mapLimit(syms, 8, async sym => candleMap.set(sym, await deps.candles(sym).catch(() => null)))
  const entries = open
    .map(p => {
      const candles = candleMap.get(p.sym)
      return candles ? traceOpenCall(p, candles, todayLive) : null
    })
    .filter((e): e is OpenTraceEntry => e !== null)
    // in-play first (still actionable), then newest call first
    .sort(
      (a, b) =>
        (a.status === 'in-play' ? 0 : 1) - (b.status === 'in-play' ? 0 : 1) ||
        b.callDate.localeCompare(a.callDate) ||
        a.sym.localeCompare(b.sym),
    )
  await store.write('open-trace', { date: today, generatedAt: nowSec, entries })
  return { traced: entries.length }
}
