import { atr, rsi } from '../indicators'
import { assessBusinessHealth, type BusinessHealthSnapshot } from '../businessHealth'
import type { Candle } from '../types'
import { exchangeFor } from '../symbols'
import { sessionUtcHours } from '../rvol'
import type { ResearchLearningSnapshot } from './researchLearning'
import { summarizeReportTrends } from '../reportTrends'

/** The visible research layer. A sleeve may inspect a setup before it has earned
 * the right to place it; `mode` is therefore part of the data rather than UI
 * decoration. Nothing in this module sizes a trade. */
export type StrategySleeve = 'short-horizon' | 'quality-dip' | 'social-ignition' | 'macro-event' | 'composite-control'
export type LabState = 'setup' | 'watch' | 'avoid' | 'collecting'

export interface ForecastContract {
  definition: 'benchmark-excess-no-close-stop-v1' | 'target-before-stop-v1' | 'three-session-direction-v1'
  label: string
  /** Separates model revisions without changing the event being predicted. */
  modelVersion?: string
  probabilityBasis?: 'historical-analogues' | 'forward-campaigns'
  probabilityUpInterval?: [number, number]
  probabilityDownInterval?: [number, number]
  baselineProbabilityUp?: number | null
  baselineBrierScore?: number | null
  brierSkillScore?: number | null
  directionN?: number
  barrierN?: number
  horizonSessions: number
  probabilityEdge?: number | null
  probabilityTarget?: number | null
  probabilityStop?: number | null
  probabilityUp?: number | null
  probabilityDown?: number | null
  probabilityFlat?: number | null
  expectedMovePct?: number | null
  expectedLowPct?: number | null
  expectedHighPct?: number | null
  liveN?: number
  directionAccuracy?: number | null
  brierScore?: number | null
  calibratedN: number
  provisional: boolean
  calibrationBasis?: 'pooled-forward-campaigns' | 'validated-report-trend'
  conditioningVersion?: 'report-trend-dirichlet-prequential-v1'
  conditioningContext?: string | null
  conditioningStatus?: 'collecting' | 'validated' | 'no-improvement'
  conditioningReason?: string
  conditioningN?: number
  conditioningPooledN?: number
  conditioningValidationN?: number
  conditioningBrierScore?: number | null
  conditioningBaselineBrierScore?: number | null
  conditioningBrierSkillScore?: number | null
  conditioningBrierMetric?: 'three-class-target-stop-neither'
  pooledProbabilityTarget?: number | null
  pooledProbabilityStop?: number | null
  probabilityNeither?: number | null
}

export interface StrategyObservation {
  id: string
  sleeve: StrategySleeve
  sym: string
  side: 'long' | 'short' | 'neutral'
  state: LabState
  score: number
  entry: number | null
  stop: number | null
  target: number | null
  detectedAt: number
  availableAt: number
  reasons: string[]
  risks: string[]
  dataGaps: string[]
  metrics: Record<string, number | string | boolean | null>
  forecast: ForecastContract
}

export interface StrategyOutcome {
  entry: number
  exit: number
  firstBarrier: 'target' | 'stop' | 'none'
  targetHit: boolean
  stopHit: boolean
  returnPct: number
  sessions: number
  closeReturnPct?: number
  finishedHigher?: boolean
  directionHit?: boolean
  executionStatus?: 'filled' | 'cancelled-gap' | 'not-applicable'
  executionVersion?: string
  /** Venue close of the declared horizon, independent of provider bar stamps. */
  horizonEndAt?: number
  executionStartAt?: number
}

export interface StrategyLabRecord extends StrategyObservation {
  lastGradeAttemptAt?: number
  outcome?: StrategyOutcome
}

export interface EngineLabSnapshot {
  version: 2
  date: string
  generatedAt: number
  mode: 'shadow'
  cadence: string
  sleeves: {
    key: StrategySleeve
    label: string
    status: 'control' | 'shadow' | 'collecting'
    purpose: string
    evidenceN: number
    promotionRule: string
  }[]
  observations: StrategyObservation[]
  learning?: ResearchLearningSnapshot
}

export interface SocialLabRow {
  sym: string
  name?: string
  redditRank?: number | null
  redditMentions: number | null
  redditEngagement?: number | null
  surgeMultiple: number | null
  sources: number
  stocktwits: boolean
  channelNet: number | null
  channelMentions?: number | null
  redditUpvotes?: number | null
  redditRankDelta?: number | null
  channelBreadth?: number | null
  channelVelocity?: number | null
  channelHype?: number
  evidenceScore?: number
  capUsdM?: number | null
  last?: number | null
}

export interface SocialHistoryPoint {
  observedAt: number
  rows: {
    sym: string; name?: string; redditRank?: number | null; redditMentions: number | null; sources: number
    redditEngagement?: number | null; surgeMultiple?: number | null; stocktwits?: boolean; channelNet?: number | null; channelMentions?: number | null
    redditUpvotes?: number | null; redditRankDelta?: number | null
    channelBreadth?: number | null; channelVelocity?: number | null; channelHype?: number
    evidenceScore?: number
  }[]
}

const pct = (now: number, then: number) => (then > 0 ? ((now - then) / then) * 100 : 0)
const r1 = (n: number) => Math.round(n * 10) / 10
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)))
const r2 = (n: number) => Math.round(n * 100) / 100
const r4 = (n: number) => Math.round(n * 10_000) / 10_000
const DAY_SEC = 86_400
const SHORT_HORIZON = 3
export const SHORT_HORIZON_MODEL_VERSION = 'nonoverlapping-analogues-v2'
export const LAB_EXECUTION_VERSION = 'next-open-costs-v2'
export const QUALITY_DIP_MODEL_VERSION = 'quality-dip-report-trends-v4'
export const SOCIAL_IGNITION_MODEL_VERSION = 'social-ignition-next-open-v2'
const SLIPPAGE = 0.001

/** Yahoo timestamps daily bars at the open. Without venue session metadata we
 * conservatively wait until 21:30 UTC for today's equity bar; crypto bars finish
 * at midnight UTC. Reject malformed OHLC rather than compressing a holding
 * horizon by silently deleting a bad session. */
export function completedLabCandles(candles: Candle[], nowSec: number, sym: string): Candle[] {
  if (!Number.isFinite(nowSec) || candles.some(c => !Number.isFinite(c.t))) return []
  const today = Math.floor(nowSec / DAY_SEC)
  const crypto = exchangeFor(sym) === 'CRYPTO'
  const known = candles.filter(c => Number.isFinite(c.t) && c.t <= nowSec &&
    (Math.floor(c.t / DAY_SEC) < today || (!crypto && nowSec % DAY_SEC >= 21.5 * 3600)))
  if (known.some(c => ![c.o, c.h, c.l, c.c, c.v].every(Number.isFinite) ||
    Math.min(c.o, c.h, c.l, c.c) <= 0 || c.v < 0 ||
    c.l > Math.min(c.o, c.c) || c.h < Math.max(c.o, c.c) || c.l > c.h)) return []
  const sessions = new Map<number, Candle>()
  for (const c of [...known].sort((a, b) => a.t - b.t)) sessions.set(Math.floor(c.t / DAY_SEC), c)
  return [...sessions.values()]
}

/** Daily-bar timestamps identify a UTC session date, not its execution time:
 * Stooq uses midnight and Yahoo normally uses the exchange open. */
function labSessionBounds(t: number, sym: string): { open: number; close: number } {
  const day = Math.floor(t / DAY_SEC) * DAY_SEC
  const exchange = exchangeFor(sym)
  if (exchange === 'CRYPTO') return { open: day, close: day + DAY_SEC }
  const hours = sessionUtcHours(exchange, day)
  return { open: day + hours.open * 3600, close: day + hours.close * 3600 }
}

/** Descriptive 95% Wilson interval, not proof of out-of-sample calibration. */
function frequencyInterval(hits: number, n: number): [number, number] {
  if (!n) return [0, 1]
  const z2 = 1.96 ** 2
  const p = hits / n
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n)
  const half = 1.96 * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / (1 + z2 / n)
  return [r4(Math.max(0, centre - half)), r4(Math.min(1, centre + half))]
}

interface ShortFeature {
  index: number
  values: number[]
  return1Pct: number
  return3Pct: number
  return10Pct: number
  rsi14: number
  volumeRatio: number
}

const mean = (xs: number[]) => xs.reduce((sum, n) => sum + n, 0) / Math.max(1, xs.length)
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const at = (sorted.length - 1) * q
  const lo = Math.floor(at)
  const hi = Math.ceil(at)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo)
}

/** Features are deliberately compact and price-derived. They can be recreated at
 * every historical timestamp without using revised fundamentals or future news. */
function shortFeatures(candles: Candle[]): ShortFeature[] {
  const closes = candles.map(c => c.c)
  const rsis = rsi(closes)
  const out: ShortFeature[] = []
  for (let i = 20; i < candles.length; i++) {
    const last = closes[i]
    const return1Pct = pct(last, closes[i - 1])
    const return3Pct = pct(last, closes[i - 3])
    const return10Pct = pct(last, closes[i - 10])
    const sma10 = mean(closes.slice(i - 9, i + 1))
    const daily = closes.slice(i - 10, i + 1).slice(1).map((c, j) => pct(c, closes[i - 10 + j]))
    const dailyMean = mean(daily)
    const volatility10 = Math.sqrt(mean(daily.map(n => (n - dailyMean) ** 2)))
    const avgVolume20 = mean(candles.slice(i - 19, i + 1).map(c => Math.max(0, c.v)))
    const volumeRatio = avgVolume20 > 0 ? candles[i].v / avgVolume20 : 1
    const rsi14 = rsis[i] ?? 50
    out.push({
      index: i,
      values: [return1Pct, return3Pct, return10Pct, rsi14, pct(last, sma10), volatility10, Math.log(Math.max(0.1, volumeRatio))],
      return1Pct,
      return3Pct,
      return10Pct,
      rsi14,
      volumeRatio,
    })
  }
  return out
}

export interface ShortHorizonRow {
  sym: string
  candles: Candle[]
  earningsRisk?: boolean
}

/** A point-in-time, three-session nearest-analogue forecast. The displayed
 * probability is the smoothed frequency among similar states in that symbol's
 * own prior tape; the separate liveN/accuracy fields measure truly forward
 * StreetSignal forecasts as they mature. */
export function shortHorizonObservations(
  rows: ShortHorizonRow[],
  nowSec: number,
  alwaysInclude: string[] = [],
): StrategyObservation[] {
  const observations: StrategyObservation[] = []
  const required = new Set(alwaysInclude.map(s => s.toUpperCase()))
  for (const row of rows) {
    const candles = completedLabCandles(row.candles, nowSec, row.sym)
    const lastBar = candles.at(-1)
    const problem = candles.length < 90
      ? 'At least 90 valid completed daily sessions are needed; history is missing, short or contains invalid OHLC.'
      : lastBar && nowSec - lastBar.t > 7 * DAY_SEC
        ? 'The latest completed price is over seven calendar days old; refresh market data before forecasting.'
        : null
    if (problem) {
      if (required.has(row.sym.toUpperCase())) observations.push({
        id: `${nowSec}:short-horizon:${row.sym}`, sleeve: 'short-horizon', sym: row.sym,
        side: 'neutral', state: 'collecting', score: 0, entry: null, stop: null, target: null,
        detectedAt: nowSec, availableAt: nowSec, reasons: [problem], risks: [], dataGaps: [problem],
        metrics: { signalSessionAt: lastBar?.t ?? null },
        forecast: { definition: 'three-session-direction-v1', modelVersion: SHORT_HORIZON_MODEL_VERSION,
          probabilityBasis: 'historical-analogues', label: 'Close after 3 sessions versus the latest completed close',
          horizonSessions: SHORT_HORIZON, calibratedN: 0, liveN: 0, provisional: true },
      })
      continue
    }
    const features = shortFeatures(candles)
    const current = features.at(-1)
    if (!current) continue
    // The current forecast starts only after all three forward closes are known
    // for every historical state. Features and normalisation use prior data only.
    const history = features.filter(f => f.index + SHORT_HORIZON < candles.length).slice(-500)
    if (history.length < 30) continue
    const dimensions = current.values.map((_, d) => history.map(f => f.values[d]))
    const centres = dimensions.map(mean)
    const scales = dimensions.map((xs, d) => Math.max(0.05, Math.sqrt(mean(xs.map(x => (x - centres[d]) ** 2)))))
    const ranked = history
      .map(f => ({
        feature: f,
        distance: Math.sqrt(mean(f.values.map((value, d) => ((value - current.values[d]) / scales[d]) ** 2))),
      }))
      .sort((a, b) => a.distance - b.distance || b.feature.index - a.feature.index)
    // Adjacent three-session outcomes share two returns. Keep the closest state,
    // then embargo overlapping outcome windows before adding another analogue.
    const nearest: typeof ranked = []
    for (const candidate of ranked) {
      if (nearest.every(n => Math.abs(n.feature.index - candidate.feature.index) >= SHORT_HORIZON)) nearest.push(candidate)
      if (nearest.length >= 60) break
    }
    const forwardReturns = nearest.map(({ feature }) => pct(candles[feature.index + SHORT_HORIZON].c, candles[feature.index].c))
    const up = forwardReturns.filter(n => n > 0).length
    const down = forwardReturns.filter(n => n < 0).length
    const flat = forwardReturns.length - up - down
    // A fixed non-overlapping prior prevents a small selected cohort from
    // claiming certainty, while preserving the symbol's unconditional drift.
    const baselineReturns = history.filter((_, i) => i % SHORT_HORIZON === 0)
      .map(f => pct(candles[f.index + SHORT_HORIZON].c, candles[f.index].c))
    const baselineUp = (baselineReturns.filter(n => n > 0).length + 1) / (baselineReturns.length + 3)
    const baselineDown = (baselineReturns.filter(n => n < 0).length + 1) / (baselineReturns.length + 3)
    const baselineFlat = 1 - baselineUp - baselineDown
    const priorN = 12
    const probabilityUp = (up + priorN * baselineUp) / (forwardReturns.length + priorN)
    const probabilityDown = (down + priorN * baselineDown) / (forwardReturns.length + priorN)
    const probabilityFlat = (flat + priorN * baselineFlat) / (forwardReturns.length + priorN)
    const probabilityUpInterval = frequencyInterval(up, forwardReturns.length)
    const probabilityDownInterval = frequencyInterval(down, forwardReturns.length)
    const expectedMovePct = quantile(forwardReturns, 0.5)
    const expectedLowPct = quantile(forwardReturns, 0.2)
    const expectedHighPct = quantile(forwardReturns, 0.8)
    const supported = forwardReturns.length >= 20 && mean(nearest.map(n => n.distance)) <= 2
    const longEdge = supported && probabilityUp >= 0.6 && probabilityUpInterval[0] > 0.5 && expectedMovePct >= 0.35
    const shortEdge = supported && probabilityDown >= 0.6 && probabilityDownInterval[0] > 0.5 && expectedMovePct <= -0.35
    const side: StrategyObservation['side'] = longEdge ? 'long' : shortEdge ? 'short' : 'neutral'
    const last = candles.at(-1)!.c
    const typicalAbsMove = quantile(forwardReturns.map(Math.abs), 0.5)
    const riskPct = Math.max(0.8, Math.min(4, typicalAbsMove * 0.65))
    const rewardPct = Math.max(1.2, Math.min(8, typicalAbsMove * 1.1))
    const stop = side === 'neutral' ? null : r2(last * (side === 'long' ? 1 - riskPct / 100 : 1 + riskPct / 100))
    const target = side === 'neutral' ? null : r2(last * (side === 'long' ? 1 + rewardPct / 100 : 1 - rewardPct / 100))
    const strength = Math.max(probabilityUp, probabilityDown) - 0.5
    const score = clamp(30 + strength * 260 + Math.min(10, forwardReturns.length / 6) + Math.min(10, Math.abs(expectedMovePct) * 1.5))
    const lean = probabilityUp >= probabilityDown + 0.04 ? 'up' : probabilityDown >= probabilityUp + 0.04 ? 'down' : 'flat'
    observations.push({
      id: `${nowSec}:short-horizon:${row.sym}`,
      sleeve: 'short-horizon',
      sym: row.sym,
      side,
      state: side === 'neutral' ? 'watch' : 'setup',
      score,
      entry: last,
      stop,
      target,
      detectedAt: nowSec,
      availableAt: nowSec,
      reasons: [
        `Historical up estimate ${Math.round(probabilityUp * 100)}% from ${forwardReturns.length} non-overlapping analogues (${up} finished higher), shrunk toward the symbol’s prior rate`,
        `analogue median move ${expectedMovePct >= 0 ? '+' : ''}${r1(expectedMovePct)}%; historical 20th–80th percentile range ${r1(expectedLowPct)}% to ${r1(expectedHighPct)}%`,
        `current tape: 1d ${current.return1Pct >= 0 ? '+' : ''}${r1(current.return1Pct)}%, 3d ${current.return3Pct >= 0 ? '+' : ''}${r1(current.return3Pct)}%, RSI ${Math.round(current.rsi14)}`,
      ],
      risks: [
        ...(row.earningsRisk ? ['earnings fall inside the engine risk window; a gap can overwhelm a three-session model'] : []),
        ...(Math.abs(current.return3Pct) >= 7 ? ['the three-session move is already extended, increasing reversal and gap risk'] : []),
        ...(side === 'neutral' ? ['neither direction clears the historical frequency, uncertainty, similarity and median-move gates'] : []),
        ...(!supported ? ['fewer than 20 usable analogues or the current state is too far from prior states; no supported directional setup'] : []),
        'historical frequencies and intervals are descriptive; predictive skill must be earned in forward forecasts',
      ],
      dataGaps: ['live pre-market gaps, options positioning and intraday order flow are not in this daily-close forecast'],
      metrics: {
        lean,
        signalSessionAt: candles.at(-1)!.t,
        analogueCandidates: history.length,
        analogueEffectiveN: nearest.length,
        rangeCoverage: 0.6,
        rangeLowQuantile: 0.2,
        rangeHighQuantile: 0.8,
        return1Pct: r1(current.return1Pct),
        return3Pct: r1(current.return3Pct),
        return10Pct: r1(current.return10Pct),
        rsi14: r1(current.rsi14),
        volumeRatio20: r2(current.volumeRatio),
        analogueDistance: r2(mean(nearest.map(n => n.distance))),
        earningsRisk: Boolean(row.earningsRisk),
      },
      forecast: {
        definition: 'three-session-direction-v1',
        modelVersion: SHORT_HORIZON_MODEL_VERSION,
        probabilityBasis: 'historical-analogues',
        probabilityUpInterval,
        probabilityDownInterval,
        baselineProbabilityUp: r4(baselineUp),
        label: 'Close after 3 sessions versus the latest completed close; range is historical 20th–80th percentiles',
        horizonSessions: 3,
        probabilityUp: r4(probabilityUp),
        probabilityDown: r4(probabilityDown),
        probabilityFlat: r4(probabilityFlat),
        probabilityTarget: null,
        probabilityStop: null,
        expectedMovePct: r1(expectedMovePct),
        expectedLowPct: r1(expectedLowPct),
        expectedHighPct: r1(expectedHighPct),
        calibratedN: forwardReturns.length,
        liveN: 0,
        directionAccuracy: null,
        brierScore: null,
        provisional: true,
      },
    })
  }
  const sorted = observations.sort((a, b) => b.score - a.score)
  const visible = sorted.filter(o => required.has(o.sym.toUpperCase()))
  for (const obs of sorted) if (!required.has(obs.sym.toUpperCase()) && visible.length < 14) visible.push(obs)
  return visible.sort((a, b) => b.score - a.score)
}

export interface QualityDipRow {
  sym: string
  candles: Candle[]
  /** Retained for callers; market size or index membership does not prove health. */
  qualityProxy?: boolean
  capUsdM: number | null
  businessHealth?: BusinessHealthSnapshot | null
  earningsRisk?: boolean
}

export function qualityDipObservations(rows: QualityDipRow[], spy: Candle[], nowSec: number): StrategyObservation[] {
  const spyTape = completedLabCandles(spy, nowSec, 'SPY')
  const spyAt = (t: number) => [...spyTape].reverse().find(c => Math.floor(c.t / DAY_SEC) <= Math.floor(t / DAY_SEC))
  const out: StrategyObservation[] = []
  for (const row of rows) {
    const tape = completedLabCandles(row.candles, nowSec, row.sym)
    if (tape.length < 60 || nowSec - tape.at(-1)!.t > 7 * DAY_SEC) continue
    const closes = tape.map(c => c.c)
    const last = closes.at(-1)!
    const high252 = Math.max(...closes.slice(-252))
    const drawdownPct = pct(last, high252)
    // A drawdown is a research candidate, never evidence that a business is good.
    if (drawdownPct > -8) continue
    const return5 = pct(last, closes.at(-6)!)
    const return20 = pct(last, closes.at(-21)!)
    const spyEnd = spyAt(tape.at(-1)!.t)
    const spyStart = spyAt(tape.at(-21)!.t)
    const relative20 = spyEnd && spyStart ? return20 - pct(spyEnd.c, spyStart.c) : null
    const lastRsi = rsi(closes).at(-1) ?? 50
    const sma10 = mean(closes.slice(-10))
    const sma50 = mean(closes.slice(-50))
    const sma200 = closes.length >= 200 ? mean(closes.slice(-200)) : null
    const recentLow = Math.min(...tape.slice(-5).map(c => c.l))
    const priorLow = Math.min(...tape.slice(-10, -5).map(c => c.l))
    const higherLow = recentLow > priorLow
    const stabilising = last > closes.at(-2)! && last > sma10 && higherLow
    const knife = return5 < -12 || drawdownPct < -45
    const atr14 = atr(tape).at(-1) ?? 0
    const stop = r2(Math.min(Math.min(...tape.slice(-20).map(c => c.l)) - atr14 * 0.5, last - atr14 * 2))
    // A half-recovery is a published scenario to test, not an expected return or
    // a price target justified by valuation. No return-to-high assumption.
    const target = r2(last + (high252 - last) * 0.5)
    const riskPct = stop > 0 ? (last - stop) / last * 100 : 100
    const rewardRisk = stop > 0 && last > stop ? (target - last) / (last - stop) : 0
    const business = row.businessHealth?.sym.toUpperCase() === row.sym.toUpperCase() ? row.businessHealth : null
    const health = assessBusinessHealth(business, nowSec)
    const trajectory = summarizeReportTrends(business?.reportHistory ?? [], nowSec)
    if (row.businessHealth && !business) health.gaps.push('The supplied financial statements belong to a different symbol.')
    const geometry = stop > 0 && riskPct <= 18 && rewardRisk >= 1.5
    const state: LabState = knife || health.status === 'deteriorating' || trajectory.status === 'deteriorating' ? 'avoid'
      : health.status === 'healthy' && trajectory.status !== 'insufficient' && stabilising && geometry && !row.earningsRisk ? 'setup' : 'watch'
    const score = clamp(15 + (health.status === 'healthy' ? 30 : health.status === 'unknown' ? 0 : -20) +
      Math.min(20, Math.abs(drawdownPct) * 0.6) + (stabilising ? 20 : 0) +
      (last > sma50 ? 8 : 0) + (relative20 != null && relative20 > -8 ? 5 : 0) +
      (rewardRisk >= 1.5 ? 5 : 0) - (knife ? 30 : 0) +
      (trajectory.status === 'improving' ? 8 : trajectory.status === 'stable' ? 3 : trajectory.status === 'deteriorating' ? -18 : 0))
    out.push({
      id: `${nowSec}:quality-dip:${row.sym}`,
      sleeve: 'quality-dip', sym: row.sym, side: 'long', state, score,
      entry: last, stop: stop > 0 ? stop : null, target: stop > 0 ? target : null,
      detectedAt: nowSec, availableAt: nowSec,
      reasons: [
        `${r1(Math.abs(drawdownPct))}% below the highest close in ${Math.min(252, tape.length)} completed sessions; the price drop alone does not establish value`,
        ...health.reasons.slice(0, 2),
        `Business trajectory: ${trajectory.status} across ${trajectory.observations} dated reports`,
        stabilising ? 'price reclaimed its 10-session average with a higher five-session low and a rising latest close' : 'a higher low and recovery above the 10-session average are not both confirmed',
        `63-session research scenario: recover half the drawdown to ${target}; ${r1(rewardRisk)}× reward/risk before execution costs`,
      ],
      risks: [
        ...health.risks,
        ...(trajectory.status === 'deteriorating' ? ['repeated weakening report comparisons override the latest standalone healthy screen'] : []),
        ...(knife ? ['severe drawdown or ongoing sharp selling; a healthy historical filing does not stop a falling price'] : []),
        ...(!geometry ? ['the recovery scenario does not offer 1.5× reward/risk within an 18% stop distance'] : []),
        ...(row.earningsRisk ? ['earnings are inside the near-term risk window; wait for the event before a setup'] : []),
        ...(last < sma50 ? ['price remains below its 50-session average'] : []),
        ...(sma200 != null && last < sma200 ? ['price remains below its 200-session average; the longer trend has not recovered'] : []),
        ...(relative20 != null && relative20 < -10 ? [`20-session relative strength is ${r1(relative20)}pp versus SPY`] : []),
        'reported business health is backward-looking; valuation, competitive changes and new bad news can prevent recovery',
      ],
      dataGaps: [
        ...health.gaps,
        ...(trajectory.status === 'insufficient' ? ['a sustained business trajectory is not established from comparable historical reports'] : []),
        ...(sma200 == null ? ['fewer than 200 completed sessions: long-term moving-average trend unavailable'] : []),
        ...(relative20 == null ? ['date-aligned SPY comparison unavailable'] : []),
        'valuation, forward estimate revisions and the cause of the drawdown require independent review',
      ],
      metrics: {
        financialHealth: health.status, drawdownPct: r1(drawdownPct), return5Pct: r1(return5), return20Pct: r1(return20),
        reportTrend: trajectory.status, reportObservations: trajectory.observations, reportComparisonN: trajectory.comparisonN,
        reportLatestAvailableAt: trajectory.latestAvailableAt, reportRevenueGrowthChangePp: trajectory.metrics.revenueGrowthChangePp,
        reportNetMarginChangePp: trajectory.metrics.netMarginChangePp, reportCashMarginChangePp: trajectory.metrics.freeCashFlowMarginChangePp ?? trajectory.metrics.operatingCashFlowMarginChangePp,
        relative20Pct: relative20 == null ? null : r1(relative20), rsi14: r1(lastRsi), stabilising, higherLow,
        sma10: r2(sma10), sma50: r2(sma50), sma200: sma200 == null ? null : r2(sma200), atrPct: r2(atr14 / last * 100),
        stopDistancePct: r2(riskPct), scenarioRewardRisk: r2(rewardRisk), signalSessionAt: tape.at(-1)!.t,
        capUsdM: row.capUsdM, annualPeriodEnd: business?.annualPeriodEnd ?? null, balancePeriodEnd: business?.balancePeriodEnd ?? null,
        filingAvailableAt: business?.availableAt ?? null, sourceUrl: business?.sourceUrl ?? null,
        revenueGrowthPct: business?.metrics.revenueGrowthPct ?? null, netMarginPct: business?.metrics.netMarginPct ?? null,
        freeCashFlow: business?.metrics.freeCashFlow ?? null, operatingCashFlow: business?.metrics.operatingCashFlow ?? null,
        debtToEquity: business?.metrics.debtToEquity ?? null, currentRatio: business?.metrics.currentRatio ?? null,
        shareCountChangePct: business?.metrics.shareCountChangePct ?? null,
      },
      forecast: {
        definition: 'target-before-stop-v1', modelVersion: QUALITY_DIP_MODEL_VERSION, probabilityBasis: 'forward-campaigns',
        label: 'Half-drawdown recovery scenario before ATR/support stop within 63 sessions; not a valuation target',
        horizonSessions: 63, probabilityTarget: null, probabilityStop: null, calibratedN: 0, liveN: 0, provisional: true,
      },
    })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 8)
}

export function socialIgnitionObservations(rows: SocialLabRow[], history: SocialHistoryPoint[], nowSec: number): StrategyObservation[] {
  const previous = [...history].filter(p => p.observedAt < nowSec).sort((a, b) => b.observedAt - a.observedAt)[0]
  const priorBySym = new Map((previous?.rows ?? []).map(r => [r.sym, r]))
  return rows
    .map(row => {
      const prior = priorBySym.get(row.sym)
      const mentionVelocity = row.redditMentions != null && prior?.redditMentions != null && prior.redditMentions > 0
        ? row.redditMentions / prior.redditMentions
        : null
      const crossPlatform = row.sources >= 2
      const promotionRisk = (row.capUsdM != null && row.capUsdM < 500 && row.sources < 2) || (row.surgeMultiple ?? 0) >= 6
      const directional: StrategyObservation['side'] = (row.channelNet ?? 0) > 0 ? 'long' : (row.channelNet ?? 0) < 0 ? 'short' : 'neutral'
      const last = row.last ?? null
      const stop = last == null || directional === 'neutral' ? null : r1(directional === 'long' ? last * 0.92 : last * 1.08)
      const target = last == null || directional === 'neutral' ? null : r1(directional === 'long' ? last * 1.16 : last * 0.84)
      let score = 20 + row.sources * 16
      if ((row.surgeMultiple ?? 0) >= 2) score += 22
      if ((mentionVelocity ?? 0) >= 1.5) score += 18
      if (row.stocktwits) score += 8
      if ((row.redditRankDelta ?? 0) >= 5) score += 8
      if ((row.channelBreadth ?? 0) >= 2) score += 8
      if ((row.channelVelocity ?? 0) >= 1.5) score += 8
      if ((row.channelHype ?? 0) > 0) score -= Math.min(18, (row.channelHype ?? 0) * 6)
      if (promotionRisk) score -= 22
      score = clamp(score)
      const state: LabState = promotionRisk ? 'avoid' : crossPlatform && ((row.surgeMultiple ?? 0) >= 1.5 || (mentionVelocity ?? 0) >= 1.5) ? 'setup' : 'watch'
      return {
        id: `${nowSec}:social-ignition:${row.sym}`,
        sleeve: 'social-ignition' as const,
        sym: row.sym,
        side: directional,
        state,
        score,
        entry: last == null ? null : r1(last),
        stop,
        target,
        detectedAt: nowSec,
        availableAt: nowSec,
        reasons: [
          `${row.sources} independent source${row.sources === 1 ? '' : 's'} currently naming it`,
          row.surgeMultiple != null ? `Reddit mentions are ${r1(row.surgeMultiple)}× the prior 24h reading` : 'no reliable 24h Reddit comparison yet',
          mentionVelocity != null ? `${r1(mentionVelocity)}× mentions versus the prior StreetSignal scan` : 'first StreetSignal pulse observation; velocity starts after the next scan',
          row.redditRankDelta != null ? `Reddit rank moved ${row.redditRankDelta >= 0 ? '+' : ''}${row.redditRankDelta} places over 24h` : 'Reddit rank movement unavailable',
          row.channelBreadth ? `${row.channelBreadth} independent YouTube channels discussed it` : 'no cross-channel YouTube breadth yet',
        ],
        risks: [
          ...(promotionRisk ? ['promotion/pump risk is elevated; do not chase this state'] : []),
          ...(directional === 'neutral' ? ['attention has no independently confirmed direction yet'] : []),
          ...(row.sources < 2 ? ['single-source attention can disappear as quickly as it arrived'] : []),
          ...((row.channelHype ?? 0) > 0 ? [`${row.channelHype} recent creator mention${row.channelHype === 1 ? '' : 's'} carried promotional or chase language`] : []),
        ],
        dataGaps: ['unique-author, engagement-quality and coordinated-promotion detection need source-level feeds'],
        metrics: { sources: row.sources, redditMentions: row.redditMentions, surgeMultiple: row.surgeMultiple, scanVelocity: mentionVelocity == null ? null : r1(mentionVelocity), stocktwits: row.stocktwits, channelNet: row.channelNet, capUsdM: row.capUsdM ?? null },
        forecast: {
          definition: 'target-before-stop-v1' as const,
          modelVersion: SOCIAL_IGNITION_MODEL_VERSION,
          probabilityBasis: 'forward-campaigns' as const,
          label: 'Target before stop within 10 sessions',
          horizonSessions: 10,
          probabilityTarget: null,
          probabilityStop: null,
          calibratedN: 0,
          provisional: true,
        },
      }
    })
    .filter(o => o.score >= 35)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
}

/** Grade only after the full information horizon exists. Execution begins at the
 * next bar's open; same-bar barrier ambiguity is resolved stop-first. Direction
 * is always measured from the signal close to the horizon close. */
export function gradeStrategyObservation(obs: StrategyObservation, tape: Candle[], nowSec?: number): StrategyOutcome | null {
  const shortHorizon = obs.forecast.definition === 'three-session-direction-v1'
  if (!shortHorizon && (obs.side === 'neutral' || obs.stop == null || obs.target == null)) return null
  const candles = completedLabCandles(tape, nowSec ?? Math.max(...tape.map(c => c.t)) + DAY_SEC, obs.sym)
  const horizon = obs.forecast.horizonSessions
  if (!Number.isInteger(horizon) || horizon < 1 || !Number.isFinite(obs.availableAt)) return null
  const stampedSignal = obs.metrics.signalSessionAt
  const hasSignalStamp = typeof stampedSignal === 'number' && Number.isFinite(stampedSignal)
  // Match the saved source session exactly. For legacy observations only, infer
  // the latest session whose regular close was already known at publication.
  // This also refuses a truncated tape that has lost the signal session.
  const signalIndex = hasSignalStamp
    ? candles.findIndex(c => Math.floor(c.t / DAY_SEC) === Math.floor(stampedSignal / DAY_SEC))
    : candles.reduce((last, c, i) => labSessionBounds(c.t, obs.sym).close <= obs.availableAt ? i : last, -1)
  if (signalIndex < 0 || labSessionBounds(candles[signalIndex].t, obs.sym).close > obs.availableAt) return null
  const start = candles.findIndex(c => labSessionBounds(c.t, obs.sym).open > obs.availableAt)
  // Direction has one fixed end: the third close after the published source
  // session. An intraday publication cannot buy that day's already-past open
  // and must not shift the direction outcome to a fourth close instead.
  const end = shortHorizon ? signalIndex + horizon : start + horizon - 1
  if ((!shortHorizon && start < 0) || end >= candles.length || end <= signalIndex) return null
  const finalClose = candles[end].c
  const signalReference = obs.entry ?? candles[signalIndex].c
  if (!Number.isFinite(signalReference) || signalReference <= 0) return null
  const closeReturnPct = pct(finalClose, signalReference)
  const finishedHigher = closeReturnPct > 0
  const probabilities = [obs.forecast.probabilityUp ?? 0, obs.forecast.probabilityDown ?? 0, obs.forecast.probabilityFlat ?? 0]
  const maximum = Math.max(...probabilities)
  const predictedClass = probabilities.filter(p => p === maximum).length === 1 ? probabilities.indexOf(maximum) : -1
  const actualClass = closeReturnPct > 0 ? 0 : closeReturnPct < 0 ? 1 : 2
  const directionHit = shortHorizon ? predictedClass < 0 ? undefined : predictedClass === actualClass
    : obs.side === 'long' ? finishedHigher : closeReturnPct < 0
  const directionFields = {
    closeReturnPct: r4(closeReturnPct), finishedHigher, directionHit,
    horizonEndAt: labSessionBounds(candles[end].t, obs.sym).close, executionVersion: LAB_EXECUTION_VERSION,
  }
  if (obs.side === 'neutral' || obs.stop == null || obs.target == null || start < 0 || start > end) {
    return { entry: r4(signalReference), exit: r4(finalClose), firstBarrier: 'none', targetHit: false, stopHit: false,
      returnPct: 0, sessions: obs.side === 'neutral' ? horizon : 0, executionStatus: 'not-applicable', ...directionFields }
  }
  const open = candles[start].o
  const executionFields = { ...directionFields, executionStartAt: labSessionBounds(candles[start].t, obs.sym).open }
  const long = obs.side === 'long'
  const entry = open * (long ? 1 + SLIPPAGE : 1 - SLIPPAGE)
  const valid = [obs.stop, obs.target].every(n => Number.isFinite(n) && n > 0) &&
    (long ? obs.stop < entry && entry < obs.target && obs.stop < open && open < obs.target
      : obs.target < entry && entry < obs.stop && obs.target < open && open < obs.stop)
  if (!valid) return { entry: r4(open), exit: r4(open), firstBarrier: 'none', targetHit: false, stopHit: false, returnPct: 0, sessions: 0, executionStatus: 'cancelled-gap', ...executionFields }
  const settle = (exitPrice: number, firstBarrier: StrategyOutcome['firstBarrier'], sessions: number): StrategyOutcome => {
    const exit = exitPrice * (long ? 1 - SLIPPAGE : 1 + SLIPPAGE)
    // Short P&L is (entry - exit) / entry, not entry / exit - 1.
    const ret = (long ? exit - entry : entry - exit) / entry * 100
    return { entry: r4(entry), exit: r4(exit), firstBarrier, targetHit: firstBarrier === 'target',
      stopHit: firstBarrier === 'stop', returnPct: r4(ret), sessions, executionStatus: 'filled', ...executionFields }
  }
  for (let i = start; i <= end; i++) {
    const c = candles[i]
    // An opening gap happens before the bar's high/low. A stop cannot fill at
    // yesterday's level through a gap; a target gap is conservatively capped.
    if (long ? c.o <= obs.stop : c.o >= obs.stop) return settle(c.o, 'stop', i - start + 1)
    if (long ? c.o >= obs.target : c.o <= obs.target) return settle(obs.target, 'target', i - start + 1)
    const stopHit = long ? c.l <= obs.stop : c.h >= obs.stop
    const targetHit = long ? c.h >= obs.target : c.l <= obs.target
    if (stopHit) return settle(obs.stop, 'stop', i - start + 1)
    if (targetHit) return settle(obs.target, 'target', i - start + 1)
  }
  return settle(finalClose, 'none', end - start + 1)
}

/** Keep independent, compatible forecast campaigns. An early barrier exit does
 * not release the remaining direction horizon for a second evidence point. */
export function compatibleLabRecords(obs: StrategyObservation, records: StrategyLabRecord[]): StrategyLabRecord[] {
  const seen = new Set<string>()
  const horizonBySymbol = new Map<string, number>()
  return records
    .filter(r => r.sleeve === obs.sleeve && r.forecast.definition === obs.forecast.definition &&
      r.forecast.horizonSessions === obs.forecast.horizonSessions &&
      r.forecast.modelVersion === obs.forecast.modelVersion && r.outcome &&
      r.availableAt < obs.availableAt && (r.outcome.horizonEndAt == null ||
        (r.outcome.horizonEndAt > r.availableAt && r.outcome.horizonEndAt <= obs.availableAt)))
    .sort((a, b) => a.availableAt - b.availableAt || a.id.localeCompare(b.id))
    .filter(r => {
      const priorEnd = horizonBySymbol.get(r.sym) ?? -Infinity
      if (seen.has(r.id) || r.availableAt <= priorEnd) return false
      seen.add(r.id)
      // Legacy rows without horizonEndAt can still be deduplicated at their
      // publication timestamp; they are never mixed into a newer model version.
      horizonBySymbol.set(r.sym, r.outcome?.horizonEndAt ?? r.availableAt)
      return true
    })
}

export function calibrateLabObservations(observations: StrategyObservation[], records: StrategyLabRecord[]): StrategyObservation[] {
  return observations.map(obs => {
    const own = compatibleLabRecords(obs, records)
    const barrierRecords = own.filter(r => r.side === obs.side && r.side !== 'neutral' && r.stop != null && r.target != null &&
      r.outcome?.executionVersion === LAB_EXECUTION_VERSION && r.outcome.executionStatus === 'filled' && r.outcome.sessions > 0)
    const barrierN = barrierRecords.length
    const targets = barrierRecords.filter(r => r.outcome?.targetHit).length
    const stops = barrierRecords.filter(r => r.outcome?.stopHit).length
    const directions = own.filter(r => typeof r.outcome?.directionHit === 'boolean')
    const directionHits = directions.filter(r => r.outcome?.directionHit).length
    const validProbability = (p: number | null | undefined): p is number => p != null && Number.isFinite(p) && p >= 0 && p <= 1
    const probabilityRows = own.filter(r => validProbability(r.forecast.probabilityUp) && typeof r.outcome?.finishedHigher === 'boolean')
    const brierScore = probabilityRows.length >= 10
      ? mean(probabilityRows.map(r => (r.forecast.probabilityUp! - (r.outcome?.finishedHigher ? 1 : 0)) ** 2))
      : null
    // Compare against the base rate saved when EACH forecast was made, never
    // a base rate estimated using the outcomes we are now evaluating.
    const paired = probabilityRows.filter(r => validProbability(r.forecast.baselineProbabilityUp))
    const baselineBrier = paired.length >= 10
      ? mean(paired.map(r => (r.forecast.baselineProbabilityUp! - (r.outcome?.finishedHigher ? 1 : 0)) ** 2)) : null
    const pairedBrier = paired.length >= 10
      ? mean(paired.map(r => (r.forecast.probabilityUp! - (r.outcome?.finishedHigher ? 1 : 0)) ** 2)) : null
    const shortHorizon = obs.sleeve === 'short-horizon'
    return {
      ...obs,
      forecast: {
        ...obs.forecast,
        calibratedN: shortHorizon ? obs.forecast.calibratedN : barrierN,
        liveN: own.length,
        directionN: directions.length,
        barrierN,
        directionAccuracy: directions.length >= 10 ? r4(directionHits / directions.length) : null,
        brierScore: brierScore == null ? null : r4(brierScore),
        baselineBrierScore: baselineBrier == null ? null : r4(baselineBrier),
        brierSkillScore: baselineBrier != null && baselineBrier > 0 && pairedBrier != null ? r4(1 - pairedBrier / baselineBrier) : null,
        probabilityTarget: barrierN >= 15 ? r4((targets + 1) / (barrierN + 3)) : null,
        probabilityStop: barrierN >= 15 ? r4((stops + 1) / (barrierN + 3)) : null,
        // Sample size alone cannot demonstrate calibration, net expectancy or
        // robustness. Promotion stays explicit; these sleeves cannot size money.
        provisional: true,
      },
    }
  })
}

export function buildEngineLab(args: {
  date: string
  nowSec: number
  quality: StrategyObservation[]
  social: StrategyObservation[]
  shortHorizon?: StrategyObservation[]
  compositeEvidenceN: number
  qualityEvidenceN?: number
  socialEvidenceN?: number
  shortHorizonEvidenceN?: number
  learning?: ResearchLearningSnapshot
}): EngineLabSnapshot {
  return {
    version: 2,
    date: args.date,
    generatedAt: args.nowSec,
    mode: 'shadow',
    cadence: 'Three-session forecasts refresh from the daily close; social observations record every engine scan and are designed for intraday feeds next.',
    sleeves: [
      { key: 'composite-control', label: 'Composite control', status: 'control', purpose: 'Existing calibrated momentum/reversal engine used as the benchmark.', evidenceN: args.compositeEvidenceN, promotionRule: 'Already live; retains its current risk rules.' },
      { key: 'short-horizon', label: '3-Session Forecast', status: 'shadow', purpose: 'Estimate up/down odds and a plausible range over the next three market sessions from point-in-time historical analogues.', evidenceN: args.shortHorizonEvidenceN ?? 0, promotionRule: 'At least 40 non-overlapping live forecasts, useful probability calibration and positive expectancy after next-open execution costs.' },
      { key: 'quality-dip', label: 'Quality Dip Recovery', status: 'shadow', purpose: 'Test 63-session recovery scenarios after reported profitability, cash flow, balance-sheet health and chart stabilisation pass explicit checks.', evidenceN: args.qualityEvidenceN ?? 0, promotionRule: 'At least 40 independent 63-session campaigns, positive net expectancy after costs, acceptable drawdown and sector-appropriate fundamental coverage.' },
      { key: 'social-ignition', label: 'Social Ignition', status: 'shadow', purpose: 'Detect acceleration and cross-platform agreement before attention becomes saturated.', evidenceN: args.socialEvidenceN ?? 0, promotionRule: 'At least 40 independent campaigns; promotion-risk cohort must remain excluded or independently profitable.' },
      { key: 'macro-event', label: 'Macro/Event Transmission', status: 'collecting', purpose: 'Map surprises and global shocks to first- and second-order beneficiaries and victims.', evidenceN: 0, promotionRule: 'Requires timestamped event-surprise data and point-in-time exposure maps before auditioning.' },
    ],
    observations: [...(args.shortHorizon ?? []), ...args.quality, ...args.social].sort((a, b) => b.score - a.score),
    ...(args.learning ? { learning: args.learning } : {}),
  }
}

export function appendSocialHistory(history: SocialHistoryPoint[], rows: SocialLabRow[], nowSec: number): SocialHistoryPoint[] {
  const point: SocialHistoryPoint = {
    observedAt: nowSec,
    rows: rows.map(r => ({
      sym: r.sym,
      name: r.name,
      redditRank: r.redditRank ?? null,
      redditMentions: r.redditMentions,
      sources: r.sources,
      redditEngagement: r.redditEngagement ?? null,
      surgeMultiple: r.surgeMultiple ?? null,
      stocktwits: r.stocktwits,
      channelNet: r.channelNet,
      channelMentions: r.channelMentions ?? null,
      redditUpvotes: r.redditUpvotes ?? null,
      redditRankDelta: r.redditRankDelta ?? null,
      channelBreadth: r.channelBreadth ?? null,
      channelVelocity: r.channelVelocity ?? null,
      channelHype: r.channelHype ?? 0,
      evidenceScore: r.evidenceScore,
    })),
  }
  return [...history.filter(p => p.observedAt !== nowSec), point].sort((a, b) => a.observedAt - b.observedAt).slice(-120)
}
