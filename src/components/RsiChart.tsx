import { useEffect, useMemo, useRef } from 'react'
import { createChart, ColorType } from 'lightweight-charts'
import type { Candle } from '../../shared/types'
import { rsi } from '../../shared/indicators'
import { toLineSeries, toLocalBars } from '../lib/chartData'

export function RsiChart({ candles, intraday = false }: { candles: Candle[]; intraday?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const values = useMemo(() => rsi(candles.map(c => c.c)), [candles])
  const currentRsi = values.at(-1) ?? null
  const state = currentRsi == null ? 'collecting' : currentRsi >= 70 ? 'overbought' : currentRsi <= 30 ? 'oversold' : 'neutral'

  useEffect(() => {
    if (!ref.current || candles.length === 0) return
    const bars = intraday ? toLocalBars(candles) : candles
    const css = getComputedStyle(document.documentElement)
    const themed = (v: string, fallback: string) => css.getPropertyValue(v).trim() || fallback
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
      handleScroll: false,
      handleScale: false,
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
    line.setData(toLineSeries(bars, values))
    const band = themed('--line', 'rgba(148,186,200,0.10)')
    line.createPriceLine({ price: 70, color: band, lineWidth: 1, lineStyle: 3, axisLabelVisible: false, title: '' })
    line.createPriceLine({ price: 30, color: band, lineWidth: 1, lineStyle: 3, axisLabelVisible: false, title: '' })
    chart.timeScale().fitContent()
    const ro = new ResizeObserver(() => chart.applyOptions({ width: ref.current?.clientWidth ?? 300 }))
    ro.observe(ref.current)
    return () => { ro.disconnect(); chart.remove() }
  }, [candles, intraday, values])

  return (
    <div className="chart-box indicator-chart">
      <div className="chart-legend indicator-legend">
        <span style={{ color: 'var(--blue)' }}>RSI 14 {currentRsi == null ? '—' : currentRsi.toFixed(1)}</span>
        <span className={`indicator-state ${state}`}>{state}</span>
        <span className="indicator-bands">70 overbought · 30 oversold</span>
      </div>
      <div ref={ref} />
    </div>
  )
}
