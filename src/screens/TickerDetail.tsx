import { useEffect, useMemo, useState } from 'react'
import type { Candle, Quote } from '../../shared/types'
import { getCandles, getNews, getTickerBrief, getSeasonality } from '../lib/api'
import { db, getCapital, type RuleItem } from '../lib/db'
import { mirrorConfig } from '../lib/configMirror'
import { fmtPrice, fmtPct } from '../lib/format'
import { detectSetups } from '../../shared/setups'
import { avgDailyVolume, relativeVolume, sessionElapsedFraction } from '../../shared/rvol'
import { exchangeFor } from '../../shared/symbols'
import { runBacktest, type BacktestSummary } from '../../shared/backtest'
import { PriceChart } from '../components/PriceChart'
import { RsiChart } from '../components/RsiChart'
import { PositionCalculator } from '../components/PositionCalculator'
import { AlertEditor } from '../components/AlertEditor'
import { Badge } from '../components/Badge'
import { IconBack, IconWarn } from '../components/icons'

const RANGES = ['3mo', '6mo', '1y'] as const
type Range = (typeof RANGES)[number]

export function TickerDetail({ symbol, onBack }: { symbol: string; onBack: () => void }) {
  const [range, setRange] = useState<Range>('6mo')
  const [candles, setCandles] = useState<Candle[]>([])
  const [quote, setQuote] = useState<Quote | null>(null)
  const [news, setNews] = useState<{ title: string; url: string; publishedSec: number }[]>([])
  const [rules, setRules] = useState<RuleItem[]>([])
  const [capital, setCapital] = useState(5000)
  const [backtest, setBacktest] = useState<BacktestSummary[] | null>(null)
  const [seasonality, setSeasonality] = useState<Awaited<ReturnType<typeof getSeasonality>> | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getCapital().then(setCapital)
  }, [])

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

  const [brief, setBrief] = useState<{ brief: string; at: number } | null>(null)

  useEffect(() => {
    getNews(symbol).then(setNews).catch(() => setNews([]))
    getTickerBrief(symbol).then(setBrief).catch(() => setBrief(null))
    getSeasonality(symbol).then(setSeasonality).catch(() => setSeasonality(null))
    db.rules.where('symbol').equals(symbol).toArray().then(setRules)
  }, [symbol])

  const shareBrief = () => {
    const text = `${symbol} — StreetSignal brief\n${brief?.brief ?? ''}`
    if (navigator.share) navigator.share({ title: `${symbol} brief`, text }).catch(() => {})
    else navigator.clipboard?.writeText(text)
  }

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
        <button className="back" onClick={onBack} aria-label="Back to watchlist"><IconBack /></button>
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

      {error && <p className="calc-warn"><IconWarn size={12} /> {error}</p>}

      <div className="detail-badges">
        {rvol != null && <span className={`rvol ${rvol >= 2 ? 'hot' : ''}`}>RVOL {rvol.toFixed(1)}x</span>}
        {setups.map(s => (
          <Badge key={s} kind={s} />
        ))}
      </div>

      {brief && (
        <div className="ai-card" style={{ marginBottom: 10 }}>
          <h3>What's new · {symbol}</h3>
          <p style={{ fontSize: 13.5 }}>{brief.brief}</p>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="ai-note">AI brief, refreshed every 6h. Not advice.</span>
            <button className="mini-btn ghost" onClick={shareBrief}>Share</button>
          </div>
        </div>
      )}

      <PriceChart candles={candles} />
      <RsiChart candles={candles} />

      <div className="detail-grid">
        <div>
          <h3 className="section-title">Price alerts</h3>
          <AlertEditor symbol={symbol} rules={rules} onSave={saveRule} onDelete={deleteRule} />
        </div>
        {/* key remounts the calculator when the price first arrives so defaults prefill */}
        <PositionCalculator key={`${symbol}-${price == null ? 'loading' : 'ready'}`} defaultEntry={price} defaultStop={defaultStop} riskClass="normal" capital={capital} />
      </div>

      <section className="calc" style={{ marginTop: 18 }}>
        <h3>Setup backtest <span className="calc-sub">this ticker · {range} of daily bars</span></h3>
        {backtest === null ? (
          <button className="mini-btn" onClick={() => setBacktest(runBacktest(candles).summary)} disabled={candles.length < 60}>
            Run backtest
          </button>
        ) : backtest.length === 0 ? (
          <p className="calc-hint">No setup triggers occurred in this window.</p>
        ) : (
          <>
            {backtest.map(b => (
              <div key={b.setup} className="perf-row" style={{ marginTop: 6 }}>
                <span>{b.setup} <span style={{ color: 'var(--faint)' }}>×{b.n}</span></span>
                <span>{b.win5 != null ? `${Math.round(b.win5 * 100)}% win · ${b.avg5!.toFixed(1)}% @5d · ${b.avg20 != null ? b.avg20.toFixed(1) : '—'}% @20d` : 'no scoreable window'}</span>
              </div>
            ))}
            <p className="calc-hint">Daily closes, no costs/slippage; small samples mislead — treat as calibration, not proof.</p>
          </>
        )}
      </section>

      {seasonality && (
        <section className="calc" style={{ marginTop: 18 }}>
          <h3>Seasonality <span className="calc-sub">{seasonality.years} years of history</span></h3>
          <div className="dow-grid">
            {seasonality.dow.map(d => (
              <div key={d.day} className="dow-cell">
                <span className={`dow-avg ${d.avgPct != null && d.avgPct >= 0 ? 'up-text' : 'down-text'}`}>{d.avgPct != null ? `${d.avgPct >= 0 ? '+' : ''}${d.avgPct.toFixed(2)}%` : '·'}</span>
                <span className="dow-name">{d.name}</span>
              </div>
            ))}
          </div>
          <p className="calc-hint" style={{ marginTop: 8 }}>
            {seasonality.strongestDay && seasonality.weakestDay && (
              <>Strongest day historically: {seasonality.strongestDay.name}. Weakest: {seasonality.weakestDay.name}. </>
            )}
            {seasonality.bestMonth && seasonality.worstMonth && (
              <>Best month: {seasonality.bestMonth.name} ({seasonality.bestMonth.avgPct?.toFixed(1)}%); worst: {seasonality.worstMonth.name} ({seasonality.worstMonth.avgPct?.toFixed(1)}%). </>
            )}
            {seasonality.reliable
              ? 'Averages of history, not promises; use for timing discipline, not as signals.'
              : 'Under 2 years of data: treat all of this as noise.'}
          </p>
        </section>
      )}

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
