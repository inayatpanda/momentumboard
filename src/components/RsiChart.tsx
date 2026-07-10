import { useEffect, useRef } from 'react'
import { createChart, ColorType } from 'lightweight-charts'
import type { Candle } from '../../shared/types'
import { rsi } from '../../shared/indicators'
import { toLineSeries } from '../lib/chartData'

export function RsiChart({ candles }: { candles: Candle[] }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ref.current || candles.length === 0) return
    const css = getComputedStyle(document.documentElement)
    const themed = (v: string, fallback: string) => css.getPropertyValue(v).trim() || fallback
    // token-driven throughout, matching PriceChart: transparent surface, faint
    // horizontal hairlines only, faint crosshair, and a barely-there area fill.
    const chart = createChart(ref.current, {
      height: 110,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: themed('--muted', '#93a6ad'), fontSize: 10 },
      grid: { vertLines: { visible: false }, horzLines: { color: themed('--line', 'rgba(148,186,200,0.10)') } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, visible: false },
      crosshair: {
        horzLine: { color: themed('--faint', '#5d6d74'), labelBackgroundColor: themed('--panel', '#12171a') },
        vertLine: { color: themed('--faint', '#5d6d74'), labelBackgroundColor: themed('--panel', '#12171a') },
      },
    })
    const line = chart.addAreaSeries({
      lineColor: themed('--blue', '#62c1e5'),
      topColor: themed('--blue-soft', 'rgba(98,193,229,0.13)'),
      bottomColor: 'rgba(0, 0, 0, 0)',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
    })
    line.setData(toLineSeries(candles, rsi(candles.map(c => c.c))))
    const band = themed('--line', 'rgba(148,186,200,0.10)')
    line.createPriceLine({ price: 70, color: band, lineWidth: 1, lineStyle: 3, axisLabelVisible: false, title: '' })
    line.createPriceLine({ price: 30, color: band, lineWidth: 1, lineStyle: 3, axisLabelVisible: false, title: '' })
    chart.timeScale().fitContent()
    const ro = new ResizeObserver(() => chart.applyOptions({ width: ref.current?.clientWidth ?? 300 }))
    ro.observe(ref.current)
    return () => {
      ro.disconnect()
      chart.remove()
    }
  }, [candles])

  return (
    <div className="chart-box">
      <div className="chart-legend"><span style={{ color: 'var(--blue)' }}>RSI 14</span></div>
      <div ref={ref} />
    </div>
  )
}
