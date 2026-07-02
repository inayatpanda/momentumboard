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
    const chart = createChart(ref.current, {
      height: 110,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: themed('--muted', '#8b98a8'), fontSize: 10 },
      grid: { vertLines: { visible: false }, horzLines: { color: themed('--line', 'rgba(148,168,190,0.06)') } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, visible: false },
    })
    const line = chart.addLineSeries({ color: '#c792ea', lineWidth: 1, priceLineVisible: false, lastValueVisible: true })
    line.setData(toLineSeries(candles, rsi(candles.map(c => c.c))))
    line.createPriceLine({ price: 70, color: 'rgba(255,93,115,0.5)', lineWidth: 1, lineStyle: 3, axisLabelVisible: false, title: '' })
    line.createPriceLine({ price: 30, color: 'rgba(34,201,141,0.5)', lineWidth: 1, lineStyle: 3, axisLabelVisible: false, title: '' })
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
      <div className="chart-legend"><span style={{ color: '#c792ea' }}>RSI 14</span></div>
      <div ref={ref} />
    </div>
  )
}
