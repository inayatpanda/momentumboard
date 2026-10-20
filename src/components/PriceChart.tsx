import { useEffect, useRef, useState } from 'react'
import { createChart, ColorType, CrosshairMode, type IChartApi, type UTCTimestamp } from 'lightweight-charts'
import type { Candle } from '../../shared/types'
import { sma } from '../../shared/indicators'
import { drawableMAs, toCandleSeries, toLocalBars, toVolumeSeries, toLineSeries } from '../lib/chartData'
import type { ColorRole, PriceLineSpec, StageMarkerSpec } from '../lib/engineLevels'

// Every colour is read from the theme tokens at mount (getComputedStyle), so the
// chart holds in both themes and everywhere it's mounted (mobile detail, Desk, Quant).
const MA_STYLES = [
  { period: 20, token: '--blue', fallback: '#62c1e5' },
  { period: 50, token: '--amber', fallback: '#f2b843' },
  { period: 200, token: '--muted', fallback: '#93a6ad' },
]

type ChartDisplay = 'candles' | 'line'
const compactVolume = (n: number) => n >= 1_000_000_000 ? `${(n / 1_000_000_000).toFixed(1)}B` : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(0)}K` : `${Math.round(n)}`
const chartNumber = (n: number) => n >= 1 ? n.toFixed(2) : n.toFixed(4)

export function PriceChart({
  candles,
  priceLines = [],
  marker,
  height = 300,
  interactive = false,
  intraday = false,
  initialDisplay = 'candles',
}: {
  candles: Candle[]
  priceLines?: PriceLineSpec[]
  marker?: StageMarkerSpec
  height?: number
  // false (cards, walls): the chart is a PICTURE — wheel/drag pass through so
  // the page scrolls; no crosshair. true (the dedicated chart page): full
  // pan/zoom/crosshair. Scrolling stays intentional: zooming is something you
  // chose a chart page to do, never something a card hijacks mid-scroll.
  interactive?: boolean
  // The bars are HOURS, not days (the 1D and 1W ranges). The axis then has to
  // show clock times — and in the reader's own timezone, which lightweight-
  // charts cannot do, so the bars are shifted onto it (toLocalBars).
  intraday?: boolean
  initialDisplay?: ChartDisplay
}) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi>()
  const [display, setDisplay] = useState<ChartDisplay>(initialDisplay)
  const [showMAs, setShowMAs] = useState(initialDisplay === 'candles')
  const [showVolume, setShowVolume] = useState(initialDisplay === 'candles')
  const [inspected, setInspected] = useState<Candle | null>(() => candles.at(-1) ?? null)

  useEffect(() => setInspected(candles.at(-1) ?? null), [candles])

  useEffect(() => {
    if (!ref.current || candles.length === 0) return
    const bars = intraday ? toLocalBars(candles) : candles
    const css = getComputedStyle(document.documentElement)
    const themed = (v: string, fallback: string) => css.getPropertyValue(v).trim() || fallback
    const chart = createChart(ref.current, {
      height,
      // transparent background: the card surface (gradient) shows through
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: themed('--muted', '#93a6ad'), fontSize: 11 },
      // sparse, faint grid: horizontal hairlines only
      grid: { vertLines: { visible: false }, horzLines: { color: themed('--line', 'rgba(148,186,200,0.10)') } },
      rightPriceScale: { borderVisible: false },
      // a few bars of right padding so a marker on the LAST bar (the stage read)
      // isn't clipped by the price axis
      timeScale: { borderVisible: false, timeVisible: intraday, secondsVisible: false, rightOffset: marker ? 7 : 0 },
      crosshair: interactive
        ? {
            horzLine: { color: themed('--faint', '#5d6d74'), labelBackgroundColor: themed('--panel', '#12171a') },
            vertLine: { color: themed('--faint', '#5d6d74'), labelBackgroundColor: themed('--panel', '#12171a') },
          }
        : { mode: CrosshairMode.Hidden },
      handleScroll: interactive,
      handleScale: interactive,
    })
    chartRef.current = chart

    const up = themed('--green', '#2bd396')
    const down = themed('--red', '#ff5f76')
    const ink = themed('--muted', '#93a6ad')
    const roleColor = (role: ColorRole) => (role === 'up' ? up : role === 'down' ? down : ink)

    const candleSeries = chart.addCandlestickSeries({
      visible: display === 'candles',
      upColor: up,
      downColor: down,
      wickUpColor: up,
      wickDownColor: down,
      borderVisible: false,
      // drop the last-price axis pill + line: on a card it stacks onto the
      // entry/stop/target labels and the four numbers collide into a pile.
      // The axis now shows ONLY the engine levels; live price is the last candle.
      lastValueVisible: false,
      priceLineVisible: false,
    })
    candleSeries.setData(toCandleSeries(bars))

    const closeSeries = chart.addAreaSeries({
      visible: display === 'line',
      lineColor: themed('--blue', '#62c1e5'),
      topColor: themed('--blue-soft', 'rgba(98,193,229,0.13)'),
      bottomColor: 'rgba(0, 0, 0, 0)',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: interactive,
    })
    closeSeries.setData(toLineSeries(bars, bars.map(c => c.c)))
    const activeSeries = display === 'candles' ? candleSeries : closeSeries

    // volume: very muted — the soft accent tints, a whisper under the candles
    const volUp = themed('--green-soft', 'rgba(43,211,150,0.13)')
    const volDown = themed('--red-soft', 'rgba(255,95,118,0.13)')
    if (showVolume) {
      const volumeSeries = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false })
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false })
      volumeSeries.setData(toVolumeSeries(bars).map((d, i) => ({ ...d, color: bars[i].c >= bars[i].o ? volUp : volDown })))
    }

    const closes = bars.map(c => c.c)
    if (showMAs) {
      for (const { period, token, fallback } of drawableMAs(MA_STYLES, bars.length)) {
        const line = chart.addLineSeries({ color: themed(token, fallback), lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })
        line.setData(toLineSeries(bars, sma(closes, period)))
      }
    }

    // Engine annotations: entry/stop/target as coloured dashes. NO titled axis
    // pills — with a call's levels inevitably close together, "engine stop /
    // engine entry / engine target" tiles stacked into an unreadable pile on
    // every card (and buried the price axis). The colour IS the meaning, the
    // legend chips under the chart carry the words, and only the axis shows
    // the bare numbers.
    for (const pl of priceLines) {
      activeSeries.createPriceLine({ price: pl.price, color: roleColor(pl.role), lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '' })
    }
    if (marker) {
      activeSeries.setMarkers([
        { time: bars[bars.length - 1].t as UTCTimestamp, position: marker.position, color: roleColor(marker.role), shape: 'circle', text: marker.text },
      ])
    }

    if (interactive) {
      const originalByDisplayTime = new Map(bars.map((bar, i) => [bar.t, candles[i]]))
      chart.subscribeCrosshairMove(param => {
        const point = typeof param.time === 'number' ? originalByDisplayTime.get(param.time) : undefined
        setInspected(point ?? candles.at(-1) ?? null)
      })
    }

    chart.timeScale().fitContent()
    const ro = new ResizeObserver(() => chart.applyOptions({ width: ref.current?.clientWidth ?? 300 }))
    ro.observe(ref.current)
    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current = undefined
    }
  }, [candles, priceLines, marker, height, interactive, intraday, display, showMAs, showVolume])

  const inspectedIndex = inspected ? candles.findIndex(c => c.t === inspected.t) : -1
  const previousClose = inspectedIndex > 0 ? candles[inspectedIndex - 1].c : null
  const inspectedChange = inspected && previousClose ? ((inspected.c / previousClose) - 1) * 100 : null
  const inspectedStamp = inspected ? new Date(inspected.t * 1000).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: intraday ? undefined : 'numeric',
    hour: intraday ? '2-digit' : undefined, minute: intraday ? '2-digit' : undefined,
  }) : ''

  return (
    <div className={`chart-box${interactive ? ' is-interactive' : ''}`}>
      {interactive && (
        <div className="chart-toolbar">
          <div className="chart-toggle" role="group" aria-label="Price display">
            <button type="button" className={display === 'candles' ? 'active' : ''} aria-pressed={display === 'candles'} onClick={() => setDisplay('candles')}>Candles</button>
            <button type="button" className={display === 'line' ? 'active' : ''} aria-pressed={display === 'line'} onClick={() => setDisplay('line')}>Line</button>
          </div>
          <button type="button" className={`chart-tool${showMAs ? ' active' : ''}`} aria-pressed={showMAs} onClick={() => setShowMAs(v => !v)}>Moving averages</button>
          <button type="button" className={`chart-tool${showVolume ? ' active' : ''}`} aria-pressed={showVolume} onClick={() => setShowVolume(v => !v)}>Volume</button>
          <button type="button" className="chart-tool" onClick={() => chartRef.current?.timeScale().fitContent()}>Reset zoom</button>
        </div>
      )}
      {interactive && inspected && (
        <div className="chart-readout" aria-label="Selected session values">
          <span>{inspectedStamp}</span>
          <span>O <b>{chartNumber(inspected.o)}</b></span>
          <span>H <b>{chartNumber(inspected.h)}</b></span>
          <span>L <b>{chartNumber(inspected.l)}</b></span>
          <span>C <b>{chartNumber(inspected.c)}</b></span>
          {inspectedChange != null && <span className={inspectedChange >= 0 ? 'up-text' : 'down-text'}>{inspectedChange >= 0 ? '+' : ''}{inspectedChange.toFixed(2)}%</span>}
          <span>Vol <b>{compactVolume(inspected.v)}</b></span>
        </div>
      )}
      <div className="chart-legend">
        {/* only the averages this series can actually draw — an MA200 chip over
            78 five-minute bars named a line that was never there */}
        {showMAs && drawableMAs(MA_STYLES, candles.length).map(({ period, token }) => (
          <span key={period} style={{ color: `var(${token})` }}>
            MA{period}
          </span>
        ))}
        {priceLines.map(pl => (
          <span key={pl.title} className="lvl-chip" style={{ color: pl.role === 'up' ? 'var(--green)' : pl.role === 'down' ? 'var(--red)' : 'var(--muted)' }}>
            {pl.title.replace('engine ', '')} {pl.price}
          </span>
        ))}
      </div>
      <div ref={ref} />
    </div>
  )
}
