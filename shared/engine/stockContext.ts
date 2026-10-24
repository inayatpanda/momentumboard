import { HISTORY_CORE_MODEL, HISTORY_GATED_MODEL } from './historyEvidence'
import type { Candle } from '../types'
import type { MarketPatternsSnapshot } from './marketPatterns'
import type { StrategyObservation, StrategyLabRecord } from './strategyLab'
import { completedLabCandles, LAB_EXECUTION_VERSION } from './strategyLab'
export const STOCK_CONTEXT_VERSION = 'market-sector-news-v1'
export interface ContextHeadline { title: string; url: string; syms: string[]; at: number; why: string; score: number; source?: string }
export interface StockContext {
  version: typeof STOCK_CONTEXT_VERSION; symbol: string; generatedAt: number; priceDate: string | null
  status: 'supportive' | 'mixed' | 'caution' | 'limited'
  summary: string; nextCheck: string
  support: string[]; risks: string[]; gaps: string[]
  sector: string | null; sectorSymbol: string | null
  stockMonthPct: number | null; stockVsSectorPp: number | null; sectorVsMarketPp: number | null
  market: { through: string; digest: string; regime: 'pressure' | 'rising' | 'mixed'; explanation: string; historical: string } | null
  news: { title: string; url: string; collectedAt: number; source?: string; interpretation: string }[]
  newsView: { side: 'long' | 'short'; reason: string } | null
  /** A fixed candidate probability adjustment, tested prospectively, never applied to live odds. */
  trialShift: number | null
}
const DAY = 86400
const fmt = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
const validUrl = (url: string) => { try { return ['https:', 'http:'].includes(new URL(url).protocol) } catch { return false } }
export function buildStockContext(input: {
  symbol: string; now: number; candles: Candle[]; spy: Candle[]
  sector: { name: string; symbol: string; candles: Candle[] } | null
  patterns: MarketPatternsSnapshot | null; headlines: ContextHeadline[]
  catalyst?: { side: 'long' | 'short' | null; reason: string } | null; earningsRisk?: boolean
}): StockContext {
  const { symbol, now } = input
  const out: StockContext = { version: STOCK_CONTEXT_VERSION, symbol, generatedAt: now, priceDate: null,
    status: 'limited', summary: 'More current information is needed.', nextCheck: 'Check company reports and wait for fresh prices before drawing a conclusion.', support: [], risks: [], gaps: [],
    sector: input.sector?.name ?? null, sectorSymbol: input.sector?.symbol ?? null, stockMonthPct: null, stockVsSectorPp: null, sectorVsMarketPp: null, market: null, news: [], newsView: null, trialShift: null }
  // Exact symbols only. A London ticker must not inherit a similarly named US company or US sector.
  const usListing = !/[.\-]/.test(symbol) || ['BRK.B', 'BF.B'].includes(symbol)
  const stocks = completedLabCandles(input.candles, now, symbol), spy = completedLabCandles(input.spy, now, 'SPY')
  const sectors = input.sector ? completedLabCandles(input.sector.candles, now, input.sector.symbol) : []
  const price = new Map(stocks.map(c => [day(c.t), c.c])), benchmark = new Map(spy.map(c => [day(c.t), c.c])), sector = new Map(sectors.map(c => [day(c.t), c.c]))
  const last = stocks.at(-1)
  if (last) out.priceDate = day(last.t)
  const end = out.priceDate, dates = [...price.keys()]
  const start = dates.at(-22)
  const fresh = last && now - last.t <= 7 * DAY && last.t <= now
  if (fresh && start && end) out.stockMonthPct = (price.get(end)! / price.get(start)! - 1) * 100
  else out.gaps.push('A full month of recent completed stock prices is missing.')
  if (usListing && input.sector && fresh && start && end && sector.has(start) && sector.has(end) && benchmark.has(start) && benchmark.has(end)) {
    const sectorReturn = (sector.get(end)! / sector.get(start)! - 1) * 100
    const marketReturn = (benchmark.get(end)! / benchmark.get(start)! - 1) * 100
    out.stockVsSectorPp = out.stockMonthPct! - sectorReturn
    out.sectorVsMarketPp = sectorReturn - marketReturn
    const strength = `${input.sector.name} ${out.sectorVsMarketPp >= 0 ? 'beat' : 'lagged'} the US market by ${Math.abs(out.sectorVsMarketPp).toFixed(1)} percentage points over the same month.`
    if (Math.abs(out.sectorVsMarketPp) >= 1) (out.sectorVsMarketPp > 0 ? out.support : out.risks).push(strength)
    const stockStrength = `${symbol} ${out.stockVsSectorPp >= 0 ? 'beat' : 'lagged'} its sector by ${Math.abs(out.stockVsSectorPp).toFixed(1)} percentage points.`
    if (Math.abs(out.stockVsSectorPp) >= 1) (out.stockVsSectorPp > 0 ? out.support : out.risks).push(stockStrength)
  } else out.gaps.push(usListing ? 'A matching sector and market comparison is unavailable.' : 'This listing is outside the US sector comparison; no US sector effect is assumed.')
  const p = input.patterns
  const patternAge = p ? now - Date.parse(`${p.dataThrough}T00:00:00Z`) / 1000 : Infinity
  if (p && p.generatedAt <= now && patternAge >= 0 && patternAge <= 7 * DAY) {
    const value = (sym: string) => p.current.find(c => c.symbol === sym)?.monthPct
    const shares = value('SPY'), oil = value('USO'), bonds = value('TLT')
    const oilLink = p.pairs.find(pair => pair.a === 'SPY' && pair.b === 'USO')
    if (finite(shares) && finite(oil) && finite(bonds)) {
      const oilPressure = oil > 5 && shares < 0 && oilLink?.recent != null && oilLink.recent < -.2
      const pressure = oilPressure || (shares < -2 && bonds < -2)
      const explanation = oilPressure ? `The oil futures fund rose ${Math.abs(oil).toFixed(1)}% while US shares fell ${Math.abs(shares).toFixed(1)}% over the month. This is a possible cost-pressure backdrop, not proof of an oil supply shock.`
        : pressure ? 'US shares and long-term government bonds both fell over the month. Diversifying between them has not protected against this recent fall.'
          : `US shares moved ${fmt(shares)}% and long-term government bonds ${fmt(bonds)}% over the month. This is the backdrop, not a forecast for this stock.`
      const returns = p.similar.map(r => r.returns[0]).filter(finite)
      const historical = returns.length ? `Across ${returns.length} similar past market periods, US shares finished higher ${returns.filter(v => v > 0).length} times in the following month. Outcomes ranged from ${fmt(Math.min(...returns))}% to ${fmt(Math.max(...returns))}%. These are market results, not ${symbol} results.` : 'No comparable historical market periods are available.'
      out.market = { through: p.dataThrough, digest: p.digest, regime: pressure ? 'pressure' : shares > 0 ? 'rising' : 'mixed', explanation, historical }
      if (pressure) out.risks.push('The wider market backdrop is unsettled; a good company can still fall with the market.')
    }
  }
  if (!out.market) out.gaps.push('Fresh cross-market history is unavailable; it cannot support this view.')
  const unique = new Map<string, ContextHeadline>()
  for (const h of input.headlines) {
    if (!Array.isArray(h.syms) || !h.syms.some(s => s.toUpperCase() === symbol.toUpperCase()) || !finite(h.at) || h.at > now || now - h.at > 3 * DAY || !validUrl(h.url) || !h.title) continue
    if (!unique.has(h.url)) unique.set(h.url, h)
  }
  const headlines = [...unique.values()].sort((a, b) => b.at - a.at).slice(0, 3)
  out.news = headlines.map(h => ({ title: h.title, url: h.url, collectedAt: h.at, source: h.source, interpretation: h.why }))
  if (!out.news.length) out.gaps.push('No linked company headline was collected in the past three days. This does not mean there is no news.')
  if (out.news.length && input.catalyst?.side) {
    out.newsView = { side: input.catalyst.side, reason: input.catalyst.reason }
    ;(input.catalyst.side === 'long' ? out.support : out.risks).push(`The news model sees a ${input.catalyst.side === 'long' ? 'possible benefit' : 'possible risk'}: ${input.catalyst.reason}. Check the source; this is an interpretation.`)
  }
  if (input.earningsRisk) out.risks.unshift('Earnings are close. A new report can outweigh both the chart and past patterns.')
  if (out.stockVsSectorPp != null && out.sectorVsMarketPp != null && out.market) {
    const positive = out.stockVsSectorPp >= 1 && out.sectorVsMarketPp >= 1
    const negative = out.stockVsSectorPp <= -1 && out.sectorVsMarketPp <= -1
    out.status = negative || input.earningsRisk || out.newsView?.side === 'short' ? 'caution' : positive && out.market.regime !== 'pressure' ? 'supportive' : 'mixed'
    out.summary = out.status === 'caution' ? 'There are reasons to be cautious before expecting a rise.' : out.status === 'supportive' ? 'The stock and its sector are showing strength together.' : 'The signals do not all point in the same direction.'
    out.nextCheck = input.earningsRisk ? 'Read the next earnings report before relying on the current pattern.' : negative ? 'Look for the stock to stop lagging its sector, then check whether company reports explain the weakness.' : out.stockVsSectorPp < 0 ? 'Look for the stock to catch up with its sector; sector strength alone is not enough.' : 'Check whether the next company report supports the price strength, and whether the sector keeps leading.'
    // Fixed small challenger, declared before observing outcomes. Correlated
    // stock and sector price evidence gets ONE joint vote, not two votes.
    const priceVote = positive ? 1 : negative ? -1 : 0
    const marketVote = out.market.regime === 'pressure' ? -1 : out.market.regime === 'rising' ? 1 : 0
    const newsVote = out.newsView?.side === 'long' ? 1 : out.newsView?.side === 'short' ? -1 : 0
    out.trialShift = input.earningsRisk ? null : (priceVote + marketVote + newsVote) * .01
  }
  return out
}
export interface ContextTrial {
  version: typeof STOCK_CONTEXT_VERSION; baseModelVersion: string; savedAt: number; baselineUp: number; candidateUp: number; shift: number
  patternDigest: string; contextStatus: StockContext['status']; newsCount: number
  stockVsSectorPp: number; sectorVsMarketPp: number; marketRegime: string; newsSide: string | null
}
export function withStockContext(observation: StrategyObservation, context?: StockContext): StrategyObservation {
  if (!context || context.generatedAt > observation.availableAt || observation.availableAt - context.generatedAt > 3 * DAY) return observation
  const p = observation.forecast.probabilityUp
  const eligible = [HISTORY_CORE_MODEL, HISTORY_GATED_MODEL].includes(observation.forecast.modelVersion ?? '') && observation.sleeve === 'short-horizon' && observation.forecast.definition === 'three-session-direction-v1' && observation.forecast.horizonSessions === 3 && finite(p) && p >= 0 && p <= 1 && context.trialShift != null && context.market && context.stockVsSectorPp != null && context.sectorVsMarketPp != null
  return { ...observation, metrics: { ...observation.metrics, contextVersion: context.version, contextStatus: context.status, contextSummary: context.summary },
    contextTrial: eligible ? { version: STOCK_CONTEXT_VERSION, baseModelVersion: observation.forecast.modelVersion!, savedAt: observation.availableAt, baselineUp: p!, candidateUp: Math.max(0, Math.min(1, p! + context.trialShift!)), shift: context.trialShift!, patternDigest: context.market!.digest,
      contextStatus: context.status, newsCount: context.news.length, stockVsSectorPp: context.stockVsSectorPp!, sectorVsMarketPp: context.sectorVsMarketPp!, marketRegime: context.market!.regime, newsSide: context.newsView?.side ?? null } : undefined }
}
export interface ContextTrialAudit {
  version: typeof STOCK_CONTEXT_VERSION; pending: number; completed: number; changed: number; publicationDays: number
  baselineBrier: number | null; candidateBrier: number | null; dayBalancedImprovement: number | null
  earlierImprovement: number | null; recentImprovement: number | null; status: 'collecting' | 'early-improvement' | 'no-improvement'
}
/** Frozen paired forecasts, no reconstructed news, no automatic promotion. */
export function auditContextTrials(records: StrategyLabRecord[], now: number): ContextTrialAudit {
  const valid = records.filter(r => r.contextTrial?.version === STOCK_CONTEXT_VERSION && [HISTORY_CORE_MODEL, HISTORY_GATED_MODEL].includes(r.contextTrial.baseModelVersion) && r.contextTrial.baseModelVersion === r.forecast.modelVersion && r.contextTrial.savedAt === r.availableAt && r.availableAt <= now && r.sleeve === 'short-horizon' && r.forecast.horizonSessions === 3 && r.forecast.definition === 'three-session-direction-v1')
  const seen = new Set<string>(), endBySym = new Map<string, number>()
  const completed = valid.filter(r => r.outcome?.executionVersion === LAB_EXECUTION_VERSION && finite(r.outcome.horizonEndAt) && r.outcome.horizonEndAt <= now && r.outcome.horizonEndAt > r.availableAt && typeof r.outcome.finishedHigher === 'boolean')
    .sort((a, b) => a.availableAt - b.availableAt || a.sym.localeCompare(b.sym)).filter(r => {
      const key = `${r.sym}:${r.availableAt}`
      if (seen.has(key) || r.availableAt < (endBySym.get(r.sym) ?? 0)) return false
      seen.add(key); endBySym.set(r.sym, r.outcome!.horizonEndAt!); return true
    })
  const errors = completed.flatMap(r => {
    const t = r.contextTrial!, actual = r.outcome!.finishedHigher ? 1 : 0
    return [t.baselineUp, t.candidateUp].every(p => finite(p) && p >= 0 && p <= 1) ? [{ date: day(r.availableAt), baseline: (t.baselineUp - actual) ** 2, candidate: (t.candidateUp - actual) ** 2, changed: t.baselineUp !== t.candidateUp }] : []
  })
  const days = [...new Set(errors.map(e => e.date))].sort()
  const improvements = days.map(d => mean(errors.filter(e => e.date === d).map(e => e.baseline - e.candidate))!)
  const half = Math.floor(improvements.length / 2), earlier = mean(improvements.slice(0, half)), recent = mean(improvements.slice(half))
  const enough = errors.filter(e => e.changed).length >= 60 && days.length >= 30
  return { version: STOCK_CONTEXT_VERSION, pending: valid.filter(r => !r.outcome).length, completed: errors.length, changed: errors.filter(e => e.changed).length, publicationDays: days.length,
    baselineBrier: mean(errors.map(e => e.baseline)), candidateBrier: mean(errors.map(e => e.candidate)), dayBalancedImprovement: mean(improvements), earlierImprovement: earlier, recentImprovement: recent,
    status: !enough ? 'collecting' : earlier != null && recent != null && earlier > 0 && recent > 0 ? 'early-improvement' : 'no-improvement' }
}
