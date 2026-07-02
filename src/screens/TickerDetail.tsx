import { useEffect, useMemo, useState } from 'react'
import type { Candle, Quote } from '../../shared/types'
import { getCandles, getNews } from '../lib/api'
import { db, type RuleItem } from '../lib/db'
import { mirrorConfig } from '../lib/configMirror'
import { fmtPrice, fmtPct } from '../lib/format'
import { detectSetups } from '../../shared/setups'
import { avgDailyVolume, relativeVolume, sessionElapsedFraction } from '../../shared/rvol'
import { exchangeFor } from '../../shared/symbols'
import { PriceChart } from '../components/PriceChart'
import { RsiChart } from '../components/RsiChart'
import { PositionCalculator } from '../components/PositionCalculator'
import { AlertEditor } from '../components/AlertEditor'
import { Badge } from '../components/Badge'

const RANGES = ['3mo', '6mo', '1y'] as const
type Range = (typeof RANGES)[number]

export function TickerDetail({ symbol, onBack }: { symbol: string; onBack: () => void }) {
  const [range, setRange] = useState<Range>('6mo')
  const [candles, setCandles] = useState<Candle[]>([])
  const [quote, setQuote] = useState<Quote | null>(null)
  const [news, setNews] = useState<{ title: string; url: string; publishedSec: number }[]>([])
  const [rules, setRules] = useState<RuleItem[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    getCandles(symbol, range)
      .then(d => {
        if (!alive) return
        setCandles(d.candles)
        setQuote(d.quote)
        setError(null)
      })
      .catch(e => alive && setError(String(e)))
    return () => {
      alive = false
    }
  }, [symbol, range])

  useEffect(() => {
    getNews(symbol).then(setNews).catch(() => setNews([]))
    db.rules.where('symbol').equals(symbol).toArray().then(setRules)
  }, [symbol])

  const { rvol, setups } = useMemo(() => {
    if (candles.length < 26) return { rvol: null as number | null, setups: [] as ReturnType<typeof detectSetups> }
    const now = Math.floor(Date.now() / 1000)
    const avg = avgDailyVolume(candles)
    const todayVol = quote?.todayVolume ?? candles[candles.length - 1].v
    const rv = avg ? relativeVolume(todayVol, avg, sessionElapsedFraction(exchangeFor(symbol), now)) : null
    return { rvol: rv, setups: detectSetups(candles, rv) }
  }, [candles, quote, symbol])

  const baseLow = useMemo(() => {
    if (!candles.length) return null
    const closes = candles.slice(-10).map(c => c.l)
    return Math.min(...closes)
  }, [candles])

  const saveRule = async (kind: 'priceAbove' | 'priceBelow', level: number) => {
    const existing = rules.find(r => r.kind === kind)
    const item: RuleItem = { id: existing?.id ?? `${symbol}-${kind}-${Date.now()}`, symbol, kind, level, createdAt: existing?.createdAt ?? Date.now() }
    await db.rules.put(item)
    setRules(r => [...r.filter(x => x.id !== item.id), item])
    mirrorConfig()
  }
  const deleteRule = async (id: string) => {
    await db.rules.delete(id)
    setRules(r => r.filter(x => x.id !== id))
    mirrorConfig()
  }

  const price = quote?.price ?? (candles.length ? candles[candles.length - 1].c : null)
  const hasReversalContext = setups.includes('basing') || setups.includes('reclaim') || setups.includes('divergence')
  const defaultStop = price == null ? null : hasReversalContext && baseLow != null && baseLow < price ? baseLow : price * 0.95

  return (
    <div className="detail">
      <header className="detail-head">
        <button className="back" onClick={onBack} aria-label="Back to watchlist">←</button>
        <div>
          <h2>{symbol}</h2>
          {quote && (
            <span className="detail-price">
              {fmtPrice(quote.price, quote.currency)}{' '}
              <span className={quote.changePct >= 0 ? 'up-text' : 'down-text'}>{fmtPct(quote.changePct)}</span>
            </span>
          )}
        </div>
        <div className="range-pills">
          {RANGES.map(r => (
            <button key={r} className={r === range ? 'active' : ''} onClick={() => setRange(r)}>
              {r.toUpperCase()}
            </button>
          ))}
        </div>
      </header>

      {error && <p className="calc-warn">⚠ {error}</p>}

      <div className="detail-badges">
        {rvol != null && <span className={`rvol ${rvol >= 2 ? 'hot' : ''}`}>RVOL {rvol.toFixed(1)}x</span>}
        {setups.map(s => (
          <Badge key={s} kind={s} />
        ))}
      </div>

      <PriceChart candles={candles} />
      <RsiChart candles={candles} />

      <h3 className="section-title">Price alerts</h3>
      <AlertEditor symbol={symbol} rules={rules} onSave={saveRule} onDelete={deleteRule} />

      {/* key remounts the calculator when the price first arrives so defaults prefill */}
      <PositionCalculator key={`${symbol}-${price == null ? 'loading' : 'ready'}`} defaultEntry={price} defaultStop={defaultStop} riskClass="normal" />

      {news.length > 0 && (
        <section>
          <h3 className="section-title">Recent news</h3>
          <ul className="news-list">
            {news.slice(0, 8).map(n => (
              <li key={n.url}>
                <a href={n.url} target="_blank" rel="noreferrer">{n.title}</a>
                {n.publishedSec > 0 && <span>{new Date(n.publishedSec * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
