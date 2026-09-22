import type { Candle, RegimeColor } from '../../../shared/types'
import type { AppStore } from './store'
import { validateConfig, type AppConfig } from '../../../shared/config'
import { atr, swingCapacity } from '../../../shared/indicators'
import { technicalStage, type Stage } from '../../../shared/technicals'
import { breadthAbove50, refineRegime, regimeFromCandles } from '../../../shared/setups'
import { seasonalitySummary } from '../../../shared/seasonality'
import {
  catalystFactor,
  channelsFactor,
  bandwidthFactor,
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
import {
  EARNINGS_FADE_MAX_PER_RUN,
  classifyEarningsFade,
  earningsFadeCall,
  earningsFadeDisabled,
  type EarningsFadeRead,
} from '../../../shared/engine/earningsFadeLane'
import { clusterCandidates, detectClusters, TREND_DAY_SYMS, TREND_HISTORY_DAYS, type TrendDay } from '../../../shared/engine/hypeCluster'
import type { DiscoveryCandidate, DiscoveryResult } from '../../../shared/engine/discovery/types'
import { DIP_CATALYST_KIND, EARNINGS_FADE_CATALYST_KIND, LANE_CATALYST_KINDS, VELOCITY_CATALYST_KIND, WILDCARD_CATALYST_KIND, type CatalystTag } from '../../../shared/engine/catalyst'
import { WILDCARD_SIZE_CAP, selectWildcard, wildcardDisabled } from '../../../shared/engine/wildcardLane'
import { wildcardThesis } from '../../../shared/engine/voice'
import { extractNewsCatalysts, type NewsCatalyst } from './newsCatalysts'
import type { NasdaqEarningsRow } from './nasdaqEarnings'
import { DIP_NEWS_BUDGET, unservedVenue, type DipNewsVerdict } from './dipNews'
import { annotatePostMortems, POSTMORTEM_LLM_MAX_TOKENS, type PostMortemAsk } from './postMortemLlm'
import { newsTone, worldMult, worldTone, VIX_SYMBOL, WORLD_SYMBOLS, type WorldRead } from '../../../shared/engine/worldTape'
import {
  baseHitRate,
  brierPoint,
  CALIB_DEF_VERSION,
  CALIBRATED_HORIZON_SESSIONS,
  calibratedOutcomeOf,
  emptyCalibration,
  gradeBaseRate,
  gradeFor,
  gradePrediction,
  ENGINE_MODEL_VERSION,
  migrateCalibration,
  maybeNudgeWeights,
  migrateWeights,
  probabilityFor,
  rebaseWeights,
  retireIcEvidence,
  retireIcOnModelBump,
  updateCalibration,
  updateIcStats,
  type CalibrationState,
  type WeightsState,
} from '../../../shared/engine/calibration'
import { pickDiverse } from '../../../shared/engine/select'
import { isCryptoSymbol } from '../../../shared/symbols'
import {
  CRYPTO_CALIB_KEY,
  CRYPTO_HORIZONS,
  CRYPTO_UNIVERSE,
  cryptoBaseHitRate,
  cryptoCandleMap,
  cryptoCandlesVia,
  cryptoGradeBaseRate,
  cryptoProbabilityFor,
  emptyCryptoCalibration,
  gradeCryptoPrediction,
  loadCryptoCalibration,
  updateCryptoCalibration,
  type CryptoCalibrationState,
} from '../../../shared/engine/cryptoCalibration'
import {
  CRYPTO_CHART_ONLY_DIRECTIVE,
  CRYPTO_REGIME_SYMBOL,
  CRYPTO_RISK_KEY,
  CRYPTO_TECH_WINDOWS,
  CRYPTO_WEIGHTS,
  cryptoCapacity,
  cryptoCombinedFor,
  cryptoDisabled,
  cryptoLaneOwns,
  cryptoMomentumFactor,
  cryptoRegimeFrom,
  cryptoSizeCap,
  cryptoTitleMatches,
  cryptoUniverseFor,
  cryptoVoice,
  initCryptoRisk,
  loadCryptoRisk,
} from '../../../shared/engine/cryptoLane'
import { FUNNEL_TRACE_INDEX_KEY, FUNNEL_TRACE_INDEX_MAX, funnelTraceKey, funnelTraceRecorder, type FunnelTrace } from '../../../shared/engine/funnelTrace'
import {
  MISS_LEDGER_KEY,
  accrueCausalOutcome,
  accrueMissDay,
  gateAttribution,
  maturedTraceDate,
  normaliseMissLedger,
  regretDisabled,
  type MissExample,
  type MissLedger,
} from '../../../shared/engine/missLedger'
import { GATE_STATE_KEY, advanceGateState, effectiveGates, gateEligibility, gateFeedbackDisabled, normaliseGateState } from '../../../shared/engine/gateState'
import { classifyOutcome, postMortemKey } from '../../../shared/engine/postMortem'
import { horizonOf } from '../../../shared/engine/horizon'
import { credibilityOf, gradeChannelStances, type ChannelCredState, type ExtractLike } from '../../../shared/engine/channelCred'
import { computeCohortRung, computeRung, cohortRungOf, initRisk, isRouteEtp, mapInstrument, migrateRisk, spotInstrument, RUNG_RISK_PCT, type CohortRung, type RiskState } from '../../../shared/engine/riskLadder'
import { capCohortOf, SMALL_CAP_MAX_USD_M, type CapCohortOrUnknown } from '../../../shared/engine/capClass'
import { avgDollarVol20, ROSTER_MAX, updateRoster, type RosterCandidate, type RosterEntry } from '../../../shared/engine/roster'
import type { T212Position } from './t212lib'
import { isRejection, round2, type EmptySideReason, type EngineCall, type FactorName, type FactorScore, type PredOutcome, type Prediction } from '../../../shared/engine/types'
import type { OutcomeLite } from '../../../shared/engine/riskLadder'
import { primaryThemeOf, themeCandidates, themeHeat, themesOf } from '../../../shared/engine/themes'
import { traceOpenCall, type OpenTraceEntry } from '../../../shared/engine/openTrace'
import { appendSocialHistory, buildEngineLab, calibrateLabObservations, gradeStrategyObservation, qualityDipObservations, shortHorizonObservations, socialIgnitionObservations, type ShortHorizonRow, type SocialHistoryPoint, type SocialLabRow, type StrategyLabRecord } from '../../../shared/engine/strategyLab'
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
  // THE DATED CALENDAR WITH ITS NUMBERS ON IT — the same nasdaq.com snapshot the
  // two deps above are now served from, handed over whole: the print date, which
  // SIDE of the session it landed on (`pre`/`post`, knowable only from a forward
  // read — nasdaqEarnings.ts explains why), the reported EPS and the % surprise.
  // Read by the earnings-fade lane, which needs all three to find the reaction
  // bar and to know whether the print was a beat.
  //
  // OPTIONAL, and that is the fail-soft — the same shape `postMortemSentence` and
  // `discovery` use. Absent (every existing fixture, a replay, a host with no
  // store) means the lane simply never runs and not one other line of the board
  // changes. A rejecting dep is the same thing: the lane treats it as an empty
  // calendar and publishes nothing.
  earningsEvents?: () => Promise<NasdaqEarningsRow[]>
  // overnight world tape: latest daily % change for the Asia/Europe indices, US
  // futures and VIX (^VIX carried in the same list, split out in buildBoard).
  // Fail-soft: any read the source can't supply is null — a vote it cannot cast.
  worldReads: () => Promise<WorldRead[]>
  // the reader's REAL Trading 212 book, or null when T212 is unconfigured / down.
  // Fail-soft: a broker outage must never stop the board building.
  holdings: () => Promise<T212Position[] | null>
  // ONE plain sentence explaining a sized loser, for at most
  // POSTMORTEM_LLM_BUDGET of them per grading run (postMortemLlm.ts).
  // OPTIONAL, and that is the fail-soft: absent — a replay, a test, a
  // deployment with no LLM key — means the deterministic post-mortem line
  // stands alone and not one prediction row is touched. Nothing published
  // reads it either way.
  postMortemSentence?: (prompt: string) => Promise<string>
  // THE SCAN (discovery engine v2 — docs/superpowers/specs/2026-09-22-discovery-engine-v2-design.md).
  // Every other door above SAMPLES the market: today's top-50 movers, 130 famous
  // names, whatever the crowd happened to be naming. This one reads a persistent
  // universe end to end and hands back the names its lenses fired on, with the
  // bars it already paid for so nothing is fetched twice.
  //
  // OPTIONAL, and that is the fail-soft — the same shape postMortemSentence uses.
  // Absent (every existing fixture, a replay, `DISCOVERY=off`) means the legacy
  // inflow stands alone and not one line of the run below changes. A null answer
  // means the same thing for a run where the stage was wired but declined.
  discovery?: (input: {
    date: string
    /** every name a door has already offered today, so the universe can learn who else named it */
    nominations: { sym: string; origin: string; capBand?: 'large' | 'mid' | 'small'; sector?: string; exchange?: 'US' | 'LSE' }[]
    spy: Candle[] | null
    isEtp: (sym: string) => boolean
  }) => Promise<DiscoveryResult | null>
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

export function defaultDeps(
  env: { FINNHUB_API_KEY?: string; T212_API_KEY?: string; T212_SECRET_KEY?: string; T212_HOST?: string; DISCOVERY?: string },
  // The scan's bar cache lives in the store, and deps are built before buildBoard
  // is handed one — so the store arrives the way env does, through the closure.
  // Optional: absent, the discovery dep reaches for the live store the handlers
  // already share (storeProvider), which is what predict-background passes anyway.
  store?: AppStore,
): EngineDeps {
  // THE EARNINGS CALENDAR, KEY-FIRST NO LONGER (2026-09-22).
  //
  // Every earnings fact the engine owns used to come from ONE Finnhub call, and
  // this deployment's Finnhub account refuses roughly 78% of them — so the fact
  // the whole `earningsRisk` rule stands on was arriving intermittently and
  // failing SILENTLY (the catch below returns [], which reads exactly like "no
  // name reports this fortnight"). nasdaq.com's own calendar is free, key-less
  // and has answered 200 on every probe (nasdaqEarnings.ts). So:
  //
  //   PRIMARY   the nasdaq snapshot — ten forward dates a run, cached ~6h each,
  //             merged into one durable blob that keeps the session timing a
  //             forward read is the only source of. Sliced to the same 14-day
  //             window the Finnhub call used, so `earningsRisk` is judged over
  //             exactly the horizon it always was.
  //   SUPPLEMENT Finnhub, and only when a key exists AND the call actually
  //             succeeds: names it knows about that the snapshot does not are
  //             ADDED. It can no longer remove or overwrite anything, which is
  //             what makes a 78% refusal rate harmless instead of invisible.
  //
  // Both deps below still share ONE memoised fetch per run, and the log line
  // names which source served how much — a calendar that quietly went empty is
  // the failure this whole change exists to end.
  let nasdaqOnce: Promise<NasdaqEarningsRow[]> | null = null
  const fetchNasdaqCalendar = () => {
    if (!nasdaqOnce)
      nasdaqOnce = (async () => {
        try {
          const { snapshotEarningsCalendar } = await import('./nasdaqEarnings')
          // deps are built before buildBoard is handed a store, so it arrives
          // through the closure exactly as it does for `discovery`; absent, the
          // live store the handlers already share.
          const target = store ?? (await import('./storeProvider')).appStore
          const rows = await snapshotEarningsCalendar(target, new Date().toISOString().slice(0, 10))
          return rows
        } catch (e) {
          console.log('EARNINGS: nasdaq snapshot failed —', String(e).slice(0, 160))
          return []
        }
      })()
    return nasdaqOnce
  }

  let earningsOnce: Promise<{ sym: string; date: string; hour?: string }[]> | null = null
  const fetchEarnings = () => {
    if (!earningsOnce)
      earningsOnce = (async () => {
        const todayISO = new Date().toISOString().slice(0, 10)
        const { upcomingEarnings } = await import('./nasdaqEarnings')
        // `hour` is Finnhub's vocabulary and the event radar prints it, so the
        // snapshot's own `time` is translated into it rather than the radar
        // learning a second spelling of one fact.
        const primary = upcomingEarnings(await fetchNasdaqCalendar(), todayISO, 14).map(r => ({
          sym: r.sym,
          date: r.date,
          hour: r.time === 'pre' ? 'bmo' : r.time === 'post' ? 'amc' : undefined,
        }))
        const bySym = new Map(primary.map(e => [e.sym.toUpperCase(), e]))
        let added = 0
        if (env.FINNHUB_API_KEY) {
          try {
            const to = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)
            const res = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${todayISO}&to=${to}&token=${env.FINNHUB_API_KEY}`)
            if (res.ok) {
              const j = (await res.json()) as { earningsCalendar?: { symbol?: string; date?: string; hour?: string }[] }
              for (const e of j.earningsCalendar ?? []) {
                const sym = (e.symbol ?? '').trim().toUpperCase()
                if (!sym || bySym.has(sym)) continue
                bySym.set(sym, { sym: e.symbol as string, date: e.date ?? '', hour: e.hour || undefined })
                added++
              }
            }
          } catch {
            /* the supplement is a supplement: a refusal costs nothing now */
          }
        }
        console.log(`EARNINGS: calendar — nasdaq ${primary.length} rows in the next 14d, finnhub added ${added}`)
        return [...bySym.values()]
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
    // The paper's one sentence per sized loser (postMortemLlm.ts). Non-strict,
    // like every other LLM dep here: whatever provider the deployment has
    // answers, and a deployment with none simply throws on the first ask and
    // stands the pass down for the run.
    postMortemSentence: async prompt => {
      const { callLlm } = await import('./llm')
      return (await callLlm(prompt, { maxTokens: POSTMORTEM_LLM_MAX_TOKENS })).text
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
    // all three derive from the same memoised snapshot above — one set of HTTP
    // calls, three shapes
    earningsSyms: async () => new Set((await fetchEarnings()).map(e => e.sym)),
    earningsCalendar: () => fetchEarnings(),
    // the WHOLE snapshot, past prints included: the fade lane reads dates that
    // have already happened (that is where `eps` and `surprise` live), so it
    // must not be handed the forward-only slice the two deps above take.
    earningsEvents: () => fetchNasdaqCalendar(),
    // The universe scan (discovery.ts). `DISCOVERY=off` kills the stage before a
    // single bar is fetched and the legacy inflow runs exactly as it did.
    // Fail-soft is total and deliberate — a module that is not there yet, a seed
    // that will not load, a blown wall-clock budget, a store that refuses — all
    // land here as a logged null, because the scan is INFLOW: an engine that
    // cannot see MORE this morning must still see everything it always saw.
    discovery: async input => {
      try {
        const { runDiscovery, discoveryDisabled, discoveryAllowedOnHost } = await import('./discovery')
        // the lever, read from the caller's bag FIRST and the process second: on
        // Netlify and in the Worker it arrives as a plain env var, and a bag that
        // simply doesn't carry the key must not be read as "the lever is off".
        const lever = env.DISCOVERY ?? (typeof process !== 'undefined' ? process.env?.DISCOVERY : undefined)
        if (discoveryDisabled({ DISCOVERY: lever })) return null
        // HOST GATE. The cron Worker dispatches this run into Pages Functions,
        // and a Cloudflare invocation may make FIFTY subrequests. A ~1,866-name
        // scan would not just fail there: it would burn the budget the rest of
        // the run needs, so the paper would break at the quotes and the news
        // rather than at the scan. Actions and Netlify are Node and uncapped.
        // `runtimeHost()` is the repo's existing host seam (runtimeEnv.ts) —
        // reused rather than re-sniffed, because two answers to "where am I" is
        // one too many.
        const { runtimeHost } = await import('./runtimeEnv')
        if (!discoveryAllowedOnHost({ DISCOVERY: lever }, runtimeHost() !== 'workers')) {
          console.log('DISCOVERY: skipped — host subrequest budget')
          return null
        }
        const { loadUniverseSeed } = await import('../../../shared/engine/discovery/universeSeed')
        const { appStore } = await import('./storeProvider')
        return await runDiscovery({ ...input, store: store ?? appStore, seed: loadUniverseSeed() })
      } catch (e) {
        console.log('DISCOVERY: failed —', String(e).slice(0, 200))
        return null
      }
    },
  }
}

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T

/** ONCE PER PROCESS, not once per load. The seed refusal is a fact about the
 * COMMITTED ARTEFACT — in production it cannot change while the process lives —
 * and `loadState` runs on every board build AND every grading pass, so the line
 * printed several times a run, burying the lines that describe what the run
 * actually did.
 *
 * Keyed by the refused artefact (`defVersion:generation`) rather than a bare
 * boolean, which is once-per-process for the one seed a deployed process can
 * ever see, and still says something on the only occasion a second key can
 * arise: a DIFFERENT artefact being refused. A silent second refusal would be
 * the one case where the flag cost information rather than noise. */
const seedRefusalsLogged = new Set<string>()

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
  // THE DEFINITION SWAP. The outcome definition changed → stored buckets counted
  // a different thing and their hit rates aren't probabilities anymore. They are
  // RETIRED, never merged, and the only question is what stands in their place.
  //
  //  · A seed ON THE CURRENT DEFINITION replaces them, exactly as it always has —
  //    and never a stale one: live state is not regressed to a seed measuring an
  //    outcome the engine has already moved past.
  //  · NO SUCH SEED AND THE ENGINE GOES COLD: EMPTY buckets on the new
  //    definition — every read pools to the base rate, every published row grades
  //    C — until a regenerated seed lands. That was the v4 (10→21 session) state
  //    for as long as the committed artefact still said `defVersion: 3`, and it is
  //    what the NEXT definition change will land in. Carrying the old buckets
  //    forward to avoid an all-C board would price the reader's money off a hit
  //    definition nobody is being scored on, which is the one thing this version
  //    gate exists to prevent.
  //
  // The FACTOR IC goes with them (`retireIcEvidence`): every column in the weights
  // blob is a sum of `outcome.excessPct` measured under the retired definition, so
  // feeding it to the nudge loop would let the old yardstick steer the new one. The
  // ratified weight vector itself is kept — that is `rebaseWeights`'s decision, on
  // its own trigger, and a horizon change may not smuggle a model change through.
  if (calibration.defVersion !== CALIB_DEF_VERSION) {
    const from = calibration.defVersion ?? 1
    const buckets = Object.keys(calibration.buckets ?? {}).length
    const setups = Object.keys(calibration.setupBuckets ?? {}).length
    const brierN = calibration.brier?.length ?? 0
    const live = calibration.evidence?.live?.n ?? 0
    if (seedCal.defVersion === CALIB_DEF_VERSION) {
      calibration = clone(seedCal)
      console.log(
        `CALIBRATION: outcome definition v${from} → v${CALIB_DEF_VERSION} — RETIRED ${buckets} bucket(s), ${setups} setup bucket(s) ` +
          `and ${brierN} Brier point(s) (${live} live rows); reseeded from the committed generation ${seedCal.seedGeneration ?? 1} seed`,
      )
    } else {
      calibration = emptyCalibration()
      console.log(
        `CALIBRATION: outcome definition v${from} → v${CALIB_DEF_VERSION} — RETIRED ${buckets} bucket(s), ${setups} setup bucket(s) ` +
          `and ${brierN} Brier point(s) (${live} live rows). The committed seed is v${seedCal.defVersion ?? 1} and CANNOT install, so the ` +
          `engine runs on EMPTY v${CALIB_DEF_VERSION} buckets — everything pools to the base rate and every row grades C — until a ` +
          `v${CALIB_DEF_VERSION} seed lands`,
      )
    }
    weightsBlob = retireIcEvidence(weightsBlob, today, `calibration outcome definition v${from} → v${CALIB_DEF_VERSION}`)
  }
  // A regenerated seed at the SAME outcome definition announces itself by
  // generation. The stored blob wins forever otherwise — that is correct for
  // live accrual, but it means a better seed could never land (stage 2b).
  // On swap the stored blob is REPLACED, not merged: "do not mix a regenerated
  // seed with the committed one — regenerate whole" (backtest.ts header).
  // Both halves are gated on the SEED's defVersion for the same reason the swap
  // above is: an artefact measuring a different hit must not install, however
  // loudly it announces itself.
  //
  // …AND THE REFUSAL IS THE LOUD HALF OF IT. The generation-4 `seed.json` announced
  // generation 4 on `defVersion: 3`: it out-ranked anything a cold v4 state carried
  // and would have installed on the spot if generation were the only test. It was
  // refused, and the refusal logged, because a generation says which WALK measured
  // the buckets and a defVersion says WHAT it measured — an artefact that measured
  // the wrong thing does not become right by being newer. The committed seed is
  // generation 5 on defVersion 4 now and does install; the gate stays, for the next
  // horizon move.
  const seedInstallable = seedCal.defVersion === CALIB_DEF_VERSION
  const storedGen = calibration.seedGeneration ?? 1
  const seedGen = seedCal.seedGeneration ?? 1
  if (seedInstallable && seedGen > storedGen) {
    console.log(
      `CALIBRATION: seed generation ${storedGen} → ${seedGen} — replacing ` +
        `${calibration.evidence?.live?.n ?? 0} live rows with the deeper seed ` +
          `(those inside its window are re-measured by the walk; later rows re-accrue from here — every grade stands in the ledger either way)`,
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
  // …and when it is NOT installable, say so once rather than leaving a production
  // runlog silent about a seed that is sitting there and will never land. ONCE is
  // literal (`seedRefusalLogged`): the artefact cannot become installable while
  // the process runs, so repeating it on every load is noise, not information.
  const refusalKey = `${seedCal.defVersion ?? 1}:${seedGen}`
  if (!seedInstallable && !seedRefusalsLogged.has(refusalKey)) {
    seedRefusalsLogged.add(refusalKey)
    console.log(
      `CALIBRATION: the committed seed (generation ${seedGen}, defVersion ${seedCal.defVersion ?? 1}) is REFUSED — it measures outcome ` +
        `definition v${seedCal.defVersion ?? 1} and the engine grades v${CALIB_DEF_VERSION}. Regenerate the seed at the current horizon.`,
    )
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
  // migrateWeights also holds the [0.5×, 1.5×] band on `current` — the invariant
  // used to be enforced only by the nudge loop, so a stored out-of-band vector
  // scored real boards until fifteen more predictions matured. It takes `today`
  // for the same reason rebaseWeights does: a history entry dated by the run.
  //
  // …AND `retireIcOnModelBump` SITS BETWEEN THEM, because neither of the other two
  // can do its job. The comment on ENGINE_MODEL_VERSION used to claim rebaseWeights
  // caught a model change by spotting a key the stored base lacked — but
  // migrateWeights has already backfilled that key by the time it looks, so the
  // fingerprint matches and it returns untouched. A four-core IC would have gone on
  // steering a five-core model. The stamp is the only channel that can tell the two
  // epochs apart; an absent one is backfilled rather than retired, so a seed
  // installing its measured IC is never stripped on the way in.
  const weights = rebaseWeights(retireIcOnModelBump(migrateWeights(weightsBlob, DEFAULT_WEIGHTS, today), today), DEFAULT_WEIGHTS, today)
  calibration = migrateCalibration(calibration)
  const channelCred = (await store.read<ChannelCredState>('channel-credibility')) ?? {}
  return { weights, calibration, channelCred }
}

/** THE CRYPTO PARTITION'S OWN TWO BLOBS (Stage 1c Phase B), read exactly the way
 * `loadState` reads the equity pair one function up — two keys, two reads, two
 * writes. Nothing here opens `seed.json`: the committed seed was swept over an
 * equity universe with crypto explicitly filtered out, so it is not evidence
 * about a coin, and the crypto partition's honest cold start is EMPTY (B1,
 * `emptyCryptoCalibration`).
 *
 * Both loaders refuse a blob they cannot trust rather than patching it: the
 * calibration goes cold without its `basis` brand (an equity blob written under
 * this key would otherwise hand the partition 8,500 SPY-benchmarked rows), and
 * the ladder goes cold on a malformed rung (permission to size is never
 * recovered from a broken record). */
async function loadCryptoState(store: AppStore, today: string): Promise<{ cal: CryptoCalibrationState; risk: CohortRung }> {
  return {
    cal: loadCryptoCalibration(await store.read<CalibrationState>(CRYPTO_CALIB_KEY)),
    risk: loadCryptoRisk(await store.read<CohortRung>(CRYPTO_RISK_KEY), today),
  }
}

/** IS THE CALIBRATION GETTING BETTER? — the precondition every rung promotion
 * carries (riskLadder.ts). Lifted out of the equity pass verbatim so the crypto
 * ladder can ask the same question of its OWN trail: two ladders reading one
 * rule, rather than one rule written twice and drifting. Ten points before it
 * can say no, so a young trail never blocks a promotion on absence of evidence. */
const brierImprovingOf = (b: { mean: number }[]): boolean =>
  b.length >= 10 ? b.slice(-5).reduce((s, x) => s + x.mean, 0) / 5 <= b.slice(-10, -5).reduce((s, x) => s + x.mean, 0) / 5 : true

/** TWO OF THE FIVE SHADOW SLOTS A SIDE ARE RESERVED FOR THE LANES, and the
 * reservation is what makes the lanes reachable at all.
 *
 * The shadow budget was a plain `|composite|` sort, and it is the LAST filter of
 * the run — so the five loudest composites on a side took every slot. A lane row
 * cannot compete on that axis by construction: the earnings-fade, dip, velocity
 * and wildcard lanes build their own calls off their own triggers and land at
 * |25..55|, against a screener-topping composite in the 70s and 80s. The result
 * was a budget that spent itself on the ordinary board every morning while the
 * lanes — which exist precisely to collect evidence the ordinary board cannot —
 * published nothing and therefore learned nothing. A lane that can never be
 * sampled is a lane that can never be measured, and the earnings-fade lane in
 * particular is shadow-only by ruling: the budget IS its entire route to the
 * ledger.
 *
 * TWO, not five: the reservation must not become the budget. Three slots a side
 * stay open to whatever the board ranks highest — including a lane row, if it
 * happens to rank there — so the ordinary population keeps supplying the bulk of
 * the calibration evidence and the lanes are guaranteed a hearing rather than a
 * majority. Lane rows compete among THEMSELVES on |composite| for the two, and an
 * absent lane costs nothing: an unfilled reserved slot falls straight through to
 * the ordinary ranking, so a day with no lane rows picks exactly what it always
 * did.
 *
 * Pure and exported because it is a RULE about a budget, and the rule is what the
 * tests are about. Dedup, side and shadow filtering all happen at the caller. */
export const LANE_SHADOW_RESERVE = 2

export function pickShadowSide<T extends { id: string; composite: number; catalyst?: { kind: string } }>(eligible: T[], cap: number): T[] {
  if (cap <= 0) return []
  const byConviction = (a: T, b: T) => Math.abs(b.composite) - Math.abs(a.composite)
  const reserved = eligible
    .filter(b => LANE_CATALYST_KINDS.has(b.catalyst?.kind ?? ''))
    .sort(byConviction)
    .slice(0, Math.min(LANE_SHADOW_RESERVE, cap))
  const taken = new Set(reserved.map(b => b.id))
  return [...reserved, ...eligible.filter(b => !taken.has(b.id)).sort(byConviction)].slice(0, cap)
}

const mapLimit = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = []
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))))
  }
  return out
}

// ---- step 0: grade what matured, update every learning store ----

/** THE MISS LEDGER'S HOOK (shared/engine/missLedger.ts owns every rule).
 *
 * Ten sessions after a run, that run's refusals have an answer. This reads the
 * trace day that just matured and charges what each not-called name went on to
 * do to the gate that refused it. It PUBLISHES NOTHING: `miss-ledger` is read by
 * no board, no paper, no calibration and no grade — Stage 3c is what eventually
 * consumes it, and it needs weeks of this measured before it may move a gate.
 *
 * Exactly ONE day per pass, and always the NEWEST matured one:
 *  - the blob is ADDITIVE, so a day accrued twice would double-charge its gates.
 *    `days[date]` is the guard, and it is why the engine may run ten times in an
 *    afternoon without inflating the ledger.
 *  - working the newest rather than catching up from the oldest bounds the cost
 *    at one day's fetch budget forever, and keeps the 60-day prune safe: a day
 *    old enough to be pruned can never be selected again. The honest cost is that
 *    a day the engine was down for is never measured — an absence, not a zero,
 *    and one nothing downstream mistakes for evidence.
 *
 * Fail-soft is the caller's job (see the try/catch at the call site): every
 * learning blob is already durable by the time this runs, so a failure here costs
 * the day's regret measurement and nothing else. */
async function accrueMissLedger(store: AppStore, spy: Candle[], cache: Map<string, Candle[] | null>, getCandles: (sym: string) => Promise<Candle[] | null>): Promise<void> {
  // the parity seam (missLedger.ts) — `REGRET=off` makes this pass a no-op, the
  // way the pre-3b tree was, so a window walk can prove the two runs publish the
  // same rows. Never set in production.
  if (regretDisabled()) return
  const index = (await store.read<string[]>(FUNNEL_TRACE_INDEX_KEY)) ?? []
  const date = maturedTraceDate(index, spy)
  if (!date) return
  const ledger = normaliseMissLedger(await store.read<MissLedger>(MISS_LEDGER_KEY))
  if (ledger.days[date]) return
  const trace = await store.read<FunnelTrace>(funnelTraceKey(date))
  // A tombstone (`disabled`) is a day the recorder was stubbed off: no data, and
  // emphatically not a day the engine refused nothing. accrueMissDay refuses it
  // too; it is checked here as well so no `days` entry is minted for it either.
  if (!trace || trace.disabled) return
  // The selection key and the accrual key must be ONE value: a trace whose own
  // `date` field disagrees with the index key would file the day under the
  // wrong entry, the guard above would never see it, and every later run would
  // re-charge the same day forever (Task-1 review, Important 3). Stored blobs
  // are untrusted; refuse the mismatch outright.
  if (trace.date !== date) {
    console.error(`MISS-LEDGER: trace at ${date} claims to be ${trace.date} — refusing the day`)
    return
  }
  const next = await accrueMissDay(ledger, trace, spy, { isFree: sym => cache.has(sym), candles: getCandles })
  await store.write(MISS_LEDGER_KEY, next)
  console.log(`MISS-LEDGER: ${date} — ${next.days[date].checked} checked, ${next.days[date].unchecked} unchecked, ${next.days[date].misses} misses`)
}

/** THE ONE ROW A DAY THAT IS THE EXPERIMENT (shared/engine/wildcardLane.ts).
 * A row published BECAUSE a gate refused it carries the gate it overrode on
 * itself, stamped at publication; this is the only test anything in the grading
 * pass makes about one. The catalyst kind is the discriminator rather than the
 * `wildcard` block, because the kind is what the ladder and the factor-IC
 * exclusions key off too, and one answer to "is this the experiment?" is worth
 * more than three that could drift. */
const isWildcardRow = (p: Prediction): boolean => p.catalyst?.kind === WILDCARD_CATALYST_KIND

/** THE CAUSAL WRITE-BACK (Stage 3d).
 *
 * A wildcard graded today is the one thing this engine can produce that a
 * refusal never can: a real, sided, STOPPED outcome on a trade a named gate
 * turned down. It is charged to that gate — the one stored on the row when the
 * choice was made, never re-derived, because the trace row it came from was
 * overwritten by the publication itself and there is nothing left to re-derive
 * from.
 *
 * It runs BEFORE the miss accrual and therefore before the gate feedback that
 * follows both, on purpose: `accrueCausalOutcome` books into `sidedCost` /
 * `sidedSaved`, which is what eligibility reads, so a causal outcome reaches the
 * feedback loop on the day it grades rather than waiting a further calibrated
 * horizon for a miss population to mature behind it (the plan's "no lag" clause,
 * and worth more now that the horizon is 21 sessions). Each
 * hook re-reads the blob for itself, so the two writes cannot clobber one
 * another.
 *
 * The parity seam is `REGRET=off` (missLedger.ts) exactly as for the ledger it
 * writes into — the caller checks it — and `WILDCARD=off` cannot reach here at
 * all, because with the lane silent no row was ever stamped.
 *
 * IDEMPOTENCE IS THE CALLER'S, deliberately: this function books exactly what it
 * is handed, and `wildcard.booked` on the row (types.ts) is the receipt that
 * decides what that is. Putting the check here would mean re-reading and
 * re-writing the prediction blobs from inside the ledger hook — two records of
 * one fact, in the one place a throw is expected. */
async function bookCausalOutcomes(store: AppStore, events: (MissExample & { hit: boolean })[]): Promise<void> {
  if (!events.length) return
  const ledger = normaliseMissLedger(await store.read<MissLedger>(MISS_LEDGER_KEY))
  for (const ev of events) accrueCausalOutcome(ledger, ev)
  await store.write(MISS_LEDGER_KEY, ledger)
  for (const ev of events)
    console.log(`WILDCARD: ${ev.sym} ${ev.side} graded ${ev.hit ? 'HIT' : 'miss'} at ${ev.excessPct}pp — causal evidence charged to ${ev.gate}`)
}

/** THE GATE FEEDBACK HOOK (shared/engine/gateState.ts owns every rule).
 *
 * The one place in the engine where a threshold the reader's calls are judged
 * against can change. It runs LAST, after the miss ledger has booked the day it
 * just measured, so a gate is always judged on the freshest evidence — and it
 * writes only when something actually happened: a notch, or the first time a
 * gate earned one and could not have it.
 *
 * `predictions-index` is the session clock. Calendar days would count the
 * mornings the engine never ran, and the cadence rule is about how much evidence
 * has passed under a gate, not how much time. The INDEX travels, not its length:
 * the list is capped at 250 entries, so a length-based clock stopped ticking the
 * day it saturated (gateState.ts, `sessionsSince`).
 *
 * Fail-soft is the caller's job (the same try/catch the miss ledger rides in):
 * every learning blob is durable by now, so a failure here costs a notch and
 * nothing else — and the board reads whatever `gate-state` last said. */
async function advanceGates(store: AppStore, cfg: AppConfig | null | undefined, sessionIndex: readonly string[], today: string): Promise<void> {
  if (gateFeedbackDisabled()) return
  const state = normaliseGateState(await store.read(GATE_STATE_KEY))
  const eligibility = gateEligibility(gateAttribution(await store.read(MISS_LEDGER_KEY)))
  const { state: next, moves, notes } = advanceGateState(state, eligibility, sessionIndex, {
    date: today,
    appetite: cfg?.riskAppetite,
    overrides: cfg?.gateOverride,
  })
  // WROTE ONLY ON A REAL CHANGE — and the test is the STATE, not the event list:
  // an advance that drops a stale "eligible and held" note produces neither a move
  // nor a note, and a blob left holding that note would keep announcing it. An
  // untouched state serialises identically and costs the run nothing.
  if (JSON.stringify(next) === JSON.stringify(state)) return
  await store.write(GATE_STATE_KEY, next)
  // ONE sentence per event, and the same sentence the panel and the paper print.
  for (const m of moves) console.log(`GATE: ${m.line}`)
  for (const n of notes) console.log(`GATE: ${n.line}`)
}

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
  // ---- PHASE-A RELAXATION 1 of 3: THE CRYPTO PARTITION GRADES ITSELF ----
  // Phase A grades a crypto row against SPY and lets it teach nothing (the
  // containment: "watched, never graded against a market it doesn't trade in").
  // That stays true for every LEGACY crypto row — the ones already in the ledger,
  // struck on a clock the asset does not keep. What is relaxed here, and only
  // here, is the row the CRYPTO LANE published and stamped `cohort: 'crypto'`:
  // it grades on the crypto basis (absolute, 14 crypto bars, entry at the first
  // bar opening after the call, stop exposure from the publication bar) and
  // accrues into the crypto blob. The equity skips below are untouched — a
  // crypto row still teaches the equity calibration, the factor IC, the Brier
  // trail, the rung streams, the panes and the gate ledger exactly nothing.
  //
  // The seam is `cryptoCandlesVia` (B1): completed bars only, so a run at 06:00
  // and a run at 23:59 grade the identical series and nothing is ever measured
  // against a bar that is still moving. It wraps the CACHED fetcher, so the crypto
  // path costs no extra call.
  const cryptoCandlesOf = cryptoCandlesVia(getCandles, nowSec)
  const cryptoBarCache = new Map<string, Candle[] | null>()
  const getCryptoCandles = async (sym: string) => {
    if (!cryptoBarCache.has(sym)) cryptoBarCache.set(sym, await cryptoCandlesOf(sym))
    return cryptoBarCache.get(sym) ?? null
  }
  const cryptoOff = cryptoDisabled()
  // Under CRYPTO=off nothing accrues and nothing writes back (`cryptoMoved`
  // stays false), so the two blob reads would be pure cost — cold objects are
  // observationally identical here, and the lever keeps the store footprint at
  // its Phase-A shape too.
  const { cal: cryptoCal, risk: cryptoRisk } = cryptoOff
    ? { cal: emptyCryptoCalibration(), risk: initCryptoRisk(today) }
    : await loadCryptoState(store, today)
  /** Every crypto-lane row whose 14-bar grade landed in THIS pass — the crypto
   * partition's own `newlyGraded`, feeding its own Brier trail. There is no
   * wildcard column: the experiment slot refuses crypto outright
   * (`wildcardLane.ts`), and that exclusion is a Phase-A guard that STAYS. */
  const cryptoGraded: { probability: number; outcome?: PredOutcome; shadow: boolean }[] = []
  /** …and the crypto ladder's own evidence window and its own newly-graded
   * count, the exact shape `allOutcomes` / `newByCohort` have for equities. */
  const cryptoOutcomes: OutcomeLite[] = []
  let cryptoNewActionable = 0

  let graded = 0
  // per-cohort tally of NON-shadow calls graded THIS run — feeds each sleeve's
  // graded-at-rung counter so it stays honest even while a young cohort pools.
  const newByCohort: Record<CapCohortOrUnknown, number> = { large: 0, small: 0, unknown: 0 }
  // EVERY ROW GRADED THIS RUN, tagged rather than pre-filtered.
  //
  // `wildcard` rides along instead of the experiment being dropped at the push,
  // so this array keeps meaning exactly what its name says and each consumer
  // states its own policy at its own site. A pre-filtered array named
  // `newlyGraded` would hand a future consumer an incomplete population that
  // looks complete — the silence this whole stage exists to end.
  //
  // TODAY IT HAS EXACTLY TWO CONSUMERS, and both EXCLUDE the experiment:
  //
  //  · the BRIER TRAIL (`brierPoint`, below) — a wildcard is the engine
  //    deliberately overriding its own no. Its probability is not a forecast the
  //    engine stood behind, so scoring it would measure the calibration of a
  //    belief nobody held — and the trail is not display: `brierImproving` is a
  //    precondition of every rung promotion (riskLadder.ts), so one experiment a
  //    week would help set the size of every ordinary call.
  //  · the LIFETIME counters (the scorecard, below) — the Ledger's never-resets
  //    headline answer to "is this tool accurate?". Same argument, one horizon
  //    longer.
  //
  // Both are readings of the engine's SKILL, which is precisely what a refused
  // trade taken on purpose is not evidence of. What the wildcard DOES still move
  // is everything that is a record of an outcome rather than of skill:
  // `updateCalibration` (it was the reader's money at a real size),
  // `graded`/`predictions-pending` (it graded), the per-row ledger, and the
  // causal column of the miss ledger, which is the whole reason it was bought.
  const newlyGraded: { probability: number; outcome?: PredOutcome; shadow: boolean; wildcard: boolean }[] = []
  // each non-shadow outcome carries its cohort so the risk ladder can split large
  // vs small; unknown-cap calls stay in the combined stream but neither sleeve.
  const allOutcomes: (OutcomeLite & { cohort: CapCohortOrUnknown })[] = []
  const stillPending: string[] = []
  // THE SIZED LOSERS THIS RUN — the only rows the budgeted sentence is spent on
  // (postMortemLlm.ts). `riskPct > 0` is the engine's own definition of a row
  // the reader could act on: shadows, watch rows and cut rows are all set to 0
  // at the single sizing site, so this needs no second test for them.
  const sentenceAsks: { date: string; pred: Prediction }[] = []
  // THE WILDCARD OUTCOMES THE LEDGER IS OWED — one causal outcome each, charged
  // to the gate each one overrode once every grade in this pass is durable.
  // Collected rather than written inline for the reason every other ledger write
  // in this pass is: a blob failure must never sit between a grade and its
  // store.write.
  //
  // NOT "the wildcards that closed this run": the population is every wildcard
  // whose row says `wildcard.booked === false` — the receipt written with the
  // grade (types.ts). Most passes that is exactly the ones that just graded; on
  // the pass after a ledger failure it is also the one that graded last time and
  // never reached the blob. The `pred` reference travels so the receipt can be
  // stamped `true` once the write returns.
  const causalOutcomes: { ev: MissExample & { hit: boolean }; pred: Prediction; date: string }[] = []
  // Reuse the records graded in this invocation when building the scorecard.
  // Netlify Blobs can briefly return the pre-write version after a write, which
  // otherwise makes a successful grading run publish an empty scorecard.
  const predictionsByDate = new Map<string, Prediction[]>()
  for (const date of index) {
    const preds = (await store.read<Prediction[]>(`predictions:${date}`)) ?? []
    predictionsByDate.set(date, preds)
    let changed = false
    for (const pred of preds) {
      // WHICH PARTITION MEASURES THIS ROW — decided once, here, and it decides
      // the tape, the clock and the basis together. `cohort` is the stamp the
      // crypto lane wrote at publication (types.ts): a row without it is an
      // equity row OR a legacy crypto row, and both take the path they have
      // always taken.
      //
      // The BASIS is NOT lever-gated, deliberately. A cohort-stamped row's
      // outcome definition was fixed the morning it published — absolute, 14
      // crypto bars, completed-bars tape — and `CRYPTO=off` governs the LANE
      // (publication, accrual, the rung stream), never the arithmetic of a row
      // that already exists. Grading a cohort row on the SPY path under the
      // lever would store a wrong number in the ledger forever, and flipping
      // the lever back on would then feed that SPY-benchmarked outcome to the
      // crypto rung's evidence window. Accrual below IS lever-gated: under
      // CRYPTO=off a cohort row resolves on its own basis and teaches nothing.
      const cryptoBasisRow = pred.cohort === 'crypto'
      const candles = cryptoBasisRow ? await getCryptoCandles(pred.sym) : await getCandles(pred.sym)
      if (!candles) continue
      /** The three lenses, on whichever clock owns this row. Crypto's are 7 / 14
       * / 29 CRYPTO BARS — the ×7/5 images of a week, its own calibrated horizon
       * and a month — and they land in the same three fields because renaming them
       * would rewrite every stored row for a cosmetic gain.
       *
       * THE TWO PARTITIONS NO LONGER SHARE A CALIBRATED FIELD (v4). Equity moved
       * to `outcome21` — 21 sessions, `CALIBRATED_OUTCOME` in calibration.ts —
       * while crypto's calibrated grade is still `outcome10`, which on a cohort row
       * means 14 crypto bars (`CRYPTO_GRADE_HORIZON`). So "learn at the calibrated
       * field" is now TWO sites, one per partition, and each says which it is. */
      const gradeAt = (lens: 0 | 1 | 2, equityHorizon: 5 | 10 | 21) =>
        cryptoBasisRow ? gradeCryptoPrediction(pred, candles, CRYPTO_HORIZONS[lens]) : gradePrediction(pred, candles, spy, equityHorizon)
      // CONTAINMENT (1c A1): a legacy crypto row RESOLVES — its outcomes fill so
      // the ledger's history completes and the row stops being outstanding — but
      // it TEACHES nothing. Its grade was struck against SPY on a clock the asset
      // doesn't keep; booking it anywhere the equity engine learns (calibration,
      // IC, Brier, rungs, panes, the gate ledger, the paper's sentence) would be
      // learning from a measurement the engine now knows was malformed. Phase B
      // gives crypto its own everything.
      //
      // `|| cryptoBasisRow` closes the one seam between the two accrual paths: the
      // symbol test and the cohort stamp are independent, so a row that were
      // somehow stamped 'crypto' under a non-crypto symbol would otherwise book
      // into BOTH blobs. The stamp chose the row's population at publication and is
      // never revised (the accrual doctrine), so the equity loop refuses anything
      // the stamp claims — whatever the symbol says.
      //
      // HOISTED out of the grade block it used to live in, because the two
      // partitions now learn at different lenses and both blocks need the answer.
      const cryptoRow = isCryptoSymbol(pred.sym) || cryptoBasisRow
      const wildcardRow = isWildcardRow(pred)
      // grading stores all three lenses (5/10/21d); only ONE of them trains
      // anything, and which one depends on the partition (see `gradeAt`).
      if (!pred.outcome5) {
        const o = gradeAt(0, 5)
        if (o) {
          pred.outcome5 = o
          changed = true
        }
      }
      // THE 10 LENS. For an equity row this is now a LEDGER LENS ONLY — stored,
      // displayed, and training nothing (CALIB_DEF_VERSION v4 moved the hit to 21
      // sessions). For a `cohort: 'crypto'` row it is still the partition's own
      // calibrated grade at 14 bars, and everything the crypto blob learns, it
      // learns here — unchanged, deliberately: the crypto partition was not part
      // of the horizon ruling and its clock did not move.
      if (!pred.outcome10) {
        const o = gradeAt(1, 10)
        if (o) {
          pred.outcome10 = o
          changed = true
          // the OTHER partition learns here, in its own object, under its own key
          // (Phase-A relaxation 1 — see the seam at the top of this function).
          // `updateCryptoCalibration` forces `capUsdM` to null, so the row books
          // the cohortless key that is the only scheme this blob will ever hold;
          // everything else the equity path does — the sized/shadow sub-counts, the
          // setup-family buckets, the evidence counters — happens INSIDE the crypto
          // state. Nothing pools: the two objects have no key in common and no read
          // walks both.
          if (cryptoBasisRow && !cryptoOff) {
            updateCryptoCalibration(cryptoCal, pred, o)
            cryptoGraded.push({ probability: pred.probability, outcome: o, shadow: !!pred.shadow })
            if (!pred.shadow && !pred.watchOnly) cryptoNewActionable++
          }
          // `graded` counts a row once, WHEN ITS OWN CALIBRATED LENS LANDS — here
          // for a cohort row (14 bars), at the 21 lens below for everything else.
          // Not gated on `cryptoOff`, exactly as it was not before: the lever
          // governs accrual, never whether a row that resolved is reported as
          // resolved.
          if (cryptoBasisRow) graded++
        }
      }
      // THE CALIBRATED GRADE FOR EVERY EQUITY ROW (CALIB_DEF_VERSION v4, owner
      // ruling 2026-09-22): 21 sessions — one to two weeks up to a month, the
      // reader's actual holding period. Calibration buckets, setup buckets,
      // factor-IC weights, the Brier trail, the scorecard panes, the risk-ladder
      // counters and the wildcard's causal outcome ALL learn here and nowhere else.
      // A row therefore stays pending until this lands (~31 sessions with the 21
      // lens itself needing a full window after the call), which is the honest cost
      // of grading on the horizon the reader actually trades.
      if (!pred.outcome21) {
        const o = gradeAt(2, 21)
        if (o) {
          pred.outcome21 = o
          changed = true
          // EVERY LOSER EXPLAINS ITSELF (postMortem.ts). Deterministic, pure, and
          // computed here because here is the only place the loss and the tape
          // that caused it are both in scope — it rides the store.write below for
          // free. EVERY graded loser gets one: a shadow's failure is the audition
          // the shadow was published to run, and a watch row the reader could not
          // act on still teaches how this SHAPE of call dies. Winners get nothing,
          // and no published decision reads the field. `regretDisabled()` is the
          // parity seam (missLedger.ts): with `REGRET=off` no loser is stamped
          // and none is queued, which is the pre-3b tree exactly.
          //
          // …and the ONE population examined either way is the WILDCARD (Stage
          // 3d, spec §4.1: "mandatory post-mortem win or lose"). The slot exists
          // to find out what happens when a gate is overridden, so a win that
          // went unexamined would be exactly the half of the answer the
          // experiment was bought for. `classifyOutcome` is the same site with a
          // wider question: it delegates every loser to `classifyLoser`
          // unchanged, and gives a winner the one class the loser order cannot
          // honestly produce.
          //
          // It moved here WITH the grade, not with the field it used to sit
          // beside: a post-mortem is "why did the calibrated call fail", and
          // leaving it at 10d would have it explain a loss the engine is no longer
          // scored on — and, worse, contradict the grade on rows that recovered or
          // broke between the two lenses.
          if ((!o.hit || wildcardRow) && !regretDisabled() && !cryptoRow) {
            pred.postMortem = { ...classifyOutcome(pred, o, candles), at: nowSec }
            // …and if the reader had money on it, queue it for the paper's one
            // sentence. Queued, not asked: the ask happens after every grade in
            // this pass is durable (see the pass below). LOSERS ONLY, still: the
            // prompt (postMortemLlm.ts) opens "a swing-trade call lost money",
            // so handing it a winning wildcard would buy a sentence explaining a
            // loss that did not happen. The deterministic `won` line above is
            // the whole of what a winning experiment says.
            if (pred.riskPct > 0 && !o.hit) sentenceAsks.push({ date, pred })
          }
          // …and the causal evidence the slot was spent on is now OWED to the
          // ledger, which the row says on itself. Written here so it rides the
          // same `store.write` the grade does: the debt and the outcome that
          // created it become durable in one operation, or neither does. The
          // collection pass below is what turns it into a queued write.
          // …a CRYPTO wildcard (legacy only — the pool refuses coins now) owes
          // the ledger nothing: its outcome is SPY-malformed, so charging any
          // equity gate with it would be exactly the contamination A1 stops.
          // `booked` stays absent — no debt is ever minted, none can go unsettled.
          if (wildcardRow && pred.wildcard && !regretDisabled() && !cryptoRow) pred.wildcard.booked = false
          // THE calibrated grade: calibration buckets, setup buckets, factor-IC
          // weights, the Brier trail and the risk-ladder counters all learn here,
          // at 21 sessions.
          if (!cryptoRow) updateCalibration(calibration, pred, o) // cohort read off pred.capUsdM inside
          // …but NOT factor IC for a lane call — ANY lane (LANE_CATALYST_KINDS,
          // catalyst.ts). A lane call carries a constant technical placeholder
          // (dipLane.ts, velocityLane.ts) rather than a measured factor vote, so
          // booking its outcome would train the technical factor's IC on the
          // lane's P&L — a signal it never cast. Calibration buckets and setup
          // buckets above still accrue: only factor-IC is excluded.
          if (!LANE_CATALYST_KINDS.has(pred.catalyst?.kind ?? '') && !cryptoRow) w = updateIcStats(w, pred, o)
          if (!cryptoRow) newlyGraded.push({ probability: pred.probability, outcome: o, shadow: !!pred.shadow, wildcard: wildcardRow })
          // one row, one count, at its own calibrated lens (see the 10 block)
          if (!cryptoBasisRow) graded++
          // …and the risk ladder's graded-at-rung counter, which the WILDCARD is
          // blind to (Stage 3d). A wildcard is the engine deliberately overriding
          // its own no at a quarter of the rung; letting that outcome count
          // toward the evidence that raises or lowers the rung would let one
          // experiment a week set the size of every ordinary call. It is the KIND
          // that is tested and not the whole lane family — a dip and a velocity
          // row are ordinary trades the reader carries at full weight, and they
          // go on moving the rung exactly as they always have.
          if (!pred.shadow && !pred.watchOnly && !wildcardRow && !cryptoRow) newByCohort[capCohortOf(pred.capUsdM)]++
        }
      }
      // shadows and watch-only calls feed calibration/IC above but never the
      // risk ladder — the rung is earned on calls the reader could actually take,
      // on the SAME calibrated outcome the ladder learns from, which since v4 is
      // the 21-session one (`calibratedOutcomeOf`). The counter above and this
      // evidence window read one field or they drift apart by exactly the rows
      // that graded between the two lenses.
      // …and neither does a WILDCARD, for the reason on the counter above: the
      // rung is earned on the calls the engine BELIEVED, and this is the one it
      // published because it did not. The counter and this evidence window must
      // exclude the same stream or the two drift apart by exactly the rows the
      // exclusion was written for.
      // …and `leveraged` means GEARED, not "routed" (Stage 1c-R). The rule this
      // flag feeds — three consecutive leveraged calls stopped out demotes the
      // rung — is about geared exposure compounding a losing streak. A 1×
      // tracker carries no gearing, so a routed spot position is an ordinary
      // stop-out and is counted as one. Inert for equity: every equity route is
      // a 2× or 3× ETP, so `leverage > 1` is `!!instrument` there.
      const calibrated = calibratedOutcomeOf(pred)
      if (calibrated && !pred.shadow && !pred.watchOnly && !isWildcardRow(pred) && !isCryptoSymbol(pred.sym) && pred.cohort !== 'crypto')
        allOutcomes.push({ hit: calibrated.hit, stopped: calibrated.stopped, leveraged: (pred.instrument?.leverage ?? 0) > 1, cohort: capCohortOf(pred.capUsdM) })
      // …and the crypto ladder's evidence window, which is the SAME sentence
      // over a disjoint population: the crypto stream never enters `allOutcomes`
      // (the guard one line up is unconditional and stays that way) and the
      // equity stream never enters this one. Same rule about which rows count —
      // actionable only, no shadows, no watch rows.
      //
      // ONE KNOWN ASYMMETRY, stated rather than denied: a row graded DURING a
      // CRYPTO=off window filled its outcome on the crypto basis but accrued
      // nowhere (calibration, Brier and `cryptoNewActionable` all live inside
      // the fill block, which runs once) — yet this window re-scans every
      // lever-on pass, so such a row re-enters the evidence here while the
      // counters above never saw it. Direction is conservative only: the extra
      // rows can feed demotion's last-20 hit rate, never promotion (that needs
      // `gradedAtRung`, which they never moved), and at rung 0 demotion floors.
      // The alternative — marking outcomes with the lever state they graded
      // under — buys a field on every row to close a drift that cannot promote.
      if (pred.outcome10 && !pred.shadow && !pred.watchOnly && !cryptoOff && pred.cohort === 'crypto')
        cryptoOutcomes.push({ hit: pred.outcome10.hit, stopped: pred.outcome10.stopped, leveraged: (pred.instrument?.leverage ?? 0) > 1 })
      // THE DEBT COLLECTION (Stage 3d fix wave). Read off the ROW rather than off
      // "did it grade in this pass", which is what makes a failed ledger write
      // recoverable: a row graded last time whose blob write threw still says
      // `booked === false`, and this is the pass that settles it.
      //
      // `=== false` and not `!booked`, deliberately — the receipt is a tri-state
      // (types.ts). A wildcard graded before the field existed carries `undefined`
      // and must read as "settled long ago"; treating absence as a debt would have
      // the first run after this ships re-book every wildcard still inside the
      // 30-date window.
      if (calibrated && pred.wildcard?.booked === false && isWildcardRow(pred) && !regretDisabled())
        causalOutcomes.push({
          ev: { date: pred.date, sym: pred.sym, side: pred.side, excessPct: calibrated.excessPct, gate: pred.wildcard.gate, hit: calibrated.hit },
          pred,
          date,
        })
    }
    if (changed) await store.write(`predictions:${date}`, preds)
    if (preds.some(p => !p.outcome5 || !p.outcome10 || !p.outcome21)) stillPending.push(date)
  }
  await store.write('predictions-pending', stillPending.slice(-250))

  // THE PAPER'S SENTENCE (postMortemLlm.ts) — deliberately HERE, after every
  // grade above is already durable on disk. A sentence is the least important
  // thing this pass produces and the only part of it that depends on a third
  // party being up, so it is never allowed to sit between a grade and its
  // write: a 429 from Groq must cost the day's prose and nothing else. The
  // rows are then re-written with what the model said, and a failure of THAT
  // write costs the sentence too — the grade is already down.
  if (deps.postMortemSentence && sentenceAsks.length) {
    try {
      const asks: PostMortemAsk[] = sentenceAsks.map(({ pred }) => ({
        sym: pred.sym,
        side: pred.side,
        date: pred.date,
        setup: pred.setup,
        entry: pred.entry,
        stop: pred.stop,
        target: pred.target,
        thesis: pred.thesis,
        falsifier: pred.falsifier,
        catalyst: pred.catalyst ?? null,
        outcome: calibratedOutcomeOf(pred)!,
        postMortem: pred.postMortem!, // mutated in place — it rides the write below
      }))
      const stat = await annotatePostMortems(asks, deps.postMortemSentence)
      for (const date of new Set(sentenceAsks.map(a => a.date))) {
        const rows = predictionsByDate.get(date)
        if (rows) await store.write(`predictions:${date}`, rows)
      }
      console.log(`POSTMORTEM-LLM: ${stat.asked} asked, ${stat.written} written, ${stat.upgraded} upgraded, ${stat.overflow} past budget`)
    } catch (e) {
      console.log(`POSTMORTEM-LLM: skipped — ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // WHAT THE ENGINE MAY CLAIM AS SKILL — `newlyGraded` less the experiments (see
  // its declaration for the full enumeration of consumers and policies). Derived
  // once, here, so the Brier trail and the lifetime counters below can never
  // drift into disagreeing about which rows count.
  const skillGraded = newlyGraded.filter(g => !g.wildcard)
  if (skillGraded.length) {
    const mean = brierPoint(skillGraded)
    if (mean != null) calibration.brier = [...calibration.brier, { date: today, mean: Math.round(mean * 1000) / 1000, n: skillGraded.length }].slice(-250)
  }
  // …and the crypto partition's OWN trail, in its own blob, off its own graded
  // rows. It exists for one reason: `brierImproving` is a precondition of every
  // rung promotion, so a crypto ladder reading the equity trail would have its
  // sizing gated by how well the engine forecast equities — the contamination
  // this partition exists to prevent, arriving through the one door nobody
  // watches. Nothing filters wildcards out of it because nothing can be one: the
  // experiment slot refuses crypto, and that Phase-A exclusion stays.
  if (cryptoGraded.length) {
    const mean = brierPoint(cryptoGraded)
    if (mean != null) cryptoCal.brier = [...cryptoCal.brier, { date: today, mean: Math.round(mean * 1000) / 1000, n: cryptoGraded.length }].slice(-250)
  }
  w = maybeNudgeWeights(w, today)

  const brierImproving = brierImprovingOf(calibration.brier)
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

  // ---- THE CRYPTO RUNG STREAM: its own instance, never the equity ladder ----
  // `computeCohortRung` verbatim, with the two arguments that would have carried
  // equity evidence across the partition chosen rather than inherited:
  //
  //  · `combined` is the CRYPTO ladder itself (`cryptoCombinedFor`). For an
  //    equity sleeve, mirroring the combined rung while thin is right — the whole
  //    book's record is still evidence about a young large-cap sleeve. For crypto
  //    it would hand a cold cohort the sizing that 8,500 SPY-benchmarked outcomes
  //    paid for. Mirroring itself is a no-op that keeps `gradedAtRung` honest
  //    until it has twenty of its own and stands on them.
  //  · `override` is NULL. `cfg.riskRungOverride` is the owner pinning THE BOOK;
  //    letting it pin this ladder too would hand the crypto cohort a rung its own
  //    record never earned, and the half-size cap is released by exactly that
  //    record (`cryptoSizeCap`). The owner's pin governs the money it was aimed
  //    at; the crypto cohort earns its own or stays at half.
  //
  // With `CRYPTO=off` the whole stream is inert: no outcome enters it, no count,
  // and the blob is not written at all — the ladder the lever restores is the one
  // that existed before it, byte for byte.
  const nextCryptoRisk = computeCohortRung(
    cryptoRisk,
    cryptoOutcomes.slice(-60),
    cryptoNewActionable,
    cryptoCombinedFor(cryptoRisk),
    brierImprovingOf(cryptoCal.brier),
    null,
    today,
  )

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

  // scorecard: the rolled-up honesty pane. Aggregates the CALIBRATED outcome —
  // 21 sessions since v4 (`calibratedOutcomeOf`) — so the pane measures the same
  // thing the engine learned from (the per-row ledger still shows all three
  // lenses, 5d / 10d / 21d, and a row appears here only once the 21 one lands).
  const byGrade: Record<string, { n: number; hits: number; sumExcess: number }> = {}
  const byRegime: Record<string, { n: number; hits: number }> = {}
  const bySetup: Record<string, { n: number; hits: number; sumExcess: number }> = {}
  const overlays: Record<string, { n: number; hits: number }> = {}
  // HOW THE ENGINE LOSES, by setup family × regime × class (spec §4.3). Shadows
  // are counted with everything else, on bySetup's argument: the question is
  // "does this SHAPE of call fail this way in this tape?", and a shadow is
  // exactly that shape being auditioned. Counted off the row's own stored
  // post-mortem rather than re-derived — a loser graded before the field existed
  // is simply absent (it ages out of the 30-date window on its own) and no row is
  // ever classified twice.
  const byPostMortem: Record<string, number> = {}
  // THE WILDCARD'S PLACE IN EACH PANE (Stage 3d fix wave), and one rule decides
  // all four: A WILDCARD TAKES THE TREATMENT THE PANE ALREADY GIVES A SHADOW.
  // Both are populations carrying no reader conviction — a shadow because nobody
  // was offered it, a wildcard because the engine's own gates said no — so every
  // pane here has already had to answer this exact question once.
  //
  //  · byGrade   — ITS OWN KEY, exactly as a shadow gets one. The letter is not
  //                why this row published (a wildcard's evidence contract is false
  //                by construction and its grade is usually null), so folding it
  //                into C would make C mean two different things. Visible rather
  //                than dropped: it IS reader money, and "how have the experiments
  //                done?" deserves an answer.
  //  · byRegime  — EXCLUDED, as a shadow is. This is the live/skill pane: "how does
  //                the engine read THIS tape?" must not be answered with the row it
  //                published because it read the tape the other way.
  //  · bySetup   — INCLUDED, as a shadow is. The question is about the SHAPE, and a
  //                wildcard's setup family is a real read of a real chart — sized,
  //                stopped and graded. The most honest sample the family has.
  //  · byPostMortem — INCLUDED, as a shadow is, and therefore only ever as a LOSER:
  //                `'won'` is excluded outright below, because this roll-up is HOW
  //                THE ENGINE LOSES and a win is not one of the ways.
  //
  // Everything the wildcard is excluded from, it says elsewhere: its own byGrade
  // key, the miss ledger's causal column, and the row's own `wildcard` block.
  for (const date of fullIndex.slice(-30)) {
    const preds = predictionsByDate.get(date) ?? (await store.read<Prediction[]>(`predictions:${date}`)) ?? []
    for (const p of preds) {
      const o = calibratedOutcomeOf(p)
      if (!o) continue
      // CONTAINMENT (1c A1): a legacy crypto row's outcome was struck against
      // SPY on the wrong clock — it appears in NO pane. Phase B gives the
      // cohort its own panes.
      if (isCryptoSymbol(p.sym)) continue
      const wildcardRow = isWildcardRow(p)
      // shadow first, for the same reason `preGradeShadow` stands over the
      // publish override: "the reader was never offered this" is the stronger
      // statement, and a shadowed wildcard is not seated at all today.
      const g = (byGrade[p.shadow ? 'shadow' : wildcardRow ? 'wildcard' : p.grade] ??= { n: 0, hits: 0, sumExcess: 0 })
      g.n++
      if (o.hit) g.hits++
      g.sumExcess += o.excessPct
      if (p.setup) {
        // per-setup honesty (shadows included — the panes ask "does this SHAPE
        // of call work?", and shadows are exactly the shapes being auditioned;
        // a wildcard is that shape actually carried, with a stop)
        const s = (bySetup[p.setup] ??= { n: 0, hits: 0, sumExcess: 0 })
        s.n++
        if (o.hit) s.hits++
        s.sumExcess += o.excessPct
      }
      if (!p.shadow && !wildcardRow) {
        const r = (byRegime[p.regime] ??= { n: 0, hits: 0 })
        r.n++
        if (o.hit) r.hits++
      }
      // …and `'won'` never enters the how-we-lose roll-up. It is the one class
      // that names no failure at all (postMortem.ts's `classifyOutcome`, reachable
      // only for the wildcard slot), so a `family:regime:won` key would read as a
      // way this shape of call dies. The win is reported where it belongs: the
      // causal column of the miss ledger, which is what it was bought for.
      if (p.postMortem && p.postMortem.cls !== 'won') {
        const k = postMortemKey(p.setup, p.regime, p.postMortem.cls)
        byPostMortem[k] = (byPostMortem[k] ?? 0) + 1
      }
      if (p.overlay) {
        const ov = (overlays[p.overlay.flag] ??= { n: 0, hits: 0 })
        ov.n++
        // a veto "hits" when it dodged a loser; boost/caution graded straight
        if (p.overlay.flag === 'veto' ? !o.hit : o.hit) ov.hits++
      }
    }
  }
  // LIFETIME counters: the by-grade/by-regime panes rebuild from the last 30
  // dates, but "is this tool accurate?" is a months-scale question — these
  // accumulate forever (live calls and shadows separately) and never reset.
  // …which is exactly why they read `skillGraded` and not `newlyGraded`: a
  // counter that never resets is the last place an experiment belongs, and there
  // are only two columns here, neither of which a wildcard is. (See
  // `newlyGraded`'s declaration for the full consumer table.)
  const priorCard = await store.read<{ lifetime?: { live: { graded: number; hits: number; sumExcess: number }; shadow: { graded: number; hits: number; sumExcess: number }; since: string } }>('engine-scorecard')
  const lifetime = priorCard?.lifetime ?? { live: { graded: 0, hits: 0, sumExcess: 0 }, shadow: { graded: 0, hits: 0, sumExcess: 0 }, since: today }
  for (const g of skillGraded) {
    const side = g.shadow ? lifetime.shadow : lifetime.live
    side.graded++
    if (g.outcome!.hit) side.hits++
    side.sumExcess += g.outcome!.excessPct
  }
  await store.write('engine-scorecard', {
    byGrade,
    byRegime,
    bySetup,
    byPostMortem,
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
  // …and the crypto partition's two, beside them and never inside them.
  //
  // WRITTEN ONLY WHEN THE PARTITION ACTUALLY MOVED — the `advanceGates`
  // precedent, and here it carries a second claim: a grading pass on an
  // equity-only ledger writes the SAME set of blobs it wrote before this lane
  // existed, so "which blobs does a pass touch?" stays a question with the old
  // answer for every deploy that has never seen a crypto row. Two triggers,
  // because there are two ways it can move: a fresh grade (which accrued into
  // the calibration), or a rung step off evidence banked on an earlier pass.
  //
  // With `CRYPTO=off` neither can happen — no row was graded on the crypto
  // basis, no outcome entered the stream — so the lever leaves the footprint of
  // the pre-lane tree exactly.
  const cryptoMoved = cryptoGraded.length > 0 || JSON.stringify(nextCryptoRisk) !== JSON.stringify(cryptoRisk)
  if (!cryptoOff && cryptoMoved) {
    await store.write(CRYPTO_CALIB_KEY, cryptoCal)
    await store.write(CRYPTO_RISK_KEY, nextCryptoRisk)
    if (cryptoGraded.length)
      console.log(`CRYPTO: ${cryptoGraded.length} graded on the crypto clock — rung R${nextCryptoRisk.rung}, ${cryptoCal.evidence?.live?.n ?? 0} live outcomes on the partition`)
  }

  // LAST in the pass, and wrapped whole. Every learning blob above is durable by
  // now, so a miss-ledger failure — a missing trace, an upstream 503 on a candle
  // fetch, a malformed blob — costs the day's regret measurement and cannot touch
  // a grade, a rung or a published row.
  // …starting with the EXPERIMENT'S readout (Stage 3d). First of the three
  // because it is the only one whose evidence is real — a stopped, sided outcome
  // on a trade a gate refused — and because the gate feedback two hooks down
  // reads what it writes, so a wildcard that closed this morning argues at this
  // morning's gate review rather than ten sessions behind it. Its own guard: a
  // ledger hiccup here must not be reported as a miss-accrual failure, and the
  // accrual below re-reads the blob for itself either way.
  try {
    await bookCausalOutcomes(store, causalOutcomes.map(c => c.ev))
    // THE RECEIPT, and only now (fix wave, F-4). Until this line the rows say
    // `booked: false` and the debt is outstanding, so a throw above — a 503, a
    // malformed ledger blob — leaves the outcome recoverable on the next pass
    // instead of silently gone: the grade was durable before this hook ran and
    // nothing here can un-write it.
    //
    // THE RESIDUAL, stated rather than hidden: if the ledger write returns and
    // THIS write then fails, the next pass books the same outcome a second time.
    // That window is one blob write wide and its cost is one duplicated causal
    // sample on one gate — against the alternative, which is a sample the slot
    // spent a week buying vanishing with nothing left anywhere to say it existed.
    if (causalOutcomes.length) {
      for (const c of causalOutcomes) if (c.pred.wildcard) c.pred.wildcard.booked = true
      for (const date of new Set(causalOutcomes.map(c => c.date))) {
        const rows = predictionsByDate.get(date)
        if (rows) await store.write(`predictions:${date}`, rows)
      }
    }
  } catch (e) {
    console.log(`WILDCARD: causal write-back skipped — ${e instanceof Error ? e.message : String(e)}`)
  }
  try {
    await accrueMissLedger(store, spy, candleCache, getCandles)
  } catch (e) {
    console.log(`MISS-LEDGER: skipped — ${e instanceof Error ? e.message : String(e)}`)
  }
  // …and then, on what that ledger has measured, the one mechanism allowed to move
  // a published threshold. Its OWN guard, so a gate failure is never reported as a
  // ledger failure — and its own guard is enough: it reads the ledger blob itself,
  // so a morning the accrual could not run still evaluates the evidence already
  // banked. Last, and least urgent: a notch must never cost this pass a grade.
  try {
    await advanceGates(store, cfg, fullIndex, today)
  } catch (e) {
    console.log(`GATE: skipped — ${e instanceof Error ? e.message : String(e)}`)
  }
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

/** THE BOARD'S OWN TAPE LENGTH: one year of daily bars, which is what
 * `cachedCandles` (Yahoo `range=1y`) hands every candidate the engine has ever
 * scored. The discovery scan keeps 300 bars per name for its own 52-week
 * features, so any tape it lends the board is cut back to this before the board
 * reads it — `swingCapacity` and `patternScore` both consume the WHOLE array,
 * and the same name measured over 300 bars is a different number from the same
 * name over 252. A shared tape must not quietly change a score. */
export const BOARD_CANDLE_BARS = 252

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
  // THE RUN'S THRESHOLDS. `gatesFor(cfg.riskAppetite)` is still the base
  // ('aggressive' lowers the dead zone / expected-move floor — catalyst.ts); the
  // `gate-state` blob adds whatever the miss ledger's evidence has earned since,
  // clamped to hard bounds, and hands back the preset EXACTLY while the blob is
  // absent (shared/engine/gateState.ts). One object carries all three tunable
  // thresholds — including the context cap, which composeCall reads off it rather
  // than off its module constant — and the funnel trace stores it whole, so a
  // trace read back next quarter knows which dead zone said no that morning.
  const gateState = normaliseGateState(await store.read(GATE_STATE_KEY))
  const gates = effectiveGates(cfg, gateState)
  // THE FUNNEL'S RECORD (shared/engine/funnelTrace.ts). Every `continue` below now
  // also says WHY, into an accumulator that costs a Map insert and decides nothing.
  // Written once at the end of the run, fail-soft, under `funnel-trace:${today}`.
  // Rows are keyed (name, side-or-none), so a chart the engine argued both ways
  // about — a lane long over a demoted composite short — keeps both verdicts.
  const trace = funnelTraceRecorder()
  // WHICH PAIRS THE CRYPTO LANE OWNS TODAY (Stage 1c Phase B) — the reader's own
  // watchlist narrowed to the three the partition is defined over, and EMPTY
  // whenever `CRYPTO=off`. Computed here, before the first door, because
  // `addSource`'s containment guard has to know whether a name it is refusing as
  // an equity candidate is going somewhere else or nowhere at all.
  const cryptoUniverse = cryptoDisabled() ? [] : cryptoUniverseFor(watchSyms)

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
    // CONTAINMENT (stage 1c, phase A): a crypto pair is WATCHED, never a
    // candidate — until the lane exists it would be scored on equity factors,
    // graded against SPY on a 5-day clock it doesn't keep, and its refusals
    // would feed the gate ledger that tunes equity thresholds. Refused at THE
    // door (every door calls addSource), recorded once in the trace so the
    // audit and Phase B's relaxation both have a named line to diff.
    // ---- PHASE-A RELAXATION 2 of 3: THE LANE CLAIMS ITS OWN NAMES ----
    // The REFUSAL is untouched: a crypto pair is still never an equity
    // candidate, never fetched here, never on the roster, never in the breadth
    // read, never scored on equity factors against an equity regime. What is
    // relaxed is narrower and is about the RECORD: when the crypto lane will
    // evaluate this exact name today, this door stops writing `crypto-contained`
    // over it, because the name was not contained — it was routed. The lane
    // writes the row's real fate a few hundred lines below, through the same
    // `publishCall` every other row goes through.
    //
    // Everything else still records `crypto-contained` exactly as it did, and
    // says which universe it fell outside of: a pair the partition is not
    // defined over (DOGE-EUR, ETH-BTC), one the reader has not asked to watch,
    // and every pair at all when `CRYPTO=off`. The Phase-A trace row is the
    // lever's off state and stays reachable by all three routes.
    if (isCryptoSymbol(key)) {
      if (!cryptoLaneOwns(key, cryptoUniverse))
        trace.record(key, 'crypto-contained', {
          source,
          // three distinct refusals, each named as itself: the lever, a pair
          // the partition is not defined over, and a lane pair arriving from a
          // non-watchlist door the reader never asked to watch — "outside the
          // universe" would be false about BTC-USD from a screener
          detail: cryptoDisabled()
            ? 'crypto pair — the lane is off (CRYPTO=off); watched, never a candidate'
            : (CRYPTO_UNIVERSE as readonly string[]).includes(key.toUpperCase())
              ? `crypto pair the lane serves but the reader has not watchlisted — the lane is watchlist-driven; watched, never a candidate`
              : `crypto pair outside the lane's universe (${CRYPTO_UNIVERSE.join(', ')}) — watched, never a candidate`,
        })
      return
    }
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

  // ---- the scan: the universe read, rather than sampled ----
  // Every door above is a SAMPLE of the market — today's top-50 movers, 130
  // famous names, whatever the crowd was naming. The scan walks a persistent
  // universe end to end and offers the names its lenses fired on (spec
  // 2026-09-22 §4). It is one more GATED source and nothing more: a scan name
  // faces the same liquidity, capacity, factor and calibration stack as a
  // screener name, and is never a call by fiat.
  //
  // Placed AFTER the sleeve door and BEFORE the cluster's, for the reason the
  // sleeve sits where it does: addSource keeps the FIRST source, so `scan:<lens>`
  // lands only on a name no other door claimed. That makes the source string an
  // exact test for "the scan was its only way in" (the cap budget below reads it)
  // and leaves screener/holding/watchlist/sleeve attribution untouched on a name
  // two doors found. Scan BEHAVIOUR is keyed off scanSet, never off the string.
  //
  // The nominations cost nothing: they are exactly what the doors above have
  // already put in `sources`, handed over so the universe can record that the
  // screeners, the crowd, a theme, a catalyst, the watchlist, the book and the
  // sleeve all named this morning — the evidence its priority bump is built on.
  const scanNominations = [...sources].map(([sym, s]) => ({ sym, origin: `nom:${s.source}` }))
  // …and the call itself, wrapped so that EVERY way it can fail is the same
  // failure: a rejection, a synchronous throw out of a broken module, an absent
  // dep. All three are a null scan and a legacy run. `Promise.resolve().then` is
  // what turns the synchronous throw into the rejection the catch can see.
  const scan = await Promise.resolve()
    .then(() => deps.discovery?.({ date: today, nominations: scanNominations, spy, isEtp: (sym: string) => isRouteEtp(sym, cfg.levMap ?? {}) }) ?? null)
    .catch(() => null)
  /** What the scan actually put in the pool. The SET, like the sleeve's: a scan
   * name the gainers screen also found keeps the screener's door and is still a
   * scan name everywhere membership decides anything. */
  const scanSet = new Set<string>()
  /** The subset for which THE SCAN WAS THE ONLY DOOR — the elevation-only set.
   *
   * A SET, not a source-string test, and that distinction is finding #2: a name
   * whose door was stamped `scan:breakout` and which then joined the roster came
   * back tomorrow through the roster replay ABOVE, still carrying `scan:` — so a
   * string test called it scan-only for ever, and no later door could correct
   * the record. Decided HERE, at the door, where "did anyone else claim this
   * name today?" is a fact rather than an inference. A stored `scan:` source is
   * explicitly NOT another door: it is this same set, yesterday.
   *
   * A scan name that ALSO came in through an ordinary door (screener, holding,
   * watchlist, catalyst…) is absent from this set and competes for the roster
   * and the cap budget exactly like the name that door found. */
  const scanOnlySet = new Set<string>()
  const scanBySym = new Map<string, DiscoveryCandidate>()
  /** The bars the scan already paid for. Reused by the candle fill exactly as the
   * cluster's prefetch is — fetching a tape twice wastes the call and, worse, the
   * second read can fail where the first succeeded. */
  const discoveryTapes = new Map<string, Candle[]>()
  if (scan) {
    for (const c of scan.candidates) {
      const key = c.sym.toUpperCase()
      const claimed = sources.get(key)?.source
      // "another door" means another door TODAY. A replayed roster source that
      // is itself `scan:` is this set's own history, not a second opinion.
      const hadOtherDoor = claimed != null && !claimed.startsWith('scan:')
      addSource(key, `scan:${c.lenses[0]?.lens ?? 'none'}`)
      // only what the door ADMITTED: addSource still refuses crypto pairs and
      // route ETPs, and a refused name must not swell the budget below nor be
      // handed the dip lane's size evidence on the strength of an index listing.
      if (!sources.has(key)) continue
      scanSet.add(key)
      if (!hadOtherDoor) scanOnlySet.add(key)
      scanBySym.set(key, c)
    }
    // THE SCAN'S TAPES, RESHAPED TO THE BOARD'S OWN SHAPE — both halves matter.
    //
    // 1. Only for names the scan ACTUALLY PICKED. The scan holds a tape for every
    //    universe name it read (~1,900 of them); handing all of them to the fill
    //    below would have swapped the candle source of EVERY board name — roster,
    //    holdings, watchlist, sleeve — the day the stage was switched on.
    // 2. Sliced to the last 252 bars, because that is what `cachedCandles` (the
    //    1y Yahoo read every other name gets) returns. The scan keeps 300 bars,
    //    and swingCapacity + patternScore both read the WHOLE array: a 300-bar
    //    tape gives a different capacity percentile and a different pattern base
    //    from the same name's 252-bar one, so an unsliced reuse would have moved
    //    scores for reasons that have nothing to do with the market.
    // Same name, same window, same numbers, whether the scan ran or not.
    for (const [sym, tape] of scan.tapes) {
      const key = sym.toUpperCase()
      if (!scanSet.has(key)) continue
      discoveryTapes.set(key, tape.length > BOARD_CANDLE_BARS ? tape.slice(-BOARD_CANDLE_BARS) : tape)
    }
    const st = scan.stats
    const perLens = Object.entries(st.perLens)
      .filter(([, n]) => n > 0)
      .map(([lens, n]) => `${lens} ${n}`)
      .join(', ')
    console.log(
      `DISCOVERY: universe ${st.universeSize}, scanned ${st.scanned}, selected ${st.selected}` +
        `${perLens ? ` (${perLens})` : ''}, ${st.elapsedMs}ms, cache ${st.barsFromCache}/${st.barsFetched}${st.budgetHit ? ' · budget hit' : ''}`,
    )
  }

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
    // A scan pick joins them: a lens firing on a name's own tape is evidence of
    // the same weight, and it too buys priority and nothing else.
    if (sleeveSet.has(sym) || clusterPeers.has(sym) || scanSet.has(sym)) return 4
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
  //
  // …and the scan gets its OWN allowance on top, which is why this is an addition
  // and not one larger number. Tier 4 puts a scan pick ahead of the screens, so a
  // flat 180 would have let a hundred-name scan evict the very discovery feeds it
  // is meant to widen — the universe read would have been paid for out of everyone
  // else's budget. 320 is the ceiling on what one run will ever fetch; the
  // mapLimit(8) below still binds the RATE. A run with no scan is exactly 180.
  const candidateBudget = Math.min(180 + scanSet.size, 320)
  const candidateSyms = [...sources.keys()]
    .sort((a, b) => candidatePriority(a) - candidatePriority(b) || a.localeCompare(b))
    .slice(0, candidateBudget)
  // the budget's own cut, named: everything the sort put past the last slot
  const candidateSet = new Set(candidateSyms)
  for (const [sym, s] of sources) {
    if (!candidateSet.has(sym))
      trace.record(sym, 'trimmed', { source: s.source, detail: `past the ${candidateBudget}-candidate evaluation budget` })
  }
  const candleMap = new Map<string, Candle[]>()
  await mapLimit(candidateSyms, 8, async sym => {
    // fail-soft per symbol: one refused read costs one candidate, never the board
    // both prefetches first: a tape the cluster or the scan already read is the
    // same tape, and a second read is a wasted call that can fail on its own
    const c = clusterTapes.get(sym) ?? discoveryTapes.get(sym) ?? (await deps.candles(sym).catch(() => null))
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
  //
  // The scan joins them on the same terms and for the same reason: its picks carry
  // capUsdM null (a lens reads a tape, not a balance sheet) and sit at tier 4, so
  // unqueued they would take every slot. It does not need the cap either — its
  // size evidence is the index band it was seeded from (the dip read below).
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
  // the SET this time, not the source string: `scanOnlySet` was decided at the
  // scan door, where "did another door claim this name today?" is a fact. The
  // string cannot answer it — a scan name that joined the roster comes back
  // through the roster replay still stamped `scan:`, so the string says
  // "scan-only" for ever, whatever happens afterwards. A scan pick the screener
  // also offered is not in the set and keeps the screener's cap claim, which is
  // right: that name arrived with a cap the screener carries.
  const scanOnly = (s: string) => scanOnlySet.has(s)
  const elevatedOnly = (s: string) => sleeveOnly(s) || clusterElevated(s) || scanOnly(s)
  // 15 plus the scan's own allowance, ceiling 25 — the same shape as the candidate
  // budget above and for the same reason. A hundred unpriced scan names behind a
  // fixed 15 would leave the queue's tail unpriced every morning; letting the scan
  // BUY its slots keeps a run without one at exactly the 15 it has always spent.
  const capBudget = Math.min(15 + scanSet.size, 25)
  const noCap = [...noCapAll.filter(s => !elevatedOnly(s)), ...noCapAll.filter(elevatedOnly)].slice(0, capBudget)
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
    // …or, where no cap was ever fetched, membership of the S&P 500 or the FTSE
    // 100 — and that is the whole of the claim, stated exactly.
    //
    // WHAT THE EVIDENCE IS AND IS NOT. The seed's `capBand` is INDEX MEMBERSHIP,
    // not a measurement: 'large' is conferred by sp500, ndx OR ftse100, and the
    // smallest members of those lists are $3–8B companies, not >$10B ones. So a
    // band is NOT the same claim ">$10B" makes and must not be read as one. What
    // the two big lists do evidence is the thing the dip lane actually cares
    // about — a widely held, widely covered name whose fall is news rather than
    // a liquidity accident. The Nasdaq-100 alone is not enough (it is a
    // 100-name index with no size floor of its own), and a mid or small band
    // never was.
    //
    // It is a FALLBACK, not an override: a name whose cap the pass above
    // actually fetched is judged on the number. Only silence lets the listing
    // speak.
    const capUsdM = sources.get(sym)?.capUsdM
    const scanPick = scanBySym.get(sym)
    const bigIndexListed =
      capUsdM == null && scanPick?.capBand === 'large' && (scanPick.index ?? []).some(ix => ix === 'sp500' || ix === 'ftse100')
    const quality = sleeveSet.has(sym) || (capUsdM ?? 0) > 10_000 || bigIndexListed
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
  // …and the scan is watched on exactly the same terms, for a sharper reason.
  //
  // The roster is 80 slots, admits on JOIN_CAPACITY and trims the LARGEST CAPS
  // FIRST — and a scan pick arrives with capUsdM null, which sorts last in a
  // largest-first trim, i.e. it is the safest thing in the room. The 2026-09-22
  // dry run selected ~87 names a day; letting them queue for the roster would
  // have evicted the earned members (the names that showed they can travel)
  // within a week and replaced them with whatever a lens liked that morning,
  // permanently, since nothing would then trim them back out.
  //
  // The scan does not need the roster: `evalRows` below appends every scan pick
  // to the day's scoring list directly, so a scan name is READ every day it
  // fires — it simply never takes a permanent seat. Membership of `scanOnlySet`
  // is the test, never the source string, and a scan name that ALSO came through
  // an ordinary door is not in it and competes for the roster normally. [R2/R18]
  const rosterCandidates = candidates.filter(
    c => !(sleeveSet.has(c.sym) && sources.get(c.sym)?.source === 'sleeve') && !scanOnlySet.has(c.sym),
  )
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
  // …and every scan pick the roster and the sleeve don't already carry. Without
  // this the scan would have been an expensive way to widen the TRIM: a lens fires,
  // the name joins the pool, its tape is fetched — and the roster's join gate (which
  // admits only names that have already shown they can travel) drops it before a
  // single factor is computed. Seeing more is worth nothing unless what is seen is
  // scored, so a scan name reaches evaluation on the scan's own evidence, exactly
  // as a sleeve name reaches it on the sleeve's. It still earns the roster, or not,
  // on its own merits.
  const evalRows = [
    ...roster.map(e => ({ sym: e.sym, capUsdM: e.capUsdM })),
    ...candidateSyms
      .filter(sym => sleeveSet.has(sym) && !rosterSymSet.has(sym) && candleMap.has(sym))
      .map(sym => ({ sym, capUsdM: sources.get(sym)?.capUsdM ?? null })),
    ...candidateSyms
      .filter(sym => scanSet.has(sym) && !sleeveSet.has(sym) && !rosterSymSet.has(sym) && candleMap.has(sym))
      .map(sym => ({ sym, capUsdM: sources.get(sym)?.capUsdM ?? null })),
  ]
  // The quietest drop in the whole run, and the largest: a candidate with a good
  // tape that is on NONE of the lists above — roster, sleeve, and the scan when
  // it ran — is never scored at all.
  // It is the roster trim doing the cutting, one door along — so it is `trimmed`,
  // with the reason spelled out. Side-free, because no side was ever argued: a
  // lane (dip, velocity) may still publish on such a name below, and that
  // publication writes its own SIDED row rather than overwriting this one. Both
  // are true — the composite never looked, and the lane called it — and under one
  // row per name only the second survived.
  const evalSet = new Set(evalRows.map(e => e.sym.toUpperCase()))
  // TWO STRINGS, PINNED (engine.discovery.test.ts asserts both literally).
  // The scan is a THIRD list, so when it ran the sentence has to name it — but a
  // run WITHOUT the scan (DISCOVERY=off, a Worker host, a thrown scan) must
  // produce the funnel trace this engine has always produced, to the byte, and
  // that means the word-for-word string main ships. A detail string is read back
  // a quarter later by a human and diffed by a test; it is not decoration.
  const neverScoredDetail = scan
    ? 'not on the roster, not in the sleeve, not a scan pick — never scored'
    : 'not on the roster and not in the sleeve — never scored'
  for (const sym of candidateSyms) {
    if (candleMap.has(sym) && !evalSet.has(sym)) trace.record(sym, 'trimmed', { source: sources.get(sym)?.source, detail: neverScoredDetail })
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
  // wildcard: the EXPERIMENT SLOT's record (Stage 3d, wildcardLane.ts), present on
  // exactly one row a day at most and absent on every other. It is the ONE caller
  // permitted to publish a row the grade would otherwise have sized to zero, and
  // it says why in its own field: the row is here BECAUSE a gate refused it, so
  // asking the grade for permission would refuse it a second time and the slot
  // would never buy a single causal outcome. Everything else about the row is this
  // path's ordinary arithmetic — the calibration read, the probability, the
  // accrual stamp, the levels, the trace — and its size is `sizeCap`'s business
  // like any other lane's cap. Returns the published row so the assembly can seat
  // it after the cuts.
  // crypto: THE OTHER PARTITION'S THREE ANSWERS (Stage 1c Phase B), handed in
  // rather than looked up, so this closure keeps exactly one calibration read,
  // one anchor and one rung lookup instead of growing a branch per artefact.
  // Present ONLY on a crypto-lane row: `state` is the crypto blob (branded, so
  // the equity state is a compile error here), `anchor` its own grade base,
  // `rung` its own ladder's, `regime` BTC's tape computed before this call and
  // never relabelled after, and `routed` whether the owner has actually mapped a
  // tracker for this pair yet.
  const publishCall = (
    call: EngineCall,
    capUsdM: number | null,
    cat: CatalystTag | null,
    forceShadow = false,
    sizeCap = 1,
    trail?: Prediction['trail'],
    wildcard?: Prediction['wildcard'],
    crypto?: { state: CryptoCalibrationState; anchor: number; rung: number; regime: RegimeColor | 'unknown' } | null,
  ): Prediction => {
    // cap-class cohort drives BOTH the calibration lookup (its own buckets first,
    // then pooled) and the risk rung below. Unknown cap pools to the cohortless
    // path and the combined rung — never guessed into a sleeve.
    const cohort = capCohortOf(capUsdM)
    // THE TAPE THIS ROW WAS CALLED INTO, and the bucket key it will teach. For
    // an equity row it is the run's own SPY+QQQ read; for a crypto row it is
    // BTC's, computed before `composeCall` saw it and carried through unchanged
    // — the ratified rule is "never relabelled after", and this is the one place
    // the stamp is written.
    const rowRegime = crypto ? crypto.regime : regime
    // A SHORT the reader can't ROUTE is not a takeable call (the full argument is
    // below, where `shadow` is assembled). Read HERE because it is one of the three
    // things that can be known about this row BEFORE the grade — and the
    // population the grade is read from has to be one of them.
    // …and `short1x` counts (Stage 1c-R): an inverse TRACKER is as placeable in
    // an ISA as an inverse ETP, so a short the owner has mapped one for is
    // routable. Inert for equity — no equity entry carries a 1x field — and it
    // is what makes a crypto short's `short1x` mean anything at all: without it
    // the field would configure a route the pre-grade shadow test refuses.
    const shortRoute = (cfg.levMap ?? {})[call.sym]
    const unshortable = call.side === 'short' && !(shortRoute?.short1x || shortRoute?.short2x || shortRoute?.short3x)
    // WHOSE HISTORY THIS ROW IS READ AGAINST — AND WHOSE IT WILL JOIN
    // [stage 3c — the provenance partition; the discriminator re-ratified after
    // the Task-1 review].
    //
    // ONE TEST DECIDES BOTH, and that is the point. `preGradeShadow` is exactly
    // the set of shadow causes that are knowable BEFORE the grade and that no
    // grade can undo: an earnings print inside the horizon, a short an ISA cannot
    // route, a lane stand-down. Such a row was never on offer at any grade — it is
    // the dilution the walk named (26% of the seed's graded evidence is velocity
    // shadow, pooled into the same per-band buckets a sized row reads) — so it is
    // PRICED against the pooled population it belongs to, and it ACCRUES into the
    // shadow sub-count so no sized read ever sees it. Its probability is a record
    // of what the engine thought, not money on offer.
    //
    // EVERY OTHER ROW is a candidate: priced and graded on SIZED history, and
    // stamped `accrual: 'sized'` so its outcome comes back to the same population
    // that judged it. That includes the rows that end up carrying no size at all —
    // a grade-null demotion, a below-base watch row, a C on thin evidence. Their
    // unsized-ness is the ANSWER this read gave them, not a property they had
    // going in, and their outcomes are the band's own record of what happened
    // next. Keying accrual on SIZE instead sealed that record shut: a band whose
    // sized read dipped under the anchor demoted every call it made, each demotion
    // accrued outside the sized population, and the sized read could never move
    // again however well the band did — while the pooled read, on those very same
    // outcomes, recovered. The grade-null branch below states the invariant that
    // forbids exactly this ("buckets below 50% can never earn their way back up");
    // the stamp is what keeps it true.
    //
    // The fourth shadow condition (`!grade && !contract`) is decided BY this read,
    // so feeding it back would be circular — it is priced sized like any other
    // candidate, and under this stamp it accrues sized too. Priced and booked in
    // one population: no deviation left to document.
    const preGradeShadow = call.earningsRisk || unshortable || forceShadow
    const population = preGradeShadow ? 'pooled' : 'sized'
    // …and it is a CURVE now, read at this call's own |composite| rather than at
    // the corner of the band it falls in: two calls 14 points apart no longer
    // share a probability, and one point of conviction moves the number. `nEff`
    // is how many observations actually straddle this read — the grade prices it
    // directly, so a thin bucket can no longer buy a full-size B. `belowEvidence`
    // says the number was handed DOWN from the lowest conviction this rung has
    // ever graded, which caps the grade at C. `provisional` is display only
    // (nEff < MIN_BUCKET_N) — nothing below branches on it.
    // …and `call.setup` is the last argument because of what it unlocks: once
    // this row's family has thirty SIZED outcomes in this band, its own record
    // takes 0.3 of the price (spec §4.3(c)). It moves `p` only — nEff and the
    // evidence flags stay the ladder's — and it is inert on a pooled read, so a
    // shadow's price is untouched by it. See probabilityFor's `blendSetup`.
    // …and a CRYPTO row reads the SAME ladder over a different object: the
    // cohort argument is un-passable in `cryptoProbabilityFor` (B1 pins it to
    // 'unknown', which inside a blob where every key is a crypto key reads
    // "this regime, then all regimes, then my own base rate"), and the grade is
    // measured from the crypto partition's own anchor. The equity 0.4158 must
    // never appear here — it was swept over a universe crypto was filtered out
    // of. On a cold partition both numbers are the honest 0.5, which is what
    // makes every crypto row a C at half size until the cohort has watched
    // itself ~50 times.
    const { p, provisional, nEff, belowEvidence } = crypto
      ? cryptoProbabilityFor(crypto.state, call.side, rowRegime, Math.abs(call.composite), population, call.setup)
      : probabilityFor(calibration, call.side, regime, Math.abs(call.composite), cohort, population, call.setup)
    const grade = gradeFor(p, nEff, crypto ? crypto.anchor : gradeAnchor, belowEvidence)
    // grade null = calibration sees no edge in this bucket. The call stays off
    // the paper — but it MUST enter the ledger as a shadow, or buckets below
    // 50% can never earn their way back up (nothing would ever get graded).
    // Entering the ledger is only half of that guarantee, and stage 3c is where
    // the other half got its own name: the row must also accrue into the SIZED
    // population (`accrual`, above), or the recovery it records is invisible to
    // the very read that demoted it.
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
    // (`unshortable` itself is computed above the probability read — it is one of
    // the three pre-grade facts that choose the population.)
    const belowBase = !grade && call.evidence.contract && !preGradeShadow
    // …and the ONE row the grade may not shadow (Stage 3d). A wildcard is a
    // blocked trade the slot took on purpose: its evidence contract is false by
    // construction (nothing was ever assessed — it never got past a gate) and its
    // grade is usually null, so the ordinary rule would shadow it every single
    // time and the experiment would produce a shadow, which is exactly the thing
    // wildcardLane.ts refuses as worthless — a shadow yields no causal evidence
    // at all. The override is narrow and one-directional: it can only turn OFF
    // the grade-null branch. `preGradeShadow` still stands over it — an earnings
    // print or an unroutable short shadows a wildcard like anything else, and the
    // lane already refuses both, so this is the belt under those braces rather
    // than a second opinion about them.
    const shadow = preGradeShadow || (!wildcard && !grade && !call.evidence.contract)
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
    // The experiment slot's row, live (Stage 3d) — a fourth tier that is NOT a
    // tier: it names no conviction/evidence verdict at all, because the verdict
    // was "no" and the slot is spending money to test it. It stands beside
    // full/half rather than inside them so the three size codes keep meaning what
    // they always meant, and it can only be true when nothing above shadowed the
    // row.
    const wildcardLive = !!wildcard && !shadow
    const watchOnly = !shadow && !fullTrade && !halfTrade && !wildcardLive
    // …and the row carries the SMALLER of two independent haircuts, never their
    // product (the v1 D4 rule, ratified). The tier fraction answers "how much did
    // conviction and evidence earn?" (1 full, 0.5 half); sizeCap answers "how much
    // does this LANE allow on a row of this kind?" — the velocity door caps, which
    // are momentum sizing and not an evidence deficiency. Multiplying them would
    // publish a half-graded confirmation probe at an EIGHTH of a rung: two
    // different statements about one row, both applied, and a number the reader
    // cannot trace to either rule.
    // …and the wildcard enters that arithmetic at 1, so the ONLY thing deciding
    // its size is its cap. That is the honest shape of the rule for a row whose
    // tier is undefined by construction: `WILDCARD_SIZE_CAP` (0.25) is a
    // statement about the KIND of row, exactly as the velocity doors are, and
    // multiplying it by a tier the row never earned would publish an experiment
    // at a fraction nobody chose. A wildcard that DOES happen to grade into a
    // tier takes the smaller of the two like everything else here — the cap is a
    // ceiling, never a floor.
    const tierFraction = fullTrade ? 1 : halfTrade ? 0.5 : wildcardLive ? 1 : 0
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

    // …and the crypto row trades at the CRYPTO ladder's rung, never the equity
    // book's. `cohortRungOf` would send it to the combined rung (its cap is
    // null, so its cohort is 'unknown'), which is precisely the inheritance the
    // partition exists to refuse.
    const rung = crypto ? crypto.rung : cohortRungOf(risk, cohort)
    // sizedFraction === 1 implies tierFraction === 1, i.e. fullTrade, so `grade` is
    // non-null here for exactly the reason it was under the old `fullTrade` test.
    // …and BELOW full size, a CRYPTO row mints its 1× tracker (Stage 1c-R). The
    // `sizedFraction === 1` gate exists because a 2-3× ETP is a full-conviction
    // instrument — geared, daily-rebalanced, decaying — and handing one to a
    // row the engine deliberately made small gives back the exposure the cap
    // just took away. A 1× tracker is none of those things: it is the asset,
    // and the fraction is the SIZE it is held at, which is the ordinary
    // arithmetic every share position already obeys. Written as a crypto-only
    // arm rather than by weakening the equity gate: the gate's argument about
    // geared ETPs is untouched, and no equity row can reach this call.
    const instrument =
      sizedFraction === 1
        ? mapInstrument(call.side, call.sym, grade!, rung, cfg.levMap ?? {})
        : crypto && sizedFraction > 0
          ? spotInstrument(call.side, call.sym, cfg.levMap ?? {})
          : null
    const callThemes = themesOf(call.sym)
    const id = `${today}:${call.sym}:${call.side}`
    if (routeBlocked) routeBlockedShorts.add(id)
    if (routeShadowed) routeShadowedShorts.add(id)
    const row: Prediction = {
      ...call,
      id,
      sleeve: 'composite-control',
      forecast: {
        definition: 'benchmark-excess-no-close-stop-v1',
        label: 'Beat SPY by at least 1pp without a daily close through the stop',
        horizonSessions: crypto ? CRYPTO_HORIZONS[1] : 10,
        probabilityEdge: Math.round(p * 100) / 100,
        probabilityTarget: null,
        probabilityStop: null,
        calibratedN: Math.round(nEff),
        provisional,
      },
      detectedAt: nowSec,
      availableAt: nowSec,
      date: today,
      modelVersion: ENGINE_MODEL_VERSION,
      regime: rowRegime,
      priceAtPrediction: call.entry,
      themes: callThemes.length ? callThemes : undefined,
      catalyst: cat ? { kind: cat.kind, reason: cat.reason } : undefined,
      trail,
      capUsdM,
      shadow: shadow || undefined,
      // WHICH POPULATION THIS ROW WILL TEACH, settled here and never revised — the
      // same `preGradeShadow` test that chose the population it was priced on, so
      // a row can never be graded against one population and booked into the
      // other. Always written (never `|| undefined`): absence is the legacy
      // signal updateCalibration reads for rows published before the stamp, and a
      // row that omitted it would be indistinguishable from one of those.
      accrual: preGradeShadow ? 'shadow' : 'sized',
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
      // PAPER ONLY: a row the reader can read but not place. A short qualifies
      // because an ISA cannot place one without an inverse ETP — and so does
      // EVERY crypto row that carries no instrument, on the same sentence and
      // for the same reason. The test is THE INSTRUMENT ON THIS ROW, never a
      // key upstream in levMap: a configured route that did not mint (a geared
      // ticket on a capped row, a long tracker under a short call) is not a
      // route this row carries. Since Stage 1c-R a crypto row with a 1× tracker
      // for its side DOES mint at half size, so the label lifts exactly when a
      // real, placeable instrument appears on the row — and not one moment
      // earlier.
      paperOnly: !watchOnly && !instrument && (call.side === 'short' || !!crypto),
      // The stamp must describe what the call ACTUALLY got. The composite loop
      // re-scores with worldMult before publishing; a LANE composite is structural
      // (depth-derived in dipLane.ts, run-derived in velocityLane.ts) and never
      // sees the nudge at all. Printing 1.1 on a lane row would advertise a
      // conviction adjustment that was never applied — so every lane row records
      // the multiplier it truly ran at: 1.
      // …and a CRYPTO row records 1 for the same reason a lane row does: the
      // world tape is Asia/Europe indices, US futures and the VIX (worldTape.ts)
      // — an equity-session read with nothing to say about a 24/7 pair — so the
      // crypto lane never applies the nudge, and printing anything but 1 here
      // would advertise an adjustment that was never made.
      worldTape: { tone: tone.tone, mult: crypto || LANE_CATALYST_KINDS.has(cat?.kind ?? '') ? 1 : worldMult(tone.tone, call.side) },
      // WHICH PARTITION MEASURED THIS ROW (types.ts) — present only here, and it
      // is what the grading pass reads to decide the clock, the basis and the
      // blob. Absent on every equity row, so an ordinary board serialises
      // byte-for-byte as it did.
      ...(crypto ? { cohort: 'crypto' as const } : {}),
      // THE EXPERIMENT'S SEPARABLE RECORD (Stage 3d), on exactly the rows that
      // are one and absent everywhere else — so no field on an ordinary row moved
      // and the serialisation of a normal board is byte-for-byte what it was.
      ...(wildcardLive ? { wildcard } : {}),
    }
    board.push(row)
    // …and the size decision is REPORTED HERE rather than handed back to the
    // caller. publishCall is a closure over the whole run, so it can write the
    // row itself; returning a code instead would have meant editing all three call
    // sites (composite, dip, velocity) to remember to record it — and "the caller
    // forgot" is precisely the class of silence Stage 3a exists to end. `revise`,
    // not `record`: a publication is the row's fate and must overwrite whatever
    // gate the composite wrote on the way past — on THIS side's key, which is why
    // a lane long can no longer erase the short's row or be erased by it.
    //
    // route-blocked outranks called-shadow because it is the more specific truth:
    // the row cleared everything and an ISA simply cannot place it. `grade-watchonly`
    // is NOT used, and the zero-size case is not one population but two: a call the
    // calibration rates BELOW ITS OWN BASE RATE on a full evidence contract is an
    // honest, fully-evidenced setup the tape is against, where a `called-watch` row
    // is C on thin evidence — conviction and evidence both short. Pooling them under
    // one code meant 3b's accounting could never tell "we don't believe this side
    // today" from "we barely believe this name at all".
    //
    // …and `called-wildcard` leads the chain because it is the most specific
    // truth there is about the row: it published BECAUSE a gate refused it. The
    // three size codes could not carry it honestly — `called-half` names a TIER
    // this row never earned (the existing rows name conviction/evidence and let
    // the lane's cap ride in `detail`, the velocity door's precedent), and
    // `called-watch` names a row that carries no money when this one carries a
    // quarter of the rung. What the trace keeps instead is the whole biography:
    // `revise` writes `priorGate` with the code this key held a moment ago, which
    // IS the gate under test — so a trace read back next quarter says both what
    // refused the name and that the engine went and took it anyway.
    trace.revise(
      call.sym,
      wildcardLive
        ? 'called-wildcard'
        : routeShadowed
          ? 'route-blocked'
          : shadow
            ? 'called-shadow'
            : fullTrade
              ? 'called-full'
              : halfTrade
                ? 'called-half'
                : belowBase
                  ? 'called-below-base'
                  : 'called-watch',
      {
        side: call.side,
        source: sources.get(call.sym.toUpperCase())?.source,
        // …with the COHORT named first on a crypto row. The gate taxonomy has no
        // crypto code and deliberately gains none — the row published exactly
        // like any other, at the size its own grade and its own cap allowed —
        // but a trace read back next quarter must be able to tell which
        // partition's calibration priced it without re-parsing the symbol.
        detail: (crypto ? 'crypto cohort · ' : '') + (wildcardLive
          ? `experiment — quarter size, testing ${wildcard!.gate}`
          : routeShadowed
            ? `no ISA short route${routeBlocked ? ' — promotable to an observation' : ''}`
            : shadow
              ? call.earningsRisk
                ? 'earnings print inside the horizon'
                : forceShadow
                  ? 'the lane stood it down'
                  : unshortable
                    ? 'no ISA short route'
                    : 'graded null on a failed evidence contract'
              : `grade ${grade ?? 'null'}${call.evidence.contract ? '' : ', contract failed'}${belowBase ? ', below base rate' : ''}${sizeCap < 1 ? `, lane cap ${sizeCap}` : ''}`),
      },
    )
    return row
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
      momentum: momentumFactor(closes, spyCloses, candles),
      // THE BANDWIDTH READ (factors.ts): the Bollinger-width percentile the
      // 2026-09-22 walk-forward study found to be the only sign-stable price
      // feature, signed by the trend the chart read is already arguing. Off the
      // SAME closes every other price factor reads, so nothing extra is fetched.
      bandwidth: bandwidthFactor(closes),
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
      // The gate-free core read (composite.ts — the same arithmetic the call would
      // have stood on), computed BEFORE the trace row so the refusal can carry its
      // own conviction. The near-miss list below is a narrower population (real
      // levels, no earnings print), and the miss ledger's fetch budget was ranking
      // by it — so exactly the rows a gate refused hardest ranked 0. The row's own
      // number is the honest proxy.
      const core = coreCompositeOf(factors, weights.current, regime)
      trace.record(entry.sym, call.gate, {
        side: call.side,
        source: sources.get(entry.sym.toUpperCase())?.source,
        detail: draftedFirstPass ? `second-pass · ${call.detail ?? ''}` : call.detail,
        core,
      })
      // Nothing published. Record the core read so the assembly can name this name
      // if the whole side comes up empty. Requires real levels: a row the reader
      // cannot even see an entry/stop for is not worth naming. An earnings print
      // inside the horizon is excluded on the same principle that shadows the
      // trade — the engine does not point at coin flips.
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

  // ---- the earnings-fade lane: PUBLISHED, GRADED, NEVER SIZED ----
  //
  // The walk-forward study over two years of bars found exactly one relationship
  // that was monotone, sign-stable and t_NW-significant, and it ran the wrong
  // way: a name that beat on EPS AND gapped up 3%+ lost 1.47pp to SPY over ten
  // sessions and 3.43pp over twenty (n = 212, one season). Read as a long it is
  // the opposite of an edge; read as a short it is a candidate event lane. The
  // owner's ruling (2026-09-22, "option 1") is that it ships as a SHADOW lane —
  // the rows publish, they grade, they never carry a penny — so the engine
  // accrues its OWN evidence under its OWN gates instead of arguing from one
  // replayed earnings season. `forceShadow` is passed as a literal `true` below,
  // not as a constant a future edit can flip, because a flag named
  // `..._SHADOW_FIRST` is an invitation and this one is a ruling.
  //
  // It runs LAST of the three lanes and after the candle fill, for the ordinary
  // reason: it reads `candleMap`, and one chart gets one row per side, so a name
  // that already carries a short — composite or lane — keeps it.
  //
  // THE EVENT COMES FROM THE SNAPSHOT, not from `earningsSet`. That set is a
  // forward-looking fortnight of bare symbols; this lane needs a PAST print with
  // its surprise attached and the session it landed on, which is exactly what
  // `deps.earningsEvents` carries (nasdaqEarnings.ts). The dep is optional and
  // the lane is wholly skipped when it is absent, so every existing fixture
  // builds a byte-identical board.
  //
  // Symbols are matched EXACTLY, not by `baseSym`: the snapshot already speaks
  // Yahoo's form (`BRK.B` → `BRK-B`), and stripping to the root would let one
  // company's print be attributed to another's share class.
  let earningsFadeCount = 0
  if (!earningsFadeDisabled() && deps.earningsEvents) {
    try {
      const events = await deps.earningsEvents().catch(() => [] as NasdaqEarningsRow[])
      // The LATEST print per name. A calendar 45 sessions deep holds a name's
      // previous quarter too, and a stale row would have its reaction bar decades
      // outside the two-session window — the classifier would refuse it anyway,
      // but reading one row per name keeps the pass O(candidates).
      const latestBySym = new Map<string, NasdaqEarningsRow>()
      for (const e of events) {
        if (!e?.sym || !e.date) continue
        const key = e.sym.toUpperCase()
        const prev = latestBySym.get(key)
        if (!prev || e.date > prev.date) latestBySym.set(key, e)
      }
      const shortRows = new Set(board.filter(b => b.side === 'short').map(b => b.sym.toUpperCase()))
      const fadeCandidates: { sym: string; read: EarningsFadeRead; call: EngineCall; capUsdM: number | null }[] = []
      for (const [sym, candles] of candleMap) {
        const key = sym.toUpperCase()
        if (shortRows.has(key)) continue
        const event = latestBySym.get(key)
        if (!event) continue
        // Per-SYMBOL fail-soft, exactly as the velocity lane takes it: one
        // unreadable tape costs that name its call and nothing else.
        try {
          const read = classifyEarningsFade(candles, event, spy)
          if (!read) continue
          // The snapshot carries a market cap of its own, which is the only cap
          // many just-reported names have in this run — the cap cache is filled
          // for candidates, and a name can reach `candleMap` without one.
          const capUsdM = sources.get(sym)?.capUsdM ?? event.marketCapUsdM ?? null
          const raw = earningsFadeCall(sym, candles, read, capUsdM)
          if (!raw) continue
          fadeCandidates.push({ sym, read, call: raw, capUsdM })
        } catch (e) {
          console.log(`BOARD: earnings-fade read on ${sym} failed —`, String(e).slice(0, 160))
        }
      }
      // LARGEST GAP FIRST, capped. One earnings morning can print thirty
      // qualifying pops, and publishing all of them would spend the whole
      // 5-per-side shadow budget on a single correlated bet — the very starvation
      // the budget's own dedup rule exists to prevent.
      fadeCandidates.sort((a, b) => b.read.gapPct - a.read.gapPct)
      for (const { sym, read, call, capUsdM } of fadeCandidates.slice(0, EARNINGS_FADE_MAX_PER_RUN)) {
        publishCall(
          // earnings honesty applied here like every other lane — the lane is pure
          // and has no forward calendar of its own.
          { ...call, earningsRisk: earningsSet.has(baseSym(sym)) },
          capUsdM,
          { kind: EARNINGS_FADE_CATALYST_KIND, side: 'short', reason: read.detail, strength: 40 },
          true, // ALWAYS shadow. Not a default, not a flag — the ruling.
        )
        // publishCall writes `called-shadow` under the name's own DISCOVERY door,
        // which is true and not enough: a reader auditing the trace has to be able
        // to tell a lane's deliberate shadow from a grade-null one. The lane
        // re-attributes its own row — same gate, its own source — which is what
        // makes the day's fade rows countable in the record.
        trace.revise(sym, 'called-shadow', {
          side: 'short',
          source: `lane:${EARNINGS_FADE_CATALYST_KIND}`,
          detail: `shadow only, never sized · ${read.detail}`,
        })
        earningsFadeCount++
        console.log(`BOARD: earnings fade (shadow) on ${sym} — ${read.detail}`)
      }
    } catch (e) {
      // Lane-wide fail-soft: a calendar outage, a dep that throws, a shape the
      // snapshot changed under us. The board is exactly what it would have been.
      console.log('BOARD: earnings-fade lane failed —', String(e).slice(0, 160))
    }
  }
  if (earningsFadeCount) console.log(`BOARD: earnings-fade lane published ${earningsFadeCount} shadow short${earningsFadeCount === 1 ? '' : 's'}`)

  // one outstanding shadow per sym+side: skip a shadow candidate whose sym+side
  // still has a shadow that hasn't reached its CALIBRATED grade on a recent prior
  // date — three correlated CEG shorts teach nothing while starving the tiny shadow
  // budget of fresh names. Gated on the calibrated outcome (not outcome5, and since
  // CALIB_DEF_VERSION v4 not outcome10 either) so a slot frees only once its
  // evidence has actually fed the learning loop — which is now at 21 sessions.
  // THE LOOKBACK MOVED WITH IT. It was ten dates, which was exactly the old
  // horizon; leaving it there would release every slot below by the WINDOW sliding
  // out from under an ungraded row rather than by the row grading, which is the one
  // thing the rule exists to prevent (the walk pins the identity —
  // replay-window.ts `WILDCARD_SLOT_LOOKBACK` vs `POSTMORTEM_HORIZON_MIRROR`).
  // The cost is real and accepted: a name shadowed three weeks ago holds its slot
  // for three weeks, because that is how long its evidence takes to arrive.
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
  const priorDates = ((await store.read<string[]>('predictions-index')) ?? []).filter(d => d !== today).slice(-CALIBRATED_HORIZON_SESSIONS)
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
  /** ONE SLOT, ACROSS DAYS (Stage 3d, spec §4.1: "a new wildcard only when the
   * previous closes"). The same scan, one lane further over — and it is a
   * BOOLEAN, not a key set, because the invariant is about the SLOT and not about
   * a name: an open experiment on ABC blocks a new one on XYZ, which is the whole
   * cadence. The causal evidence is meant to arrive one clean sample at a time.
   *
   * THE CALIBRATED OUTCOME is the release, exactly as it is for a shadow slot: a
   * wildcard has closed when the calibrated horizon has graded it, not when the
   * reader stopped looking at it. And the prior dates this loop reads ARE that
   * horizon (`CALIBRATED_HORIZON_SESSIONS`), so the slot reopens on the session the
   * grade lands and not one earlier — the identity the walk asserts as a constant
   * relation rather than a coincidence. The honest boundary:
   * a wildcard whose tape never arrived stops holding the slot once it falls out
   * of this window — which is the same bound the shadow dedup has lived under,
   * and the alternative is one dead name ending the experiment lane for good. */
  let outstandingWildcard = false
  for (const date of priorDates) {
    for (const p of (await store.read<Prediction[]>(`predictions:${date}`)) ?? []) {
      // …read through `calibratedOutcomeOf` like every other "has this graded?"
      // test in the engine. A crypto shadow is held a few bars longer than its own
      // 14-bar grade needs (its outcome21 is 29 bars) — stated rather than special
      // -cased: the slot is a budget for fresh NAMES, and one clock for it is worth
      // more than a partition-aware one.
      if ((p.shadow || p.observation) && !calibratedOutcomeOf(p)) outstandingShadowKeys.add(`${p.sym}:${p.side}`)
      if (p.observation && !calibratedOutcomeOf(p)) outstandingObservationKeys.add(`${p.sym}:${p.side}`)
      if (isWildcardRow(p) && !calibratedOutcomeOf(p)) outstandingWildcard = true
    }
  }
  const pickShadow = (side: 'long' | 'short', cap: number) =>
    pickShadowSide(
      board.filter(b => b.side === side && !!b.shadow && !outstandingShadowKeys.has(`${b.sym}:${b.side}`)),
      cap,
    )
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
    // The row's fate genuinely changed after it published, so the trace follows
    // it — on the SHORT key. The lane's long keeps its own row: two facts about
    // one chart, which is the whole reason the key carries the side.
    trace.revise(row.sym, 'called-shadow', { side: 'short', source: sources.get(sym)?.source, detail: `the ${lane} lane's read on the same chart outranked it` })
    console.log(`BOARD: ${lane} read on ${row.sym} demotes the composite short to a shadow`)
  }

  const actionableShorts = board.filter(b => !b.shadow && !b.watchOnly && b.side === 'short')
  const shortTrades = pickDiverseSide(actionableShorts, 'short', 3, 'trade')
  demoteToWatch(actionableShorts, new Set(shortTrades.map(t => t.id)))
  const trades = [...longTrades, ...shortTrades]
  const watchPool = board.filter(b => !b.shadow && b.watchOnly)
  const watch = [...pickDiverseSide(watchPool, 'long', 6, 'watch'), ...pickDiverseSide(watchPool, 'short', 6, 'watch')]
  // …and a trade the cuts above sent DOWN to the watch list is a row the reader
  // gets, so it must stop reading like a row that vanished. `demoteToWatch` strips
  // the size but keeps the row on the board, and the watch pick then seats it —
  // yet its trace row still said `slot-cut` / `diversity`, which is the fate of the
  // rows that fell off the board entirely. The cut is still the true story of how
  // the row got here, so it is kept verbatim in `detail`; only the GATE changes,
  // and only for the rows the watch list actually seated. A row that published as
  // a watch row in the first place (called-watch / called-below-base) is already
  // right and is left alone — re-labelling it would pool the two zero-size
  // populations back together.
  for (const row of watch) {
    const prev = trace.rowAt(row.sym, row.side)
    if (!prev || (prev.gate !== 'slot-cut' && prev.gate !== 'diversity')) continue
    trace.revise(row.sym, 'called-watch', {
      side: row.side,
      source: prev.source,
      detail: `on the watch list · ${prev.detail ?? 'cut from the trade slots'}`,
    })
  }
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
    // short1x counts (1c-R): an inverse 1x tracker is a route an ISA can place,
    // and "routable short" must mean ONE thing — publishCall's unshortable test
    // already counts it, and a near-miss printing "no ISA route" about a name
    // the board would route is the split this line closes
    return !!(m?.short1x || m?.short2x || m?.short3x)
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
      // Its own code, not `called-watch`: this row is on the board because the
      // SIDE was empty and it was the best thing the route blocked — not because a
      // grade sized it to zero. 3b counts by code, and pooling the promotion with
      // the graded watch rows would make "the route cost us the side" invisible.
      trace.revise(observation.sym, 'called-observation', {
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
        // a probability question, not a grading one. Pooled in the STAGE-3C sense
        // too, and for the same reason the shadows are: this row carries riskPct 0,
        // will accrue as shadow evidence if it is ever graded, and was never a
        // candidate for sizing — so the sized population is not the one it is drawn
        // from and pricing it there would claim it had been.
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

  const SHADOW_CAP = 5
  const shadows = [...pickShadow('long', SHADOW_CAP), ...pickShadow('short', SHADOW_CAP)]

  // ---- the shadows that never made the ledger ----
  // pickShadow is the LAST filter of the run, and it drops rows two ways: past the
  // per-side budget, and deduped against a prior shadow on the same name that has
  // not graded yet. Either way the row appears in nothing — not the board, not the
  // ledger, nothing the reader or the learning loop ever sees — while its trace row
  // still said `called-shadow` or `route-blocked`. A `called-*` code has to mean
  // "the reader got this row" or 3b's accounting is counting publications that
  // never happened, so these rows get their own gate and `detail` says which of the
  // two dropped them. Kept as one code deliberately: both are the shadow budget
  // refusing a row that had already published, and the prose tells them apart
  // without making the taxonomy carry a distinction 3b can already read.
  const shadowedIds = new Set(shadows.map(s => s.id))
  for (const b of board) {
    if (!b.shadow || shadowedIds.has(b.id)) continue
    trace.revise(b.sym, 'shadow-capped', {
      side: b.side,
      source: sources.get(b.sym.toUpperCase())?.source,
      detail: outstandingShadowKeys.has(`${b.sym}:${b.side}`)
        ? 'dropped by the shadow budget — already outstanding as an ungraded shadow'
        : `past the ${SHADOW_CAP}-per-side shadow budget`,
    })
  }

  // ---- 🃏 THE WILDCARD: one blocked trade, taken on purpose ----
  //
  // Every gate in this engine accumulates CORRELATIONAL regret and nothing else:
  // a refusal has no stop, was never a position, and the excess the miss ledger
  // charges it is an upper bound on a trade nobody took. This is the one row a
  // week that answers the other question — what actually happens to a reader who
  // takes the row the gate turned down, at a real size, with a real stop, and
  // gets stopped out of it half the time. The choosing is wildcardLane.ts's and is
  // pure; everything here is the engine seating what it chose.
  //
  // WHY IT RUNS HERE, at the very end of the assembly and not one line earlier:
  //
  //  · AFTER THE LAST `revise`. The lane reads the trace to find out what refused
  //    each name, so it must read the trace FINAL. `diversity`, `slot-cut`, the
  //    watch re-label, `called-observation` and `shadow-capped` are all written
  //    above, and a lane that ran before them would be reasoning about verdicts
  //    the run had not finished handing down (Task-1 review handoff).
  //  · AFTER BOTH CUTS, which is what makes "never counts toward the 3/side caps"
  //    structural rather than a rule someone has to remember: `pickDiverseSide`
  //    has already run on both sides and cannot see this row. Exactly the
  //    observation promotion's pattern, one push into `liveCalls`.
  //  · BEFORE `trace.build`, so its own `called-wildcard` row (and the
  //    `priorGate` naming the gate it overrode) is in the day's record.
  //
  // AND THE ROW IT PUBLISHES IS A REAL ONE: it goes through publishCall like
  // everything else, so it is priced against the same calibration, stamped
  // `accrual: 'sized'` (it is the reader's money — a quarter of the rung), given
  // levels by the same `levelsFor` the near-miss rows use, and graded on the same
  // ten sessions. What it does NOT get: leverage (structurally — `mapInstrument`
  // is only reached at `sizedFraction === 1`, and a quarter can never be that),
  // a place in the risk ladder's rung evidence, or a vote in factor IC.
  /** The side the experiment seated on, when it did — read once, at the board
   * write, to keep the empty-side COPY honest (see there). */
  let wildcardSide: 'long' | 'short' | null = null
  // The seam (wildcardLane.ts / missLedger.ts). `WILDCARD=off` is 3d's own
  // switch, and `REGRET=off` silences the lane too: a wildcard whose causal
  // write-back is dead is an experiment with no readout, and the 3b parity walk
  // must not find one arm publishing rows the other cannot.
  if (!wildcardDisabled() && !regretDisabled()) {
    try {
      const selection = selectWildcard({
        traceRows: trace.rows(),
        nearMisses,
        catalystBySym,
        // the HYGIENIC per-gate read, never the raw stat: bare mirror rows are
        // excluded there, and thinness measured off counts that let a gate argue
        // with itself would spend the slot on the wrong gate (Task-1 review).
        gateStats: gateAttribution(await store.read(MISS_LEDGER_KEY)),
        calibration,
        regime,
        deadZone: gates.deadZone,
        levMap: cfg.levMap ?? {},
        outstanding: outstandingWildcard,
        exclusions: {
          earningsSyms: earningsSet,
          publishedKeys,
          liveSyms: new Set(liveCalls.map(l => l.sym.toUpperCase())),
        },
      })
      // `candidate.miss` is the near-miss row BY REFERENCE (Task-1 review): it is
      // read here and never written, so the array the trace serialises below is
      // the same array the run built.
      const c = selection?.candidate
      if (c) {
        const m = c.miss
        const smallCap = m.capUsdM != null && m.capUsdM < SMALL_CAP_MAX_USD_M
        // the SAME arithmetic composeCall and the near-miss rows use — an
        // experiment must never drift onto levels of its own
        const { expectedMovePct, entry, stop, target } = levelsFor(m.core, m.capacityPct ?? 0, m.atrNow, m.lastClose, smallCap)
        // STOP MANDATORY, and checked rather than assumed. `levelsFor` always
        // returns a number, but a flat tape (ATR 0) returns the ENTRY as that
        // number, and a "stop" the price is already through is not a falsifier —
        // it is a row that would be stopped out before the reader read it. The
        // lanes refuse their own degenerate shapes for the same reason
        // (dipLane.ts, velocityLane.ts); the slot refuses this one and simply
        // goes unspent, which is what an experiment slot does when the day has
        // nothing worth testing.
        const shapeOk = c.side === 'long' ? stop < entry && target > entry : stop > entry && target < entry
        if (!shapeOk) {
          console.log(`WILDCARD: ${c.sym} ${c.side} declined — degenerate levels (entry ${entry}, stop ${stop}, target ${target})`)
        } else {
          const { thesis, falsifier } = wildcardThesis({ sym: c.sym, side: c.side, stop, hypothesis: selection.hypothesis })
          const record: Prediction['wildcard'] = {
            gate: c.gate,
            priority: selection.priority,
            hypothesis: selection.hypothesis,
            gateEvidenceN: c.gateEvidenceN,
          }
          const row = publishCall(
            {
              sym: c.sym,
              side: c.side,
              composite: m.core,
              factors: Object.fromEntries(
                (Object.entries(m.factors) as [FactorName, FactorScore][]).map(([name, f]) => [name, { ...f, weight: weights.current[name] ?? 0 }]),
              ) as Record<FactorName, FactorScore & { weight: number }>,
              setup: setupFamilyOf(c.side, m.stage as Stage | null),
              // NO EVIDENCE CONTRACT, and the row says so out loud. This call was
              // refused before an evidence read was ever assessed, so claiming a
              // contract here would invent the one thing the experiment is
              // deliberately doing without.
              evidence: {
                coverage: 0,
                famAgree: 0,
                contract: false,
                contextPts: 0,
                detail: `wildcard experiment — core read ${m.core}, blocked at ${c.gate} (${c.gateEvidenceN} outcomes on that gate in the miss ledger); no evidence contract was ever assessed`,
              },
              expectedMovePct,
              entry,
              stop,
              target,
              capacityPct: m.capacityPct ?? 0,
              smallCap,
              // THE REAL FLAG, not the assumption. The lane excludes earnings
              // names outright — those are the braces — and this is the belt: it
              // is the same question `publishCall`'s `preGradeShadow` asks of
              // every other row, asked of this one too, off the same
              // `earningsSet` the composite loop reads (keyed by base symbol).
              // Hardcoding `false` here made the lane's own exclusion the ONLY
              // thing standing between the reader and a quarter-size bet on a
              // coin flip, and left the defensive shadow branch below permanently
              // unreachable — a belt that cannot be reached is not a belt.
              earningsRisk: earningsSet.has(baseSym(c.sym)),
              stage: m.stage,
              note: `🃏 wildcard experiment — quarter size, testing the ${c.gate} gate; one real outcome is worth more to the engine than a hundred refusals`,
              thesis,
              falsifier,
            },
            m.capUsdM,
            // the tag IS the separable record the ladder and factor IC key off
            // (catalyst.ts). `reason` carries the hypothesis, which is built from
            // numbers only and never from model prose.
            { kind: WILDCARD_CATALYST_KIND, side: c.side, reason: selection.hypothesis, strength: 0 },
            false,
            WILDCARD_SIZE_CAP,
            undefined,
            record,
          )
          if (row.shadow) {
            // THE BELT UNDER THE LANE'S BRACES. `preGradeShadow` stands over the
            // publish override in all three of its arms — an earnings print, an
            // unroutable short, a lane stand-down — and the lane refuses the first
            // two itself, so this branch fires only when the lane has regressed.
            // That is what it is for, and it is now genuinely armed: the earnings
            // flag above is the day's real one rather than a hardcoded `false`, so
            // a lane that stopped excluding prints is caught HERE instead of
            // publishing a quarter-size bet on a binary event.
            //
            // A shadowed wildcard bought nothing — a shadow yields no causal
            // evidence, which is the only thing the slot exists to buy — so it is
            // not seated, and the record is put back the way it was: the row
            // leaves the board it never earned a place on, and the trace returns
            // to naming the gate that refused the name. Leaving it would strand a
            // `called-shadow` code on a row appearing in nothing the reader or the
            // ledger ever sees, which is precisely the silence the `shadow-capped`
            // code was added to end.
            //
            // AND THE SLOT IS NOT SPENT (adjudicated, fix wave F-3). The one-slot
            // invariant is enforced by the outstanding scan, which reads
            // `predictions:<date>` for a wildcard row with no calibrated outcome — and
            // this row reaches no ledger at all: `shadows` was assembled before
            // this lane ran, so a row pushed into `board` afterwards is in neither
            // collection, and the splice above leaves `board` as it found it. The
            // slot is therefore spent on EVIDENCE and never on an attempt, which
            // is the only reading consistent with why it exists: holding the lane
            // shut for the calibrated horizon a refused row would have taken to grade
            // would cost the engine a real causal sample to punish it for a bug.
            const at = board.indexOf(row)
            if (at !== -1) board.splice(at, 1)
            trace.revise(c.sym, c.gate, { side: c.side, source: sources.get(c.sym)?.source, detail: 'wildcard declined — it would have published as a shadow' })
            console.log(`WILDCARD: ${c.sym} ${c.side} would have shadowed on publication — not seated`)
          } else {
            wildcardSide = row.side
            liveCalls.push(row)
            // …and it joins the RANKING rather than trailing the array, exactly
            // as a promoted observation does. Re-sorted here and only here, so a
            // day with no wildcard runs the single sort it always ran.
            liveCalls.sort((a, b) => (a.watchOnly ? 1 : 0) - (b.watchOnly ? 1 : 0) || Math.abs(b.composite) - Math.abs(a.composite))
            // A NEAR MISS ON THE SAME CHART YIELDS. The empty-side publisher above
            // ran first in wall-clock order, but the wildcard is the earlier
            // DECISION — it was chosen from that very near-miss list, and the
            // choice is what the day's record is about. The two rows would also
            // share an id (`date:SYM:side`), so one of them must go, and it is
            // never in doubt which: a near miss is a printed comparison with no
            // belief, no size and no stop the reader may act on, published only
            // so a blank side has a name; a wildcard is a sized call with a
            // falsifier. Both sides of the chart are cleared, on the same
            // one-direction-per-chart rule the observation promotion obeys.
            for (let i = nearMissRows.length - 1; i >= 0; i--)
              if (nearMissRows[i].sym.toUpperCase() === row.sym.toUpperCase()) nearMissRows.splice(i, 1)
            console.log(
              `WILDCARD: ${row.sym} ${row.side} taken at ${WILDCARD_SIZE_CAP}× the rung (priority ${selection.priority}) — testing ${c.gate}: ${selection.hypothesis}`,
            )
          }
        }
      }
    } catch (e) {
      // Fail-soft, exactly as the trace write is: the board, both cuts and every
      // ordinary row are already decided by the time this runs, so a lane failure
      // costs the day's experiment and nothing the reader was owed.
      console.log('WILDCARD: lane skipped —', String(e).slice(0, 160))
    }
  }

  // ---- ₿ THE CRYPTO LANE: a partitioned cohort riding the same board ----
  //
  // PHASE-A RELAXATION 3 of 3, and the one the other two exist for. Everything
  // above this line is the equity engine, unchanged: crypto never entered
  // `sources`, `candleMap`, the roster, the breadth read, the near-miss list,
  // the wildcard pool or either 3-per-side cut. The lane runs HERE for exactly
  // the reason the wildcard does — after both cuts, so "never consumes an equity
  // slot" is structural rather than a rule somebody has to remember, and before
  // `trace.build`, so its rows are in the day's record.
  //
  // WHAT MAKES IT A PARTITION AND NOT A UNIVERSE EXTENSION:
  //  · its own tape — `cryptoCandleMap` (B1): completed bars only, so the run at
  //    05:35 and the run at 07:35 read the identical series and nothing is scored
  //    against a bar that is still moving.
  //  · its own clock — `CRYPTO_TECH_WINDOWS`, threaded from B1's adjudicated
  //    table, so "the 50-day" is 70 crypto bars and the RSI period is still 14.
  //  · its own tape read — BTC's regime, computed BEFORE `composeCall` and fed
  //    in, never relabelled after.
  //  · its own calibration and its own rung, read from the crypto blobs.
  //  · its own momentum denominator — absolute, because the grade is absolute.
  //  · ONE ROW PER SIDE, capped at half the rung, paper-only until a tracker
  //    exists.
  //
  // Fail-soft in full, the wildcard's own pattern: the board, both cuts and every
  // equity row are already decided by the time this runs, so a lane failure costs
  // the day's crypto rows and nothing the reader was owed.
  /** The sides a crypto row seated on — read at the board write, so the
   * empty-side copy cannot tell the reader "nothing tradeable on the long side"
   * over a row they can see. Exactly the wildcard's `wildcardSide` problem. */
  const cryptoSides = new Set<'long' | 'short'>()
  if (cryptoUniverse.length) {
    try {
      // BTC's tape is fetched whether or not the reader watches it: the cohort's
      // regime is BTC's, and an ETH call priced against `unknown` would fail its
      // evidence contract for want of a fetch nobody made.
      const wanted = [...new Set([CRYPTO_REGIME_SYMBOL, ...cryptoUniverse])]
      const cryptoTapes = await cryptoCandleMap(deps.candles, nowSec, wanted)
      const cryptoRegime = cryptoRegimeFrom(cryptoTapes.get(CRYPTO_REGIME_SYMBOL))
      const { cal: cryptoCal, risk: cryptoRisk } = await loadCryptoState(store, today)
      const cryptoAnchor = cryptoGradeBaseRate(cryptoCal)
      const cryptoGradedN = cryptoBaseHitRate(cryptoCal).n
      const cap = cryptoSizeCap(cryptoRisk.rung)
      console.log(`CRYPTO: lane on for ${cryptoUniverse.join(', ')} — BTC tape ${cryptoRegime}, ${cryptoGradedN} graded outcomes, cap ${cap}× at R${cryptoRisk.rung}`)

      const drafts: { sym: string; call: EngineCall; routed: boolean }[] = []
      for (const sym of cryptoUniverse) {
        const candles = cryptoTapes.get(sym)
        if (!candles || candles.length < CRYPTO_TECH_WINDOWS.minHistory) {
          trace.record(sym, 'no-candles', { source: 'watchlist', detail: `crypto cohort — no completed tape, or fewer than ${CRYPTO_TECH_WINDOWS.minHistory} bars of one` })
          continue
        }
        const read = technicalStage(sym, candles, CRYPTO_TECH_WINDOWS)
        if (!read) {
          trace.record(sym, 'no-data', { source: 'watchlist', detail: 'crypto cohort — no technical stage read off the tape' })
          continue
        }
        const closes = candles.map(c => c.c)
        // THE FACTOR TABLE FOR A COIN, and every null in it is a decision.
        //  · technical  — the same `technicalFactor`, over a read taken on the
        //                 crypto clock. A core factor and a contract leg.
        //  · momentum   — absolute, 29 bars, in the pair's own travel. The other
        //                 contract leg, and the reason it exists (recon §2.4).
        //  · sector     — there is no crypto sector ETF. A real null.
        //  · seasonality— NOT READ: `seasonalitySummary` divides its history by
        //                 252 sessions, which reports a 5-year crypto tape as
        //                 7.2 years and lets the library call a tendency
        //                 "reliable" on data it never had (B1's
        //                 `seasonalityYear252`). A wrong number is worse than no
        //                 number in a CORE family.
        //  · smartMoney — 13F filings do not hold coins.
        //  · insiders   — Form 4s do not either.
        //  · catalyst   — the news-catalyst LLM can nominate a pair, and the tag
        //                 also RELAXES the expected-move floor. Deliberately not
        //                 wired in B2: that is a gate relaxation, and this task
        //                 relaxes only the sites it builds.
        //  · social / channels — RETIRED, not missing (Stage 1c-R). Both were
        //                 live reads that genuinely cover crypto — the crowd
        //                 names BTC and pundits voice sides on it — and the
        //                 owner's directive retires them anyway: a coin is
        //                 priced off the chart and a little major news, nothing
        //                 else. The directive itself is the `detail` at both
        //                 sites, dated, so a future session cannot mistake these
        //                 two nulls for wiring nobody finished.
        //  · news       — THE "little", and the only context factor left. It is
        //                 fed the ALIAS-matched titles (`cryptoTitleMatches`),
        //                 not the base-ticker scan: `\bBTC\b` never matches
        //                 "Bitcoin", so this factor was near-dead every morning.
        //                 "Major" is enforced by `newsFactor`'s own polarity
        //                 lexicon (a headline with no polarity word casts no
        //                 votes), and "a little" by CRYPTO_WEIGHTS' halved news
        //                 weight inside `gates.contextMaxPts` — two independent
        //                 bounds, either of which alone keeps a headline from
        //                 creating a call or flipping its side.
        const factors: Record<FactorName, FactorScore> = {
          technical: technicalFactor(read),
          momentum: cryptoMomentumFactor(closes),
          // · bandwidth  — NOT READ, and deliberately, on the same argument as
          //                 seasonality above. The percentile is computable off
          //                 any closes, but the evidence behind the factor is not
          //                 transferable: the walk-forward study measured 1,855
          //                 EQUITIES on daily SESSION bars against SPY, and a
          //                 24/7 pair's "120 sessions" is a different window over
          //                 a tape with no close, no open and no index to be
          //                 relative to. A number computed on evidence that never
          //                 covered it is worse than no number in a CORE family.
          bandwidth: { score: null, detail: 'not read for crypto — the bandwidth study measured equity sessions' },
          sector: sectorFactor(null),
          social: { score: null, detail: `not read for crypto — ${CRYPTO_CHART_ONLY_DIRECTIVE}` },
          channels: { score: null, detail: `not read for crypto — ${CRYPTO_CHART_ONLY_DIRECTIVE}` },
          insiders: insiderFactor(undefined),
          news: newsFactor(cryptoTitleMatches(sym, mediaTitles)),
          seasonality: { score: null, detail: 'not read for crypto — the seasonality library counts a year in 252 sessions' },
          smartMoney: smartMoneyFactor(null),
          catalyst: catalystFactor(null),
        }
        // …and `capUsdM: null` is CHOSEN here, not merely absent (B1's
        // `CRYPTO_NOT_A_CLOCK`, stopMult): a coin has no market cap, so
        // `levelsFor` puts the stop at 1.5×ATR rather than the small-cap 2×.
        // That is the right arm — the widening exists for names that GAP on thin
        // books, and a 24/7 pair with continuous liquidity is the opposite case
        // — and it is the single highest-leverage ratio in the lane, because it
        // sets the close-through rate `gradeCryptoPrediction` walks.
        //
        // `earningsWithinHorizon: false` is likewise chosen, and it closes a real
        // trap: `earningsSet.has(baseSym('BTC-USD'))` strips to 'BTC', so a real
        // equity ticker BTC printing results would have shadowed every bitcoin
        // call for as long as it was on the calendar. A coin has no print.
        //
        // NO SECOND PASS. The equity loop re-scores with the world-tape nudge;
        // the crypto lane does not, because that tape is equity indices, US
        // futures and the VIX. The row records mult 1, which is the truth.
        //
        // THE VECTOR IS FROZEN, and it is not `weights.current` (Stage 1c-R).
        // That vector is the EQUITY IC-nudged one; crypto rows are quarantined
        // out of the loop that moves it, so reading it here let equity evidence
        // silently re-bucket crypto composites with no learning path behind it.
        // `CRYPTO_WEIGHTS` is the same vector with news halved — see its note.
        const drafted = composeCall({
          sym,
          factors,
          weights: CRYPTO_WEIGHTS,
          regime: cryptoRegime,
          capacityPct: cryptoCapacity(closes),
          atr: atr(candles, CRYPTO_TECH_WINDOWS.atr)[candles.length - 1],
          lastClose: closes[closes.length - 1],
          entryQuality: read.entryQuality,
          stage: read.stage,
          earningsWithinHorizon: false,
          capUsdM: null,
          gates,
          catalyst: null,
          volumeConfirmed: read.volumeConfirmed,
          // THE EVIDENCE CONTRACT, FOR A COIN [decided, per B1's binding 4].
          // `confirmingLeg` is `sector || breadth || volume`, and a crypto row
          // has no sector ETF and no honest breadth vote (three pairs, against
          // `breadthAbove50`'s ten-series floor) — so it collapses to VOLUME
          // CONFIRMED, and `famAgree >= 2` runs over the two core factors that
          // can score at all. The contract therefore MEANS, for a crypto row:
          // "the chart read and the month's absolute move both point this way,
          // BTC's tape is known, and today's volume paid for it." That is
          // reachable — which is the whole point, because an unreachable
          // contract is the A-grade bug in a different costume — and it is
          // strictly harder than the equity version in one respect: an equity
          // row can pass on breadth alone, where this one cannot.
          breadthKnown: false,
        })
        if (isRejection(drafted)) {
          trace.record(sym, drafted.gate, {
            side: drafted.side,
            source: 'watchlist',
            detail: `crypto cohort · ${drafted.detail ?? ''}`,
            // the SAME frozen vector the call would have been priced by — a near
            // miss reported against a different vector from the one that refused
            // it is a number nobody can trace back to the decision
            core: coreCompositeOf(factors, CRYPTO_WEIGHTS, cryptoRegime),
          })
          continue
        }
        // ROUTED = THIS SIDE'S OWN 1× TRACKER EXISTS, which is exactly the
        // instrument `publishCall` will mint for the row (a geared ticket needs
        // a full-size row, and the cohort cap forbids one until the record
        // earns it). Asking the same question the mint asks is what keeps the
        // voice and the row's `paperOnly` from ever disagreeing — with ONE
        // known ledger-only exception (1c-R review): a SHADOWED crypto row
        // sizes to zero, so the mint's `sizedFraction > 0` gate leaves it
        // `paperOnly: true, instrument: null` while this note carries no
        // paper-only sentence. The board never shows shadows, so no reader
        // sees the pair disagree; recorded here rather than special-cased.
        drafts.push({ sym, call: drafted, routed: !!spotInstrument(drafted.side, sym, cfg.levMap ?? {}) })
      }

      // ONE ROW PER SIDE (the ratified slot rule). Cut BEFORE publication, not
      // after, so a pair that lost the slot never reaches the ledger at all —
      // the shadow budget and the equity cuts both work that way, and a
      // published-then-discarded row is the `shadow-capped` silence again.
      for (const side of ['long', 'short'] as const) {
        const ofSide = drafts.filter(d => d.call.side === side).sort((a, b) => Math.abs(b.call.composite) - Math.abs(a.call.composite))
        for (const [i, d] of ofSide.entries()) {
          if (i > 0) {
            trace.record(d.sym, 'slot-cut', { side, source: 'watchlist', detail: 'crypto cohort · one row per side, and a stronger pair took it' })
            continue
          }
          const voice = cryptoVoice({ sym: d.sym, side: d.call.side, gradedN: cryptoGradedN, routed: d.routed, sizeCap: cap })
          const row = publishCall(
            {
              ...d.call,
              note: `${d.call.note} · ${voice.note}`,
              evidence: { ...d.call.evidence, detail: `${d.call.evidence.detail} · ${voice.detail}` },
            },
            null,
            null,
            false,
            cap,
            undefined,
            undefined,
            { state: cryptoCal, anchor: cryptoAnchor, rung: cryptoRisk.rung, regime: cryptoRegime },
          )
          // SEATED BY HAND, because both collections were assembled above: a
          // live crypto row joins the ranking exactly as a promoted observation
          // and a wildcard do, and a shadowed one joins the shadow set so the
          // ledger still grades it. Without this a crypto shadow would appear in
          // nothing at all and its `called-shadow` code would be a publication
          // that never happened.
          if (row.shadow) {
            // …and the shadow dedup applies to it like anything else: a crypto
            // short the route blocks every morning must not enter the ledger
            // seven times a week while its first copy is still ungraded.
            if (outstandingShadowKeys.has(`${row.sym}:${row.side}`)) {
              const at = board.indexOf(row)
              if (at !== -1) board.splice(at, 1)
              trace.revise(row.sym, 'shadow-capped', { side: row.side, source: 'watchlist', detail: 'crypto cohort · already outstanding as an ungraded shadow' })
              continue
            }
            shadows.push(row)
          } else {
            liveCalls.push(row)
            cryptoSides.add(row.side)
          }
          console.log(`CRYPTO: ${row.sym} ${row.side} — grade ${row.grade}, ${row.riskPct}% risk${row.shadow ? ' (shadow)' : ''}${row.paperOnly ? ', paper only' : ''}`)
        }
      }
      if (cryptoSides.size) liveCalls.sort((a, b) => (a.watchOnly ? 1 : 0) - (b.watchOnly ? 1 : 0) || Math.abs(b.composite) - Math.abs(a.composite))
    } catch (e) {
      console.log('CRYPTO: lane skipped —', String(e).slice(0, 160))
    }
  }

  // …and the two published collections, assembled LAST so the experiment is in
  // both: the board the reader sees, and the ledger that will grade it.
  const live = [...liveCalls, ...nearMissRows]
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
    // …and the CALIBRATED one, which a rerun could otherwise drop on a row that
    // matured between the morning's two passes. It is stored like the other two
    // (only ~31 sessions of reruns could ever see it here) and losing it would
    // re-open a settled wildcard debt and re-book a graded row.
    if (prev?.outcome21) p.outcome21 = prev.outcome21
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

  // Visible research sleeves. They are observations, not board calls: no sleeve
  // can size money until its own independent campaigns earn calibration.
  const socialLabRows: SocialLabRow[] = social.map(s => ({
    sym: s.sym,
    redditMentions: s.redditMentions,
    surgeMultiple: s.surgeMultiple,
    sources: s.sources,
    stocktwits: s.stocktwits,
    channelNet: s.channelNet,
    redditUpvotes: s.redditUpvotes,
    redditRankDelta: s.redditRankDelta,
    channelBreadth: s.channelBreadth,
    channelVelocity: s.channelVelocity,
    channelHype: s.channelHype ?? undefined,
    capUsdM: sources.get(s.sym)?.capUsdM ?? null,
    last: candleMap.get(s.sym)?.at(-1)?.c ?? null,
  }))
  const socialHistory = (await store.read<SocialHistoryPoint[]>('engine-lab-social-history')) ?? []
  const shortAlways = ['GOOG', 'GOOGL']
  const shortBySym = new Map<string, ShortHorizonRow>()
  for (const sym of candidateSyms) {
    const candles = candleMap.get(sym)
    if (candles) shortBySym.set(sym, { sym, candles, earningsRisk: earningsSet.has(baseSym(sym)) })
  }
  await mapLimit(shortAlways, 2, async sym => {
    if (shortBySym.has(sym)) return
    const candles = await deps.candles(sym).catch(() => null)
    if (candles && candles.length >= 90) shortBySym.set(sym, { sym, candles, earningsRisk: earningsSet.has(baseSym(sym)) })
  })
  const shortLabRaw = shortHorizonObservations([...shortBySym.values()], nowSec, shortAlways)
  const qualityLab = qualityDipObservations(
    candidateSyms.flatMap(sym => {
      const candles = candleMap.get(sym)
      return candles ? [{ sym, candles, qualityProxy: sleeveSet.has(sym) || (sources.get(sym)?.capUsdM ?? 0) > 10_000, capUsdM: sources.get(sym)?.capUsdM ?? null }] : []
    }),
    spy,
    nowSec,
  )
  const socialLabRaw = socialIgnitionObservations(socialLabRows, socialHistory, nowSec)
  let labRecords = (await store.read<StrategyLabRecord[]>('engine-lab-ledger')) ?? []
  // OLDEST open records first, not newest. `labRecords` is append-ordered, so the
  // tail is the batch pushed last run — precisely the records whose horizon has
  // NOT elapsed, which `gradeStrategyObservation` answers `null` for every time.
  // A `slice(-60)` therefore spent the whole grading budget on immature rows and
  // stranded the mature ones behind it: they never graded, and `slice(-500)`
  // eventually evicted them ungraded, so the sleeves' evidence counters — the
  // 40-campaign promotion gate in docs/ENGINE_V2.md — undercounted for ever.
  // Identical behaviour while fewer than 60 records are open; the budget and its
  // fetch concurrency are unchanged. [discovery: a 320-name pool rotates the
  // top-8/top-16 across nearly twice as many symbols, so the open set crosses 60
  // far sooner than it did at 180.]
  const openLab = labRecords.filter(r => !r.outcome).slice(0, 60)
  await mapLimit(openLab, 6, async record => {
    const candles = candleMap.get(record.sym) ?? (await deps.candles(record.sym).catch(() => null))
    if (!candles) return
    const outcome = gradeStrategyObservation(record, candles)
    if (outcome) record.outcome = outcome
  })
  const labCampaignKey = (record: Pick<StrategyLabRecord, 'sleeve' | 'sym' | 'side'>) => record.sleeve === 'short-horizon'
    ? `${record.sleeve}:${record.sym}`
    : `${record.sleeve}:${record.sym}:${record.side}`
  const activeLab = new Set(labRecords.filter(r => !r.outcome).map(labCampaignKey))
  for (const obs of [...shortLabRaw, ...qualityLab, ...socialLabRaw]) {
    const key = labCampaignKey(obs)
    const recordableShortForecast = obs.sleeve === 'short-horizon' && obs.entry != null
    const recordableSetup = obs.state === 'setup' && obs.side !== 'neutral' && obs.entry != null
    if ((!recordableShortForecast && !recordableSetup) || activeLab.has(key)) continue
    labRecords.push(obs)
    activeLab.add(key)
  }
  labRecords = labRecords.slice(-500)
  const qualityCalibrated = calibrateLabObservations(qualityLab, labRecords)
  const socialLab = calibrateLabObservations(socialLabRaw, labRecords)
  const shortLab = calibrateLabObservations(shortLabRaw, labRecords)
  const qualityEvidenceN = labRecords.filter(r => r.sleeve === 'quality-dip' && r.outcome).length
  const socialEvidenceN = labRecords.filter(r => r.sleeve === 'social-ignition' && r.outcome).length
  const shortHorizonEvidenceN = labRecords.filter(r => r.sleeve === 'short-horizon' && r.outcome).length
  const compositeEvidenceN = Object.values(calibration.buckets).reduce((sum, bucket) => sum + (bucket.n ?? 0), 0)
  await store.write('engine-lab-ledger', labRecords)
  await store.write('engine-lab', buildEngineLab({ date: today, nowSec, shortHorizon: shortLab, quality: qualityCalibrated, social: socialLab, compositeEvidenceN, shortHorizonEvidenceN, qualityEvidenceN, socialEvidenceN }))
  await store.write('engine-lab-social-history', appendSocialHistory(socialHistory, socialLabRows, nowSec))

  // …and the empty-side COPY drops the side an experiment seated on (Stage 3d).
  // Every one of those sentences opens "nothing tradeable on the X side today"
  // (format.ts), and a side carrying a quarter-size wildcard has something
  // tradeable on it — so leaving the line would print a claim the reader can see
  // is false, right above the row that falsifies it.
  //
  // Only the READER-FACING copy is dropped. The funnel's own `emptySides` goes
  // into the trace below UNTOUCHED: the ordinary funnel really did empty that
  // side for that reason, that is what the record is for, and the walk reads it.
  // Nothing about the gate is lost on the board either — the row carries the gate
  // it overrode in `wildcard.gate`, and the trace row keeps it as `priorGate`.
  // …and a CRYPTO row seated on an empty side does exactly the same thing to
  // that sentence, so it is dropped on the same rule. A board that says "nothing
  // tradeable on the long side today" above a half-size bitcoin call is a board
  // the reader can see is lying — and the funnel's own `emptySides` still goes
  // into the trace untouched below, because the ORDINARY funnel really did empty
  // that side and that is what the record is for.
  const filledSides = new Set<string>([...cryptoSides, ...(wildcardSide ? [wildcardSide] : [])])
  const shownEmptySides = filledSides.size ? Object.fromEntries(Object.entries(emptySides).filter(([s]) => !filledSides.has(s))) : emptySides
  // the paper and the app see only live calls; shadows exist to be graded
  await store.write('engine-board', {
    date: today,
    generatedAt: nowSec,
    regime,
    board: live,
    // additive + optional: why a side carries nothing tradeable, when one doesn't
    emptySides: Object.keys(shownEmptySides).length ? shownEmptySides : undefined,
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
    // would book one name twice. `hasRow` asks about the NAME across every key it
    // could hold: rows are keyed by (name, side) now, so asking about one key
    // would count a name that has a row on the other side.
    let notCandidate = 0
    for (const sym of offered) if (!sources.has(sym) && !trace.hasRow(sym)) notCandidate++
    trace.notCandidate(notCandidate)
    // ---- WHERE THE BOARD AND THE RECORD DELIBERATELY DISAGREE (Stage 3d) ----
    //
    // On a day the experiment slot is spent, two of the arguments below are NOT
    // what the reader was shown, and both divergences run the same way: the board
    // is edited so it cannot state something false, and the record keeps the
    // funnel's own truth for the walk, the ledger and 3b's accounting to read. A
    // reviewer finding one of them alone will read it as a bug, so they are named
    // together, once, at the site where the record is written:
    //
    //  1. `emptySides` — the BOARD blob (above) drops the side the wildcard seated
    //     on, because "nothing tradeable on the short side today" is a claim the
    //     reader can falsify by looking at the sized row beneath it. THIS argument
    //     is untouched: the ordinary funnel really did empty that side, for that
    //     reason, and the gate the wildcard overrode survives on the row
    //     (`wildcard.gate`) and in its trace row (`priorGate`) either way.
    //  2. `nearMisses` — this argument still names the row the wildcard was chosen
    //     FROM, which by now is a published call. The board dropped its near-miss
    //     twin (they would otherwise share an id, and a near miss is a printed
    //     comparison with no belief, size or stop beside a sized experiment); the
    //     record keeps it because the choice was MADE from this list, and a list
    //     edited to remove the row that was chosen would make the day's selection
    //     unreproducible — the one thing a replay of this lane has to be able to do.
    //
    // The trace ROWS carry no such divergence: the wildcard's own key holds
    // `called-wildcard` with `priorGate` naming its gate, which is exactly what
    // the reader was shown.
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
    // CONTAINMENT (1c A1): a held coin is counted (the reader owns it) but the
    // engine neither fetches its tape nor writes it a technical read — no
    // equity-factor lens on a 24/7 asset, and no candle spend on a contained name.
    const held = holdings.slice(0, ROSTER_MAX).filter(p => !isCryptoSymbol(p.symbol))
    holdingsCount = holdings.slice(0, ROSTER_MAX).length
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
  // THE LOOKBACK IS THE HORIZON, plus two sessions of slack for an index that
  // skipped a day. It was ten — exactly the OLD calibrated horizon — and stayed
  // there when v4 moved the grade to 21 sessions, so the open book stopped
  // tracing a live call eleven sessions before its grade could land: the row
  // vanished from the reader's open positions while the engine was still going
  // to grade it. The window must outlive the grade, never the other way round.
  const index = ((await store.read<string[]>('predictions-index')) ?? []).slice(-(CALIBRATED_HORIZON_SESSIONS + 2)).filter(d => d < today)
  const open: Prediction[] = []
  for (const date of index) {
    for (const p of (await store.read<Prediction[]>(`predictions:${date}`)) ?? []) {
      // watch-only calls aren't positions — the open book traces trades. Open
      // until the CALIBRATED grade lands — `calibratedOutcomeOf`, 21 sessions
      // since CALIB_DEF_VERSION v4 — matching openTrace's GRADE_HORIZON so
      // "grades in N sessions" stays truthful. It read `outcome10` here, which
      // since v4 is a DISPLAY lens the ledger keeps and nothing grades on: a row
      // was dropped from the open book at 10 sessions and then graded at 21,
      // eleven sessions after the reader last saw it.
      //
      // …and a CRYPTO row is kept OUT of the open book entirely (Stage 1c Phase
      // B, and it is a DECISION rather than an omission — B1's
      // `CRYPTO_LOOKBACKS.openTraceGradeHorizon` names the fork). `openTrace.ts`
      // holds the equity answers to both of the questions the crypto partition
      // re-answers: `GRADE_HORIZON = CALIBRATED_HORIZON_SESSIONS` and an entry of
      // `t >= dayEpoch` (the publication day's own bar). Fed a crypto row
      // unchanged it would tell the reader a call matures on the equity clock
      // when the grade will strike it on fourteen bars, and base its running P&L on a bar the return leg
      // deliberately forfeits — the trace and the grade contradicting each other
      // in front of the person holding the position. The other arm of the fork
      // (teaching openTrace the crypto clock) is a real option and is recorded as
      // the follow-up; until it is taken, saying nothing beats saying something
      // the grade will contradict. The row still grades, still teaches the crypto
      // partition, and still appears on the board and in the ledger.
      if (!p.shadow && !p.watchOnly && !calibratedOutcomeOf(p) && p.cohort !== 'crypto') open.push(p)
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
