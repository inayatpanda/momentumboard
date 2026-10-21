import type { Candle } from '../../shared/types'
import { gradeStrategyObservation, shortHorizonObservations } from '../../shared/engine/strategyLab'
import { historyGate, HISTORY_CORE_MODEL, HISTORY_VERSION, type HistoryGate, type HistoricalStats, type HistoricalStrategy, type HistoricalStudy, type HistoricalTrade } from '../../shared/engine/historyEvidence'

// Frozen before inspecting results. Two established US stocks per broad sector;
// a bounded sensitivity panel, NOT historical S&P constituents or the live board.
export const HISTORY_SYMBOLS = ['AAPL', 'MSFT', 'JPM', 'BAC', 'JNJ', 'PFE', 'XOM', 'CVX', 'CAT', 'HON', 'PG', 'KO', 'HD', 'MCD', 'DIS', 'VZ', 'DUK', 'SO', 'NEM', 'FCX', 'AMT', 'SPG']
export const HISTORY_START = Date.UTC(2016, 0, 1) / 1000
export const EVALUATION_START = Date.UTC(2020, 0, 1) / 1000
export interface HistoryTape { sym: string; fetchedAt: number; candles: Candle[]; adjustment: number[] }
const day = (t: number) => Math.floor(t / 86400)
const yearOf = (t: number) => new Date(t * 1000).getUTCFullYear()
const quarterOf = (t: number) => { const d = new Date(t * 1000); return d.getUTCFullYear() * 4 + Math.floor(d.getUTCMonth() / 3) }
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null

/** Refuse partial/malformed bars and absent adjusted closes; no fabricated OHLC.
 * Features use split-adjusted price bars; outcomes additionally incorporate the
 * provider's dividend-adjustment ratio on each actual execution date. */
export function parseHistoryTape(json: any, sym: string, now: number): HistoryTape {
  const r = json?.chart?.result?.[0], q = r?.indicators?.quote?.[0], adj = r?.indicators?.adjclose?.[0]?.adjclose
  if (r?.meta?.symbol !== sym || !Array.isArray(r?.timestamp) || !q || !Array.isArray(adj)) throw new Error(`${sym}: missing history or adjustment data`)
  const candles: Candle[] = [], adjustment: number[] = [], seen = new Set<number>()
  for (let i = 0; i < r.timestamp.length; i++) {
    const t = r.timestamp[i]
    if (!Number.isFinite(t) || day(t) >= day(now) || t < HISTORY_START) continue
    const values = [q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i], q.volume?.[i], adj[i]]
    if (!values.every(v => typeof v === 'number' && Number.isFinite(v)) || values.slice(0, 4).some(v => v <= 0) || adj[i] <= 0 || q.volume[i] < 0 ||
      q.low[i] > Math.min(q.open[i], q.close[i]) || q.high[i] < Math.max(q.open[i], q.close[i]) || seen.has(day(t))) throw new Error(`${sym}: invalid or duplicate bar`)
    seen.add(day(t)); candles.push({ t, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] }); adjustment.push(adj[i] / q.close[i])
  }
  if (candles.some((c, i) => i > 0 && c.t <= candles[i - 1].t)) throw new Error(`${sym}: unordered history`)
  return { sym, fetchedAt: now, candles, adjustment }
}

export function adjustedReturn(entry: number, exit: number, entryAdjustment: number, exitAdjustment: number, short = false): number {
  const a = entry * entryAdjustment, b = exit * exitAdjustment
  return (short ? a - b : b - a) / a * 100
}

/** Calendar clusters keep contemporaneous stocks together. Moving four-quarter
 * blocks also retain serial dependence across overlapping holding windows.
 * The 98.75% interval accounts for four displayed comparisons (Bonferroni);
 * it does NOT repair survivorship bias or establish prospective skill. */
export function historicalStats(rows: HistoricalTrade[], interval = true): HistoricalStats {
  const groups = new Map<number, HistoricalTrade[]>()
  for (const t of rows) { const q = quarterOf(t.signalAt); groups.set(q, [...(groups.get(q) ?? []), t]) }
  const paired = rows.filter(r => r.brier != null && r.baselineBrier != null)
  let uncertaintyPp: [number, number] | null = null
  if (interval && groups.size >= 12) {
    const keys = [...groups.keys()].sort((a, b) => a - b)
    const blocks: { sum: number; n: number }[] = []
    for (let q = keys[0]; q <= keys.at(-1)!; q++) {
      const g = groups.get(q) ?? []; blocks.push({ sum: g.reduce((s, t) => s + t.returnPct - t.marketPct, 0), n: g.length })
    }
    let seed = 21102026
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
    const samples: number[] = []
    for (let k = 0; k < 4000; k++) {
      let total = 0, n = 0, used = 0
      while (used < blocks.length) {
        const start = Math.floor(random() * blocks.length)
        for (let j = 0; j < 4 && used < blocks.length; j++, used++) { const b = blocks[(start + j) % blocks.length]; total += b.sum; n += b.n }
      }
      if (n) samples.push(total / n)
    }
    samples.sort((a, b) => a - b)
    if (samples.length) uncertaintyPp = [samples[Math.floor(samples.length * .00625)], samples[Math.min(samples.length - 1, Math.floor(samples.length * .99375))]]
  }
  return { n: rows.length, quarters: groups.size, meanReturnPct: mean(rows.map(r => r.returnPct)), meanMarketPct: mean(rows.map(r => r.marketPct)),
    excessPp: mean(rows.map(r => r.returnPct - r.marketPct)), beatRate: mean(rows.map(r => Number(r.returnPct > r.marketPct))),
    brier: mean(paired.map(r => r.brier!)), baselineBrier: mean(paired.map(r => r.baselineBrier!)), uncertaintyPp }
}

export function buildHistoricalStudy(tapes: HistoryTape[], spy: HistoryTape, now: number, digest: string, log: (s: string) => void = () => {}): HistoricalStudy {
  const definitions = [
    { key: 'direction-core', label: 'Three-session direction', horizon: 3, description: 'Existing analogue model, tested on price data. Historical earnings exclusions and daily board ranking cannot be reconstructed.' },
    { key: 'direction-gated', label: 'Direction with an evidence filter', horizon: 3, description: 'Same signals; each year is allowed only if the prior two years beat SPY and improved probability error over the stock’s normal drift.' },
    { key: 'pullback-price', label: 'Stabilising pullback', horizon: 63, description: 'Price-only control: 8–35% below the 63-session high, above a rising 20-session average. This does not test business health or valuation.' },
    { key: 'trend-price', label: 'Trend and relative strength', horizon: 20, description: 'Price-only control: above the 200-session average, 50-session average above 200, and a stronger 20-session return than SPY.' },
  ]
  const trades: Record<string, HistoricalTrade[]> = Object.fromEntries(definitions.map(d => [d.key, []]))
  const cancelled: Record<string, number> = {}, missing: Record<string, number> = {}
  const spyIndex = new Map(spy.candles.map((c, i) => [day(c.t), i]))
  for (const tape of tapes) {
    const bars = tape.candles, occupied: Record<string, number> = {}
    for (let i = 520; i + 3 < bars.length; i++) {
      const signalAt = day(bars[i].t) * 86400 + 22 * 3600
      if (signalAt >= now || signalAt < Date.UTC(2018, 0, 1) / 1000) continue
      const si = spyIndex.get(day(bars[i].t))
      if (si == null || si < 200) continue
      // Same fixed 250-session maximum as the live model.
      // Future bars go ONLY to settlement, never to signal construction.
      const prefix = bars.slice(i - 249, i + 1)
      const obs = shortHorizonObservations([{ sym: tape.sym, candles: prefix }], signalAt)[0]
      const avg = (n: number, end = i) => bars.slice(end - n + 1, end + 1).reduce((s, c) => s + c.c, 0) / n
      const drop = (1 - bars[i].c / Math.max(...bars.slice(i - 62, i + 1).map(c => c.h))) * 100
      const pullback = drop >= 8 && drop <= 35 && bars[i].c > avg(20) && avg(20) > avg(20, i - 5)
      const trend = bars[i].c > avg(200) && avg(50) > avg(200) && bars[i].c / bars[i - 20].c > spy.candles[si].c / spy.candles[si - 20].c
      for (const d of definitions.filter(d => d.key !== 'direction-gated')) {
        const core = d.key === 'direction-core'
        // The horizon's close can produce the next signal: its entry is on the
        // following open, after the previous campaign has fully ended.
        if (i < (occupied[d.key] ?? -1) || (core ? !obs || obs.state !== 'setup' : d.key === 'pullback-price' ? !pullback : !trend)) continue
        const end = i + d.horizon
        if (end >= bars.length) continue
        const complete = Array.from({ length: d.horizon + 1 }, (_, j) => spy.candles[si + j] && day(bars[i + j].t) === day(spy.candles[si + j].t)).every(Boolean)
        if (!complete) { if (signalAt >= EVALUATION_START) missing[d.key] = (missing[d.key] ?? 0) + 1; continue }
        occupied[d.key] = end
        let ret: number
        if (core) {
          const outcome = gradeStrategyObservation(obs!, bars.slice(i, end + 1), day(bars[end].t) * 86400 + 22 * 3600)
          if (!outcome || outcome.executionStatus !== 'filled') { if (signalAt >= EVALUATION_START) cancelled[d.key] = (cancelled[d.key] ?? 0) + 1; continue }
          const exitIdx = i + outcome.sessions
          ret = adjustedReturn(outcome.entry, outcome.exit, tape.adjustment[i + 1], tape.adjustment[exitIdx], obs!.side === 'short')
        } else ret = adjustedReturn(bars[i + 1].o * 1.001, bars[end].c * .999, tape.adjustment[i + 1], tape.adjustment[end])
        const marketPct = adjustedReturn(spy.candles[si + 1].o * 1.001, spy.candles[si + d.horizon].c * .999, spy.adjustment[si + 1], spy.adjustment[si + d.horizon])
        const up = Number(bars[i + 3].c > bars[i].c)
        trades[d.key].push({ sym: tape.sym, signalAt, endAt: day(bars[end].t) * 86400 + 22 * 3600, returnPct: ret, marketPct,
          ...(core ? { brier: (obs!.forecast.probabilityUp! - up) ** 2, baselineBrier: (obs!.forecast.baselineProbabilityUp! - up) ** 2 } : {}) })
      }
    }
    log(`${tape.sym}: ${bars.length} daily sessions checked`)
  }
  const currentYear = yearOf(now), gates: HistoryGate[] = []
  for (let year = 2020; year <= currentYear; year++) gates.push(historyGate(trades['direction-core'], year))
  trades['direction-gated'] = trades['direction-core'].filter(t => gates.find(g => g.year === yearOf(t.signalAt))?.allow)
  const strategies: HistoricalStrategy[] = definitions.map(d => {
    const rows = trades[d.key].filter(t => t.signalAt >= EVALUATION_START && t.endAt < now)
    const stats = historicalStats(rows)
    const years = [...new Set(rows.map(t => yearOf(t.signalAt)))].sort().map(year => ({ year, stats: historicalStats(rows.filter(t => yearOf(t.signalAt) === year), false) }))
    const stable = stats.n >= 60 && stats.quarters >= 12 && years.length >= 3 && years.filter(y => (y.stats.excessPp ?? 0) > 0).length / years.length >= .6
    return { ...d, stats, years, cancelledN: cancelled[d.key] ?? 0, missingN: missing[d.key] ?? 0,
      status: !stats.n ? 'no-trades' : (stats.excessPp ?? 0) < 0 ? 'behind' : stable && stats.uncertaintyPp && stats.uncertaintyPp[0] > 0 ? 'ahead' : 'uncertain' }
  })
  const dataThrough = Math.min(spy.candles.at(-1)!.t, ...tapes.map(t => t.candles.at(-1)!.t))
  return { version: HISTORY_VERSION, coreModel: HISTORY_CORE_MODEL, generatedAt: now, dataFrom: spy.candles[0].t, dataThrough,
    evaluationFrom: EVALUATION_START, symbols: HISTORY_SYMBOLS, missingSymbols: HISTORY_SYMBOLS.filter(s => !tapes.some(t => t.sym === s)),
    strategies, gates, liveGate: gates.at(-1)!, costBpsPerSide: 10, dataDigest: digest,
    caveats: [
      'Historical reconstruction, not forecasts published at the time. These rules were designed after the historical period; chronological testing cannot remove that research bias.',
      'Fixed panel of 22 surviving US stocks, two per sector. Missing delisted firms and historical constituents create survivorship bias. These results do not represent the whole market or live board selections.',
      '2016–2017 warms the features; 2018–2019 supplies initial learning. Evaluation begins in 2020. Each yearly evidence filter uses only fully completed outcomes from the preceding two years; boundary-crossing outcomes are purged.',
      'Next-session open, 10 basis points per side for both strategy and SPY. Dividend-adjusted return estimates use the free feed’s adjusted-close ratios. Early exits stay in cash at zero until the same benchmark horizon ends. Borrow costs, taxes and financing are excluded.',
      'Returns are means per completed setup, not compounded portfolio returns or annual returns. Same-stock trades cannot overlap. Stocks moving together are clustered by calendar quarter with moving one-year bootstrap blocks.',
      'The uncertainty range is a 98.75% block-bootstrap interval, adjusted for four comparisons. A positive average alone is not evidence of a durable edge. Free prices and corporate-action adjustments may be revised.',
      'The three-session core is simulated without dated earnings exclusions; it is not a full replay of the production board. Price-only controls cannot validate the financial or social strategies. No simulation is added to the live forecast ledger.',
    ], unavailable: [
      { label: 'Quality recovery with sector valuation', reason: 'Needs point-in-time financial reports, share counts, valuation and catalyst evidence. A price pullback alone cannot validate this strategy.' },
      { label: 'YouTube / social ignition', reason: 'Needs dated transcripts, channel coverage and attention history. Today’s content cannot stand in for historical evidence.' },
      { label: 'Complete board engine', reason: 'Historical news, earnings gates and candidate rankings are incomplete. Only actually saved board forecasts are audited separately.' },
    ] }
}
