import { quarterlyTrend } from '../../shared/quarterlyFinancials'
import { historicalFinancialState, FINANCIAL_HISTORY_VERSION, HISTORY_SECTORS, type FinancialPanel } from './historicalFundamentals'
import type { Candle } from '../../shared/types'
import { gradeStrategyObservation, shortHorizonObservations } from '../../shared/engine/strategyLab'
import { historyGate, HISTORY_CORE_MODEL, HISTORY_VERSION, type HistoryGate, type HistoricalStats, type HistoricalStrategy, type HistoricalStudy, type HistoricalTrade } from '../../shared/engine/historyEvidence'

// Fixed before evaluating this version; survivors remain a disclosed limitation.
export const HISTORY_SYMBOLS = Object.keys(HISTORY_SECTORS)
export const HISTORY_START = Date.UTC(2016, 0, 1) / 1000
export const EVALUATION_START = Date.UTC(2020, 0, 1) / 1000
export interface HistoryTape { sym: string; fetchedAt: number; candles: Candle[]; adjustment: number[]; splits?: { at: number; ratio: number }[] }
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
  const splits = Object.values(r.events?.splits ?? {}).map((split: any) => {
    if (!Number.isFinite(split.date) || !Number.isFinite(split.numerator) || !Number.isFinite(split.denominator) || split.numerator <= 0 || split.denominator <= 0) throw new Error(`${sym}: invalid split metadata`)
    return { at: split.date, ratio: split.numerator / split.denominator }
  }).sort((a, b) => a.at - b.at)
  return { sym, fetchedAt: now, candles, adjustment, splits }
}

export function adjustedReturn(entry: number, exit: number, entryAdjustment: number, exitAdjustment: number, short = false): number {
  const a = entry * entryAdjustment, b = exit * exitAdjustment
  return (short ? a - b : b - a) / a * 100
}

/** Calendar clusters keep contemporaneous stocks together. Moving four-quarter
 * blocks also retain serial dependence across overlapping holding windows.
 * The interval accounts for all displayed comparisons (Bonferroni);
 * it does NOT repair survivorship bias or establish prospective skill. */
export function historicalStats(rows: HistoricalTrade[], interval = true, comparisons = 9): HistoricalStats {
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
    if (samples.length) uncertaintyPp = [samples[Math.floor(samples.length * (.05 / (2 * comparisons)))], samples[Math.min(samples.length - 1, Math.floor(samples.length * (1 - .05 / (2 * comparisons))))]]
  }
  return { n: rows.length, quarters: groups.size, meanReturnPct: mean(rows.map(r => r.returnPct)), meanMarketPct: mean(rows.map(r => r.marketPct)),
    excessPp: mean(rows.map(r => r.returnPct - r.marketPct)), beatRate: mean(rows.map(r => Number(r.returnPct > r.marketPct))),
    brier: mean(paired.map(r => r.brier!)), baselineBrier: mean(paired.map(r => r.baselineBrier!)), uncertaintyPp }
}

export function buildHistoricalStudy(tapes: HistoryTape[], spy: HistoryTape, now: number, digest: string, log: (s: string) => void = () => {}, financialPanels: FinancialPanel[] = [], sectorTapes: HistoryTape[] = []): HistoricalStudy {
  const definitions: { key: string; label: string; horizon: number; description: string; financial?: boolean }[] = [
    { key: 'direction-core', label: 'Three-session direction', horizon: 3, description: 'Existing analogue model, tested on price data. Historical earnings exclusions and daily board ranking cannot be reconstructed.' },
    { key: 'direction-gated', label: 'Direction with an evidence filter', horizon: 3, description: 'Same signals; each year is allowed only if the prior two years beat SPY and improved probability error over the stock’s normal drift.' },
    { key: 'pullback-price', label: 'Stabilising pullback', horizon: 63, description: 'Price-only control: 8–35% below the 63-session high, above a rising 20-session average. This does not test business health or valuation.' },
    { key: 'trend-price', label: 'Trend and relative strength', horizon: 20, description: 'Price-only control: above the 200-session average, 50-session average above 200, and a stronger 20-session return than SPY.' },
    { key: 'big-drop-price', label: 'Big drop · price only', horizon: 63, description: 'Control for the financial recovery tests: 20–60% below the 252-session highest close, above a rising 20-session average. Hold 63 sessions.' },
    { key: 'healthy-drop', label: 'Healthy business after a big drop', horizon: 63, financial: true, description: 'Same 20–60% drawdown and stabilisation as the big-drop control, plus the dated sector health screen: profit, cash flow, growth, dilution, leverage and liquidity. Hold 63 sessions.' },
    { key: 'healthy-value-drop', label: 'Healthy, good-value recovery', horizon: 63, financial: true, description: 'Healthy big-drop screen plus sector-specific ceilings on annual P/E and floors on annual free-cash-flow yield. Historical market cap uses dated shares and split-consistent prices. Hold 63 sessions; no historical news or catalyst filter.' },
    { key: 'quality-trend', label: 'Healthy business with momentum', horizon: 20, financial: true, description: 'Same trend and relative-strength rules as the price control, plus the dated sector health screen. Hold 20 sessions.' },
    { key: 'quality-value', label: 'Healthy business at a fair valuation', horizon: 63, financial: true, description: 'Dated sector health and annual valuation screens, with no drawdown or momentum requirement. Hold 63 sessions.' },
    { key: 'quarterly-recovery', label: 'Recovery with healthy quarterly trends', horizon: 63, financial: true, description: 'Same big-drop and stabilisation screen plus annual sector health, three comparable quarters, non-deteriorating quarterly trends, non-negative latest year-on-year revenue growth and positive trailing-four-quarter profit and free cash flow. No news filter.' },
    { key: 'sector-leader', label: 'Strength within a strong sector', horizon: 20, description: 'Stock above its 200-session average, beating its sector over 20 sessions, with the sector itself beating SPY. Next-open entry; fixed 20-session hold.' },
    { key: 'shock-rebound', label: 'Recovery after a sharp sell-off', horizon: 20, description: 'A fall of at least 7% in the preceding five sessions, followed by a 2% rise today, a close in the upper half of today’s range and volume at least 1.5 times its prior 20-session average. Price-and-volume test only; the cause is not assumed to be news.' },
  ]
  const comparisons = definitions.length * 2 // market and sector hypotheses
  const trades: Record<string, HistoricalTrade[]> = Object.fromEntries(definitions.map(d => [d.key, []]))
  const cancelled: Record<string, number> = {}, missing: Record<string, number> = {}, unknown: Record<string, number> = {}, candidates: Record<string, number> = {}
  const spyIndex = new Map(spy.candles.map((c, i) => [day(c.t), i]))
  for (const tape of tapes) {
    const panel = financialPanels.find(p => p.sym === tape.sym)
    const sectorTape = sectorTapes.find(t => t.sym === HISTORY_SECTORS[tape.sym])
    const sectorIndex = new Map(sectorTape?.candles.map((c,i) => [day(c.t),i]) ?? [])
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
      const bigDrop = (1 - bars[i].c / Math.max(...prefix.map(c => c.c), ...bars.slice(i - 251, i - 249).map(c => c.c))) * 100
      const recovering = bigDrop >= 20 && bigDrop <= 60 && bars[i].c > avg(20) && avg(20) > avg(20, i - 5)
      const financial = historicalFinancialState(panel, tape.sym, signalAt, bars[i].c, tape.splits)
      const healthOK = financial.health.status === 'healthy', valueOK = financial.valuation.status === 'supported'
      const quarterly = financial.snapshot?.quarterly, latestQuarter = quarterly?.quarters.at(-1), trailing = quarterly?.trailingYear
      const quarterStatus = quarterly ? quarterlyTrend(quarterly.quarters, signalAt) : 'insufficient'
      const quarterlyKnown = !!quarterly && quarterStatus !== 'insufficient' && trailing?.values.netIncome != null && trailing.values.freeCashFlow != null && latestQuarter?.revenueGrowthPct != null
      const quarterlyOK = quarterlyKnown && quarterStatus !== 'deteriorating' && trailing!.values.netIncome! > 0 && trailing!.values.freeCashFlow! > 0 && latestQuarter!.revenueGrowthPct! >= 0
      const sci = sectorIndex.get(day(bars[i].t))
      const sectorLeader = sci != null && sci >= 20 && sectorTape && day(sectorTape.candles[sci - 20].t) === day(bars[i - 20].t) &&
        bars[i].c > avg(200) && bars[i].c / bars[i - 20].c > sectorTape.candles[sci].c / sectorTape.candles[sci - 20].c &&
        sectorTape.candles[sci].c / sectorTape.candles[sci - 20].c > spy.candles[si].c / spy.candles[si - 20].c
      const shock = Array.from({length:5}, (_,j) => i-1-j).some(k => bars[k].c / bars[k-1].c <= .93)
      const volumeBase = bars.slice(i-20,i).reduce((n,c)=>n+c.v,0)/20
      const shockRebound = shock && bars[i].c / bars[i-1].c >= 1.02 && bars[i].c >= (bars[i].h+bars[i].l)/2 && volumeBase > 0 && bars[i].v >= volumeBase*1.5
      for (const d of definitions.filter(d => d.key !== 'direction-gated')) {
        const core = d.key === 'direction-core'
        // The horizon's close can produce the next signal: its entry is on the
        // following open, after the previous campaign has fully ended.
        if (i < (occupied[d.key] ?? -1)) continue
        const priceEligible = core ? !!obs && obs.state === 'setup' : d.key === 'pullback-price' ? pullback
          : d.key === 'sector-leader' ? !!sectorLeader : d.key === 'shock-rebound' ? shockRebound : ['trend-price', 'quality-trend'].includes(d.key) ? trend : d.key === 'quality-value' ? true : recovering
        if (!priceEligible) continue
        if (d.financial) {
          if (signalAt >= EVALUATION_START) candidates[d.key] = (candidates[d.key] ?? 0) + 1
          const needsValue = ['healthy-value-drop', 'quality-value'].includes(d.key)
          if ((d.key === 'quarterly-recovery' && !quarterlyKnown) || financial.health.status === 'unknown' || (needsValue && financial.valuation.status === 'unknown')) {
            if (signalAt >= EVALUATION_START) unknown[d.key] = (unknown[d.key] ?? 0) + 1
            continue
          }
          if (!healthOK || (needsValue && !valueOK) || (d.key === 'quarterly-recovery' && !quarterlyOK)) continue
        }
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
        const sectorComplete = sci != null && sectorTape && Array.from({length:d.horizon+1}, (_,j) => sectorTape.candles[sci+j] && day(sectorTape.candles[sci+j].t) === day(bars[i+j].t)).every(Boolean)
        const sectorPct = sectorComplete ? adjustedReturn(sectorTape!.candles[sci!+1].o*1.001, sectorTape!.candles[sci!+d.horizon].c*.999, sectorTape!.adjustment[sci!+1], sectorTape!.adjustment[sci!+d.horizon]) : undefined
        const up = Number(bars[i + 3].c > bars[i].c)
        trades[d.key].push({ sym: tape.sym, signalAt, endAt: day(bars[end].t) * 86400 + 22 * 3600, returnPct: ret, marketPct, sectorPct, sector: HISTORY_SECTORS[tape.sym],
          ...(d.financial ? { sector: financial.sector, filingAt: financial.snapshot?.availableAt ?? undefined, annualPeriodEnd: financial.snapshot?.annualPeriodEnd ?? undefined, annualPE: financial.valuation.pe, fcfYieldPct: financial.valuation.fcfYieldPct } : {}),
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
    const stats = historicalStats(rows, true, comparisons)
    const years = [...new Set(rows.map(t => yearOf(t.signalAt)))].sort().map(year => ({ year, stats: historicalStats(rows.filter(t => yearOf(t.signalAt) === year), false) }))
    const stable = stats.n >= 60 && stats.quarters >= 12 && years.length >= 3 && years.filter(y => (y.stats.excessPp ?? 0) > 0).length / years.length >= .6
    const sectorRows = rows.filter(r => r.sectorPct != null).map(r => ({...r, marketPct:r.sectorPct!}))
    const sectorStats = historicalStats(sectorRows, true, comparisons)
    const sectorYears = [...new Set(sectorRows.map(t => yearOf(t.signalAt)))].map(y => historicalStats(sectorRows.filter(t => yearOf(t.signalAt)===y),false))
    const sectorStable = sectorStats.n >= 60 && sectorStats.quarters >= 12 && sectorYears.length >= 3 && sectorYears.filter(y=>(y.excessPp??0)>0).length/sectorYears.length >= .6
    const sectorStatus = !sectorStats.n ? 'no-trades' as const : (sectorStats.excessPp??0)<0 ? 'behind' as const : sectorStable && sectorStats.uncertaintyPp && sectorStats.uncertaintyPp[0]>0 ? 'ahead' as const : 'uncertain' as const
    return { ...d, stats, years, sectorStats, sectorStatus, missingSectorN: rows.length-sectorRows.length,
      sectors: [...new Set(rows.map(t => t.sector!))].sort().map(sector => {
        const group = rows.filter(t => t.sector === sector)
        const matched = group.filter(t => t.sectorPct != null).map(t => ({ ...t, marketPct: t.sectorPct! }))
        return { sector, stats: historicalStats(group, false), sectorStats: historicalStats(matched, false) }
      }),
      ...(d.financial ? { candidateN: candidates[d.key] ?? 0, unknownFinancialN: unknown[d.key] ?? 0,
        examples: [...rows].sort((a, b) => b.signalAt - a.signalAt).slice(0, 3) } : {}),
      cancelledN: cancelled[d.key] ?? 0, missingN: missing[d.key] ?? 0,
      status: !stats.n ? 'no-trades' : (stats.excessPp ?? 0) < 0 ? 'behind' : stable && stats.uncertaintyPp && stats.uncertaintyPp[0] > 0 ? 'ahead' : 'uncertain' }
  })
  const dataThrough = Math.min(spy.candles.at(-1)!.t, ...tapes.map(t => t.candles.at(-1)!.t))
  return { version: HISTORY_VERSION, coreModel: HISTORY_CORE_MODEL, generatedAt: now, dataFrom: spy.candles[0].t, dataThrough,
    evaluationFrom: EVALUATION_START, symbols: HISTORY_SYMBOLS, missingSymbols: HISTORY_SYMBOLS.filter(s => !tapes.some(t => t.sym === s)),
    financialCoverage: { version: FINANCIAL_HISTORY_VERSION, symbols: financialPanels.filter(p => p.points.length).map(p => p.sym),
      unavailableSymbols: HISTORY_SYMBOLS.filter(sym => !financialPanels.some(p => p.sym === sym && p.points.length)), snapshots: financialPanels.reduce((n, p) => n + p.points.length, 0),
      companies: financialPanels.map(p => ({ sym: p.sym, snapshots: p.points.length, firstAvailableAt: p.points[0]?.availableAt ?? null, latestAvailableAt: p.points.at(-1)?.availableAt ?? null })) },
    comparisons, confidencePct: (1 - .05 / comparisons) * 100,
    strategies, gates, liveGate: gates.at(-1)!, costBpsPerSide: 10, dataDigest: digest,
    caveats: [
      'Historical reconstruction, not forecasts published at the time. These rules were designed after the historical period; chronological testing cannot remove that research bias.',
      'Fixed panel of 55 surviving US stocks, five per sector. EA was considered but its historical feed contained only the final acquisition-day price; NFLX replaced it for data availability before results were inspected. EQR and AVB also lacked usable free histories; WELL fills the fifth REIT slot. The larger panel is a robustness check, not an unbiased historical universe. Missing delisted firms and historical constituents create survivorship bias. These results do not represent the whole market or live board selections.',
      '2016–2017 warms the features; 2018–2019 supplies initial learning. Evaluation begins in 2020. Each yearly evidence filter uses only fully completed outcomes from the preceding two years; boundary-crossing outcomes are purged.',
      'Next-session open, 10 basis points per side for both strategy and SPY. Dividend-adjusted return estimates use the free feed’s adjusted-close ratios. Early exits stay in cash at zero until the same benchmark horizon ends. Borrow costs, taxes and financing are excluded.',
      'Sector ETFs are matched on every holding-window date and pay the same costs. Missing sector dates are excluded from sector statistics only and disclosed. Present-day sector mappings are fixed, not historical classifications.',
      'Returns are means per completed setup, not compounded portfolio returns or annual returns. Same-stock trades cannot overlap. Stocks moving together are clustered by calendar quarter with moving one-year bootstrap blocks.',
      `The uncertainty range is a ${((1 - .05 / comparisons) * 100).toFixed(2)}% block-bootstrap interval, adjusted for all ${comparisons} market/sector comparisons. A positive average alone is not evidence of a durable edge. Free prices and corporate-action adjustments may be revised.`,
      'Financial screens use only reports filed by next-day noon UTC at the signal date. Annual financial/value screens retain annual flows. The quarterly recovery screen separately reconstructs consecutive quarters and trailing-year profit/cash flow without overlapping YTD totals. Missing values never become healthy; financials, utilities and REITs remain specialist-review exclusions. Sector classifications are a fixed present-day mapping, not historical classifications.',
      'Historical valuation reconstructs market cap from dated common shares and split-consistent prices. Share observations expire after 180 days; ambiguous share counts and missing split metadata exclude valuation. This is an estimate, not historical vendor market cap.',
      'Financial rules and thresholds were fixed before this run. All predeclared strategies are reported, including failures. This is retrospective research, not untouched prospective validation. Sector breakdowns are descriptive and not independently validated strategies.',
      'The three-session core is simulated without dated earnings exclusions; it is not a full replay of the production board. Price-only controls cannot validate the financial or social strategies; comparisons across differently selected trades do not isolate a causal effect of the filters. No simulation is added to the live forecast ledger.',
    ], unavailable: [
      { label: 'Complete live recovery strategy', reason: 'Historical financial screens are now tested, but dated catalyst/news, report-trajectory gates and the live stop/target rules differ. Fixed-horizon financial tests do not validate the complete live recovery strategy.' },
      { label: 'Institutional, insider and congressional following', reason: 'No complete dated disclosure dataset has been backtested here. Positions must be evaluated from public disclosure dates, never the earlier trade or quarter-end date. These sources remain research context, not validated return strategies.' },
      { label: 'Acute news reactions', reason: 'The sharp-sell-off test measures price and volume only. A dated headline/event archive is required to establish a news-reaction strategy.' },
      { label: 'YouTube / social ignition', reason: 'Needs dated transcripts, channel coverage and attention history. Today’s content cannot stand in for historical evidence.' },
      { label: 'Complete board engine', reason: 'Historical news, earnings gates and candidate rankings are incomplete. Only actually saved board forecasts are audited separately.' },
    ] }
}
