import { useEffect, useRef } from 'react'
import { createChart, ColorType, type IChartApi, type UTCTimestamp } from 'lightweight-charts'
import type { Candle } from '../../shared/types'
import { sma } from '../../shared/indicators'
import { toCandleSeries, toVolumeSeries, toLineSeries } from '../lib/chartData'
import type { ColorRole, PriceLineSpec, StageMarkerSpec } from '../lib/engineLevels'

// Every colour is read from the theme tokens at mount (getComputedStyle), so the
// chart holds in both themes and everywhere it's mounted (mobile detail, Desk, Quant).
const MA_STYLES = [
  { period: 20, token: '--blue', fallback: '#62c1e5' },
  { period: 50, token: '--amber', fallback: '#f2b843' },
  { period: 200, token: '--muted', fallback: '#93a6ad' },
]

export function PriceChart({
  candles,
  priceLines = [],
  marker,
}: {
  candles: Candle[]
  priceLines?: PriceLineSpec[]
  marker?: StageMarkerSpec
}) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi>()

  useEffect(() => {
    if (!ref.current || candles.length === 0) return
    const css = getComputedStyle(document.documentElement)
    const themed = (v: string, fallback: string) => css.getPropertyValue(v).trim() || fallback
    const chart = createChart(ref.current, {
      height: 300,
      // transparent background: the card surface (gradient) shows through
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: themed('--muted', '#93a6ad'), fontSize: 11 },
      // sparse, faint grid: horizontal hairlines only
      grid: { vertLines: { visible: false }, horzLines: { color: themed('--line', 'rgba(148,186,200,0.10)') } },
      rightPriceScale: { borderVisible: false },
      // a few bars of right padding so a marker on the LAST bar (the stage read)
      // isn't clipped by the price axis
      timeScale: { borderVisible: false, timeVisible: false, rightOffset: marker ? 7 : 0 },
      crosshair: {
        horzLine: { color: themed('--faint', '#5d6d74'), labelBackgroundColor: themed('--panel', '#12171a') },
        vertLine: { color: themed('--faint', '#5d6d74'), labelBackgroundColor: themed('--panel', '#12171a') },
      },
    })
    chartRef.current = chart

    const up = themed('--green', '#2bd396')
    const down = themed('--red', '#ff5f76')
    const ink = themed('--muted', '#93a6ad')
    const roleColor = (role: ColorRole) => (role === 'up' ? up : role === 'down' ? down : ink)

    const candleSeries = chart.addCandlestickSeries({
      upColor: up,
      downColor: down,
      wickUpColor: up,
      wickDownColor: down,
      borderVisible: false,
    })
    candleSeries.setData(toCandleSeries(candles))

    // volume: very muted — the soft accent tints, a whisper under the candles
    const volUp = themed('--green-soft', 'rgba(43,211,150,0.13)')
    const volDown = themed('--red-soft', 'rgba(255,95,118,0.13)')
    const volumeSeries = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false })
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false })
    volumeSeries.setData(toVolumeSeries(candles).map((d, i) => ({ ...d, color: candles[i].c >= candles[i].o ? volUp : volDown })))

    const closes = candles.map(c => c.c)
    for (const { period, token, fallback } of MA_STYLES) {
      const line = chart.addLineSeries({ color: themed(token, fallback), lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })
      line.setData(toLineSeries(candles, sma(closes, period)))
    }

    // Engine annotations: live-call entry/stop/target as horizontal price lines,
    // and the client-side stage read as a marker on the most recent bar. Both are
    // wiped automatically when the chart is torn down on symbol/range change.
    for (const pl of priceLines) {
      candleSeries.createPriceLine({ price: pl.price, color: roleColor(pl.role), lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: pl.title })
    }
    if (marker) {
      candleSeries.setMarkers([
        { time: candles[candles.length - 1].t as UTCTimestamp, position: marker.position, color: roleColor(marker.role), shape: 'circle', text: marker.text },
      ])
    }

    chart.timeScale().fitContent()
    const ro = new ResizeObserver(() => chart.applyOptions({ width: ref.current?.clientWidth ?? 300 }))
    ro.observe(ref.current)
    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current = undefined
    }
  }, [candles, priceLines, marker])

  return (
    <div className="chart-box">
      <div className="chart-legend">
        <span style={{ color: 'var(--blue)' }}>MA20</span>
        <span style={{ color: 'var(--amber)' }}>MA50</span>
        <span style={{ color: 'var(--muted)' }}>MA200</span>
      </div>
      <div ref={ref} />
    </div>
  )
}
