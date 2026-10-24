import { assessBusinessHealth, type BusinessHealthSnapshot } from '../businessHealth'
import { sectorFinancialPolicy } from '../sectorFinancials'
import { summarizeReportTrends } from '../reportTrends'
import type { Candle } from '../types'
import type { StockContext } from './stockContext'
import { completedLabCandles } from './strategyLab'

const DAY = 86400
const date = (t: number) => new Date(t * 1000).toISOString().slice(0, 10)
export const londonDay = (t: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t * 1000))
const signed = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}`
export interface DropCheck {
  status: 'no-large-drop' | 'holding-up' | 'weakening' | 'unclear' | 'not-applicable'
  label: string; summary: string; next: string
  drawdownPct: number | null; sessions: number; weekPct: number | null
  health: 'healthy' | 'deteriorating' | 'unknown'; trend: string; reportAvailableAt: number | null
  reportPeriod: string | null; sourceUrl: string | null
  facts: string[]; gaps: string[]; newsReason: string | null
}
export function buildDropCheck(input: { symbol: string; now: number; candles: Candle[]; sector?: string | null; health?: BusinessHealthSnapshot | null; news?: { verdict: 'transient' | 'structural' | 'unclear'; reason: string } | null }): DropCheck {
  const { symbol, now } = input
  const tape = completedLabCandles(input.candles, now, symbol).slice(-252)
  const fresh = !!tape.length && now - tape.at(-1)!.t <= 7 * DAY
  const drawdown = fresh && tape.length >= 60 ? (tape.at(-1)!.c / Math.max(...tape.map(c => c.c)) - 1) * 100 : null
  const week = fresh && tape.length >= 6 ? (tape.at(-1)!.c / tape.at(-6)!.c - 1) * 100 : null
  const out: DropCheck = { status: 'unclear', label: 'More evidence needed', summary: 'We cannot yet tell whether this is a temporary setback or a weakening business.', next: 'Read the latest company report and the reason for the fall.', drawdownPct: drawdown, sessions: tape.length, weekPct: week, health: 'unknown', trend: 'insufficient', reportAvailableAt: null, reportPeriod: null, sourceUrl: null, facts: [], gaps: [], newsReason: input.news?.reason ?? null }
  if (/[.\-]/.test(symbol) && !['BRK.B', 'BF.B'].includes(symbol)) {
    return { ...out, status: 'not-applicable', label: 'Company check unavailable', summary: 'This listing is outside our US company-report checks. A price fall alone cannot tell us whether it is a bargain.', next: 'Use reports for this exact listing; US company checks may not apply.' }
  }
  const h = input.health?.sym === symbol && input.health.status !== 'stale' && input.health.availableAt != null && input.health.availableAt <= now ? input.health : null
  const assessment = assessBusinessHealth(h, now, input.sector)
  const trend = summarizeReportTrends(h?.reportHistory ?? [], now)
  out.health = assessment.status
  out.trend = trend.status
  out.reportAvailableAt = h?.availableAt ?? null
  out.reportPeriod = h?.balancePeriodEnd ?? null
  out.sourceUrl = h?.sourceUrl?.startsWith('https://') ? h.sourceUrl : null
  out.gaps = [...assessment.gaps, ...trend.gaps]
  if (!fresh || drawdown == null) out.gaps.unshift('At least 60 recent completed sessions are needed for the high-price comparison.')
  if (h) {
    const labels = { netIncome: 'Annual profit', operatingCashFlow: 'Annual cash from operations', freeCashFlow: 'Annual cash left after capital spending', revenueGrowthPct: 'Annual sales growth', recentRevenueGrowthPct: 'Latest comparable interim sales growth' } as const
    for (const key of Object.keys(labels) as (keyof typeof labels)[]) {
      const e = h.evidence[key], value = h.metrics[key]
      if (value == null || !Number.isFinite(value) || !e || e.availableAt > now) continue
      out.facts.push(`${labels[key]}: ${key.includes('Growth') ? `${signed(value)}%` : value > 0 ? 'positive' : value < 0 ? 'negative' : 'zero'} (period ended ${e.periodEnd}).`)
    }
    out.facts.push(...assessment.risks, ...assessment.reasons.filter(r => /liabilit|debt|liquidity/i.test(r)))
    if (trend.status !== 'insufficient') out.facts.push(`Across ${trend.observations} reports, the recent trend is ${trend.status === 'stable' ? 'stable or mixed' : trend.status}.`)
  }
  const large = (drawdown != null && drawdown <= -15) || (week != null && week <= -8)
  if (!large) {
    if (drawdown != null && week != null) Object.assign(out, { status: 'no-large-drop', label: 'No large drop right now', summary: 'The stock does not currently meet our large-drop check.', next: 'Keep watching the company reports; a small fall does not establish a buying opportunity.' })
    return out
  }
  if (sectorFinancialPolicy(input.sector)?.specialist) return { ...out, summary: 'This type of business needs specialist checks. The available general figures cannot establish whether the drop is temporary.' }
  if (assessment.status === 'deteriorating' || trend.status === 'deteriorating') {
    Object.assign(out, { status: 'weakening', label: 'Reported warning signs', summary: trend.status === 'deteriorating' ? 'Recent reports show the business weakening. Treat the drop as more than a possible bargain.' : 'The latest available figures show financial warning signs. The drop should not be treated as temporary without further evidence.', next: 'Look for sales, profit and cash flow to recover in a new report before assuming the problem has passed.' })
  } else if (input.news?.verdict === 'structural') {
    out.summary = 'Recent headlines flag a possible lasting problem. The reports alone cannot settle it.'
    out.next = 'Read the linked company news and the company’s own explanation before judging the drop.'
  } else if (assessment.status === 'healthy' && ['stable', 'improving'].includes(trend.status)) {
    Object.assign(out, { status: 'holding-up', label: 'Business holding up so far', summary: 'Available reports show positive profit and cash flow, with no persistent weakening in the report trend. A temporary setback is possible, but the reason for the fall is not proven.', next: 'Check the company’s outlook and wait for the selling to settle. A sound business can still be overpriced.' })
  }
  return out
}
export interface DailyStockSnapshot {
  symbol: string; at: number; day: string; status: StockContext['status']; priceDate: string | null
  sectorPp: number | null; stockPp: number | null; regime: string | null; newsUrls: string[]
  health: string | null; trend: string | null; reportAt: number | null
}
export interface StockChanges { baselineAt: number | null; heading: string; lines: string[]; session: string | null }
export function snapshotStock(c: StockContext): DailyStockSnapshot {
  return { symbol: c.symbol, at: c.generatedAt, day: londonDay(c.generatedAt), status: c.status, priceDate: c.priceDate, sectorPp: c.sectorVsMarketPp, stockPp: c.stockVsSectorPp, regime: c.market?.regime ?? null, newsUrls: c.news.map(n => n.url), health: c.dropCheck?.health ?? null, trend: c.dropCheck?.trend ?? null, reportAt: c.dropCheck?.reportAvailableAt ?? null }
}
/** Keep the latest observation of each London date, never substitute an intraday
 * refresh for yesterday. Only actual saved observations enter this history. */
export function retainStockDays(history: DailyStockSnapshot[], additions: DailyStockSnapshot[], now: number): DailyStockSnapshot[] {
  const days = new Map<string, DailyStockSnapshot>()
  for (const row of [...history, ...additions]) {
    if (!Number.isFinite(row.at) || row.at > now || now - row.at > 8 * DAY || row.day !== londonDay(row.at)) continue
    const key = `${row.symbol}:${row.day}`, existing = days.get(key)
    if (!existing || row.at > existing.at) days.set(key, row)
  }
  return [...days.values()].sort((a,b) => a.at - b.at)
}
export function stockChanges(c: StockContext, candles: Candle[], history: DailyStockSnapshot[]): StockChanges {
  const currentDay = londonDay(c.generatedAt)
  const prev = history.filter(h => h.symbol === c.symbol && h.day < currentDay && h.at < c.generatedAt && c.generatedAt - h.at <= 8 * DAY).sort((a,b) => b.at - a.at)[0]
  const yesterday = date(Date.parse(`${currentDay}T12:00:00Z`) / 1000 - DAY)
  const out: StockChanges = { baselineAt: prev?.at ?? null, heading: !prev || prev.day === yesterday ? 'What changed since yesterday?' : `What changed since ${prev.day}?`, lines: [], session: null }
  const tape = completedLabCandles(candles, c.generatedAt, c.symbol), last = tape.at(-1), before = tape.at(-2)
  if (last && before && c.generatedAt - last.t <= 7 * DAY) out.session = `Latest completed session (${date(last.t)}): ${signed((last.c / before.c - 1) * 100)}% from the previous close.`
  if (!prev) { out.lines.push('Daily tracking has started. We need an earlier saved day to compare news, sector trends and company checks.'); return out }
  if (prev.priceDate === c.priceDate) out.lines.push('No new completed trading session since the saved comparison.')
  if (prev.status !== c.status) out.lines.push(`The market view changed from ${view(prev.status)} to ${view(c.status)}.`)
  if (prev.sectorPp != null && c.sectorVsMarketPp != null && Math.abs(c.sectorVsMarketPp - prev.sectorPp) >= 1) out.lines.push(`The sector’s monthly lead over the US market ${c.sectorVsMarketPp > prev.sectorPp ? 'grew' : 'shrank'} by ${Math.abs(c.sectorVsMarketPp - prev.sectorPp).toFixed(1)} percentage points.`)
  if (prev.regime && c.market && prev.regime !== c.market.regime) out.lines.push(`The wider market backdrop changed to ${c.market.regime === 'pressure' ? 'more pressure' : c.market.regime === 'rising' ? 'rising US shares' : 'mixed conditions'}.`)
  const added = c.news.filter(n => !prev.newsUrls.includes(n.url) && n.collectedAt > prev.at)
  if (added.length) out.lines.push(`${added.length} newly collected company ${added.length === 1 ? 'headline' : 'headlines'} in this view. Collection time does not confirm when the news happened.`)
  if (prev.reportAt != null && c.dropCheck?.reportAvailableAt != null && c.dropCheck.reportAvailableAt > prev.reportAt) out.lines.push('Newer company filing evidence is now included. Open the business check below.')
  if (prev.health && c.dropCheck && (prev.health !== c.dropCheck.health || prev.trend !== c.dropCheck.trend)) out.lines.push('The company-report assessment changed. Check the latest figures and any missing information below.')
  if (!out.lines.length || (out.lines.length === 1 && prev.priceDate === c.priceDate)) out.lines.push('No material change detected in the available market, news and company checks. Coverage can be incomplete.')
  return out
}
const view = (status: StockContext['status']) => ({ supportive: 'price support', caution: 'reasons for caution', mixed: 'mixed signals', limited: 'more information needed' })[status]
