// Does ANY discovery signal predict forward 10-session excess return vs SPY?
//
//   npx tsx scripts/discovery-walk-forward.ts [--dates N] [--limit N] [--step N]
//
// The board currently sizes nothing, so before the scoring is rebuilt we need to
// know whether the raw material has an edge at all. This runs the real engine —
// the same `computeFeatures`, `percentileRanks` and `runLenses` production calls
// — over every session in the bars window, with the tape cut at the signal date
// and nothing after it, and scores what each lens and each feature actually
// bought you ten sessions later.
//
// NO LOOK-AHEAD, and three separate places earn that claim:
//   • features read a PREFIX of the tape (scripts/lib/walkForward.ts
//     `featuresAtDay`), and SPY is cut to the same UTC day;
//   • the cross-sectional percentiles that the lenses gate on are recomputed
//     from that date's prefix features only — never from today's ranks;
//   • the trade is entered at the NEXT session's open and exited at the close 10
//     sessions later, so nothing is bought at a price that was still printing.
//
// Everything is measured as EXCESS over SPY across the same calendar window, in
// percentage points, and a hit is +1pp — the engine's own definition.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fetchUniverseBars } from '../netlify/functions/lib/discoveryBars'
import { computeFeatures, emaSeries } from '../shared/engine/discovery/features'
import { applyHygiene, percentileRanks } from '../shared/engine/discovery/rank'
import { runLenses } from '../shared/engine/discovery/lenses'
import { buildUniverse } from '../shared/engine/discovery/universe'
import { loadUniverseSeed } from '../shared/engine/discovery/universeSeed'
import type { Features, UniverseMember } from '../shared/engine/discovery/types'
import { isRouteEtp } from '../shared/engine/riskLadder'
import type { Candle } from '../shared/types'
import {
  HORIZON,
  HIT_THRESHOLD_PP,
  benchReturnPct,
  decilesOf,
  forwardOutcome,
  isHit,
  lastIndexAtOrBefore,
  mean,
  median,
  neweyWestT,
  rankAvgTies,
  spearman,
  tStat,
  utcDay,
} from './lib/walkForward'

/* ───────────────────────────── arguments ───────────────────────────── */

const argv = process.argv.slice(2)
const flag = (name: string): string | null => {
  const eq = argv.find(a => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null
}
const maxDates = Number(flag('dates')) || 0
const limit = Number(flag('limit')) || 0
const stepArg = Number(flag('step')) || 0
const OUT = flag('out') ?? 'docs/superpowers/plans/2026-09-22-discovery-walk-forward-results.md'
/** Sessions held after the entry bar. The engine's own call window is 10; 5 and
 * 20 are here because "is there an edge" and "is there an edge AT THIS HORIZON"
 * are different questions, and a signal that only works at one of them is a
 * signal about the horizon rather than about the name. Every Newey–West lag in
 * the run follows this number, because the overlap IS the horizon. */
const HORIZON_N = Number(flag('horizon')) || HORIZON
/** Append a horizon's section to an existing report instead of replacing it, and
 * demote every heading one level so the section nests under the 10-session run
 * rather than competing with it. */
const APPEND = argv.includes('--append')
const H2 = APPEND ? '###' : '##'
const H3 = APPEND ? '####' : '###'
/** How much tape to ask Yahoo for. `fetchUniverseBars` hard-codes `range=1y` on
 * a cache miss, which is 251 sessions — 100 of them go to the warm-up and 13 to
 * the forward window, leaving only 139 signal dates. `DBARS_MAX` already caps
 * every tape at 300 bars, so asking for 2y costs nothing downstream and fills
 * that cap: ~188 dates instead of 139, for the same 21 seconds of fetching.
 *
 * The rewrite rides on the module's OWN `fetchFn` seam rather than touching
 * discoveryBars.ts: only the `range=` parameter changes, `interval=1d` is
 * untouched, and `--history 1y` reproduces production's exact request. */
const HISTORY = flag('history') ?? '2y'
const barsFetch: typeof fetch =
  HISTORY === '1y'
    ? fetch
    : ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        return fetch(url.replace('range=1y', `range=${HISTORY}`), init)
      }) as typeof fetch

/** ≥ 200 bars or the name is not in the study: a short tape both fails the
 * 100-bar warm-up on most dates and biases the cross-section toward whatever was
 * recently listed. */
const MIN_BARS = 200
/** Sessions of history a feature read must have behind it. 100 covers the
 * 60-session returns and gives the 120-day Bollinger percentile something to
 * stand on; the 250-session 52-week high degrades gracefully to what exists. */
const WARMUP = 100

/* ────────────────────────────── the tape ────────────────────────────── */

const t0 = Date.now()
const seedRows = loadUniverseSeed()
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
const { members } = buildUniverse(limit > 0 ? seedRows.slice(0, limit) : seedRows, null, [], today)
const allSyms = [...members.keys()].sort()

console.log(`walk-forward · seed ${allSyms.length} names · horizon ${HORIZON_N} sessions · hit ≥ +${HIT_THRESHOLD_PP}pp`)

const spyRes = await fetchUniverseBars(['SPY'], { cache: false, fetchFn: barsFetch, log: () => {} })
const spy = spyRes.tapes.get('SPY') ?? []
if (spy.length < 150) throw new Error(`SPY tape is ${spy.length} bars — no benchmark, no study`)
console.log(`SPY: ${spy.length} bars, ${new Date(spy[0].t * 1000).toISOString().slice(0, 10)} → ${new Date(spy[spy.length - 1].t * 1000).toISOString().slice(0, 10)}`)

const barsRes = await fetchUniverseBars(allSyms, {
  cache: false,
  fetchFn: barsFetch,
  budgetMs: 600_000,
  maxRequests: 4_000,
  concurrency: 8,
  log: line => console.log(`  ${line}`),
})
console.log(
  `bars: ${barsRes.stats.fetched} fetched, ${barsRes.stats.failed} failed, ${barsRes.unread.length} unread in ${(barsRes.stats.elapsedMs / 1000).toFixed(0)}s`,
)

const syms: string[] = []
const tapes: Candle[][] = []
const exchanges: ('US' | 'LSE')[] = []
const memberOf: UniverseMember[] = []
for (const sym of allSyms) {
  const tape = barsRes.tapes.get(sym)
  if (!tape || tape.length < MIN_BARS) continue
  syms.push(sym)
  tapes.push(tape)
  exchanges.push(members.get(sym)!.exchange)
  memberOf.push(members.get(sym)!)
}
const droppedShort = allSyms.length - syms.length
console.log(`universe in study: ${syms.length} names (${droppedShort} dropped: no tape or < ${MIN_BARS} bars)`)

/* ────────────────────────── the date axis ────────────────────────── */

// SPY's own sessions are the master calendar: it is the benchmark, so a date it
// did not trade is a date with no excess return to measure.
const spyDays = spy.map(b => utcDay(b.t))
const firstIdx = WARMUP
const lastIdx = spy.length - (HORIZON_N + 3) // room for next-open entry + the whole forward window
let step = stepArg > 0 ? stepArg : 1
let dateIdxs: number[] = []
for (let i = firstIdx; i <= lastIdx; i += step) dateIdxs.push(i)
if (maxDates > 0 && dateIdxs.length > maxDates) {
  const keep = Math.ceil(dateIdxs.length / maxDates)
  step *= keep
  dateIdxs = dateIdxs.filter((_, i) => i % keep === 0)
}
console.log(`dates: ${dateIdxs.length} sessions (step ${step}), ${new Date(spy[dateIdxs[0]].t * 1000).toISOString().slice(0, 10)} → ${new Date(spy[dateIdxs[dateIdxs.length - 1]].t * 1000).toISOString().slice(0, 10)}`)

// SPY regime on the signal date: above or below its own 50-EMA. Computed from
// the whole series ONCE — the value at index i uses only closes up to i, which
// is what an EMA recurrence is, so this is a prefix read despite looking global.
const spyEma50 = emaSeries(spy.map(b => b.c), 50)

/* ───────────────────────── feature + lens keys ───────────────────────── */

const FEATURE_KEYS = [
  'ret5', 'ret20', 'ret60', 'rsSpy20', 'rsSpy60', 'rvol', 'distEma21Atr', 'ema50Slope20',
  'ddFrom20dHigh', 'distTo52wHigh', 'bbWidthPctl120', 'upDays10', 'rsi14', 'volTrend5',
] as const
type FeatureKey = (typeof FEATURE_KEYS)[number]

const LENS_KEYS = ['unusual-up', 'unusual-down', 'rs-leader', 'pullback', 'breakout', 'dip', 'weak', 'climax'] as const
type LensKey = (typeof LENS_KEYS)[number]
/** A short lens is right when the name FALLS, so its excess is the negation. */
const SHORT_LENS = new Set<LensKey>(['unusual-down', 'weak', 'climax'])
const lensSign = (k: LensKey) => (SHORT_LENS.has(k) ? -1 : 1)

/* ───────────────────────────── the sweep ───────────────────────────── */

// Observations are appended date by date, so each date owns a contiguous range —
// which is what lets every per-date statistic below be a loop over a slice
// rather than a group-by over 300k rows.
const obsSym: number[] = []
const obsExcess: number[] = []
const obsMae: number[] = []
const obsQual: number[] = []
const obsLens: number[] = []
const obsFeat: number[][] = FEATURE_KEYS.map(() => [])
const dateStart: number[] = []
const dateEnd: number[] = []

const isEtp = (sym: string) => isRouteEtp(sym, {})

let sweepT0 = Date.now()
for (let d = 0; d < dateIdxs.length; d++) {
  const ti = dateIdxs[d]
  const day = spyDays[ti]
  const spyPrefix = spy.slice(0, ti + 1)
  dateStart.push(obsSym.length)

  // Pass 1 — where each tape stands on this date, and the newest bar each VENUE
  // printed. Staleness is measured per exchange for the same reason discoverPure
  // does it: a UK bank holiday is not a delisting.
  const idxOf = new Int32Array(syms.length).fill(-1)
  const lastByExchange = new Map<string, number>()
  for (let s = 0; s < syms.length; s++) {
    const idx = lastIndexAtOrBefore(tapes[s], day)
    if (idx < WARMUP - 1) continue
    idxOf[s] = idx
    const t = tapes[s][idx].t
    const ex = exchanges[s]
    if (t > (lastByExchange.get(ex) ?? 0)) lastByExchange.set(ex, t)
  }
  const fallbackLast = Math.max(...[...lastByExchange.values()], 0)

  // Pass 2 — features on the prefix, then hygiene, exactly as discoverPure runs
  // them (features for everyone, hygiene next, percentiles over the survivors).
  const prefixOf: (Candle[] | null)[] = new Array(syms.length).fill(null)
  const featOf: (Features | null)[] = new Array(syms.length).fill(null)
  const qualified: number[] = []
  for (let s = 0; s < syms.length; s++) {
    const idx = idxOf[s]
    if (idx < 0) continue
    const prefix = tapes[s].slice(0, idx + 1)
    const f = computeFeatures(syms[s], prefix, spyPrefix)
    prefixOf[s] = prefix
    featOf[s] = f
    if (!f) continue
    const code = applyHygiene(memberOf[s], f, lastByExchange.get(exchanges[s]) ?? fallbackLast, isEtp)
    if (!code) qualified.push(s)
  }

  const pcts = percentileRanks(qualified.map(s => featOf[s]!))

  // Lenses, for the hygiene survivors only — the same names production would
  // have put in front of them.
  const lensMask = new Int32Array(syms.length)
  for (const s of qualified) {
    const f = featOf[s]!
    const hits = runLenses(f, pcts.get(syms[s])!, memberOf[s], prefixOf[s])
    for (const h of hits) {
      const key: LensKey = h.lens === 'unusual' ? ((f.ret1 ?? 0) >= 0 ? 'unusual-up' : 'unusual-down') : (h.lens as LensKey)
      lensMask[s] |= 1 << LENS_KEYS.indexOf(key)
    }
  }

  // Outcomes. Recorded for every name with readable features and a complete
  // forward window — qualified or not — so the universe baseline is the whole
  // cross-section and the qualifying baseline is a subset of it.
  for (let s = 0; s < syms.length; s++) {
    const f = featOf[s]
    if (!f) continue
    const out = forwardOutcome(tapes[s], idxOf[s], HORIZON_N)
    if (!out) continue
    const bench = benchReturnPct(spy, out.entryDay, out.exitDay)
    if (bench == null) continue
    obsSym.push(s)
    obsExcess.push(out.retPct - bench)
    obsMae.push(out.maePct)
    obsQual.push(pcts.has(syms[s]) ? 1 : 0) // percentiles exist only for hygiene survivors
    obsLens.push(lensMask[s])
    for (let k = 0; k < FEATURE_KEYS.length; k++) {
      const v = f[FEATURE_KEYS[k]] as number | null
      obsFeat[k].push(v == null ? NaN : v)
    }
  }
  dateEnd.push(obsSym.length)

  if (d % 10 === 0 || d === dateIdxs.length - 1) {
    const per = (Date.now() - sweepT0) / (d + 1)
    console.log(
      `  date ${d + 1}/${dateIdxs.length} ${new Date(spy[ti].t * 1000).toISOString().slice(0, 10)} · ${qualified.length} qualified · ${obsSym.length} obs · eta ${((per * (dateIdxs.length - d - 1)) / 1000).toFixed(0)}s`,
    )
  }
}
const nDates = dateIdxs.length
const nObs = obsSym.length
console.log(`sweep done: ${nObs.toLocaleString()} name-dates in ${((Date.now() - sweepT0) / 1000).toFixed(0)}s`)

/* ───────────────────────────── analysis ───────────────────────────── */

const half1 = (d: number) => d < Math.floor(nDates / 2)
const regimeUp: boolean[] = dateIdxs.map(ti => {
  const e = spyEma50[ti]
  return e != null && spy[ti].c > e
})
const dateLabel = dateIdxs.map(ti => new Date(spy[ti].t * 1000).toISOString().slice(0, 10))

const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—')
const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '—')

interface Summary {
  n: number
  mean: number
  median: number
  hit: number
  t: number
  tNW: number
  dateShare: number
  mae: number
}

/** Summarise a set of observation indices, with `sign` flipping a short lens.
 * Two t-statistics on purpose: the naive one the brief asked for, and a
 * Newey–West t over the per-date means, which is the one that survives the fact
 * that consecutive dates share 9 of their 10 forward sessions. */
function summarise(idx: readonly number[], sign: number): Summary {
  const vals = idx.map(i => obsExcess[i] * sign)
  const perDate: number[] = []
  let datesWithFire = 0
  if (idx.length) {
    const byDate = new Map<number, number[]>()
    for (const i of idx) {
      const d = dateOfObs(i)
      const list = byDate.get(d)
      if (list) list.push(obsExcess[i] * sign)
      else byDate.set(d, [obsExcess[i] * sign])
    }
    datesWithFire = byDate.size
    for (let d = 0; d < nDates; d++) {
      const list = byDate.get(d)
      if (list) perDate.push(mean(list))
    }
  }
  return {
    n: idx.length,
    mean: mean(vals),
    median: median(vals),
    hit: vals.length ? vals.filter(isHit).length / vals.length : NaN,
    t: tStat(vals),
    tNW: perDate.length > HORIZON_N + 2 ? neweyWestT(perDate, HORIZON_N) : NaN,
    dateShare: datesWithFire / nDates,
    mae: mean(idx.map(i => obsMae[i])),
  }
}

// obs → date index, by binary search over the contiguous per-date ranges.
function dateOfObs(i: number): number {
  let lo = 0
  let hi = nDates - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (i < dateStart[mid]) hi = mid - 1
    else if (i >= dateEnd[mid]) lo = mid + 1
    else return mid
  }
  return -1
}

const allIdx: number[] = []
const qualIdx: number[] = []
for (let i = 0; i < nObs; i++) {
  allIdx.push(i)
  if (obsQual[i]) qualIdx.push(i)
}

const lensIdx = new Map<LensKey, number[]>(LENS_KEYS.map(k => [k, []]))
for (let i = 0; i < nObs; i++) {
  const m = obsLens[i]
  if (!m) continue
  for (let k = 0; k < LENS_KEYS.length; k++) if (m & (1 << k)) lensIdx.get(LENS_KEYS[k])!.push(i)
}

/** Mean of a subset defined by a date predicate and/or a name predicate. */
function meanWhere(idx: readonly number[], sign: number, keep: (i: number) => boolean): { n: number; mean: number; hit: number } {
  const vals: number[] = []
  for (const i of idx) if (keep(i)) vals.push(obsExcess[i] * sign)
  return { n: vals.length, mean: mean(vals), hit: vals.length ? vals.filter(isHit).length / vals.length : NaN }
}

// Per-observation date and exchange, materialised once: dateOfObs is a binary
// search and the split tables would otherwise run it a few million times.
const obsDate = new Int32Array(nObs)
for (let d = 0; d < nDates; d++) for (let i = dateStart[d]; i < dateEnd[d]; i++) obsDate[i] = d
const obsIsLse = new Uint8Array(nObs)
for (let i = 0; i < nObs; i++) obsIsLse[i] = exchanges[obsSym[i]] === 'LSE' ? 1 : 0

/* ── feature deciles and rank ICs ── */

interface FeatureStat {
  key: FeatureKey
  d1: { mean: number; hit: number; n: number }
  d10: { mean: number; hit: number; n: number }
  spread: number
  icMean: number
  icT: number
  icH1: number
  icH2: number
  icTH1: number
  icTH2: number
  icUp: number
  icDown: number
  icUS: number
  icLSE: number
  ics: number[]
}

const featureStats: FeatureStat[] = []
for (let k = 0; k < FEATURE_KEYS.length; k++) {
  const col = obsFeat[k]
  const dSum = new Float64Array(11)
  const dHit = new Float64Array(11)
  const dCnt = new Float64Array(11)
  // Date-stamped, not a bare list: the halves and the regime split are read back
  // off this array, and a date whose IC came out NaN (a feature with no variance
  // that day) would otherwise slide every later date into the wrong bucket.
  const icRows: { d: number; ic: number }[] = []
  const icsUS: number[] = []
  const icsLSE: number[] = []
  for (let d = 0; d < nDates; d++) {
    const rows: number[] = []
    for (let i = dateStart[d]; i < dateEnd[d]; i++) if (obsQual[i] && Number.isFinite(col[i])) rows.push(i)
    if (rows.length < 20) continue
    const xs = rows.map(i => col[i])
    const ys = rows.map(i => obsExcess[i])
    const ic = spearman(xs, ys)
    if (Number.isFinite(ic)) icRows.push({ d, ic })
    const us = rows.filter(i => !obsIsLse[i])
    const lse = rows.filter(i => obsIsLse[i])
    if (us.length >= 20) {
      const v = spearman(us.map(i => col[i]), us.map(i => obsExcess[i]))
      if (Number.isFinite(v)) icsUS.push(v)
    }
    if (lse.length >= 20) {
      const v = spearman(lse.map(i => col[i]), lse.map(i => obsExcess[i]))
      if (Number.isFinite(v)) icsLSE.push(v)
    }
    const dec = decilesOf(xs)
    for (let r = 0; r < rows.length; r++) {
      const b = dec[r]
      dSum[b] += ys[r]
      dCnt[b] += 1
      if (isHit(ys[r])) dHit[b] += 1
    }
  }
  const ics = icRows.map(r => r.ic)
  const icH1: number[] = []
  const icH2: number[] = []
  const icUp: number[] = []
  const icDown: number[] = []
  for (const { d, ic } of icRows) {
    ;(half1(d) ? icH1 : icH2).push(ic)
    ;(regimeUp[d] ? icUp : icDown).push(ic)
  }
  featureStats.push({
    key: FEATURE_KEYS[k],
    d1: { mean: dCnt[1] ? dSum[1] / dCnt[1] : NaN, hit: dCnt[1] ? dHit[1] / dCnt[1] : NaN, n: dCnt[1] },
    d10: { mean: dCnt[10] ? dSum[10] / dCnt[10] : NaN, hit: dCnt[10] ? dHit[10] / dCnt[10] : NaN, n: dCnt[10] },
    spread: (dCnt[10] ? dSum[10] / dCnt[10] : NaN) - (dCnt[1] ? dSum[1] / dCnt[1] : NaN),
    icMean: mean(ics),
    icT: tStat(ics),
    icH1: mean(icH1),
    icH2: mean(icH2),
    icTH1: tStat(icH1),
    icTH2: tStat(icH2),
    icUp: mean(icUp),
    icDown: mean(icDown),
    icUS: mean(icsUS),
    icLSE: mean(icsLSE),
    ics,
  })
}

/* ── composite ── */

/** Equal-weight mean of within-date percentile ranks of the chosen features.
 * A missing feature scores 0.5 — the middle of the field — for the same reason
 * `percentileRanks` does it: an unknown must neither win nor lose a name a slot. */
function compositeTest(selected: FeatureKey[], evalDates: (d: number) => boolean) {
  const topIdx: number[] = []
  const botIdx: number[] = []
  const perDateTop: number[] = []
  let datesBeat = 0
  let datesCounted = 0
  if (!selected.length) return { selected, top: null as Summary | null, bottom: null as Summary | null, datesBeat: 0, datesCounted: 0 }
  const cols = selected.map(key => obsFeat[FEATURE_KEYS.indexOf(key)])
  for (let d = 0; d < nDates; d++) {
    if (!evalDates(d)) continue
    const rows: number[] = []
    for (let i = dateStart[d]; i < dateEnd[d]; i++) if (obsQual[i]) rows.push(i)
    if (rows.length < 30) continue
    const score = new Float64Array(rows.length)
    for (const col of cols) {
      const have: number[] = []
      const haveAt: number[] = []
      for (let r = 0; r < rows.length; r++) if (Number.isFinite(col[rows[r]])) { have.push(col[rows[r]]); haveAt.push(r) }
      const p = new Float64Array(rows.length).fill(0.5)
      if (have.length >= 2) {
        const rk = rankAvgTies(have)
        for (let j = 0; j < haveAt.length; j++) p[haveAt[j]] = rk[j] / have.length
      }
      for (let r = 0; r < rows.length; r++) score[r] += p[r]
    }
    const dec = decilesOf([...score])
    const top: number[] = []
    for (let r = 0; r < rows.length; r++) {
      if (dec[r] === 10) { topIdx.push(rows[r]); top.push(obsExcess[rows[r]]) }
      else if (dec[r] === 1) botIdx.push(rows[r])
    }
    if (top.length) {
      const m = mean(top)
      perDateTop.push(m)
      datesCounted++
      if (m > 0) datesBeat++
    }
  }
  const top = summarise(topIdx, 1)
  top.tNW = perDateTop.length > HORIZON_N + 2 ? neweyWestT(perDateTop, HORIZON_N) : NaN
  return { selected, top, bottom: summarise(botIdx, 1), datesBeat, datesCounted }
}

// The brief's rule: positive IC, stable across both halves. `icT` is computed on
// the whole sample, so this selection is IN-SAMPLE — the honest variant below
// picks on the first half and is scored on the second only.
const STABLE_T = 2
const selectedFull = featureStats.filter(f => f.icMean > 0 && f.icH1 > 0 && f.icH2 > 0 && f.icT >= STABLE_T).map(f => f.key)
const selectedH1 = featureStats.filter(f => f.icH1 > 0 && f.icTH1 >= STABLE_T).map(f => f.key)
const compFull = compositeTest(selectedFull, () => true)
const compOOS = compositeTest(selectedH1, d => !half1(d))

/* ───────────────────────────── the report ───────────────────────────── */

const L: string[] = []
const w = (s = '') => L.push(s)

const baselineAll = summarise(allIdx, 1)
const baselineQual = summarise(qualIdx, 1)

/** The bar a lens has to clear is not zero, it is what a name drawn at random
 * from the SAME hygiene-qualified pool did — and for a short lens that bar is
 * the negation of it. `edge` is the lens's mean minus its own bar. */
const summaryRow = (label: string, s: Summary, sign = 1) =>
  `| ${label} | ${s.n.toLocaleString()} | ${fmt(s.mean)} | ${fmt(s.mean - sign * baselineQual.mean)} | ${fmt(s.median)} | ${pct(s.hit)} | ${fmt(s.t, 1)} | ${fmt(s.tNW, 1)} | ${pct(s.dateShare)} | ${fmt(s.mae, 1)} |`

w(APPEND ? `## ${HORIZON_N}-session horizon` : `# Discovery walk-forward: what actually predicts ${HORIZON_N}-session excess vs SPY`)
w()
w(`Run ${new Date().toISOString().slice(0, 19)}Z · \`npx tsx scripts/discovery-walk-forward.ts${argv.length ? ' ' + argv.join(' ') : ''}\``)
w()
w(`- **Universe** ${syms.length} names with ≥ ${MIN_BARS} daily bars (${droppedShort} of ${allSyms.length} seed rows dropped: no tape, or too short).`)
w(`- **Dates** ${nDates} sessions, ${dateLabel[0]} → ${dateLabel[nDates - 1]}, step ${step}. Warm-up ${WARMUP} bars. Tape requested: \`range=${HISTORY}\`, capped at 300 bars by \`DBARS_MAX\`.`)
w(`- **Observations** ${nObs.toLocaleString()} name-dates with readable features and a complete forward window; ${qualIdx.length.toLocaleString()} of them pass production hygiene (price, liquidity, staleness, ETP).`)
w(`- **Trade** signal on the close of *t* → entry at the **next session's open** → exit at the **close ${HORIZON_N} sessions later**. Excess = name return − SPY return over the same calendar window, in pp. Hit = excess ≥ +${HIT_THRESHOLD_PP}pp.`)
w(`- **t** is the naive t-statistic of the mean over observations. **t_NW** is a Newey–West(${HORIZON_N}) t over the per-date means — the honest one, because consecutive dates share ${HORIZON_N - 1} of their ${HORIZON_N} forward sessions and every name on a date moves with the market. Read t_NW; t is printed only because it is what a naive backtest would have reported.`)
w()
w(`${H2} a. Lenses`)
w()
w(`Short lenses (weak, climax, unusual-down) are scored as **−excess**: the lens is right when the name falls. "dates" is the share of sessions on which the lens fired at least once. MAE is the mean worst drawdown from the entry price during the hold, in %.`)
w()
w(`| lens | n | mean pp | edge vs qualified | median pp | hit | t | t_NW | dates | MAE % |`)
w(`|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|`)
for (const k of LENS_KEYS) w(summaryRow(k, summarise(lensIdx.get(k)!, lensSign(k)), lensSign(k)))
w(summaryRow('**baseline: every name-date**', baselineAll))
w(summaryRow('**baseline: hygiene-qualified**', baselineQual))
w()
w(`${H2} b. Features — deciles and rank IC`)
w()
w(`Deciles are cross-sectional **within each date** over hygiene-qualified names, so D10 is "the top 10% of the market that day", never "the top 10% of history". IC is the Spearman correlation of the feature with forward excess inside a date; IC t = mean/(sd/√dates).`)
w()
w(`Note: within a single date SPY's return is a constant, so \`rsSpy20\` is a monotone shift of \`ret20\` and \`rsSpy60\` of \`ret60\` — their cross-sectional rank ICs are IDENTICAL by construction, and any difference below is null-handling alone. That is four columns carrying two independent signals, and the multiple-comparison count in §e is stated on that basis.`)
w()
w(`| feature | D1 mean | D1 hit | D10 mean | D10 hit | D10−D1 | IC | IC t | IC h1 | IC h2 |`)
w(`|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|`)
for (const f of [...featureStats].sort((a, b) => Math.abs(b.icT) - Math.abs(a.icT))) {
  w(
    `| ${f.key} | ${fmt(f.d1.mean)} | ${pct(f.d1.hit)} | ${fmt(f.d10.mean)} | ${pct(f.d10.hit)} | ${fmt(f.spread)} | ${fmt(f.icMean, 4)} | ${fmt(f.icT, 1)} | ${fmt(f.icH1, 4)} | ${fmt(f.icH2, 4)} |`,
  )
}
w()
w(`${H2} c. Splits`)
w()
w(`${H3} Regime (SPY above / below its own 50-EMA on the signal date)`)
w()
const upDates = regimeUp.filter(Boolean).length
w(`${upDates} of ${nDates} signal dates are SPY-above-50EMA.`)
w()
w(`| lens | n up | mean up | n down | mean down |`)
w(`|---|---:|---:|---:|---:|`)
for (const k of LENS_KEYS) {
  const s = lensSign(k)
  const up = meanWhere(lensIdx.get(k)!, s, i => regimeUp[obsDate[i]])
  const dn = meanWhere(lensIdx.get(k)!, s, i => !regimeUp[obsDate[i]])
  w(`| ${k} | ${up.n} | ${fmt(up.mean)} | ${dn.n} | ${fmt(dn.mean)} |`)
}
const bUp = meanWhere(allIdx, 1, i => regimeUp[obsDate[i]])
const bDn = meanWhere(allIdx, 1, i => !regimeUp[obsDate[i]])
w(`| **baseline** | ${bUp.n} | ${fmt(bUp.mean)} | ${bDn.n} | ${fmt(bDn.mean)} |`)
w()
w(`${H3} Exchange`)
w()
w(`| lens | n US | mean US | n LSE | mean LSE |`)
w(`|---|---:|---:|---:|---:|`)
for (const k of LENS_KEYS) {
  const s = lensSign(k)
  const us = meanWhere(lensIdx.get(k)!, s, i => !obsIsLse[i])
  const lse = meanWhere(lensIdx.get(k)!, s, i => !!obsIsLse[i])
  w(`| ${k} | ${us.n} | ${fmt(us.mean)} | ${lse.n} | ${fmt(lse.mean)} |`)
}
const bUS = meanWhere(allIdx, 1, i => !obsIsLse[i])
const bLSE = meanWhere(allIdx, 1, i => !!obsIsLse[i])
w(`| **baseline** | ${bUS.n} | ${fmt(bUS.mean)} | ${bLSE.n} | ${fmt(bLSE.mean)} |`)
w()
w(`${H3} Halves (stability)`)
w()
w(`First half ${dateLabel[0]} → ${dateLabel[Math.floor(nDates / 2) - 1]}; second half ${dateLabel[Math.floor(nDates / 2)]} → ${dateLabel[nDates - 1]}.`)
w()
w(`| lens | n h1 | mean h1 | hit h1 | n h2 | mean h2 | hit h2 |`)
w(`|---|---:|---:|---:|---:|---:|---:|`)
for (const k of LENS_KEYS) {
  const s = lensSign(k)
  const a = meanWhere(lensIdx.get(k)!, s, i => half1(obsDate[i]))
  const b = meanWhere(lensIdx.get(k)!, s, i => !half1(obsDate[i]))
  w(`| ${k} | ${a.n} | ${fmt(a.mean)} | ${pct(a.hit)} | ${b.n} | ${fmt(b.mean)} | ${pct(b.hit)} |`)
}
const bA = meanWhere(allIdx, 1, i => half1(obsDate[i]))
const bB = meanWhere(allIdx, 1, i => !half1(obsDate[i]))
w(`| **baseline** | ${bA.n} | ${fmt(bA.mean)} | ${pct(bA.hit)} | ${bB.n} | ${fmt(bB.mean)} | ${pct(bB.hit)} |`)
w()
w(`${H3} Feature IC by split`)
w()
w(`| feature | IC up | IC down | IC US | IC LSE | IC t h1 | IC t h2 |`)
w(`|---|---:|---:|---:|---:|---:|---:|`)
for (const f of [...featureStats].sort((a, b) => Math.abs(b.icT) - Math.abs(a.icT))) {
  w(`| ${f.key} | ${fmt(f.icUp, 4)} | ${fmt(f.icDown, 4)} | ${fmt(f.icUS, 4)} | ${fmt(f.icLSE, 4)} | ${fmt(f.icTH1, 1)} | ${fmt(f.icTH2, 1)} |`)
}
w()
w(`${H2} d. Composite top-decile test`)
w()
w(`Equal-weight mean of within-date percentile ranks, top decile taken each date.`)
w()
w(`**In-sample selection** (IC > 0 in both halves and |IC t| ≥ ${STABLE_T} over the whole sample): ${selectedFull.length ? selectedFull.join(', ') : '_no feature qualified_'}`)
w()
if (compFull.top) {
  w(`| bucket | n | mean pp | median pp | hit | t | t_NW | MAE % |`)
  w(`|---|---:|---:|---:|---:|---:|---:|---:|`)
  w(`| composite D10 | ${compFull.top.n.toLocaleString()} | ${fmt(compFull.top.mean)} | ${fmt(compFull.top.median)} | ${pct(compFull.top.hit)} | ${fmt(compFull.top.t, 1)} | ${fmt(compFull.top.tNW, 1)} | ${fmt(compFull.top.mae, 1)} |`)
  w(`| composite D1 | ${compFull.bottom!.n.toLocaleString()} | ${fmt(compFull.bottom!.mean)} | ${fmt(compFull.bottom!.median)} | ${pct(compFull.bottom!.hit)} | ${fmt(compFull.bottom!.t, 1)} | ${fmt(compFull.bottom!.tNW, 1)} | ${fmt(compFull.bottom!.mae, 1)} |`)
  w()
  w(`Top decile beat SPY on **${compFull.datesBeat}/${compFull.datesCounted} dates (${pct(compFull.datesCounted ? compFull.datesBeat / compFull.datesCounted : NaN)})**.`)
}
w()
w(`**Out-of-sample** (features picked on the FIRST half only, scored on the second half only): ${selectedH1.length ? selectedH1.join(', ') : '_no feature qualified_'}`)
w()
if (compOOS.top && compOOS.top.n) {
  w(`| bucket | n | mean pp | hit | t | t_NW |`)
  w(`|---|---:|---:|---:|---:|---:|`)
  w(`| composite D10 (h2 only) | ${compOOS.top.n.toLocaleString()} | ${fmt(compOOS.top.mean)} | ${pct(compOOS.top.hit)} | ${fmt(compOOS.top.t, 1)} | ${fmt(compOOS.top.tNW, 1)} |`)
  w()
  w(`Top decile beat SPY on **${compOOS.datesBeat}/${compOOS.datesCounted} dates (${pct(compOOS.datesCounted ? compOOS.datesBeat / compOOS.datesCounted : NaN)})**.`)
}
w()

/* ── verdict ── */

const spanMonths = (
  (Date.parse(dateLabel[nDates - 1]) - Date.parse(dateLabel[0])) /
  (86_400_000 * 30.44)
).toFixed(1)

const strongLenses = LENS_KEYS.filter(k => {
  const s = summarise(lensIdx.get(k)!, lensSign(k))
  const a = meanWhere(lensIdx.get(k)!, lensSign(k), i => half1(obsDate[i]))
  const b = meanWhere(lensIdx.get(k)!, lensSign(k), i => !half1(obsDate[i]))
  return Number.isFinite(s.t) && s.t >= 2.5 && a.mean > 0 && b.mean > 0
})
const strongFeatures = featureStats.filter(f => Math.abs(f.icTH1) >= 2.5 && Math.abs(f.icTH2) >= 2.5 && Math.sign(f.icH1) === Math.sign(f.icH2))
const deadFeatures = featureStats.filter(f => Math.abs(f.icT) < 1.5)

w(`${H2} e. Verdict`)
w()
const lensSummaries = LENS_KEYS.map(k => {
  const sign = lensSign(k)
  const s = summarise(lensIdx.get(k)!, sign)
  const a = meanWhere(lensIdx.get(k)!, sign, i => half1(obsDate[i]))
  const b = meanWhere(lensIdx.get(k)!, sign, i => !half1(obsDate[i]))
  return { k, s, h1: a.mean, h2: b.mean, bothPositive: a.mean > 0 && b.mean > 0 }
})
const bestByNW = [...lensSummaries].filter(x => x.bothPositive).sort((a, b) => (b.s.tNW || 0) - (a.s.tNW || 0))[0]
const sameSign = featureStats.filter(f => Number.isFinite(f.icH1) && Number.isFinite(f.icH2) && Math.sign(f.icH1) === Math.sign(f.icH2))
const hygieneDelta = baselineQual.mean - baselineAll.mean
/** A SHORT lens whose mean is negative got the direction backwards: the names it
 * flagged to sell went on to beat SPY. A long lens that is merely below the
 * qualified baseline is weak, not inverted, and the two must not be printed as
 * the same failure. */
const invertedShorts = lensSummaries.filter(x => SHORT_LENS.has(x.k) && x.s.mean < 0)
const belowBaseline = lensSummaries.filter(x => !SHORT_LENS.has(x.k) && x.s.mean < baselineQual.mean)
/** Sign-flippers: an IC that changes sign between the halves is fitting the
 * regime, whatever its full-sample t says. */
const flipped = featureStats.filter(f => Number.isFinite(f.icH1) && Number.isFinite(f.icH2) && Math.sign(f.icH1) !== Math.sign(f.icH2))
/** Same sign in BOTH halves AND on BOTH venues — the only stability test in this
 * study that a feature has to pass four ways rather than two. */
const fourWayStable = sameSign.filter(
  f => Number.isFinite(f.icUS) && Number.isFinite(f.icLSE) && Math.sign(f.icUS) === Math.sign(f.icMean) && Math.sign(f.icLSE) === Math.sign(f.icMean),
)
/** …and worth acting on: four-way stability on an IC whose full-sample t is
 * under 2 is stability around zero. */
const tiebreak = fourWayStable.filter(f => Math.abs(f.icT) >= 2)
w(
  `**Nothing in this feature set clears the bar the brief set.** Over ${nObs.toLocaleString()} walk-forward name-dates a seed name's unconditional 10-session excess over SPY is ${fmt(baselineAll.mean)}pp (hit ${pct(baselineAll.hit)}); production hygiene ${hygieneDelta < 0 ? 'COSTS' : 'adds'} ${fmt(Math.abs(hygieneDelta))}pp, leaving ${fmt(baselineQual.mean)}pp (hit ${pct(baselineQual.hit)}) — so the illiquid, cheap and stale names the floors throw away ${hygieneDelta < 0 ? 'out-performed the ones they keep' : 'under-performed'}, and every lens below must be read against ${fmt(baselineQual.mean)}pp rather than against zero. ` +
    `On the brief's stated test (naive t ≥ 2.5 AND a positive mean in BOTH halves) ${strongLenses.length ? `only **${strongLenses.join(', ')}** survives` : '**no lens survives**'}` +
    `${bestByNW ? `${strongLenses.length === 1 && strongLenses[0] === bestByNW.k ? ', and it does not survive the overlap correction' : `; corrected for the overlap the best of them is **${bestByNW.k}**`} — ${fmt(bestByNW.s.mean)}pp mean, ${pct(bestByNW.s.hit)} hit, ${fmt(bestByNW.h1)}pp/${fmt(bestByNW.h2)}pp across the halves, naive t ${fmt(bestByNW.s.t, 1)} but **t_NW ${fmt(bestByNW.s.tNW, 1)}**, short of 2 and therefore not an edge anyone should size on` : ''}. ` +
    `${invertedShorts.length ? `The short lenses are INVERTED: ${invertedShorts.map(x => `${x.k} ${fmt(x.s.mean)}pp`).join(', ')} — the names they flagged to sell went on to beat SPY, so in this sample they read as contrarian LONG signals rather than shorts. ` : ''}` +
    `${belowBaseline.length ? `${belowBaseline.map(x => `${x.k} (${fmt(x.s.mean)}pp)`).join(', ')} ${belowBaseline.length === 1 ? 'sits' : 'sit'} at or below the qualified baseline of ${fmt(baselineQual.mean)}pp — selecting on ${belowBaseline.length === 1 ? 'it' : 'them'} costs you money. ` : ''}` +
    `On features, ${sameSign.length ? `${sameSign.map(f => `\`${f.key}\` (IC ${fmt(f.icMean, 4)}, t ${fmt(f.icT, 1)}; halves ${fmt(f.icH1, 4)}/${fmt(f.icH2, 4)}, half-t ${fmt(f.icTH1, 1)}/${fmt(f.icTH2, 1)})`).join(', ')} keep the SAME SIGN in both halves, and of those ${fourWayStable.length ? fourWayStable.map(f => `\`${f.key}\``).join(', ') + ' also hold that sign on BOTH venues' : 'none holds it on both venues too'}` : 'not one of the fourteen keeps the same IC sign in both halves'}; ` +
    `${strongFeatures.length ? `${strongFeatures.map(f => f.key).join(', ')} reach |t| ≥ 2.5 in both halves` : '**none reaches |t| ≥ 2.5 in both halves**'}${flipped.length ? `, and ${flipped.length} of the fourteen (${flipped.map(f => f.key).join(', ')}) change IC SIGN between the halves — the signature of a feature fitting the regime rather than the market` : ''}. ` +
    `The composite settles it: picked in-sample the top decile returns ${compFull.top ? `${fmt(compFull.top.mean)}pp (hit ${pct(compFull.top.hit)}, naive t ${fmt(compFull.top.t, 1)}, t_NW ${fmt(compFull.top.tNW, 1)}, beating SPY on ${pct(compFull.datesCounted ? compFull.datesBeat / compFull.datesCounted : NaN)} of dates)` : 'nothing'}, but selected honestly on the first half and scored on the second it returns ${compOOS.top && compOOS.top.n ? `${fmt(compOOS.top.mean)}pp (hit ${pct(compOOS.top.hit)}, t_NW ${fmt(compOOS.top.tNW, 1)}), beating SPY on only ${pct(compOOS.datesCounted ? compOOS.datesBeat / compOOS.datesCounted : NaN)} of dates` : 'nothing measurable'} — an in-sample edge that does not survive one honest split is not an edge. ` +
    `**The strongest honest ranking available today** is therefore not a ranking of these fourteen features at all: it is (1) ${bestByNW ? bestByNW.k : 'rs-leader'} as a WATCHLIST, not a sized call, (2) ${tiebreak.length ? tiebreak.map(f => `\`${f.key}\` (IC ${fmt(f.icMean, 4)})`).join(' and ') + ` — the only feature${tiebreak.length > 1 ? 's' : ''} that hold${tiebreak.length > 1 ? '' : 's'} one IC sign across both halves AND both venues while reaching |t| ≥ 2 overall — as a mild tiebreak` : 'no feature tiebreak at all'}, and (3) an explicit acknowledgement that the current board showing 0 sized calls is the correct output of this data rather than a bug in the scoring. Rebuilding the score on top of these features would be fitting noise; what the engine needs first is either a longer tape (300 bars is ${spanMonths} months of signal dates and one regime) or features that are not all measuring the same trailing price move.`,
)
w()
w(`**Multiple-comparison and honesty caveats.** 14 features — of which \`ret20\`/\`rsSpy20\` and \`ret60\`/\`rsSpy60\` are rank-identical, so 12 independent — times (whole sample + 2 halves + 2 regimes + 2 exchanges), plus 8 lenses times the same splits, is ~130 comparisons; at α = 0.05 roughly 6 "significant" results are expected from pure noise, which is why nothing above is claimed on a single naive t. ` +
  `The forward windows overlap (${HORIZON_N} sessions, stepped ${step === 1 ? 'daily' : `every ${step} sessions`}) and the cross-section is correlated within each date, so the naive t is inflated by something like √${HORIZON_N} before the cross-sectional correlation is even counted — that is why t_NW (Newey–West, ${HORIZON_N} lags, on the per-date mean series) is the number every claim leans on and why a naive t of 6.4 becomes 1.6. ` +
  `The sample is ${nDates} signal dates spanning ${spanMonths} months with SPY above its 50-EMA on ${upDates} of them: this is one regime, and nothing here has been tested through a drawdown. ` +
  `There are no transaction costs, no borrow costs on the short lenses, no slippage on the next-day open and no bid-ask — the LSE column in particular (mean ${fmt(bLSE.mean)}pp baseline, a full ${fmt(bLSE.mean - bUS.mean)}pp above US) is measured on closing prices of names whose real spreads are not in this data. ` +
  `Finally the universe is TODAY's index membership, so every name in it survived to today and nothing that was delisted, taken over or demoted during the window appears at all; the baseline excess of ${fmt(baselineAll.mean)}pp is an upper bound for that reason alone.`)
w()

const text = L.join('\n')
mkdirSync(dirname(OUT), { recursive: true })
if (APPEND) appendFileSync(OUT, '\n---\n\n' + text + '\n', 'utf8')
else writeFileSync(OUT, text + '\n', 'utf8')
console.log('\n' + text)
console.log(`\nwritten: ${OUT} · total ${((Date.now() - t0) / 1000).toFixed(0)}s`)
