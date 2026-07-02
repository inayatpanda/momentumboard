import { useEffect, useRef } from 'react'
import { createChart, ColorType, type IChartApi } from 'lightweight-charts'
import type { Candle } from '../../shared/types'
import { sma } from '../../shared/indicators'
import { toCandleSeries, toVolumeSeries, toLineSeries } from '../lib/chartData'

const MA_STYLES = [
  { period: 20, color: '#5aa9ff' },
  { period: 50, color: '#f5b83d' },
  { period: 200, color: '#8b93a5' },
]

export function PriceChart({ candles }: { candles: Candle[] }) {
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
      timeScale: { borderVisible: false, timeVisible: false },
      crosshair: { horzLine: { labelBackgroundColor: themed('--panel', '#11161d') }, vertLine: { labelBackgroundColor: themed('--panel', '#11161d') } },
    })
    chartRef.current = chart

    const up = themed('--green', '#22c98d')
    const down = themed('--red', '#ff5d73')
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

    chart.timeScale().fitContent()
    const ro = new ResizeObserver(() => chart.applyOptions({ width: ref.current?.clientWidth ?? 300 }))
    ro.observe(ref.current)
    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current = undefined
    }
  }, [candles])

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
