import type { Candle } from '../../../shared/types'
import type { AppStore } from './store'
import { validateConfig, type AppConfig } from '../../../shared/config'
import { atr, swingCapacity } from '../../../shared/indicators'
import { technicalStage, type Stage } from '../../../shared/technicals'
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
import { composeCall, coreCompositeOf, DEFAULT_WEIGHTS, levelsFor, setupFamilyOf } from '../../../shared/engine/composite'
import { rankSleeve, sleeveWithDefaults } from '../../../shared/engine/coreSleeve'
import { classifyDip, dipCall, type DipRead } from '../../../shared/engine/dipLane'
import { dipThesis } from '../../../shared/engine/voice'
import { classifyVelocity, velocityCall, VELOCITY_DOOR_CAP } from '../../../shared/engine/velocityLane'
import { clusterCandidates, detectClusters, TREND_DAY_SYMS, TREND_HISTORY_DAYS, type TrendDay } from '../../../shared/engine/hypeCluster'
import { DIP_CATALYST_KIND, LANE_CATALYST_KINDS, VELOCITY_CATALYST_KIND, gatesFor, type CatalystTag } from '../../../shared/engine/catalyst'
import { extractNewsCatalysts, type NewsCatalyst } from './newsCatalysts'
import { DIP_NEWS_BUDGET, unservedVenue, type DipNewsVerdict } from './dipNews'
import { newsTone, worldMult, worldTone, VIX_SYMBOL, WORLD_SYMBOLS, type WorldRead } from '../../../shared/engine/worldTape'
import {
  baseHitRate,
  brierPoint,
  CALIB_DEF_VERSION,
  gradeBaseRate,
  gradeFor,
  gradePrediction,
  ENGINE_MODEL_VERSION,
  migrateCalibration,
  maybeNudgeWeights,
  migrateWeights,
  probabilityFor,
  rebaseWeights,
  updateCalibration,
  updateIcStats,
  type CalibrationState,
  type WeightsState,
} from '../../../shared/engine/calibration'
import { pickDiverse } from '../../../shared/engine/select'
import { FUNNEL_TRACE_INDEX_KEY, FUNNEL_TRACE_INDEX_MAX, funnelTraceKey, funnelTraceRecorder } from '../../../shared/engine/funnelTrace'
import { horizonOf } from '../../../shared/engine/horizon'
import { credibilityOf, gradeChannelStances, type ChannelCredState, type ExtractLike } from '../../../shared/engine/channelCred'
import { computeCohortRung, computeRung, cohortRungOf, initRisk, isRouteEtp, mapInstrument, migrateRisk, RUNG_RISK_PCT, type RiskState } from '../../../shared/engine/riskLadder'
import { capCohortOf, SMALL_CAP_MAX_USD_M, type CapCohortOrUnknown } from '../../../shared/engine/capClass'
import { avgDollarVol20, ROSTER_MAX, updateRoster, type RosterCandidate, type RosterEntry } from '../../../shared/engine/roster'
import type { T212Position } from './t212lib'
import { isRejection, round2, type EmptySideReason, type EngineCall, type FactorName, type FactorScore, type PredOutcome, type Prediction } from '../../../shared/engine/types'
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
  // The FREE half of the dip-news read: the verdict already sitting in the
  // `dip-news:{sym}` blob, or null when there is none. Costs no HTTP call, no
  // LLM token and no budget slot, so buildBoard probes it for EVERY servable dip
  // candidate before spending a single fresh read. Keeping the cache INSIDE
  // dipNews (as it was) made five cache hits burn the whole budget with zero
  // fresh reads, and relabelled a sixth candidate 'unclear/budget' even when its
  // structural veto had been on the blob all along — so it traded. Fail-soft: a
  // rejection is a miss, and the name simply queues for a fresh read.
  dipNewsCached: (sym: string) => Promise<DipNewsVerdict | null>
  // one narrow question per dip candidate: do this name's recent headlines read
  // overreaction or broken thesis? (dipNews.ts). Structural stands the dip trade
  // down; anything else trades. This is the FRESH read — the cache is probed
  // through dipNewsCached above, and only cache MISSES reach here, budgeted to
  // DIP_NEWS_BUDGET calls per run, deepest dip first. Fail-soft: a rejection is
  // an 'unclear' — the lane never blocks on a lookup it couldn't make.
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
      // Gainers is read 50 deep: the top 25 of that list is mostly sub-$5 penny
      // rockets on a given day, so the mid-caps worth trading only appear once
      // the read goes past them. The other three stay 25 — nothing there is
      // being crowded out.
      const kinds = [
        ['day_gainers', 'screener:gainers', 50],
        ['day_losers', 'screener:losers', 25],
        ['most_actives', 'screener:actives', 25],
        ['small_cap_gainers', 'screener:smallcap', 25],
      ] as const
      const results = await Promise.all(
        kinds.map(async ([kind, source, count]) => (await fetchScreen(kind, undefined, count)).map(row => ({ row, source }))),
      )
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
    // Dip corroboration, in two halves so the engine can spend its budget on the
    // reads that actually cost something. The cache probe is free and is asked
    // FIRST for every candidate; only a miss reaches the fresh read below.
    // A blob fault is swallowed both ways: a hiccup must never cost the lane its
    // verdict, and a hiccup on the probe just means a fresh read instead.
    dipNewsCached: async sym => {
      const { getCached } = await import('./cache')
      const hit = await getCached<DipNewsVerdict>(`dip-news:${sym.toUpperCase()}`).catch(() => null)
      return hit?.verdict ? hit : null
    },
    // The read itself (Finnhub headlines → LLM → keyword fallback) lives in
    // dipNews.ts; the ONLY thing added here is WRITING the `dip-news:{sym}` blob.
    // Deliberately, only a DECISIVE verdict is cached: freezing an 'unclear' would
    // let one LLM outage or one quiet news window silence the check on a name all
    // week, and 'unclear' is the answer we most want to improve on tomorrow. How
    // LONG a decisive verdict freezes depends on WHO decided it: a model that read
    // the whole headline set holds for three days, a single keyword hit thaws
    // overnight so tomorrow's run can ask a provider that may be back up. Unknown
    // provenance takes the shorter freeze — the cheap error is re-reading, not
    // standing a name down on a stale regex.
    dipNews: async sym => {
      const { setCached } = await import('./cache')
      const { readDipNews, DIP_NEWS_TTL_SEC, DIP_NEWS_HEURISTIC_TTL_SEC } = await import('./dipNews')
      const verdict = await readDipNews(sym, env.FINNHUB_API_KEY ?? '')
      const ttl = verdict.via === 'llm' ? DIP_NEWS_TTL_SEC : DIP_NEWS_HEURISTIC_TTL_SEC
      if (verdict.verdict !== 'unclear') await setCached(`dip-news:${sym.toUpperCase()}`, verdict, ttl).catch(() => {})
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

async function loadState(store: AppStore, today: string) {
  // Read both learning blobs first — the stored one wins, the committed seed is
  // the cold start — then decide whether the seed SUPERSEDES what was read
  // (definition swap, then generation swap), and only then migrate/re-base what
  // survived. Reading before deciding is what lets both swaps compare the two
  // artefacts; migrating after is what keeps a swapped-in seed on the same
  // healing path as a stored blob. gradeOutstanding persists the result.
  let weightsBlob = (await store.read<WeightsState>('engine-weights')) ?? clone(seed.weights as unknown as WeightsState)
  let calibration = (await store.read<CalibrationState>('engine-calibration')) ?? clone(seed.calibration as unknown as CalibrationState)
  const seedCal = seed.calibration as unknown as CalibrationState
  const seedWeights = seed.weights as unknown as WeightsState
  // the outcome definition changed → stored buckets counted a different thing
  // and their hit rates aren't probabilities anymore. Swap in the reseeded
  // calibration — but only when the committed seed itself is on the current
  // definition; never regress live state to a stale seed.
  if (calibration.defVersion !== CALIB_DEF_VERSION && seedCal.defVersion === CALIB_DEF_VERSION) calibration = clone(seedCal)
  // A regenerated seed at the SAME outcome definition announces itself by
  // generation. The stored blob wins forever otherwise — that is correct for
  // live accrual, but it means a better seed could never land (stage 2b).
  // On swap the stored blob is REPLACED, not merged: "do not mix a regenerated
  // seed with the committed one — regenerate whole" (backtest.ts header).
  // Both halves are gated on the SEED's defVersion for the same reason the swap
  // above is: an artefact measuring a different hit must not install, however
  // loudly it announces itself.
  const seedInstallable = seedCal.defVersion === CALIB_DEF_VERSION
  const storedGen = calibration.seedGeneration ?? 1
  const seedGen = seedCal.seedGeneration ?? 1
  if (seedInstallable && seedGen > storedGen) {
    console.log(
      `CALIBRATION: seed generation ${storedGen} → ${seedGen} — replacing ` +
        `${calibration.evidence?.live?.n ?? 0} live rows with the deeper seed (they are inside its window)`,
    )
    calibration = clone(seedCal)
  }
  // Weights swap on the same condition, keyed on the weights blobs' own
  // generations (they are stored separately, so a load interrupted between the
  // two writes must be able to finish the install on the next run). They still
  // come from ONE walk: installing the seed's buckets while keeping the live IC
  // would grade tomorrow's calls with a yardstick from a different scoring epoch.
  const storedWeightsGen = weightsBlob.seedGeneration ?? 1
  const seedWeightsGen = seedWeights.seedGeneration ?? 1
  if (seedInstallable && seedWeightsGen > storedWeightsGen) {
    console.log(`WEIGHTS: seed generation ${storedWeightsGen} → ${seedWeightsGen} — replacing the learned IC with the deeper seed's`)
    weightsBlob = clone(seedWeights)
  }
  // migrateWeights backfills factors added after a snapshot was stored/seeded
  // (seed.json predates smartMoney) so an old blob never silently zeroes them.
  // rebaseWeights then handles the case migrateWeights must NOT: the owner
  // re-ordering the model. It only fires when the stored base disagrees with
  // DEFAULT_WEIGHTS, and when it does it re-bases current too and drops the IC
  // evidence gathered under the retired vector. Idempotent, so this runs on
  // every load and re-heals a blob written by an older deploy.
  // It runs AFTER any generation swap above, and on a swapped-in seed it must
  // find NOTHING to do: an emitted seed's base is DEFAULT_WEIGHTS by contract,
  // so the IC just installed is not zeroed on the way in (§4.4 — the trap that
  // silently deletes a seed's factor evidence). A seed that breaks that contract
  // is not rescued here; it is stripped, loudly, in the history entry.
  const weights = rebaseWeights(migrateWeights(weightsBlob), DEFAULT_WEIGHTS, today)
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
  const { weights, calibration, channelCred } = await loadState(store, today)
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
          // …but NOT factor IC for a lane call — ANY lane (LANE_CATALYST_KINDS,
          // catalyst.ts). A lane call carries a constant technical placeholder
          // (dipLane.ts, velocityLane.ts) rather than a measured factor vote, so
          // booking its outcome would train the technical factor's IC on the
          // lane's P&L — a signal it never cast. Calibration buckets and setup
          // buckets above still accrue: only factor-IC is excluded.
          if (!LANE_CATALYST_KINDS.has(pred.catalyst?.kind ?? '')) w = updateIcStats(w, pred, o)
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

/** The velocity lane's liquidity floor, in $M of market cap. A momentum door can
 * open on anything that moves, and the smallest of those names cannot be got out
 * of at all — so the lane trades nothing under this, and cluster membership never
 * buys an exemption (a cluster ELEVATES priority; it is never eligibility).
 *
 * An UNKNOWN cap fails the floor, deliberately: an unknown never passes a gate in
 * this engine. The cap-enrichment budget is 15 names a run, but a screener row
 * carries its cap for free — and a name moving hard enough to open a door is
 * overwhelmingly a screener name, so the floor bites the right population. */
export const VELOCITY_MIN_CAP_USD_M = 20

/** SHADOW-FIRST (owner decision, 2026-08-12): the velocity lane's ship gate
 * measured +5.25%/entry expectancy across all seven named runners with honest
 * mid-run entries — but only 38.8% of entries exited green against a 60% bar
 * written, wrongly, as a hit-rate test for a big-winner design. Rather than
 * revise a gate after seeing its results, the lane ships GRADED BUT UNSIZED:
 * every velocity call publishes as a shadow, feeding calibration and its own
 * setup family, and earns sizing only from its live record (the repo's
 * earn-influence rule). Flip to false ONLY with the owner's explicit word once
 * the ledger shows what the lane is worth. While shadowed, an unknown cap may
 * pass the liquidity floor — a shadow carries no money, and starving the
 * learning record was the replay's other lesson (77 blocked would-be calls). */
export const VELOCITY_SHADOW_FIRST = true

/** How many trending names one run may fetch candles for to check clusters.
 * clusterCandidates has already narrowed the record to symbols sitting in a
 * co-appearing pair — and returns [] outright under its 7-day warm-up, so a young
 * record costs ZERO calls — and this is the hard ceiling on top of that. */
export const CLUSTER_CANDLE_CAP = 25

/** Bank one day of the trending record — the ONLY thing that makes co-appearance
 * measurable later (hypeCluster.ts). Append-if-new-date: the FIRST run to record a
 * date owns it, so the afternoon run cannot overwrite the morning's crowd with a
 * quieter one, nor stack two rows for one date and let the co-appearance count read
 * a stutter as evidence.
 *
 * That ownership lives HERE and nowhere else. The reader (normaliseHistory) dedupes
 * by date LAST-writer-wins, so it does not enforce first-run ownership — it merely
 * never sees a second row, because this function does not write one. Should two rows
 * for one date reach the blob anyway (concurrent runs, a hand-edit, a restored
 * snapshot), the record read back is the LAST of them [review].
 *
 * A day the feed said NOTHING is not recorded at all. Recording an empty day would
 * be dishonest in a way that costs real evidence: the co-appearance window is the
 * last five RECORDED days, so an ApeWisdom outage would otherwise shove a genuine
 * day of crowd behaviour out of the window and replace it with a hole.
 *
 * Fail-soft in full: nothing downstream requires this blob to exist. */
async function recordTrendDay(store: AppStore, today: string, social: SocialPulseRow[]): Promise<void> {
  try {
    // The feed arrives rank-ordered, so the top TREND_DAY_SYMS names ARE the day's
    // crowd — wider than the 12 that become candidates, because a cluster is read off
    // the whole trending set, not off the slice the engine chose to score. Note the
    // coupling: combineSocialPulse already returns its own top 15 (social.ts, the
    // closing `.slice(0, 15)`), so TREND_DAY_SYMS = 15 records the feed ENTIRE and
    // raising it alone would record nothing extra until that slice moves too.
    // Normalised BEFORE the dedupe, or two spellings of one name eat two of the
    // day's slots and land in the record as two members of tomorrow's cluster.
    const syms = [...new Set(social.map(s => (typeof s?.sym === 'string' ? s.sym.trim().toUpperCase() : '')).filter(Boolean))].slice(0, TREND_DAY_SYMS)
    if (!syms.length) return
    // Anything that is not a LIST is no record: a blob of the wrong shape (a partial
    // restore, a hand-edit) would otherwise throw on .filter into the catch below on
    // this run and every run after it, and the record would never restart [review].
    const raw = await store.read<TrendDay[]>('social-history')
    const prior = (Array.isArray(raw) ? raw : []).filter(d => d && typeof d.date === 'string' && Array.isArray(d.syms))
    if (prior.some(d => d.date === today)) return
    await store.write('social-history', [...prior, { date: today, syms }].slice(-TREND_HISTORY_DAYS))
  } catch {
    // a blob hiccup costs the record, never the board
  }
}

export async function buildBoard(
  store: AppStore,
  deps: EngineDeps,
  nowSec: number,
): Promise<{ board: Prediction[]; rosterSize: number; regime: string; holdingsCount: number }> {
  const today = londonDate(nowSec)
  const cfg = validateConfig(await store.read('config')) ?? { watchlist: [], rules: [], ytChannels: [], capital: 5000 }
  const watchSyms = cfg.watchlist.map(w => w.symbol)
  const favourites = cfg.favouriteChannels ?? ['Stocks with Josh']
  const gates = gatesFor(cfg.riskAppetite) // 'aggressive' lowers the dead zone / expected-move floor (catalyst.ts)
  // THE FUNNEL'S RECORD (shared/engine/funnelTrace.ts). Every `continue` below now
  // also says WHY, into an accumulator that costs a Map insert and decides nothing.
  // Written once at the end of the run, fail-soft, under `funnel-trace:${today}`.
  const trace = funnelTraceRecorder()

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
  // …and today's trending set is RECORDED, because a hype cluster can only be
  // detected from a record nobody kept yet: combineSocialPulse returns one day's
  // independent ranks, so co-appearance across days has to be accumulated a day at
  // a time [C8]. Written here, right after the fetch, so the day is banked before
  // any of the work below can fail. Fail-soft and consequence-free: the blob only
  // ever ELEVATES priority later (hypeCluster.ts), so a missing day costs a little
  // future evidence and nothing else.
  await recordTrendDay(store, today, social)

  const sleeveActive = sleeveCloses.size > 0
  const sleeveTop = sleeveActive ? rankSleeve(sleeveCloses, 40) : []
  // Sleeve membership is what the batch actually RETURNED, not what was asked
  // for. fetchSparkCloses fails soft per 20-name chunk, so one refused chunk
  // leaves twenty configured names with no closes at all — and granting those
  // names the sleeve's discovery door, its dip-lane quality admission and
  // priority 4 would be handing out privileges with no data behind them. The
  // intersection means a name whose chunk died is read exactly as it was before
  // the sleeve existed, which is the only honest reading of "we don't know".
  const sleeveSet = new Set(sleeveActive ? sleeveSyms.filter(s => sleeveCloses.has(s.toUpperCase())) : [])
  const sectorPairs = await mapLimit(Object.keys(SECTOR_MEMBERS), 6, async etf => [etf, await deps.candles(etf)] as const)
  const sectorRows = computeSectorRows(new Map(sectorPairs.filter((p): p is [string, Candle[]] => p[1] !== null)), spy)
  const topSectorMembers = sectorRows.slice(0, 2).flatMap(r => SECTOR_MEMBERS[r.sym] ?? [])

  // Pundit stances, read EARLY so a high-credibility off-roster call can NOMINATE
  // a name into the candidate pool below — not merely re-score one already on the
  // roster. loadState (weights/calibration/channelCred) is hoisted here too so the
  // per-channel credibility gate is available; the SAME stancesBySym + credOf are
  // reused for the channels factor later, so there is one read and no regression.
  // Fail-soft: missing extracts → empty map → no injection.
  const { weights, calibration, channelCred } = await loadState(store, today)
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
  /** Every distinct name a door OFFERED to the pool. `not-candidate` is a count,
   * never a list (the universe of names nobody nominated is unbounded), and this
   * is the only honest population to count it over: the names the run actually
   * touched. `offered − sources` is exactly the route-ETP refusal below. */
  const offered = new Set<string>()
  const addSource = (sym: string, source: string, capUsdM: number | null = null) => {
    const key = sym.toUpperCase()
    offered.add(key)
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
  // expected-move floor, so a big liquid name in the news gets a fair look on
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
  // an 'ipo' catalyst carrying side:null — the relaxed expected-move floor, but NO free
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

  // ---- hype clusters: the crowd's own themes, discovered from the record ----
  // Names the crowd keeps naming TOGETHER whose tapes then actually move together
  // (hypeCluster.ts — both legs required, no theme ever hard-coded). Membership
  // ELEVATES priority to the sleeve's tier so a genuine crowd theme cannot be cut
  // by the 180-candidate budget, and it rides the velocity lane's narration below.
  // It is NEVER eligibility and never a call: a cluster member still faces the
  // liquidity floor, the lane's own gates and calibration like everything else.
  //
  // Read AFTER the sleeve door on purpose. addSource keeps the FIRST source, so
  // stamping 'hype-cluster' earlier would overwrite 'sleeve' on a famous name the
  // crowd is also naming — and `sleeveOnly` (the exact source-string test below)
  // would then hand that name the cap budget's front of the queue and a roster
  // slot it was deliberately denied. Sleeve attribution stays untouched.
  //
  // The fetch is bounded twice: clusterCandidates names only the symbols already
  // in a co-appearing pair (and [] under its 7-day warm-up — a young record costs
  // no calls at all), capped again at CLUSTER_CANDLE_CAP. Worst case is therefore
  // +25 candle reads on top of the 180-candidate budget below, and in practice far
  // fewer: a member that becomes a candidate is read through the same cached
  // fetcher (marketCache) either way, so only the trending names that DON'T make
  // the cut cost anything at all. Fail-soft in full: any fault → no clusters →
  // exactly the run this engine had before clusters existed.
  const clusterPeers = new Map<string, string[]>()
  // Prefetched cluster tapes are KEPT and reused by the candle fill below —
  // fetching them twice wasted up to 25 calls, and worse, a symbol that read
  // fine here could fail the uncaught second read and abort the whole board
  // (codex cross-check, salvaged 2026-08-12).
  const clusterTapes = new Map<string, Candle[]>()
  try {
    const history = await store.read<TrendDay[]>('social-history')
    const wanted = clusterCandidates(history).slice(0, CLUSTER_CANDLE_CAP)
    if (wanted.length) {
      await mapLimit(wanted, 8, async sym => {
        const c = await deps.candles(sym).catch(() => null)
        if (c?.length) clusterTapes.set(sym, c)
      })
      for (const cluster of detectClusters(history, clusterTapes, spy)) {
        for (const sym of cluster) {
          clusterPeers.set(sym, cluster.filter(s => s !== sym))
          addSource(sym, 'hype-cluster')
        }
      }
      if (clusterPeers.size) console.log('BOARD: hype clusters —', [...clusterPeers.keys()].join(', '))
    }
  } catch (e) {
    // A cluster is elevation and narration. Losing it costs a little priority and
    // one clause of prose; it must never cost the board.
    console.log('BOARD: cluster detection failed —', String(e).slice(0, 160))
  }

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
    // the SET, not the source string — a sleeve name found by the losers screen is
    // still a sleeve name. A hype-cluster member sits at the SAME tier: the crowd
    // naming three names together while their tapes move together is evidence of
    // the same weight as "this is a famous name", and both are elevation only.
    if (sleeveSet.has(sym) || clusterPeers.has(sym)) return 4
    if (sources.get(sym)?.source.startsWith('channel:')) return 5
    if (sources.get(sym)?.source.startsWith('theme:') || sources.get(sym)?.source === 'rotation') return 6
    if (sources.get(sym)?.source === 'social') return 7
    return 8
  }
  // 180, not 110: the sleeve adds up to 40 permanent candidates, the losers
  // screen another slice and the gainers screen is read 50 deep rather than 25,
  // and none of them may crowd out discovery. Candle fetches stay bounded by the
  // 180 cap itself — worst case +70 vs the old 110, unchanged by the deeper
  // gainers read (a bigger POOL binds the cap more often; it never raises it).
  // Bounded by the mapLimit(8) below — noted, accepted. [R16]
  const candidateSyms = [...sources.keys()]
    .sort((a, b) => candidatePriority(a) - candidatePriority(b) || a.localeCompare(b))
    .slice(0, 180)
  // the budget's own cut, named: everything the sort put past slot 180
  const candidateSet = new Set(candidateSyms)
  for (const [sym, s] of sources) {
    if (!candidateSet.has(sym)) trace.record(sym, 'trimmed', { source: s.source, detail: 'past the 180-candidate evaluation budget' })
  }
  const candleMap = new Map<string, Candle[]>()
  await mapLimit(candidateSyms, 8, async sym => {
    // fail-soft per symbol: one refused read costs one candidate, never the board
    const c = clusterTapes.get(sym) ?? (await deps.candles(sym).catch(() => null))
    if (c && c.length >= 30) candleMap.set(sym, c)
  })
  // …and the tape that never arrived. `no-candles`, NOT `no-data`: composeCall's
  // no-data means "we had the chart and no core factor scored", which is a
  // scoring failure. This is a supply failure, and a trace read back next quarter
  // must be able to tell them apart without parsing prose.
  for (const sym of candidateSyms) {
    if (!candleMap.has(sym)) trace.record(sym, 'no-candles', { source: sources.get(sym)?.source, detail: 'no candles, or fewer than 30 sessions of them' })
  }

  // cap lookups are budgeted: screener caps ride along free, the rest rotate.
  // ELEVATION must not EAT the budget. Both elevation-only doors — the sleeve and
  // the hype cluster — put names in the pool with capUsdM null (the spark batch
  // carries closes, not fundamentals; a cluster carries nothing but the crowd's
  // record) and both sort AHEAD of discovery in candidatePriority, so a full sleeve
  // or one big cluster would take all 15 slots and every discovery name would go the
  // day unpriced — no cap cohort, no >$10B quality read, no small-cap stop widening.
  // Elevated names therefore queue BEHIND discovery: everything else fills the budget
  // FIRST (keeping its own priority order among themselves) and they take whatever is
  // left. Neither needs the cap: a sleeve name's dip-lane quality is granted by
  // sleeveSet, never by its cap, and a cluster is priority and narration, never
  // eligibility. Tier 4 elevated them past the CANDIDATE cut (ratified); it was never
  // a claim on this budget. [R17]
  const noCapAll = candidateSyms.filter(s => sources.get(s)!.capUsdM == null && candleMap.has(s))
  // Two different tests, deliberately. The sleeve reads the SOURCE STRING, because
  // its door is stamped after every ordinary door and before the cluster's, making
  // 'sleeve' an exact test for "the sleeve was its only way in". A cluster member is
  // stamped 'hype-cluster' under the same rule, but membership ALSO elevates a name
  // some other discovery feed found (social, a theme) to the cluster's tier-4 slot —
  // so the cluster is read as the SET, exactly as candidatePriority reads it, and
  // narrowed to tier 4 so that a HOLDING or a watchlist name the crowd happens to be
  // naming keeps the higher door it earned on its own.
  const sleeveOnly = (s: string) => sources.get(s)?.source === 'sleeve'
  const clusterElevated = (s: string) => clusterPeers.has(s) && candidatePriority(s) === 4
  const elevatedOnly = (s: string) => sleeveOnly(s) || clusterElevated(s)
  const noCap = [...noCapAll.filter(s => !elevatedOnly(s)), ...noCapAll.filter(elevatedOnly)].slice(0, 15)
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
  // TWO numbers, and they are two questions [§9]. `engineBaseRate` is POOLED: it
  // is the engine's measured hit rate over the population it publishes, and it is
  // used where a PROBABILITY is wanted (the near-miss row's `probability`, far
  // below). `gradeAnchor` is what every GRADE threshold and the null floor are
  // measured from — the stored `referenceBase` when the installed seed swept one,
  // the pooled base otherwise, so the committed generation-1 seed keeps today's
  // behaviour exactly. They coincide until a generation-2+ seed installs.
  const engineBaseRate = baseHitRate(calibration).rate
  const gradeAnchor = gradeBaseRate(calibration)
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
  // The quietest drop in the whole run, and the largest: a candidate with a good
  // tape that is NEITHER on the roster NOR in the sleeve is never scored at all.
  // It is the roster trim doing the cutting, one door along — so it is `trimmed`,
  // with the reason spelled out. A lane (dip, velocity) may still publish on such
  // a name below, and that publication revises this row.
  const evalSet = new Set(evalRows.map(e => e.sym.toUpperCase()))
  for (const sym of candidateSyms) {
    if (candleMap.has(sym) && !evalSet.has(sym))
      trace.record(sym, 'trimmed', { source: sources.get(sym)?.source, detail: 'not on the roster and not in the sleeve — never scored' })
  }

  const board: Prediction[] = []
  /** Row ids of shorts shadowed ONLY for want of an ISA route, having cleared
   * every other gate — the rows the observation rank may promote. Read by the
   * assembly below, never written to a row or to the ledger. */
  const routeBlockedShorts = new Set<string>()
  /** The wider set: every short the route is the ONLY reason the reader cannot
   * see — including the ones that would have landed as watch rows rather than
   * trades. They are never promoted (an observation has to have cleared the
   * sizing gates), but the empty-side copy must still not call their side
   * "nothing cleared the gates": the gates are not what hid them. */
  const routeShadowedShorts = new Set<string>()
  // The ONE publication path. Both the composite loop and the dip-lane merge below
  // push through here, so calibration, grading, the shadow/watch/belowBase flags,
  // routing and sizing can never drift between the two lanes.
  // forceShadow: the caller has evidence this call must not be traded, but it
  // still has to publish so the ledger can grade the veto. Today's only user is
  // the dip lane's news check (a dip into a broken thesis); it deliberately goes
  // through the shadow flag rather than a new one, so sizing, routing and the
  // shadow/watch exclusivity below stay in exactly one place.
  // sizeCap: the CALLER's own ceiling on how much of the rung this row may carry,
  // 1 by default (no ceiling). The velocity lane's two doors set it (0.25 early,
  // 0.5 confirmation — VELOCITY_DOOR_CAP): a fresh break is not worse evidence,
  // it is earlier and wider, so it is sized smaller. See the sizing note below for
  // why it is a CAP and never multiplied into the tier fraction.
  // trail: the caller declares that this row's stop is a MOVING falsifier, not a
  // fixed level, so the open book and the £10k book re-read it daily (Task 6,
  // openTrace.ts / paperBook.ts). Threaded from the lane rather than inferred from
  // `setup` here: the lane that defines a trail is the only thing that can promise
  // one, and a row that merely looks like a breakout must never acquire a moving
  // stop by resemblance. Grading is untouched either way — it reads the published
  // `stop`, which is exactly what this field does NOT change.
  const publishCall = (
    call: EngineCall,
    capUsdM: number | null,
    cat: CatalystTag | null,
    forceShadow = false,
    sizeCap = 1,
    trail?: Prediction['trail'],
  ) => {
    // cap-class cohort drives BOTH the calibration lookup (its own buckets first,
    // then pooled) and the risk rung below. Unknown cap pools to the cohortless
    // path and the combined rung — never guessed into a sleeve.
    const cohort = capCohortOf(capUsdM)
    // …and it is a CURVE now, read at this call's own |composite| rather than at
    // the corner of the band it falls in: two calls 14 points apart no longer
    // share a probability, and one point of conviction moves the number. `nEff`
    // is how many observations actually straddle this read — the grade prices it
    // directly, so a thin bucket can no longer buy a full-size B. `belowEvidence`
    // says the number was handed DOWN from the lowest conviction this rung has
    // ever graded, which caps the grade at C. `provisional` is display only
    // (nEff < MIN_BUCKET_N) — nothing below branches on it.
    const { p, provisional, nEff, belowEvidence } = probabilityFor(calibration, call.side, regime, Math.abs(call.composite), cohort)
    const grade = gradeFor(p, nEff, gradeAnchor, belowEvidence)
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
    // Sizing, in three tiers instead of the old on/off (ratified 2026-08-11).
    // The old rule — only A/B on the FULL contract carries size — kept producing
    // boards where nothing was actionable: a perfectly real grade-C setup, or an
    // A whose only missing leg was an unknown regime, both published at zero size
    // beside each other, which reads to the reader as "the engine has no opinion".
    //   full  = A/B AND the core-data contract → the rung's full risk
    //   half  = C WITH the contract, or A/B WITHOUT it → half the rung's risk.
    //           One of conviction/evidence is short, never both — a real trade
    //           taken smaller, with the gap named in evidence.detail. [R12]
    //   watch = everything else: an ungraded (below-base) call, or C on thin
    //           evidence — where conviction AND evidence are both short.
    // Leverage is a separate, stricter question, and it is keyed on the size the row
    // ACTUALLY carries: an ETP is only ever routed for a row published at the FULL
    // rung (sizedFraction === 1, below). A half tier is a plain share/paper position
    // — and so is a full-tier row whose LANE door capped it to a quarter or a half.
    // The door cap is the engine saying "small here, this move is young"; handing
    // that row a 2× ETP would give the reader back the exposure the cap just took
    // away, and at daily-rebalance decay on the most slippage-prone entry the engine
    // makes. Grade C never unlocks leverage anyway (riskLadder.leverageAllowed) —
    // untouched. [R14]
    const fullTrade = !shadow && (grade === 'A' || grade === 'B') && call.evidence.contract
    const halfTrade = !shadow && !fullTrade && grade != null && (grade !== 'C' || call.evidence.contract)
    const watchOnly = !shadow && !fullTrade && !halfTrade
    // …and the row carries the SMALLER of two independent haircuts, never their
    // product (the v1 D4 rule, ratified). The tier fraction answers "how much did
    // conviction and evidence earn?" (1 full, 0.5 half); sizeCap answers "how much
    // does this LANE allow on a row of this kind?" — the velocity door caps, which
    // are momentum sizing and not an evidence deficiency. Multiplying them would
    // publish a half-graded confirmation probe at an EIGHTH of a rung: two
    // different statements about one row, both applied, and a number the reader
    // cannot trace to either rule.
    const tierFraction = fullTrade ? 1 : halfTrade ? 0.5 : 0
    const sizedFraction = Math.min(tierFraction, sizeCap)

    // A short that cleared EVERY gate — graded, evidenced, no print in the way —
    // and is a shadow for ONE reason: an ISA cannot place it. That is a different
    // sentence from "nothing cleared the gates", and the assembly below needs to
    // be able to tell the reader which one is true (and to rank such a row above
    // a near miss, which cleared nothing at all). Recorded by id, not on the row:
    // the ledger must not grow a field that means "why we hid it".
    // …and the same sentence one rung lower: a short that would have reached the
    // board at all (as a trade OR as a watch row) if only it could be routed.
    const routeShadowed = unshortable && !call.earningsRisk && !forceShadow && (grade != null || call.evidence.contract)
    const routeBlocked = routeShadowed && grade != null && (grade !== 'C' || call.evidence.contract)

    const rung = cohortRungOf(risk, cohort)
    // sizedFraction === 1 implies tierFraction === 1, i.e. fullTrade, so `grade` is
    // non-null here for exactly the reason it was under the old `fullTrade` test.
    const instrument = sizedFraction === 1 ? mapInstrument(call.side, call.sym, grade!, rung, cfg.levMap ?? {}) : null
    const callThemes = themesOf(call.sym)
    const id = `${today}:${call.sym}:${call.side}`
    if (routeBlocked) routeBlockedShorts.add(id)
    if (routeShadowed) routeShadowedShorts.add(id)
    board.push({
      ...call,
      id,
      date: today,
      modelVersion: ENGINE_MODEL_VERSION,
      regime,
      priceAtPrediction: call.entry,
      themes: callThemes.length ? callThemes : undefined,
      catalyst: cat ? { kind: cat.kind, reason: cat.reason } : undefined,
      trail,
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
      riskPct: shadow || watchOnly ? 0 : RUNG_RISK_PCT[rung] * sizedFraction,
      instrument,
      paperOnly: call.side === 'short' && !watchOnly && !instrument,
      // The stamp must describe what the call ACTUALLY got. The composite loop
      // re-scores with worldMult before publishing; a LANE composite is structural
      // (depth-derived in dipLane.ts, run-derived in velocityLane.ts) and never
      // sees the nudge at all. Printing 1.1 on a lane row would advertise a
      // conviction adjustment that was never applied — so every lane row records
      // the multiplier it truly ran at: 1.
      worldTape: { tone: tone.tone, mult: LANE_CATALYST_KINDS.has(cat?.kind ?? '') ? 1 : worldMult(tone.tone, call.side) },
    })
    // …and the size decision is REPORTED HERE rather than handed back to the
    // caller. publishCall is a closure over the whole run, so it can write the
    // row itself; returning a code instead would have meant editing all four call
    // sites (composite, dip, velocity, and the shadow path) to remember to record
    // it — and "the caller forgot" is precisely the class of silence Stage 3a
    // exists to end. `revise`, not `record`: a publication is the row's fate and
    // must overwrite whatever gate the composite wrote on the way past.
    //
    // route-blocked outranks called-shadow because it is the more specific truth:
    // the row cleared everything and an ISA simply cannot place it. `grade-watchonly`
    // is NOT used — called-watch already says "published, sized to zero".
    trace.revise(call.sym, routeShadowed ? 'route-blocked' : shadow ? 'called-shadow' : fullTrade ? 'called-full' : halfTrade ? 'called-half' : 'called-watch', {
      side: call.side,
      source: sources.get(call.sym.toUpperCase())?.source,
      detail: routeShadowed
        ? `no ISA short route${routeBlocked ? ' — promotable to an observation' : ''}`
        : shadow
          ? call.earningsRisk
            ? 'earnings print inside the horizon'
            : forceShadow
              ? 'the lane stood it down'
              : unshortable
                ? 'no ISA short route'
                : 'graded null on a failed evidence contract'
          : `grade ${grade ?? 'null'}${call.evidence.contract ? '' : ', contract failed'}${belowBase ? ', below base rate' : ''}${sizeCap < 1 ? `, lane cap ${sizeCap}` : ''}`,
    })
  }

  // Every name that produced a real core read and STILL published nothing — the
  // dead zone, the expected-move floor or an entry gate turned it down. Kept so a day
  // on which nothing at all qualifies can still name what came closest instead of
  // showing the reader an empty card (assembly below). [R11]
  const nearMisses: {
    sym: string
    core: number
    capUsdM: number | null
    lastClose: number
    atrNow: number
    capacityPct: number | null
    stage: Stage | null
    factors: Record<FactorName, FactorScore>
  }[] = []

  for (const entry of evalRows) {
    const candles = candleMap.get(entry.sym) ?? (await deps.candles(entry.sym).then(c => (c && c.length >= 30 ? c : null)))
    if (!candles) {
      trace.record(entry.sym, 'no-candles', { source: sources.get(entry.sym.toUpperCase())?.source, detail: 'no tape at scoring time' })
      continue
    }
    const closes = candles.map(c => c.c)
    const read = technicalStage(entry.sym, candles)
    if (!read) {
      // The chart was HERE and produced no read — a scoring failure, not a supply
      // one, so it shares composeCall's `no-data` rather than `no-candles`.
      trace.record(entry.sym, 'no-data', { source: sources.get(entry.sym.toUpperCase())?.source, detail: 'no technical stage read off the tape' })
      continue
    }
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
      volumeConfirmed: read.volumeConfirmed,
      breadthKnown: breadth != null,
    }
    // composeCall answers with a draft or with the NAME of the gate that refused
    // (shared/engine/types.ts — CallOrRejection). Nothing here reads the gate yet:
    // `isRejection(call)` means exactly what `!call` meant, and the two-pass
    // re-score below behaves identically — the second pass overwrites the first
    // verdict, so a re-score that fails is the rejection that stands.
    let call = composeCall(composeInput)
    // Whether the FIRST pass drafted at all. The world-tape re-score below
    // overwrites the verdict, so a name that cleared every gate and was then
    // pushed back under by the overnight nudge records the SECOND pass's gate —
    // correct for "why did nothing publish", and materially different evidence
    // from a name that never cleared anything, so the trace says which.
    const draftedFirstPass = !isRejection(call)
    if (!isRejection(call)) {
      // the 5y fetch is earned, not default: only names that already made a call
      const c5 = await deps.candles5y(entry.sym)
      if (c5 && c5.length >= 500) {
        const month = Number(today.slice(5, 7))
        factors.seasonality = seasonalityFactor(seasonalitySummary(c5), month)
      }
      // now the side is known → apply the overnight world-tape nudge for it and
      // re-score. The mult is > 0 so the side never flips, but it can push a
      // marginal call under the dead zone (→ rejected, correctly suppressed).
      // seasonality (if it loaded) rides the same re-score — honest both ways.
      call = composeCall({ ...composeInput, factors, worldMult: worldMult(tone.tone, call.side) })
    }
    if (isRejection(call)) {
      trace.record(entry.sym, call.gate, {
        side: call.side,
        source: sources.get(entry.sym.toUpperCase())?.source,
        detail: draftedFirstPass ? `second-pass · ${call.detail ?? ''}` : call.detail,
      })
      // Nothing published. Record the gate-free core read (composite.ts — the same
      // arithmetic the call would have stood on) so the assembly can name this name
      // if the whole side comes up empty. Requires real levels: a row the reader
      // cannot even see an entry/stop for is not worth naming. An earnings print
      // inside the horizon is excluded on the same principle that shadows the
      // trade — the engine does not point at coin flips.
      const core = coreCompositeOf(factors, weights.current, regime)
      const lastClose = closes[closes.length - 1]
      const atrNow = atr(candles)[candles.length - 1]
      if (core != null && lastClose != null && atrNow != null && !composeInput.earningsWithinHorizon)
        nearMisses.push({ sym: entry.sym, core, capUsdM: entry.capUsdM, lastClose, atrNow, capacityPct: composeInput.capacityPct, stage: read.stage, factors })
      continue
    }
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
  // The names whose dip long was actually CONSTRUCTED this run. A dip READ is not
  // a dip CALL: dipCall refuses the 1:1 reward-to-risk gate and the degenerate
  // shapes (stop at or above entry, target at or below it), and a refused dip
  // publishes nothing at all. The demotion rule below keys off this set rather
  // than off dipReads, so a dip the lane itself declined can no longer take a
  // valid composite short down with it and leave the reader nothing on the name.
  const constructedDipLongs = new Set<string>()
  for (const [sym, read] of dipReads) {
    if (alreadyLong.has(sym.toUpperCase())) continue
    const candles = candleMap.get(sym)
    if (!candles) continue
    const capUsdM = sources.get(sym)?.capUsdM ?? null
    const raw = dipCall(sym, candles, read, capUsdM)
    if (!raw) {
      // A dip READ that the lane then declined to BUILD (the 1:1 reward-to-risk
      // gate, or a degenerate stop/target shape — dipLane.ts). The plan's taxonomy
      // had no fit for it: every other code names a gate applied to a scored
      // composite, and this is a lane refusing its own construction. `dip-refused`
      // is an ADDITION (allowed; removals are not), and it matters because these
      // are exactly the names the wildcard lane will want to argue about.
      trace.record(sym, 'dip-refused', { side: 'long', source: sources.get(sym)?.source, detail: `dip lane declined to build · ${read.detail}` })
      continue
    }
    // dipCall is pure and has no calendar — earnings honesty is applied here, so a
    // dip into a print shadows exactly like any other call.
    dipCandidates.push({ sym, read, call: { ...raw, earningsRisk: earningsSet.has(baseSym(sym)) }, capUsdM })
    constructedDipLongs.add(sym.toUpperCase())
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
  //
  // Then the CACHE, before the budget and for every remaining candidate. A verdict
  // already on the blob costs nothing to read — no Finnhub call, no LLM token — so
  // it must not consume one of the five. When the cache did consume them (the probe
  // lived inside the dep), five hits could burn the whole budget on zero fresh
  // reads, and a sixth candidate whose structural veto was sitting in the cache all
  // along got relabelled 'unclear/budget' and traded. A cached verdict now protects
  // a name however many other dips the morning throws up.
  const dipVerdicts = new Map<string, DipNewsVerdict>()
  const usable = (v: DipNewsVerdict | null): v is DipNewsVerdict =>
    !!v && (v.verdict === 'transient' || v.verdict === 'structural' || v.verdict === 'unclear')
  const byDepth = [...dipCandidates].sort((a, b) => b.read.dropPct - a.read.dropPct)
  const servable: typeof byDepth = []
  for (const c of byDepth) {
    const venue = unservedVenue(c.sym)
    if (venue) dipVerdicts.set(c.sym, { verdict: 'unclear', reason: `no news source for ${venue} names yet` })
    else servable.push(c)
  }
  // Probed in parallel but consumed in DEPTH order: the fresh reads that follow
  // must still go to the deepest unresolved dips, so the miss list is rebuilt from
  // `servable` rather than from whichever probe happened to settle first.
  const cacheHits = await Promise.all(servable.map(c => deps.dipNewsCached(c.sym).catch(() => null)))
  const misses: typeof servable = []
  servable.forEach((c, i) => {
    const hit = cacheHits[i]
    if (usable(hit)) dipVerdicts.set(c.sym, hit)
    else misses.push(c)
  })
  await Promise.all(
    misses.slice(0, DIP_NEWS_BUDGET).map(async ({ sym }) => {
      const raw = await deps.dipNews(sym).catch(() => null)
      dipVerdicts.set(sym, usable(raw) ? raw : { verdict: 'unclear', reason: 'lookup failed' })
    }),
  )
  for (const { sym } of misses.slice(DIP_NEWS_BUDGET)) dipVerdicts.set(sym, { verdict: 'unclear', reason: 'budget' })

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
    //
    // …and the thesis is re-composed HERE, because this is the first place the
    // dip's news read exists: dipLane.ts is pure and wrote the sentence without a
    // clause. Same builder, same falsifier — the only thing that changes is
    // whether the story behind the fall gets named (voice.ts).
    publishCall(
      { ...call, ...dipThesis({ sym, dropPct: read.dropPct, stop: call.stop, news: v.verdict }) },
      capUsdM,
      { kind: DIP_CATALYST_KIND, side: 'long', reason: `${read.detail} · ${note}`, strength: 40 },
      v.verdict === 'structural',
    )
  }

  // ---- the velocity lane's own calls, merged into the same board ----
  // A name already MOVING is a long the composite cannot say in time: composeCall
  // derives its levels from an ATR-scaled conviction number, which is a
  // mean-reversion instrument, so a momentum name only composites well once the
  // move is five green days old (velocityLane.ts). The lane classifies the price
  // signature itself and builds its own long, then walks the SAME publishCall path
  // as everything else — calibration, grading, the shadow/watch rules, routing.
  //
  // Run AFTER the dip merge, and skipping any name that already carries a long,
  // because one chart gets one row per side. Two skips, and they are different:
  //   · a CONSTRUCTED dip long (dipCall actually built one) owns the name — the two
  //     lanes would otherwise publish two longs on the same chart. Keyed on the
  //     construction, never on `dipReads` [C9]: a dip the lane itself REFUSED (the
  //     1:1 gate, a degenerate shape) published nothing at all, and letting a
  //     refused read block a velocity call is how Stage 1 lost the day's only row
  //     on a name — the same bug the short demotion already had to fix.
  //   · any existing long ROW, shadow included (the `alreadyLong` rule the dip
  //     merge uses), because the ledger holds one row per sym+side.
  //
  // The liquidity floor is the lane's only eligibility rule beyond its own gates:
  // a door can open on anything that moves, and cluster membership is elevation,
  // never a pass (VELOCITY_MIN_CAP_USD_M).
  const constructedVelocityLongs = new Set<string>()
  const longRows = new Set(board.filter(b => b.side === 'long').map(b => b.sym.toUpperCase()))
  for (const sym of candidateSyms) {
    const candles = candleMap.get(sym)
    if (!candles) continue
    const key = sym.toUpperCase()
    if (longRows.has(key) || constructedDipLongs.has(key)) continue // constructedDipLongs is inside longRows; both stated, because they are two rules
    const capUsdM = sources.get(sym)?.capUsdM ?? null
    // Shadow mode admits unknown caps (no money at risk, the record is the point);
    // sized mode reverts to unknown-never-passes.
    if (capUsdM == null ? !VELOCITY_SHADOW_FIRST : capUsdM < VELOCITY_MIN_CAP_USD_M) continue
    // Per-SYMBOL fail-soft: one unreadable tape must cost that name its call and
    // nothing else. A try around the whole lane would let one symbol silence a
    // lane that had already found three other real breakouts.
    try {
      const read = classifyVelocity(candles)
      if (!read?.door) continue
      const raw = velocityCall(sym, candles, read, capUsdM)
      if (!raw) continue
      // Cluster membership is stamped into the catalyst reason so the paper can say
      // WHY the crowd is here ("moving with the names it keeps being named beside")
      // — narration off a discovered fact, never an extra vote in the composite.
      const peers = clusterPeers.get(key) ?? []
      const reason = peers.length ? `${read.detail} · hype cluster with ${peers.join(', ')}` : read.detail
      // velocityCall is pure and has no calendar — earnings honesty is applied here,
      // so a breakout into a print shadows exactly like any other call.
      publishCall(
        { ...raw, earningsRisk: earningsSet.has(baseSym(sym)) },
        capUsdM,
        { kind: VELOCITY_CATALYST_KIND, side: 'long', reason, strength: 50 },
        VELOCITY_SHADOW_FIRST, // shadow-first: graded and learning, zero reader money until the live record earns sizing
        VELOCITY_DOOR_CAP[read.door], // early 0.25, confirmation 0.5 — the door's own ceiling (bites when sizing is earned)
        // …and this row's stop IS the trail (velocityLane.ts): the books re-read it
        // every day from here on, so a momentum call that loses its falsifier is
        // reported dead the day it dies rather than at a stale printed level.
        'velocity',
      )
      constructedVelocityLongs.add(key)
      console.log(`BOARD: velocity ${read.door} door on ${sym} — ${read.detail}`)
    } catch (e) {
      console.log(`BOARD: velocity read on ${sym} failed —`, String(e).slice(0, 160))
    }
  }

  // one outstanding shadow per sym+side: skip a shadow candidate whose sym+side
  // still has a shadow that hasn't reached its calibrated grade (no outcome10) on
  // a recent prior date — three correlated CEG shorts teach nothing while starving
  // the tiny shadow budget of fresh names. Gated on outcome10 (not outcome5) so a
  // slot frees only once its evidence has actually fed the learning loop, at 10d.
  // Ordinary live (non-shadow) calls are never deduped — on EITHER side of the
  // comparison. An ungraded LIVE call from yesterday holds no shadow slot, and
  // counting it used to make today's shadow of that name vanish from the ledger
  // entirely — which silently swallowed exactly the rows the shadow budget exists
  // to collect (a structural-news veto on a name the engine called live the day
  // before).
  //
  // A promoted OBSERVATION is the one live row that does hold the slot, because it
  // is the SAME row: an observation is a route-blocked shadow the board pulled into
  // the light for a day. If yesterday's promotion has not graded yet and today's
  // copy enters as a shadow, both mature into the calibration buckets and one
  // signal is counted twice. The promotion's own rank already refuses to re-promote
  // such a name (outstandingObservationKeys, below); the shadow path has to refuse
  // it for the same reason, or the double-count simply moves one lane over.
  const priorDates = ((await store.read<string[]>('predictions-index')) ?? []).filter(d => d !== today).slice(-10)
  const outstandingShadowKeys = new Set<string>()
  /** The same idea one lane over: a PROMOTED OBSERVATION from a recent day that
   * has not graded yet. A promoted row is a live ledger row, not a shadow, so it
   * never lands in the set above — and without its own set a name the route
   * blocks every morning would be promoted again every morning, each day's copy
   * entering the ledger as fresh live evidence. Read by the observation rank
   * below. Such a row now also holds a SHADOW slot (above), so this set is
   * strictly contained in that one — kept separate on purpose: the two rules
   * answer different questions ("may this be promoted?" and "may this be
   * shadowed?") and must not start depending on each other's membership. */
  const outstandingObservationKeys = new Set<string>()
  for (const date of priorDates) {
    for (const p of (await store.read<Prediction[]>(`predictions:${date}`)) ?? []) {
      if ((p.shadow || p.observation) && !p.outcome10) outstandingShadowKeys.add(`${p.sym}:${p.side}`)
      if (p.observation && !p.outcome10) outstandingObservationKeys.add(`${p.sym}:${p.side}`)
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
    const sidePool = pool.filter(b => b.side === side)
    const { picked, skipped } = pickDiverse(
      sidePool,
      cap,
      sym => symToSector.get(baseSym(sym)) ?? primaryThemeOf(sym),
      sym => candleMap.get(sym)?.map(c => c.c) ?? null,
    )
    if (skipped.length) console.log(`BOARD: diversity gates (${label} ${side}):`, skipped.map(s => `${s.sym} — ${s.why}`).join('; '))
    // …and the two ways a row that had earned its place loses it, told apart. The
    // gate's own `why` (the blocking sector, the correlation partner) is carried
    // into `detail` verbatim — it was already computed and thrown at the console,
    // and the wildcard lane (3d) reads exactly these rows to find the day's
    // highest-value blocked trade.
    const pickedIds = new Set(picked.map(p => p.id))
    const skippedSyms = new Set(skipped.map(s => s.sym.toUpperCase()))
    for (const s of skipped) trace.revise(s.sym, 'diversity', { side, source: sources.get(s.sym.toUpperCase())?.source, detail: `${label} cut · ${s.why}` })
    for (const b of sidePool) {
      if (pickedIds.has(b.id) || skippedSyms.has(b.sym.toUpperCase())) continue
      trace.revise(b.sym, 'slot-cut', { side, source: sources.get(b.sym.toUpperCase())?.source, detail: `${label} cut · ${cap} per side already filled` })
    }
    return picked
  }
  // The actionable board is SMALL by design: at most 3 trades per side. The watch
  // list carries the rest of the ranked read so a day with no qualified trades
  // still publishes what the engine is looking at — as observations, not calls.
  //
  // Order matters. The trade slots are picked FIRST, and an actionable row the
  // diversity gates did not pick then falls THROUGH to the watch list instead of
  // off the board entirely [R13]. Under the old order (both pools computed up
  // front) the 4th-best long simply vanished — from the board AND the ledger —
  // which is how a screen full of correlated names could publish three rows and
  // silently discard nine. Demotion strips size and route; the row itself stays.
  //
  // The two sides are cut SEPARATELY, with the dip-over-short demotion sitting
  // between them. The demotion may only be triggered by a dip long that survived
  // its own cut (F3, below), so the long side has to be final before it runs; and
  // running it before the SHORT cut means a short the dip read shadows releases its
  // slot to the next-best short instead of wasting it. The two picks never see each
  // other (pickDiverseSide filters by side), so splitting them costs nothing.
  const demoteToWatch = (pool: Prediction[], picked: Set<string>) => {
    for (const b of pool) {
      if (picked.has(b.id)) continue
      b.watchOnly = true
      b.riskPct = 0
      b.instrument = null
      b.paperOnly = false // a watch row is nobody's position — exactly as publishCall stamps one
      b.horizon = horizonOf({ watchOnly: true, belowBase: b.belowBase, stage: b.stage, setup: b.setup, evidence: b.evidence })
    }
  }
  const actionableLongs = board.filter(b => !b.shadow && !b.watchOnly && b.side === 'long')
  const longTrades = pickDiverseSide(actionableLongs, 'long', 3, 'trade')
  demoteToWatch(actionableLongs, new Set(longTrades.map(t => t.id)))

  // ---- LANE evidence outranks the composite's read of the SAME chart ----
  // A triggered-and-holding dip is the tape saying this name is being BOUGHT: a
  // measured drop, the knife guard passed, a volume-PAID reclaim. A velocity door
  // is the same kind of sentence one lane over — a paid break of the 20-session
  // high, or a paid run still holding its 8-EMA. The composite
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
  //
  // The trigger is a CONSTRUCTED lane long (published, live or news-shadowed), not
  // a bare lane read. dipCall declines a shape that risks more than its target pays
  // (the 1:1 gate) and the degenerate stop/target shapes; velocityCall declines a
  // trail with no room under it — and a call the lane itself refused to trade is no
  // evidence against anything. Keying on dipReads silently deleted the day's only
  // call on such a name: the dip published nothing and the perfectly good composite
  // short was demoted beside it.
  //
  // BOTH lanes feed the key set, as one rule rather than two (Stage 1b). A sized
  // velocity long beside a live short is the identical unreadable card — the engine
  // telling the reader to buy the break and sell the chart on one morning — and the
  // resolution is the same: the lane owns the reader-facing row, the short shadows
  // on and still grades, so the ledger can answer who was right.
  //
  // And the dip long has to be a row the reader can actually TAKE (ratified
  // 2026-08-12). A dip that published below its base rate, or graded C on thin
  // evidence, lands watch-only at zero size: trading it is not on offer. Letting
  // that row demote a live, routable, fully-graded short costs the reader the
  // day's only sized call on the name and hands back an observation in its place
  // — the disagreement is real, but the cure must not be worse than the clash.
  //
  // "Takeable" means takeable at the END of the assembly, which is why this runs
  // here and not beside the news pass. A lane long can be sized when it publishes
  // and still lose its slot to the 3-per-side cut or the diversity gates above —
  // and then it is a zero-size observation like any other. Reading the PRE-cut
  // state left exactly the state F3 forbids: an unplaceable dip row on the board
  // and a routable, fully-graded short shadowed behind it.
  //
  // A velocity long's DOOR CAP is not a demotion: a quarter-size row is a sized,
  // takeable trade (0.25 of the rung is what the lane offers), so it belongs here
  // exactly like a full one. Only riskPct 0 — watch, shadow, cut — disqualifies.
  const laneLongs = new Set([...constructedDipLongs, ...constructedVelocityLongs])
  const sizedLaneLongs = new Set(
    board.filter(b => b.side === 'long' && !b.shadow && !b.watchOnly && laneLongs.has(b.sym.toUpperCase())).map(b => b.sym.toUpperCase()),
  )
  /** Row ids of shorts a lane demoted, and WHICH lane did it — read only by the
   * empty-side copy, which must not tell the reader "nothing cleared the gates"
   * about a row that cleared all of them and was then outranked by the other lane,
   * nor name the wrong lane as the one that outranked it. */
  const laneDemotedShorts = new Map<string, 'dip' | 'velocity'>()
  for (const row of board) {
    if (row.side !== 'short' || row.shadow) continue
    const sym = row.sym.toUpperCase()
    // The release, logged where it can actually be true. A structural verdict has
    // already published the dip long as a SHADOW, so such a name can never be in
    // sizedLaneLongs through the dip — and the velocity lane skips any name the dip
    // lane constructed a long on, so it cannot be in there the other way either.
    // This is not a gate; but "the news freed the short" is worth saying out loud,
    // and inside the demotion branch it could never print.
    if (structuralVetoes.has(sym) && constructedDipLongs.has(sym)) {
      console.log(`BOARD: structural news on ${row.sym} frees the composite short — both lanes now read the same way`)
      continue
    }
    if (!sizedLaneLongs.has(sym)) continue
    const lane = constructedDipLongs.has(sym) ? 'dip' : 'velocity'
    row.shadow = true
    row.watchOnly = undefined // shadow and watch are exclusive in publishCall — keep them so
    row.belowBase = undefined
    row.riskPct = 0
    row.instrument = null
    row.paperOnly = true // a short with no instrument, exactly as publishCall stamps one
    row.horizon = horizonOf({ watchOnly: false, stage: row.stage, setup: row.setup, evidence: row.evidence })
    laneDemotedShorts.set(row.id, lane)
    // the row's fate genuinely changed after it published, so the trace follows it
    trace.revise(row.sym, 'called-shadow', { side: 'short', source: sources.get(sym)?.source, detail: `the ${lane} lane's read on the same chart outranked it` })
    console.log(`BOARD: ${lane} read on ${row.sym} demotes the composite short to a shadow`)
  }

  const actionableShorts = board.filter(b => !b.shadow && !b.watchOnly && b.side === 'short')
  const shortTrades = pickDiverseSide(actionableShorts, 'short', 3, 'trade')
  demoteToWatch(actionableShorts, new Set(shortTrades.map(t => t.id)))
  const trades = [...longTrades, ...shortTrades]
  const watchPool = board.filter(b => !b.shadow && b.watchOnly)
  const watch = [...pickDiverseSide(watchPool, 'long', 6, 'watch'), ...pickDiverseSide(watchPool, 'short', 6, 'watch')]
  const liveCalls = [...trades, ...watch].sort((a, b) => (a.watchOnly ? 1 : 0) - (b.watchOnly ? 1 : 0) || Math.abs(b.composite) - Math.abs(a.composite))

  // ---- nearest misses: an empty SIDE still says what came closest ----
  // A morning where every candidate died at a gate used to publish a blank card,
  // which reads as "the engine is broken" rather than "the engine said no". So a
  // side with no live row at all names up to two nearest misses: the largest core
  // reads of that sign (composite.ts's gate-free maths), carrying real levels off
  // lastClose/ATR and labelled for exactly what they are. Zero size, zero route,
  // probability = the engine's own base rate — they earned no calibrated bucket.
  //
  // They are BOARD-ONLY on purpose: a near miss never enters `predictions:${date}`,
  // so it can never teach the calibration buckets, the factor-IC loop or the Brier
  // trail. A row with no evidence read and a base-rate probability is not a
  // prediction, and grading it would quietly bias every bucket it landed in
  // toward the population the gates exist to reject.
  //
  // The only-placeable-shorts rule governs SIZED CALLS: an ISA cannot place a
  // naked short, so a short trade needs an inverse-ETP route. A near miss is not
  // a call — it is an observation printed so the board is never blank — and
  // suppressing the unroutable ones handed us a fourth blank-board path: a day
  // where nothing clears the gates AND every core read is negative showed the
  // reader nothing at all. So a near-miss short publishes either way, and the
  // unroutable ones say so in the open ("no ISA route — observation only").
  // Keyed off EVERY published row, shadows included: the dip lane can publish a
  // long on a name whose composite produced nothing, and a near miss must never
  // duplicate the id of a row already in the ledger.
  const publishedKeys = new Set(board.map(b => `${b.sym.toUpperCase()}:${b.side}`))
  const routableShort = (sym: string) => {
    const m = (cfg.levMap ?? {})[sym.toUpperCase()]
    return !!(m?.short2x || m?.short3x)
  }
  const nearMissRows: Prediction[] = []
  /** Why a side carries nothing tradeable: 'gates' (nothing cleared them),
   * 'no-route' (something did, and an ISA cannot place it) or 'dip-lane' /
   * 'velocity-lane' (the engine had a live short and its own lane read on the same
   * chart outranked it — named by LANE, because "the dip read outranked it" is
   * simply false about a breakout). Rides the board blob so the copy on the card
   * can say which; a lie here reads as a broken engine, and 'gates' was the lie in
   * every one of the other cases. */
  const emptySides: { long?: EmptySideReason; short?: EmptySideReason } = {}
  for (const side of ['long', 'short'] as const) {
    if (liveCalls.some(b => b.side === side)) continue

    // ---- an unroutable row that cleared EVERY gate outranks a near miss ----
    // Ratified 2026-08-12. The anti-clutter rule (2026-07-24, "only show shorts I
    // can place") governs SIZED CALLS, and it still does: this row carries no size,
    // no route and no offer to trade. But a graded, evidenced short is a far better
    // answer to an empty side than a near miss, which cleared nothing at all — so
    // when the side would otherwise be nameless, the best of them is promoted out
    // of the shadow set into a labelled watch-only observation. A side WITH live
    // rows never sees it: it stays a shadow, exactly as before.
    //
    // Two names are refused the promotion outright, both for the same reason —
    // the board must not contradict itself or the ledger:
    //   · a sym:side the ledger is ALREADY carrying ungraded, as a recent shadow
    //     or as a recent promotion of its own. The condition that hides a row (no
    //     ISA route) persists for weeks, so without this a single stubborn dip
    //     would be re-promoted every morning and every copy graded as fresh live
    //     evidence — the shadow budget's dedup rule (above) exists for exactly
    //     this failure, and an observation is no more entitled to skip it.
    //   · a name the FINAL BOARD already shows a live row on — in practice a lane's
    //     long (dip or velocity). A sized long beside a short observation on the same
    //     chart is a board telling the reader both things at once, and the lane owns
    //     that name for the day. The test is what the reader can SEE, not what the
    //     dip lane attempted: a dip long that a structural news read shadowed, or
    //     that lost its slot to the 3-per-side cut, contradicts nothing because it
    //     is not on the board. Keying on the attempt (constructedDipLongs) suppressed
    //     the observation in exactly those cases and showed the reader nothing at
    //     all on either side — the contradiction this rule prevents needs a visible
    //     long to be a contradiction. liveCalls is final for the opposite side here:
    //     both sides' trades and watch rows are cut above, and this loop only runs
    //     for a side that has none.
    const observation = board
      .filter(b => b.side === side && b.shadow && routeBlockedShorts.has(b.id))
      .filter(b => !outstandingShadowKeys.has(`${b.sym}:${b.side}`) && !outstandingObservationKeys.has(`${b.sym}:${b.side}`))
      .filter(b => !liveCalls.some(l => l.sym.toUpperCase() === b.sym.toUpperCase()))
      .sort((a, b) => Math.abs(b.composite) - Math.abs(a.composite))[0]
    if (observation) {
      emptySides[side] = 'no-route'
      observation.observation = true // the machine-readable stamp every containment surface reads
      observation.shadow = undefined
      observation.watchOnly = true
      observation.belowBase = undefined
      observation.riskPct = 0
      observation.instrument = null
      observation.paperOnly = false // a watch row is nobody's position
      observation.horizon = horizonOf({ watchOnly: true, stage: observation.stage, setup: observation.setup, evidence: observation.evidence })
      observation.note = `${observation.note} · no ISA route — observation only`
      // `thesis`/`falsifier` are deliberately NOT rewritten or cleared. This row
      // is a real, fully-graded composite call — the only thing wrong with it is
      // that an ISA cannot place it — so the belief it published with is still
      // exactly what the engine believes, and the level that would falsify it is
      // still that level. What it must never carry is an OFFER, and it carries
      // none: zero size, no instrument, watch-only, and the label above. (A near
      // miss is the opposite case and has neither field — it cleared no gate, so
      // there was never a belief to state.)
      observation.evidence = { ...observation.evidence, detail: `${observation.evidence.detail} · no ISA route — observation only` }
      liveCalls.push(observation)
      trace.revise(observation.sym, 'called-watch', {
        side,
        source: sources.get(observation.sym.toUpperCase())?.source,
        detail: 'promoted observation — cleared every gate, no ISA route',
      })
      console.log(`BOARD: ${observation.sym} cleared every gate with no ISA route — shown as an observation on the empty ${side} side`)
      continue
    }
    // No promotable observation — but "nothing cleared the gates" is still only
    // one of several ways a side empties, and it is the one that blames the gates.
    //   dip-lane / velocity-lane: the side HAD a live, routable, fully-graded short
    //             and the engine's own lane read on the same chart demoted it. The
    //             gates passed; the engine simply preferred its other lane on that
    //             name — and the copy names WHICH lane, because a breakout and a
    //             dip are not the same sentence to a reader.
    //   no-route: something cleared enough to be shown — a trade or a watch row —
    //             and an ISA cannot place it. (The promoted-observation branch
    //             above covers the sized ones; this covers the rest.)
    // Ordered so the stronger claim wins: a demoted short was live, where a
    // route-shadowed one never was.
    const demoter = board.find(b => b.side === side && laneDemotedShorts.has(b.id))
    emptySides[side] = demoter
      ? laneDemotedShorts.get(demoter.id) === 'velocity'
        ? 'velocity-lane'
        : 'dip-lane'
      : board.some(b => b.side === side && b.shadow && routeShadowedShorts.has(b.id))
        ? 'no-route'
        : 'gates'

    const candidates = nearMisses
      .filter(n => (n.core >= 0 ? 'long' : 'short') === side)
      .filter(n => !publishedKeys.has(`${n.sym.toUpperCase()}:${side}`))
      // ONE DIRECTION PER CHART, the same rule the observation promotion above
      // obeys. A name the reader can SEE a live long on — in practice a lane's,
      // since a name with a live composite row is never a near miss — must not
      // also be named as the closest thing to a short. A near miss cleared no
      // gate at all; putting it opposite a sized call on the same chart is the
      // board contradicting itself over a row that was never evidence [C10].
      .filter(n => !liveCalls.some(l => l.sym.toUpperCase() === n.sym.toUpperCase()))
      .sort((a, b) => Math.abs(b.core) - Math.abs(a.core))
      .slice(0, 2)
    for (const n of candidates) {
      const cohort = capCohortOf(n.capUsdM)
      const smallCap = n.capUsdM != null && n.capUsdM < SMALL_CAP_MAX_USD_M
      // the SAME arithmetic composeCall would have used (composite.ts) — a near
      // miss must never drift onto its own stop
      const { expectedMovePct, entry, stop, target } = levelsFor(n.core, n.capacityPct ?? 0, n.atrNow, n.lastClose, smallCap)
      const unroutable = side === 'short' && !routableShort(n.sym)
      const routeNote = unroutable ? ' · no ISA route — observation only' : ''
      const themes = themesOf(n.sym)
      nearMissRows.push({
        id: `${today}:${n.sym}:${side}`,
        date: today,
        sym: n.sym,
        side,
        composite: n.core,
        setup: setupFamilyOf(side, n.stage),
        modelVersion: ENGINE_MODEL_VERSION,
        regime,
        priceAtPrediction: entry,
        themes: themes.length ? themes : undefined,
        capUsdM: n.capUsdM,
        factors: Object.fromEntries(
          (Object.entries(n.factors) as [FactorName, FactorScore][]).map(([name, f]) => [name, { ...f, weight: weights.current[name] ?? 0 }]),
        ) as Record<FactorName, FactorScore & { weight: number }>,
        evidence: {
          coverage: 0,
          famAgree: 0,
          contract: false,
          contextPts: 0,
          detail: `core read ${n.core} — short of the gates (dead zone ${gates.deadZone}, needs ~${gates.minExpectedMovePct}% expected move before relaxations, entry timing); no evidence contract was ever assessed${routeNote}`,
        },
        expectedMovePct,
        entry,
        stop,
        target,
        capacityPct: n.capacityPct ?? 0,
        smallCap,
        earningsRisk: false, // earnings names are never recorded as near misses
        stage: n.stage,
        note: `nearest miss — the engine looked and said no; shown so the day is not blank${routeNote}`,
        // No `thesis` and no `falsifier`, on purpose: this row cleared no gate, so
        // there is no belief to state and its levels are a printed comparison
        // rather than a plan. Giving it the engine's voice would make the one row
        // that is NOT a call read exactly like the ones that are.
        // POOLED [§9]: a near miss cleared no gate, so the honest thing to print
        // beside it is the engine's own measured rate over what it does publish —
        // a probability question, not a grading one.
        probability: round2(engineBaseRate),
        provisional: true,
        grade: 'C',
        riskRung: cohortRungOf(risk, cohort),
        riskPct: 0,
        instrument: null,
        paperOnly: false,
        watchOnly: true,
        nearMiss: true,
        horizon: 'week',
      })
    }
  }
  if (nearMissRows.length) console.log('BOARD: nearest misses named —', nearMissRows.map(n => `${n.sym} ${n.side} ${n.composite}`).join(', '))
  // a promoted observation joins the ranking rather than trailing the array
  liveCalls.sort((a, b) => (a.watchOnly ? 1 : 0) - (b.watchOnly ? 1 : 0) || Math.abs(b.composite) - Math.abs(a.composite))

  const live = [...liveCalls, ...nearMissRows]
  const shadows = [...pickShadow('long', 5), ...pickShadow('short', 5)]
  const final = [...liveCalls, ...shadows] // the LEDGER — near misses are board-only

  // Company names ride the published rows so the board, ledger, open book and
  // paper all print "SOC — Sable Offshore" without their own enrichment pass.
  // cachedCompanyName reads the cap: blob the capUsdM lookups already warmed,
  // so this is near-free; a miss just leaves the row ticker-only.
  await mapLimit([...final, ...nearMissRows], 8, async p => {
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
    // additive + optional: why a side carries nothing tradeable, when one doesn't
    emptySides: Object.keys(emptySides).length ? emptySides : undefined,
    worldTape: { tone: tone.tone, votes: tone.votes, detail: tone.detail },
    newsTone: globalNews,
    // focus themes ranked by headline heat — identification for the UI, never a score
    themes: themeHeat(mediaTitles).filter(t => t.hits > 0).slice(0, 3),
  })

  // ---- the funnel's daily trace ----
  // Every candidate's fate, once a day, in one blob (shared/engine/funnelTrace.ts):
  // the gate that ended each name's run, the thresholds it was judged against, the
  // near-miss array verbatim and why each empty side is empty. Nothing reads it
  // back yet — it is the raw material 3b's miss ledger, 3c's gate accounting and
  // 3d's wildcard priority are all built on, and none of them can exist until the
  // engine stops discarding its own reasons.
  //
  // Written LAST and fail-soft, deliberately: the board, the ledger and every
  // other blob are already durable by the time this runs, so a trace that cannot
  // write costs the day's evidence and nothing the reader can see. (Same pattern
  // as the pattern sweep below and recordTrendDay above.)
  try {
    // EXACTLY ONCE, and the invariant is enforced here rather than assumed:
    // a name is either a row or a count, never both. `offered − sources` is not
    // quite the count, because the watchlist rides into the roster
    // unconditionally (roster.ts) — so a levMap route on the watchlist is refused
    // by addSource AND still scored, and it earns a row. Counting it as well
    // would book one name twice.
    let notCandidate = 0
    for (const sym of offered) if (!sources.has(sym) && trace.gateOf(sym) == null) notCandidate++
    trace.notCandidate(notCandidate)
    await store.write(funnelTraceKey(today), trace.build({ date: today, gates, nearMisses, emptySides }))
    const traceIndex = (await store.read<string[]>(FUNNEL_TRACE_INDEX_KEY)) ?? []
    if (!traceIndex.includes(today)) await store.write(FUNNEL_TRACE_INDEX_KEY, [...traceIndex, today].slice(-FUNNEL_TRACE_INDEX_MAX))
  } catch (e) {
    console.log('FUNNEL: trace write failed —', String(e).slice(0, 160))
  }

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
  // "re-qualified" means the engine would TAKE this trade again today — so only
  // rows that actually cleared the gates may grant it. A near miss cleared none;
  // counting it would tell the reader an open call was re-affirmed on the very
  // day the engine refused to make it. An observation cleared them all and still
  // isn't takeable — the engine would not place it today either, so it cannot
  // re-affirm a position the reader is holding.
  const todayLive = new Set(
    (board?.date === today ? board.board : []).filter(b => !b.nearMiss && !b.observation).map(b => `${b.sym}:${b.side}`),
  )
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
