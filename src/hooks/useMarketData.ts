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

export function useMarketData(symbols: string[]) {
  const [rows, setRows] = useState<Row[]>([])
  const [regime, setRegime] = useState<RegimeColor | null>(null)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const candlesRef = useRef(new Map<string, Candle[]>())
  const fetchedAtRef = useRef(new Map<string, number>())

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
        setRows(
          symbols.map((symbol, i) => {
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
          }),
        )
        setLastUpdated(Date.now())
        setError(null)
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
