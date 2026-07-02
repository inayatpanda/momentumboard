// RETROSPECTIVE REPLAY — stress-tests the prediction engine over the past ~5
// weeks with strict point-in-time discipline: at each simulated prediction
// date D, the engine may only see candle data STRICTLY BEFORE D. Outcomes are
// graded afterward with the real (untruncated) candle history via the real
// gradePrediction(). This script does not modify any engine code — it only
// reuses shared/engine + netlify/functions/lib exports the way the live
// engine does (see netlify/functions/lib/engine.ts for the daily-run idiom).
//
// Run: npx vite-node scripts/engine-replay.ts

import { writeFileSync } from 'node:fs'
import { fetchYahooChart } from '../netlify/functions/lib/yahoo'
import { SECTORS, SECTOR_MEMBERS, computeSectorRows, type SectorRow } from '../netlify/functions/lib/sectors'
import { technicalFactor, momentumFactor, sectorFactor, seasonalityFactor } from '../shared/engine/factors'
import { composeCall, LONG_REGIME_MULT, SHORT_REGIME_MULT } from '../shared/engine/composite'
import { probabilityFor, gradeFor, gradePrediction, type CalibrationState } from '../shared/engine/calibration'
import type { FactorName, FactorScore, PredOutcome } from '../shared/engine/types'
import { technicalStage } from '../shared/technicals'
import { swingCapacity, atr } from '../shared/indicators'
import { regimeFromCandles } from '../shared/setups'
import { seasonalitySummary } from '../shared/seasonality'
import type { Candle, RegimeColor } from '../shared/types'
import seed from '../shared/engine/seed.json'

const OUT_PATH =
  '/private/tmp/claude-501/-Users-inayatsmac-Desktop-Stocks-shares/b1cc1d88-6a0b-4bec-99c4-f50e9f513821/scratchpad/replay-results.json'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---- universe selection (mechanical, anti-hindsight) ----
// 1. every SECTOR_MEMBERS symbol (fixed in code, 55 names)
// 2. + watchlist names NVDA/TSLA/PLTR if not already present
// 3. sort alphabetically, take the first 50 — no cherry-picking by past performance
const sectorMemberSet = [...new Set(Object.values(SECTOR_MEMBERS).flat())]
const watchlistExtras = ['NVDA', 'TSLA', 'PLTR'].filter(s => !sectorMemberSet.includes(s))
const universe = [...sectorMemberSet, ...watchlistExtras].sort().slice(0, 50)

console.log(`universe base pool: ${sectorMemberSet.length} sector members + ${watchlistExtras.length} watchlist extras = ${sectorMemberSet.length + watchlistExtras.length}, take first 50 alphabetically`)
console.log(`universe (${universe.length}): ${universe.join(' ')}`)

const symToSector = new Map<string, string>()
for (const [etf, members] of Object.entries(SECTOR_MEMBERS)) for (const sym of members) symToSector.set(sym, etf)

// ---- fetch 1y candles (once per symbol) ----
async function fetchSafe(sym: string): Promise<Candle[] | null> {
  try {
    const { candles } = await fetchYahooChart(sym, '1y')
    return candles
  } catch (e) {
    console.log(`  fetch failed: ${sym} (${(e as Error).message})`)
    return null
  }
}

console.log('\nfetching candles (1y, 200ms spaced)...')
const spyCandles = await fetchSafe('SPY')
if (!spyCandles) throw new Error('SPY candles unavailable — cannot replay')
await sleep(200)

const sectorCandles = new Map<string, Candle[]>()
const failures: string[] = []
for (const s of SECTORS) {
  const c = await fetchSafe(s.sym)
  if (c) sectorCandles.set(s.sym, c)
  else failures.push(s.sym)
  await sleep(200)
}

const bySym = new Map<string, Candle[]>()
for (const sym of universe) {
  const c = await fetchSafe(sym)
  if (c) bySym.set(sym, c)
  else failures.push(sym)
  await sleep(200)
}

console.log(`\nfetched ${bySym.size}/${universe.length} universe symbols, ${sectorCandles.size}/${SECTORS.length} sector ETFs, SPY ok`)
if (failures.length) console.log(`fetch failures: ${failures.join(' ')}`)

// ---- derive prediction dates: last 5 Mondays STRICTLY before today with
// >= 11 trading sessions of SPY candle data after them (D..D+10 must all
// exist so both the 5- and 10-session outcomes are gradable). Derived purely
// from SPY candle timestamps, not calendar guessing. ----
const todayStr = new Date().toISOString().slice(0, 10)
interface DateCandidate { iso: string; idx: number; epoch: number }
const mondayCandidates: DateCandidate[] = []
for (let i = 0; i < spyCandles.length; i++) {
  const iso = new Date(spyCandles[i].t * 1000).toISOString().slice(0, 10)
  if (new Date(spyCandles[i].t * 1000).getUTCDay() !== 1) continue // Monday only
  if (iso >= todayStr) continue // strictly before today
  if (spyCandles.length - i < 11) continue // need D..D+10 = 11 sessions of forward data
  mondayCandidates.push({ iso, idx: i, epoch: spyCandles[i].t })
}
const predictionDates = mondayCandidates.slice(-5)
if (predictionDates.length < 5) {
  console.log(`WARNING: only found ${predictionDates.length} valid Mondays in the fetched 1y SPY window (need 5) — proceeding with what's available`)
}
console.log(`\nprediction dates (${predictionDates.length}): ${predictionDates.map(d => d.iso).join(', ')}`)

// ---- diagnostic-only helper: mirrors composeCall's weighted-average +
// regime-adjustment math so we can report "nearest miss" composites for
// no-call symbols (never used to gate an actual call — composeCall does that). ----
function rawAdj(factors: Record<FactorName, FactorScore>, weights: Record<FactorName, number>, regime: RegimeColor | 'unknown'): number | null {
  let num = 0
  let den = 0
  for (const name of Object.keys(factors) as FactorName[]) {
    const f = factors[name]
    if (f.score == null) continue
    const w = weights[name] ?? 0
    num += w * f.score
    den += w
  }
  if (!den) return null
  const raw = num / den
  const side: 'long' | 'short' = raw >= 0 ? 'long' : 'short'
  return raw * (side === 'long' ? LONG_REGIME_MULT[regime] : SHORT_REGIME_MULT[regime])
}

// ---- engine day-one state: the committed seed, exactly as the live engine
// would have used it on day one (no relearning mid-replay — that's a
// separate, harder experiment than this stress test). ----
const weightsCurrent = seed.weights.current as unknown as Record<FactorName, number>
const calibrationState = seed.calibration as unknown as CalibrationState

interface CallRecord {
  date: string
  sym: string
  side: 'long' | 'short'
  status: 'live' | 'shadow'
  grade: 'A' | 'B' | 'C' | null
  probability: number
  provisional: boolean
  composite: number
  stage: string | null
  entryQuality: string | null
  capacityPct: number
  entry: number
  stop: number
  target: number
  outcome5: PredOutcome | null
  outcome10: PredOutcome | null
}

interface DateSummary {
  date: string
  symbolsEvaluated: number
  skippedInsufficientHistory: number
  calls: number
  live: number
  shadow: number
  noCalls: number
  nearMisses: { sym: string; adj: number }[]
}

const allCalls: CallRecord[] = []
const perDateSummary: DateSummary[] = []
let sanityCheckPrinted = false
let integrityViolations = 0
let integrityChecks = 0

for (const pd of predictionDates) {
  const D = pd.epoch
  const spySlice = spyCandles.filter(c => c.t < D)
  if (spySlice.length < 60) {
    console.log(`skip date ${pd.iso}: insufficient SPY history before it (${spySlice.length} bars)`)
    continue
  }
  integrityChecks++
  if (spySlice[spySlice.length - 1].t >= D) { integrityViolations++; throw new Error(`point-in-time violation: SPY slice for ${pd.iso}`) }
  const spySliceCloses = spySlice.map(c => c.c)
  const regime = regimeFromCandles(spySlice, spySlice)
  const month = Number(pd.iso.slice(5, 7))

  // sector rows computed ONCE per date, from sector-ETF candles truncated before D
  const sectorSliceMap = new Map<string, Candle[]>()
  for (const [etf, candles] of sectorCandles) {
    const slice = candles.filter(c => c.t < D)
    if (slice.length) sectorSliceMap.set(etf, slice)
  }
  const sectorRows: SectorRow[] = computeSectorRows(sectorSliceMap, spySlice)

  let evaluated = 0
  let skipped = 0
  let live = 0
  let shadow = 0
  let noCalls = 0
  const nearMisses: { sym: string; adj: number }[] = []

  for (const sym of universe) {
    const full = bySym.get(sym)
    if (!full) continue
    const slice = full.filter(c => c.t < D)
    if (slice.length < 60) { skipped++; continue }

    integrityChecks++
    if (slice[slice.length - 1].t >= D) { integrityViolations++; throw new Error(`point-in-time violation: ${sym} slice for ${pd.iso}`) }

    evaluated++
    const sliceCloses = slice.map(c => c.c)
    const read = technicalStage(sym, slice)
    if (!read) { noCalls++; continue }

    const etf = symToSector.get(sym)
    let rankPct: number | null = null
    if (etf && sectorRows.length >= 2) {
      const idx = sectorRows.findIndex(r => r.sym === etf)
      if (idx !== -1) rankPct = 1 - idx / (sectorRows.length - 1)
    }

    const factors: Record<FactorName, FactorScore> = {
      technical: technicalFactor(read),
      momentum: momentumFactor(sliceCloses, spySliceCloses),
      sector: sectorFactor(rankPct),
      seasonality: seasonalityFactor(seasonalitySummary(slice), month),
      social: { score: null, detail: 'not replayable' },
      channels: { score: null, detail: 'not replayable' },
      insiders: { score: null, detail: 'not replayable' },
      news: { score: null, detail: 'not replayable' },
    }

    const lastClose = sliceCloses[sliceCloses.length - 1]
    const atrSeries = atr(slice)
    const lastAtr = atrSeries[atrSeries.length - 1]
    const capacityPct = swingCapacity(sliceCloses)

    const call = composeCall({
      sym,
      factors,
      weights: weightsCurrent,
      regime,
      capacityPct,
      atr: lastAtr,
      lastClose,
      entryQuality: read.entryQuality,
      stage: read.stage,
      earningsWithinHorizon: false,
      capUsdM: null,
    })

    if (!call) {
      noCalls++
      const adj = rawAdj(factors, weightsCurrent, regime)
      if (adj != null) nearMisses.push({ sym, adj })
      continue
    }

    const p = probabilityFor(calibrationState, call.side, regime, Math.abs(call.composite))
    const grade = gradeFor(p.p, p.provisional, call.capacityPct)
    const isShadow = grade === null
    if (isShadow) shadow++
    else live++

    const predLike = { date: pd.iso, side: call.side, priceAtPrediction: lastClose, stop: call.stop }
    const outcome5 = gradePrediction(predLike, full, spyCandles, 5)
    const outcome10 = gradePrediction(predLike, full, spyCandles, 10)

    if (!sanityCheckPrinted) {
      // composeCall stores entry as round2(lastClose) — compare with the same
      // rounding the engine applies to every money field, not raw float equality.
      const roundedLastClose = Math.round(lastClose * 100) / 100
      const matches = Math.abs(call.entry - roundedLastClose) < 1e-9
      console.log(
        `\nSANITY CHECK (first recorded call): ${sym} @ ${pd.iso} side=${call.side} — call.entry=${call.entry} vs round2(last close strictly before D)=${roundedLastClose} (raw ${lastClose}) → match=${matches}`,
      )
      if (!matches) throw new Error('SANITY CHECK FAILED: entry price does not equal the last close strictly before the prediction date')
      sanityCheckPrinted = true
    }

    allCalls.push({
      date: pd.iso,
      sym,
      side: call.side,
      status: isShadow ? 'shadow' : 'live',
      grade,
      probability: p.p,
      provisional: p.provisional,
      composite: call.composite,
      stage: call.stage,
      entryQuality: read.entryQuality,
      capacityPct: call.capacityPct,
      entry: call.entry,
      stop: call.stop,
      target: call.target,
      outcome5,
      outcome10,
    })
  }

  nearMisses.sort((a, b) => Math.abs(b.adj) - Math.abs(a.adj))
  perDateSummary.push({
    date: pd.iso,
    symbolsEvaluated: evaluated,
    skippedInsufficientHistory: skipped,
    calls: live + shadow,
    live,
    shadow,
    noCalls,
    nearMisses: nearMisses.slice(0, 3).map(n => ({ sym: n.sym, adj: Math.round(n.adj * 10) / 10 })),
  })
}

console.log(`\nintegrity: ${integrityChecks} point-in-time checks run, ${integrityViolations} violations`)

// ---- aggregate stats ----
function hitRate(calls: CallRecord[], horizon: 'outcome5' | 'outcome10'): { hits: number; n: number; rate: number | null } {
  const graded = calls.filter(c => c[horizon] != null) as (CallRecord & Record<typeof horizon, PredOutcome>)[]
  const hits = graded.filter(c => c[horizon]!.hit).length
  return { hits, n: graded.length, rate: graded.length ? hits / graded.length : null }
}
function avgExcess(calls: CallRecord[], horizon: 'outcome5' | 'outcome10'): number | null {
  const graded = calls.map(c => c[horizon]).filter((o): o is PredOutcome => o != null)
  if (!graded.length) return null
  return Math.round((graded.reduce((s, o) => s + o.excessPct, 0) / graded.length) * 100) / 100
}
function stopRate(calls: CallRecord[], horizon: 'outcome5' | 'outcome10'): number | null {
  const graded = calls.map(c => c[horizon]).filter((o): o is PredOutcome => o != null)
  if (!graded.length) return null
  return Math.round((graded.filter(o => o.stopped).length / graded.length) * 1000) / 10
}

const liveCalls = allCalls.filter(c => c.status === 'live')
const shadowCalls = allCalls.filter(c => c.status === 'shadow')
const longCalls = allCalls.filter(c => c.side === 'long')
const shortCalls = allCalls.filter(c => c.side === 'short')

const byStage: Record<string, number> = {}
for (const c of allCalls) byStage[c.stage ?? 'unknown'] = (byStage[c.stage ?? 'unknown'] ?? 0) + 1
const byGrade: Record<string, number> = {}
for (const c of allCalls) byGrade[c.grade ?? 'shadow(null)'] = (byGrade[c.grade ?? 'shadow(null)'] ?? 0) + 1

const summary = {
  universe,
  universeCount: universe.length,
  fetchFailures: failures,
  predictionDates: predictionDates.map(d => d.iso),
  totals: {
    evaluations: perDateSummary.reduce((s, d) => s + d.symbolsEvaluated, 0),
    totalCalls: allCalls.length,
    live: liveCalls.length,
    shadow: shadowCalls.length,
    long: longCalls.length,
    short: shortCalls.length,
  },
  hitRates: {
    live5d: hitRate(liveCalls, 'outcome5'),
    live10d: hitRate(liveCalls, 'outcome10'),
    shadow5d: hitRate(shadowCalls, 'outcome5'),
    shadow10d: hitRate(shadowCalls, 'outcome10'),
  },
  avgExcessPct: {
    live5d: avgExcess(liveCalls, 'outcome5'),
    live10d: avgExcess(liveCalls, 'outcome10'),
    shadow5d: avgExcess(shadowCalls, 'outcome5'),
    shadow10d: avgExcess(shadowCalls, 'outcome10'),
  },
  stopOutRatePct: {
    live5d: stopRate(liveCalls, 'outcome5'),
    live10d: stopRate(liveCalls, 'outcome10'),
    shadow5d: stopRate(shadowCalls, 'outcome5'),
    shadow10d: stopRate(shadowCalls, 'outcome10'),
  },
  byStage,
  byGrade,
  integrity: { checks: integrityChecks, violations: integrityViolations },
}

writeFileSync(OUT_PATH, JSON.stringify({ summary, perDateSummary, calls: allCalls }, null, 1))
console.log(`\nwrote full results to ${OUT_PATH}`)

// ---- compact stdout summary table ----
console.log('\n=== PER-WEEK SUMMARY ===')
console.log('date        calls  live  shadow  no-call  avgExcess5d(live)  nearMisses')
for (const d of perDateSummary) {
  const weekCalls = allCalls.filter(c => c.date === d.date && c.status === 'live')
  const ax = avgExcess(weekCalls, 'outcome5')
  const nm = d.nearMisses.map(n => `${n.sym}:${n.adj}`).join(', ')
  console.log(
    `${d.date}  ${String(d.calls).padStart(5)}  ${String(d.live).padStart(4)}  ${String(d.shadow).padStart(6)}  ${String(d.noCalls).padStart(7)}  ${String(ax ?? 'n/a').padStart(17)}  ${nm}`,
  )
}

console.log('\n=== OVERALL ===')
console.log(`evaluations: ${summary.totals.evaluations}  totalCalls: ${summary.totals.totalCalls} (live ${summary.totals.live} / shadow ${summary.totals.shadow}, long ${summary.totals.long} / short ${summary.totals.short})`)
console.log(`live  5d hit rate: ${summary.hitRates.live5d.hits}/${summary.hitRates.live5d.n} (${summary.hitRates.live5d.rate != null ? (summary.hitRates.live5d.rate * 100).toFixed(1) + '%' : 'n/a'})  avgExcess ${summary.avgExcessPct.live5d ?? 'n/a'}%  stopRate ${summary.stopOutRatePct.live5d ?? 'n/a'}%`)
console.log(`live 10d hit rate: ${summary.hitRates.live10d.hits}/${summary.hitRates.live10d.n} (${summary.hitRates.live10d.rate != null ? (summary.hitRates.live10d.rate * 100).toFixed(1) + '%' : 'n/a'})  avgExcess ${summary.avgExcessPct.live10d ?? 'n/a'}%  stopRate ${summary.stopOutRatePct.live10d ?? 'n/a'}%`)
console.log(`shadow  5d hit rate: ${summary.hitRates.shadow5d.hits}/${summary.hitRates.shadow5d.n} (${summary.hitRates.shadow5d.rate != null ? (summary.hitRates.shadow5d.rate * 100).toFixed(1) + '%' : 'n/a'})  avgExcess ${summary.avgExcessPct.shadow5d ?? 'n/a'}%  stopRate ${summary.stopOutRatePct.shadow5d ?? 'n/a'}%`)
console.log(`shadow 10d hit rate: ${summary.hitRates.shadow10d.hits}/${summary.hitRates.shadow10d.n} (${summary.hitRates.shadow10d.rate != null ? (summary.hitRates.shadow10d.rate * 100).toFixed(1) + '%' : 'n/a'})  avgExcess ${summary.avgExcessPct.shadow10d ?? 'n/a'}%  stopRate ${summary.stopOutRatePct.shadow10d ?? 'n/a'}%`)
console.log(`by stage: ${JSON.stringify(byStage)}`)
console.log(`by grade: ${JSON.stringify(byGrade)}`)
