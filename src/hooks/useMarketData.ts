import { useEffect, useRef, useState } from 'react'
import type { Candle, Quote, RegimeColor, SetupKind } from '../../shared/types'
import { getQuotes, getCandles } from '../lib/api'
import { avgDailyVolume, relativeVolume, sessionElapsedFraction } from '../../shared/rvol'
import { detectSetups, regimeFromCandles } from '../../shared/setups'
import { rsi } from '../../shared/indicators'
import { exchangeFor } from '../../shared/symbols'
import type { Row } from '../components/TickerRow'

const QUOTE_MS = 120_000
const CANDLE_MS = 900_000

// MODULE-level caches, not refs: as refs they died with every unmount, so any
// trip away from the Watchlist (Desk, a chart, Settings) refetched every
// candle and rebuilt the rows from blank — the "everything reloads" feel.
// Candles respect the same 15-min TTL across mounts; the last computed rows
// repaint instantly while the fresh quote pass runs behind.
const candleStore = new Map<string, Candle[]>()
const candleFetchedAt = new Map<string, number>()
const lastRows = new Map<string, { rows: Row[]; regime: RegimeColor | null; lastUpdated: number | null }>()

export function useMarketData(symbols: string[]) {
  const memo = lastRows.get(symbols.join(','))
  const [rows, setRows] = useState<Row[]>(memo?.rows ?? [])
  const [regime, setRegime] = useState<RegimeColor | null>(memo?.regime ?? null)
  const [lastUpdated, setLastUpdated] = useState<number | null>(memo?.lastUpdated ?? null)
  const [error, setError] = useState<string | null>(null)
  const candlesRef = useRef(candleStore)
  const fetchedAtRef = useRef(candleFetchedAt)

  useEffect(() => {
    let alive = true

    async function refreshCandles() {
      const wanted = [...symbols, 'SPY', 'QQQ']
      for (const sym of wanted) {
        const at = fetchedAtRef.current.get(sym) ?? 0
        if (Date.now() - at < CANDLE_MS) continue
        try {
          const { candles } = await getCandles(sym)
          candlesRef.current.set(sym, candles)
          fetchedAtRef.current.set(sym, Date.now())
        } catch (e) {
          setError(String(e))
        }
      }
      const spy = candlesRef.current.get('SPY')
      const qqq = candlesRef.current.get('QQQ')
      if (spy && qqq && alive) setRegime(regimeFromCandles(spy, qqq))
    }

    async function refreshQuotes() {
      if (symbols.length === 0) {
        setRows([])
        return
      }
      try {
        const quotes = await getQuotes(symbols)
        if (!alive) return
        const now = Math.floor(Date.now() / 1000)
        const nextRows = symbols.map((symbol, i) => {
          const quote: Quote | null = quotes[i]
          const candles = candlesRef.current.get(symbol)
          let rvol: number | null = null
          let setups: SetupKind[] = []
          let spark: number[] | undefined
          let rsiVal: number | null = null
          if (candles && candles.length > 25) {
            const avg = avgDailyVolume(candles)
            const todayVol = quote?.todayVolume ?? candles[candles.length - 1].v
            if (avg) rvol = relativeVolume(todayVol, avg, sessionElapsedFraction(exchangeFor(symbol), now))
            setups = detectSetups(candles, rvol)
            spark = candles.slice(-30).map(c => c.c)
            const r = rsi(candles.map(c => c.c))
            rsiVal = r[r.length - 1]
          }
          return { symbol, quote, rvol, setups, spark, rsi: rsiVal }
        })
        setRows(nextRows)
        const at = Date.now()
        setLastUpdated(at)
        setError(null)
        const spyC = candlesRef.current.get('SPY')
        const qqqC = candlesRef.current.get('QQQ')
        lastRows.set(symbols.join(','), { rows: nextRows, regime: spyC && qqqC ? regimeFromCandles(spyC, qqqC) : null, lastUpdated: at })
      } catch (e) {
        setError(String(e))
      }
    }

    refreshCandles().then(refreshQuotes)
    const qi = setInterval(refreshQuotes, QUOTE_MS)
    const ci = setInterval(() => refreshCandles().then(refreshQuotes), CANDLE_MS)
    return () => {
      alive = false
      clearInterval(qi)
      clearInterval(ci)
    }
  }, [symbols.join(',')])

  return { rows, regime, lastUpdated, error }
}
