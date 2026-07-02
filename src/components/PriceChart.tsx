import { useEffect, useRef } from 'react'
import { createChart, ColorType, type IChartApi, type UTCTimestamp } from 'lightweight-charts'
import type { Candle } from '../../shared/types'
import { sma } from '../../shared/indicators'
import { toCandleSeries, toVolumeSeries, toLineSeries } from '../lib/chartData'
import type { ColorRole, PriceLineSpec, StageMarkerSpec } from '../lib/engineLevels'

const MA_STYLES = [
  { period: 20, color: '#5aa9ff' },
  { period: 50, color: '#f5b83d' },
  { period: 200, color: '#8b93a5' },
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
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: themed('--muted', '#8b98a8'), fontSize: 11 },
      grid: { vertLines: { color: themed('--line', 'rgba(148,168,190,0.06)') }, horzLines: { color: themed('--line', 'rgba(148,168,190,0.06)') } },
      rightPriceScale: { borderVisible: false },
      // a few bars of right padding so a marker on the LAST bar (the stage read)
      // isn't clipped by the price axis
      timeScale: { borderVisible: false, timeVisible: false, rightOffset: marker ? 7 : 0 },
      crosshair: { horzLine: { labelBackgroundColor: themed('--panel', '#11161d') }, vertLine: { labelBackgroundColor: themed('--panel', '#11161d') } },
    })
    chartRef.current = chart

    const up = themed('--green', '#22c98d')
    const down = themed('--red', '#ff5d73')
    const ink = themed('--muted', '#8b98a8')
    const roleColor = (role: ColorRole) => (role === 'up' ? up : role === 'down' ? down : ink)

    const candleSeries = chart.addCandlestickSeries({
      upColor: up,
      downColor: down,
      wickUpColor: up,
      wickDownColor: down,
      borderVisible: false,
    })
    candleSeries.setData(toCandleSeries(candles))

    const volumeSeries = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false })
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false })
    volumeSeries.setData(toVolumeSeries(candles))

    const closes = candles.map(c => c.c)
    for (const { period, color } of MA_STYLES) {
      const line = chart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })
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
        <span style={{ color: '#5aa9ff' }}>MA20</span>
        <span style={{ color: '#f5b83d' }}>MA50</span>
        <span style={{ color: '#8b93a5' }}>MA200</span>
      </div>
      <div ref={ref} />
    </div>
  )
}
