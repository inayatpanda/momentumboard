import { rsi } from '../indicators'
import type { Candle } from '../types'

/** The visible research layer. A sleeve may inspect a setup before it has earned
 * the right to place it; `mode` is therefore part of the data rather than UI
 * decoration. Nothing in this module sizes a trade. */
export type StrategySleeve = 'short-horizon' | 'quality-dip' | 'social-ignition' | 'macro-event' | 'composite-control'
export type LabState = 'setup' | 'watch' | 'avoid' | 'collecting'

export interface ForecastContract {
  definition: 'benchmark-excess-no-close-stop-v1' | 'target-before-stop-v1' | 'three-session-direction-v1'
  label: string
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
}

export interface StrategyLabRecord extends StrategyObservation {
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
  for (const row of rows) {
    const candles = [...row.candles].sort((a, b) => a.t - b.t)
    if (candles.length < 90) continue
    const features = shortFeatures(candles)
    const current = features.at(-1)
    if (!current) continue
    // Three future closes must already be known for a historical row. Limiting
    // the pool keeps old regimes from overwhelming more relevant recent tape.
    const history = features.filter(f => f.index <= candles.length - 4).slice(-500)
    if (history.length < 30) continue
    const dimensions = current.values.map((_, d) => history.map(f => f.values[d]))
    const centres = dimensions.map(mean)
    const scales = dimensions.map((xs, d) => Math.max(0.05, Math.sqrt(mean(xs.map(x => (x - centres[d]) ** 2)))))
    const nearest = history
      .map(f => ({
        feature: f,
        distance: Math.sqrt(mean(f.values.map((value, d) => ((value - current.values[d]) / scales[d]) ** 2))),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, Math.min(60, history.length))
    const forwardReturns = nearest.map(({ feature }) => pct(candles[feature.index + 3].c, candles[feature.index].c))
    const up = forwardReturns.filter(n => n > 0).length
    const down = forwardReturns.filter(n => n < 0).length
    const flat = forwardReturns.length - up - down
    const probabilityUp = (up + 1) / (forwardReturns.length + 3)
    const probabilityDown = (down + 1) / (forwardReturns.length + 3)
    const probabilityFlat = (flat + 1) / (forwardReturns.length + 3)
    const expectedMovePct = quantile(forwardReturns, 0.5)
    const expectedLowPct = quantile(forwardReturns, 0.2)
    const expectedHighPct = quantile(forwardReturns, 0.8)
    const longEdge = probabilityUp >= 0.6 && expectedMovePct >= 0.35
    const shortEdge = probabilityDown >= 0.6 && expectedMovePct <= -0.35
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
      entry: r2(last),
      stop,
      target,
      detectedAt: nowSec,
      availableAt: nowSec,
      reasons: [
        `${Math.round(probabilityUp * 100)}% of the ${forwardReturns.length} closest historical states finished higher after three sessions`,
        `analogue median move ${expectedMovePct >= 0 ? '+' : ''}${r1(expectedMovePct)}%; middle range ${r1(expectedLowPct)}% to ${r1(expectedHighPct)}%`,
        `current tape: 1d ${current.return1Pct >= 0 ? '+' : ''}${r1(current.return1Pct)}%, 3d ${current.return3Pct >= 0 ? '+' : ''}${r1(current.return3Pct)}%, RSI ${Math.round(current.rsi14)}`,
      ],
      risks: [
        ...(row.earningsRisk ? ['earnings fall inside the engine risk window; a gap can overwhelm a three-session model'] : []),
        ...(Math.abs(current.return3Pct) >= 7 ? ['the three-session move is already extended, increasing reversal and gap risk'] : []),
        ...(side === 'neutral' ? ['neither direction clears a 60% historical frequency with a confirming median move'] : []),
      ],
      dataGaps: ['live pre-market gaps, options positioning and intraday order flow are not in this daily-close forecast'],
      metrics: {
        lean,
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
        label: 'Close after 3 sessions versus today’s close; target/stop checked from the next open',
        horizonSessions: 3,
        probabilityUp: r2(probabilityUp),
        probabilityDown: r2(probabilityDown),
        probabilityFlat: r2(probabilityFlat),
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
  const required = new Set(alwaysInclude.map(s => s.toUpperCase()))
  const sorted = observations.sort((a, b) => b.score - a.score)
  const visible = sorted.filter(o => required.has(o.sym.toUpperCase()))
  for (const obs of sorted) if (!required.has(obs.sym.toUpperCase()) && visible.length < 14) visible.push(obs)
  return visible.sort((a, b) => b.score - a.score)
}

export function qualityDipObservations(
  rows: { sym: string; candles: Candle[]; qualityProxy: boolean; capUsdM: number | null }[],
  spy: Candle[],
  nowSec: number,
): StrategyObservation[] {
  const spyCloses = spy.map(c => c.c)
  const spy20 = spyCloses.length > 20 ? pct(spyCloses.at(-1)!, spyCloses.at(-21)!) : 0
  const out: StrategyObservation[] = []

  for (const row of rows) {
    if (row.candles.length < 60) continue
    const closes = row.candles.map(c => c.c)
    const last = closes.at(-1)!
    const high252 = Math.max(...closes.slice(-252))
    const drawdownPct = pct(last, high252)
    const return5 = pct(last, closes.at(-6)!)
    const return20 = pct(last, closes.at(-21)!)
    const relative20 = return20 - spy20
    const lastRsi = rsi(closes).at(-1) ?? 50
    const recent = row.candles.slice(-5)
    const recentLow = Math.min(...recent.map(c => c.l))
    const stabilising = last > closes.at(-2)! && last >= recentLow * 1.025
    const knife = return5 < -12 && !stabilising
    const usefulDrop = drawdownPct <= -8 && drawdownPct >= -45
    let score = 18
    if (row.qualityProxy) score += 22
    if (usefulDrop) score += Math.min(24, Math.abs(drawdownPct) * 0.8)
    if (lastRsi >= 28 && lastRsi <= 48) score += 12
    if (stabilising) score += 18
    if (relative20 > -8) score += 8
    if (knife) score -= 30
    if (!row.qualityProxy) score -= 15
    score = clamp(score)

    if (!usefulDrop && score < 45) continue
    const state: LabState = knife ? 'avoid' : row.qualityProxy && usefulDrop && stabilising ? 'setup' : 'watch'
    const stop = r1(Math.min(recentLow * 0.99, last * 0.94))
    const target = r1(last + (last - stop) * 2)
    out.push({
      id: `${nowSec}:quality-dip:${row.sym}`,
      sleeve: 'quality-dip',
      sym: row.sym,
      side: 'long',
      state,
      score,
      entry: r1(last),
      stop,
      target,
      detectedAt: nowSec,
      availableAt: nowSec,
      reasons: [
        `${r1(Math.abs(drawdownPct))}% below its 12-month high`,
        stabilising ? 'price has started to stabilise off the five-session low' : 'reversal confirmation has not appeared yet',
        row.qualityProxy ? 'inside the curated core/large-cap quality proxy' : 'not yet inside the quality proxy',
      ],
      risks: [
        ...(knife ? ['still behaving like a falling knife'] : []),
        ...(relative20 < -10 ? [`20-session relative strength is ${r1(relative20)}pp vs SPY`] : []),
      ],
      dataGaps: ['point-in-time cash flow, leverage, estimate revisions and dilution checks are not connected yet'],
      metrics: { drawdownPct: r1(drawdownPct), return5Pct: r1(return5), return20Pct: r1(return20), relative20Pct: r1(relative20), rsi14: r1(lastRsi), stabilising, capUsdM: row.capUsdM },
      forecast: {
        definition: 'target-before-stop-v1',
        label: 'Target before stop within 21 sessions',
        horizonSessions: 21,
        probabilityTarget: null,
        probabilityStop: null,
        calibratedN: 0,
        provisional: true,
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
export function gradeStrategyObservation(obs: StrategyObservation, candles: Candle[]): StrategyOutcome | null {
  const shortHorizon = obs.forecast.definition === 'three-session-direction-v1'
  if (!shortHorizon && (obs.side === 'neutral' || obs.stop == null || obs.target == null)) return null
  const start = candles.findIndex(c => c.t > obs.availableAt)
  if (start === -1) return null
  const horizon = obs.forecast.horizonSessions
  if (start + horizon - 1 >= candles.length) return null
  const entry = candles[start].o
  const finalClose = candles[start + horizon - 1].c
  const signalReference = obs.entry ?? entry
  const closeReturnPct = pct(finalClose, signalReference)
  const finishedHigher = closeReturnPct > 0
  const predictedUp = shortHorizon ? (obs.forecast.probabilityUp ?? 0.5) >= (obs.forecast.probabilityDown ?? 0.5) : obs.side === 'long'
  const directionHit = predictedUp ? finishedHigher : closeReturnPct < 0
  const directionFields = { closeReturnPct: r1(closeReturnPct), finishedHigher, directionHit }
  if (obs.side === 'neutral' || obs.stop == null || obs.target == null) {
    return { entry: r1(entry), exit: r1(finalClose), firstBarrier: 'none', targetHit: false, stopHit: false, returnPct: 0, sessions: horizon, ...directionFields }
  }
  const valid = obs.side === 'long' ? obs.stop < entry && entry < obs.target : obs.target < entry && entry < obs.stop
  if (!valid) return { entry: r1(entry), exit: r1(entry), firstBarrier: 'none', targetHit: false, stopHit: false, returnPct: 0, sessions: 0, ...directionFields }
  for (let i = start; i < start + horizon; i++) {
    const c = candles[i]
    const stopHit = obs.side === 'long' ? c.l <= obs.stop : c.h >= obs.stop
    const targetHit = obs.side === 'long' ? c.h >= obs.target : c.l <= obs.target
    if (stopHit) {
      const ret = (obs.side === 'long' ? obs.stop / entry - 1 : entry / obs.stop - 1) * 100
      return { entry: r1(entry), exit: obs.stop, firstBarrier: 'stop', targetHit: false, stopHit: true, returnPct: r1(ret), sessions: i - start + 1, ...directionFields }
    }
    if (targetHit) {
      const ret = (obs.side === 'long' ? obs.target / entry - 1 : entry / obs.target - 1) * 100
      return { entry: r1(entry), exit: obs.target, firstBarrier: 'target', targetHit: true, stopHit: false, returnPct: r1(ret), sessions: i - start + 1, ...directionFields }
    }
  }
  const exit = candles[start + horizon - 1].c
  const ret = (obs.side === 'long' ? exit / entry - 1 : entry / exit - 1) * 100
  return { entry: r1(entry), exit: r1(exit), firstBarrier: 'none', targetHit: false, stopHit: false, returnPct: r1(ret), sessions: horizon, ...directionFields }
}

export function calibrateLabObservations(observations: StrategyObservation[], records: StrategyLabRecord[]): StrategyObservation[] {
  return observations.map(obs => {
    const own = records.filter(r => r.sleeve === obs.sleeve && r.outcome)
    const barrierRecords = own.filter(r => r.side !== 'neutral' && r.stop != null && r.target != null)
    const barrierN = barrierRecords.length
    const targets = barrierRecords.filter(r => r.outcome?.targetHit).length
    const stops = barrierRecords.filter(r => r.outcome?.stopHit).length
    const directions = own.filter(r => typeof r.outcome?.directionHit === 'boolean')
    const directionHits = directions.filter(r => r.outcome?.directionHit).length
    const probabilityRows = own.filter(r => typeof r.forecast.probabilityUp === 'number' && typeof r.outcome?.finishedHigher === 'boolean')
    const brierScore = probabilityRows.length >= 10
      ? mean(probabilityRows.map(r => ((r.forecast.probabilityUp ?? 0.5) - (r.outcome?.finishedHigher ? 1 : 0)) ** 2))
      : null
    const shortHorizon = obs.sleeve === 'short-horizon'
    return {
      ...obs,
      forecast: {
        ...obs.forecast,
        calibratedN: shortHorizon ? obs.forecast.calibratedN : barrierN,
        liveN: own.length,
        directionAccuracy: directions.length >= 10 ? r2((directionHits + 1) / (directions.length + 2)) : null,
        brierScore: brierScore == null ? null : r2(brierScore),
        probabilityTarget: barrierN >= 15 ? Math.round(((targets + 1) / (barrierN + 2)) * 100) / 100 : null,
        probabilityStop: barrierN >= 15 ? Math.round(((stops + 1) / (barrierN + 2)) * 100) / 100 : null,
        provisional: (shortHorizon ? own.length : barrierN) < 40,
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
      { key: 'quality-dip', label: 'Quality Dip Recovery', status: 'shadow', purpose: 'Find temporarily damaged, inherently stronger businesses after stabilisation—not merely cheap charts.', evidenceN: args.qualityEvidenceN ?? 0, promotionRule: 'At least 40 independent campaigns, positive net expectancy after costs, and acceptable drawdown.' },
      { key: 'social-ignition', label: 'Social Ignition', status: 'shadow', purpose: 'Detect acceleration and cross-platform agreement before attention becomes saturated.', evidenceN: args.socialEvidenceN ?? 0, promotionRule: 'At least 40 independent campaigns; promotion-risk cohort must remain excluded or independently profitable.' },
      { key: 'macro-event', label: 'Macro/Event Transmission', status: 'collecting', purpose: 'Map surprises and global shocks to first- and second-order beneficiaries and victims.', evidenceN: 0, promotionRule: 'Requires timestamped event-surprise data and point-in-time exposure maps before auditioning.' },
    ],
    observations: [...(args.shortHorizon ?? []), ...args.quality, ...args.social].sort((a, b) => b.score - a.score),
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
