import { getCandles } from '../../lib/api'
import { useSlice } from '../../lib/useSlice'
import { compareDailyPrices } from '../../lib/priceComparison'
import type { Candle } from '../../../shared/types'
import type { ChartRangeId } from '../../lib/chartRange'

const pct = (n: number) => Math.abs(n) < 0.05 ? '0.0%' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' })
const COLORS = ['var(--accent)', 'var(--text-dim)', 'var(--warn)']
export default function PerformanceComparison({ symbol, name, candles, range, sectorSymbol, sectorName }: {
  symbol: string; name: string; candles: Candle[]; range: ChartRangeId; sectorSymbol?: string | null; sectorName?: string | null
}) {
  const market = useSlice(`candles:SPY:${range}`, () => getCandles('SPY', range))
  // Reuse the SPY cache if no sector is mapped; useSlice deduplicates requests.
  const peer = sectorSymbol && sectorSymbol !== symbol && sectorSymbol !== 'SPY' ? sectorSymbol : 'SPY'
  const sector = useSlice(`candles:${peer}:${range}`, () => getCandles(peer, range))
  const hasSector = peer !== 'SPY' && (sector.data?.candles.length ?? 0) > 1
  if (!market.data && !market.error) return <p role="status" className="dossier-caption">Loading market comparison…</p>
  if (!market.data || market.data.candles.length < 2) return <p className="dossier-caption">Market comparison is unavailable. <button onClick={market.refresh}>Try again</button></p>
  const result = compareDailyPrices([
    { symbol, label: name, candles },
    ...(symbol !== 'SPY' ? [{ symbol: 'SPY', label: 'US market · SPY', candles: market.data.candles }] : []),
    ...(hasSector ? [{ symbol: peer, label: `${sectorName ?? 'Sector'} · ${peer}`, candles: sector.data!.candles }] : []),
  ])
  if (!result) return <p className="dossier-caption">Not enough matching daily prices for this comparison. Try a longer range.</p>
  const { dates, series } = result
  const values = series.flatMap(s => s.values), lo = Math.min(-1, ...values), hi = Math.max(1, ...values)
  const x = (i: number) => 8 + i / (dates.length - 1) * 524
  const y = (n: number) => 182 - (n - lo) / (hi - lo) * 160
  const difference = series[0].values.at(-1)! - (series.find(s => s.symbol === 'SPY')?.values.at(-1) ?? series[0].values.at(-1)!)
  const stale = market.offline || market.data.quote?.stale || (hasSector && (sector.offline || sector.data?.quote?.stale))
  return <div className="performance-comparison">
    <p className="comparison-takeaway">{symbol === 'SPY' ? 'This fund tracks the US market.' : Math.abs(difference) < 0.05 ? 'Moving in line with the US market over these dates.' : <>{difference > 0 ? 'Ahead of' : 'Behind'} the US market by <strong>{Math.abs(difference).toFixed(1)} percentage points.</strong></>}</p>
    <dl className="comparison-key">{series.map((s, i) => <div key={s.symbol} style={{ '--comparison-colour': COLORS[i] } as React.CSSProperties}><dt><i aria-hidden="true" />{s.label}</dt><dd>{pct(s.values.at(-1)!)}</dd></div>)}</dl>
    <svg viewBox="0 0 590 210" role="img" aria-label={`Price change from ${dateLabel(dates[0])} to ${dateLabel(dates.at(-1)!)}. ${series.map(s => `${s.label}: ${pct(s.values.at(-1)!)}`).join('. ')}`} className="comparison-chart">
      {[lo, 0, hi].map(n => <g key={n}><line x1="8" x2="532" y1={y(n)} y2={y(n)} stroke="var(--border)" strokeDasharray="3 5"/><text x="540" y={y(n) + 4} fill="var(--text-dim)" fontSize="11">{pct(n)}</text></g>)}
      {series.map((s, i) => <path key={s.symbol} d={s.values.map((n, j) => `${j ? 'L' : 'M'}${x(j)},${y(n)}`).join(' ')} fill="none" stroke={COLORS[i]} strokeWidth={i === 0 ? 2.8 : 1.8} strokeDasharray={i === 1 ? '5 4' : undefined} />)}
    </svg>
    <div className="comparison-dates"><span>{dateLabel(dates[0])}</span><span>{dateLabel(dates.at(-1)!)}</span></div>
    <p className="dossier-caption">Same starting point · {dates.length} matching daily prices. {stale ? 'Using saved benchmark prices. ' : ''}{peer === 'SPY' ? 'No separate sector comparison is mapped.' : !hasSector ? `Sector prices ${sector.error ? 'are unavailable' : 'are loading'}.` : ''}</p>
    <details className="company-detail"><summary>See the evidence: comparison</summary><p className="dossier-caption">Price changes in each listing’s own currency; excludes dividends, fees and currency conversion. SPY is a US market reference, not a local-market benchmark for overseas stocks. Dates are limited to observations shared by every line; the latest daily bar may still be in progress.</p><div className="history-table-scroll"><table><caption>Price change from the first shared date</caption><thead><tr><th>Date</th>{series.map(s => <th key={s.symbol}>{s.label}</th>)}</tr></thead><tbody>{dates.map((date, i) => <tr key={date}><th>{date}</th>{series.map(s => <td key={s.symbol}>{pct(s.values[i])}</td>)}</tr>)}</tbody></table></div></details>
  </div>
}
