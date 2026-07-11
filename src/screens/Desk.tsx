import { useEffect, useState } from 'react'
import { getEngine, getMovers, getCandles, getIpos, type EngineData, type EnginePrediction } from '../lib/api'
import type { Candle } from '../../shared/types'
import { detectPatterns, type PatternHit } from '../../shared/patterns'
import { capBand, fmtPct, humanError } from '../lib/format'
import { capClassBreakdown, flattenLedger } from '../lib/ledgerStats'
import { engineLevelLines } from '../lib/engineLevels'
import { PriceChart } from '../components/PriceChart'
import { RsiChart } from '../components/RsiChart'
import { RegimeBanner } from '../components/RegimeBanner'
import { GradeChip } from '../components/GradeChip'
import { IconGear } from '../components/icons'

// THE DESK: a wide command-deck for laptop/monitor screens, built entirely out
// of data the phone app already fetches (getEngine + getMovers). Two call
// sleeves (large-cap catalyst/news, small-cap momentum) sit beside a focused
// chart; a rail carries accountability (cap-cohort track record), today's news
// catalysts, and the market-wide tape. Nothing new is fetched — this is a
// re-lay of the existing engine board for screens with room to spare.

type MoversResponse = Awaited<ReturnType<typeof getMovers>>
type IposResponse = Awaited<ReturnType<typeof getIpos>>

const RUNG_PCT = [1.0, 1.25, 1.5, 2.0]

const listedDaysAgo = (dateISO: string): number => Math.max(0, Math.round((Date.now() - Date.parse(dateISO)) / 86_400_000))

// module-level candle cache: a Refresh re-render must not refetch every chart
const candleCache = new Map<string, Candle[]>()

function PatternBadges({ patterns }: { patterns: PatternHit[] }) {
  if (!patterns.length) return null
  return (
    <span className="pat-badges">
      {patterns.map(p => (
        <span key={p.kind} className={`badge ${p.direction === 'bullish' ? 'pat-bull' : 'pat-bear'}`} title={`${p.label} — ${p.status} · level ${p.level}`}>
          {p.label} {p.status === 'confirmed' ? '✓' : '…'}
        </span>
      ))}
    </span>
  )
}

/** One call, one chart. The Desk is a chart wall now — every board name shows
 * its candles, MAs, engine levels and any classical pattern the detector sees,
 * instead of one giant chart for a single focused row. Click to expand. */
function ChartCard({ p, expanded, onToggle }: { p: EnginePrediction; expanded: boolean; onToggle: (sym: string) => void }) {
  const [candles, setCandles] = useState<Candle[]>(candleCache.get(p.sym) ?? [])
  const [patterns, setPatterns] = useState<PatternHit[]>([])
  useEffect(() => {
    let alive = true
    const cached = candleCache.get(p.sym)
    if (cached) {
      setCandles(cached)
      setPatterns(detectPatterns(cached))
      return
    }
    getCandles(p.sym)
      .then(d => {
        if (!alive) return
        candleCache.set(p.sym, d.candles)
        setCandles(d.candles)
        setPatterns(detectPatterns(d.candles))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [p.sym])
  const dirColor = p.side === 'long' ? 'var(--green)' : 'var(--red)'
  return (
    <section
      className={`card chart-card${expanded ? ' is-expanded' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => onToggle(p.sym)}
      onKeyDown={e => e.key === 'Enter' && onToggle(p.sym)}
    >
      <div className="chart-card-top">
        <span className="chart-card-id">
          <GradeChip grade={p.grade} provisional={p.provisional} />
          <b>{p.sym}</b>
          <span style={{ color: dirColor }}>{p.side === 'long' ? '▲' : '▼'}</span>
          {p.watchOnly && <span className="badge warn">watch</span>}
          {p.setup && <span className="badge">{p.setup}</span>}
          <span className="badge">{capBand(p.capUsdM) ?? 'small cap'}</span>
        </span>
        <span className="chart-card-odds">
          {Math.round(p.probability * 100)}% · ~{p.expectedMovePct}%
        </span>
      </div>
      <div className="chart-card-levels">
        in {p.entry} · stop {p.stop} · tgt {p.target}
        <PatternBadges patterns={patterns} />
      </div>
      {candles.length ? (
        <PriceChart candles={candles} priceLines={engineLevelLines(p)} height={expanded ? 340 : 190} />
      ) : (
        <p className="empty-line">loading chart…</p>
      )}
      {expanded && candles.length > 0 && <RsiChart candles={candles} />}
      {p.catalyst && (
        <div className="chart-card-cat">
          <span className="badge gold">{p.catalyst.kind}</span>
          <span>{p.catalyst.reason}</span>
        </div>
      )}
    </section>
  )
}

export function Desk({ onStandard, onOpenSettings, onQuant }: { onStandard: () => void; onOpenSettings: () => void; onQuant: () => void }) {
  const [data, setData] = useState<EngineData | null>(null)
  const [movers, setMovers] = useState<MoversResponse | null>(null)
  const [ipos, setIpos] = useState<IposResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [focus, setFocus] = useState<string | null>(null) // expanded chart card

  const load = () => {
    setLoading(true)
    setError(null)
    // IPOs are the least critical rail card — a failing calendar must never take
    // the whole desk down, so it is caught to null rather than joining the reject.
    Promise.all([getEngine(), getMovers(), getIpos().catch(() => null)])
      .then(([engine, mv, ip]) => {
        setData(engine)
        setMovers(mv)
        setIpos(ip)
      })
      .catch(e => setError(humanError(e)))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  const boardData = data?.board ?? null
  const board = boardData?.board ?? []
  const large = board.filter(p => !p.smallCap)
  const small = board.filter(p => p.smallCap)

  const cohorts = capClassBreakdown(flattenLedger(data?.ledger ?? []))
  const catalysts = board.filter(p => p.catalyst)

  if (loading && !data) {
    return (
      <div className="desk" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100dvh' }}>
        <p className="empty-line">Loading the desk…</p>
      </div>
    )
  }

  if (error && !data) {
    return (
      <div className="desk" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100dvh' }}>
        <p className="empty-line">The desk couldn't load — {error}.</p>
      </div>
    )
  }

  const updated = boardData ? new Date(boardData.generatedAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null
  const riskState = data?.riskState ?? null

  return (
    <div className="desk">
      <header className="desk-top">
        <span className="desk-brand">
          The Street Signal <span>Desk</span>
        </span>
        <RegimeBanner regime={(boardData?.regime as any) ?? null} />
        {(boardData?.worldTape || boardData?.newsTone) && (
          <span className="empty-line">
            {boardData?.worldTape && <>world tape {boardData.worldTape.tone}</>}
            {boardData?.worldTape && boardData?.newsTone && ' · '}
            {boardData?.newsTone && <>news {boardData.newsTone.label}</>}
          </span>
        )}
        <span className="empty-line">
          {riskState && `R${riskState.rung} · ${RUNG_PCT[riskState.rung]}% per idea`}
          {riskState && updated && ' · '}
          {updated && `updated ${updated}`}
        </span>
        <span className="desk-spacer" />
        <button className="mini-btn ghost" onClick={load}>Refresh</button>
        <button className="mini-btn ghost" onClick={onQuant}>Quant</button>
        <button className="mini-btn ghost" onClick={onStandard}>Standard view</button>
        <button className="gear" onClick={onOpenSettings} aria-label="Settings"><IconGear /></button>
      </header>

      <div className="desk-body">
        <main className="desk-main">
          <section className="chart-wall-head">
            <h3 className="section-title" style={{ margin: 0 }}>
              The board — every call, charted <span className="badge">{large.length} large</span> <span className="badge">{small.length} small</span>
            </h3>
            <span className="empty-line">MA20/50/200 · engine levels · classical patterns flagged when the shape is really there · click a card to expand</span>
          </section>
          {board.length === 0 && <p className="empty-line">No calls on the board today — an honest empty wall beats a forced one.</p>}
          <div className="chart-wall">
            {[...large, ...small].map(p => (
              <ChartCard key={p.id} p={p} expanded={focus === p.sym} onToggle={sym => setFocus(f => (f === sym ? null : sym))} />
            ))}
          </div>
        </main>

        <aside className="desk-rail">
          <section className="card">
            <h3 className="section-title">Track record — large vs small</h3>
            {cohorts.length === 0 && <p className="empty-line">No graded calls yet.</p>}
            {cohorts.map(c => (
              <div key={c.key} className="perf-row">
                <span>
                  <span className="badge">{c.key}</span> ×{c.n} · {c.graded} graded
                </span>
                <span>
                  {c.hitRate == null ? (
                    'none graded yet'
                  ) : (
                    <>
                      {Math.round(c.hitRate * 100)}% hit ·{' '}
                      <span className={(c.avgExcess5 ?? 0) >= 0 ? 'up-text' : 'down-text'}>{fmtPct(c.avgExcess5 ?? 0)}</span> @5d
                    </>
                  )}
                </span>
              </div>
            ))}
          </section>

          <section className="card">
            <h3 className="section-title">In the news today</h3>
            {catalysts.length === 0 && <p className="empty-line">Quiet tape — no news catalysts flagged.</p>}
            {catalysts.map(p => (
              <div
                key={p.id}
                className="perf-row"
                style={{ flexDirection: 'column', alignItems: 'stretch', gap: 2, cursor: 'pointer' }}
                role="button"
                tabIndex={0}
                onClick={() => setFocus(p.sym)}
                onKeyDown={e => e.key === 'Enter' && setFocus(p.sym)}
              >
                <span style={{ fontWeight: 700 }}>
                  {p.sym} <span style={{ color: p.side === 'long' ? 'var(--green)' : 'var(--red)', fontWeight: 400 }}>{p.side === 'long' ? '▲' : '▼'}</span>
                </span>
                <span style={{ fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>{p.catalyst!.reason}</span>
              </div>
            ))}
          </section>

          <section className="card">
            <h3 className="section-title">Movers</h3>
            {movers && movers.gainers.length > 0 && (
              <>
                <div className="empty-line" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '2px 0 4px' }}>Gainers</div>
                {movers.gainers.slice(0, 5).map(m => (
                  <div
                    key={`g-${m.sym}`}
                    className="perf-row"
                    style={{ cursor: 'pointer' }}
                    role="button"
                    tabIndex={0}
                    onClick={() => setFocus(m.sym)}
                    onKeyDown={e => e.key === 'Enter' && setFocus(m.sym)}
                  >
                    <span>{m.sym}</span>
                    <span className={(m.changePct ?? 0) >= 0 ? 'up-text' : 'down-text'}>{m.changePct != null ? fmtPct(m.changePct) : '—'}</span>
                  </div>
                ))}
              </>
            )}
            {movers && movers.losers.length > 0 && (
              <>
                <div className="empty-line" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '10px 0 4px' }}>Losers</div>
                {movers.losers.slice(0, 5).map(m => (
                  <div
                    key={`l-${m.sym}`}
                    className="perf-row"
                    style={{ cursor: 'pointer' }}
                    role="button"
                    tabIndex={0}
                    onClick={() => setFocus(m.sym)}
                    onKeyDown={e => e.key === 'Enter' && setFocus(m.sym)}
                  >
                    <span>{m.sym}</span>
                    <span className={(m.changePct ?? 0) >= 0 ? 'up-text' : 'down-text'}>{m.changePct != null ? fmtPct(m.changePct) : '—'}</span>
                  </div>
                ))}
              </>
            )}
            {(!movers || (movers.gainers.length === 0 && movers.losers.length === 0)) && (
              <p className="empty-line">No mover data right now.</p>
            )}
          </section>

          <section className="card">
            <h3 className="section-title">New listings</h3>
            {ipos && ipos.upcoming.length > 0 && (
              <>
                <div className="empty-line" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '2px 0 4px' }}>Upcoming</div>
                {ipos.upcoming.slice(0, 5).map(r => (
                  <div key={`u-${r.sym}`} className="perf-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 2 }}>
                    <span style={{ fontWeight: 700 }}>
                      {r.sym} <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}>· {r.name}</span>
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>{r.date} · {r.status}</span>
                  </div>
                ))}
              </>
            )}
            {ipos && ipos.recent.length > 0 && (
              <>
                <div className="empty-line" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '10px 0 4px' }}>Recently listed</div>
                {ipos.recent.slice(0, 5).map(r => (
                  <div
                    key={`r-${r.sym}`}
                    className="perf-row"
                    style={{ cursor: 'pointer' }}
                    role="button"
                    tabIndex={0}
                    onClick={() => setFocus(r.sym)}
                    onKeyDown={e => e.key === 'Enter' && setFocus(r.sym)}
                  >
                    <span>{r.sym}</span>
                    <span className="empty-line" style={{ fontSize: 12 }}>listed {listedDaysAgo(r.date)}d ago</span>
                  </div>
                ))}
              </>
            )}
            {(!ipos || (ipos.upcoming.length === 0 && ipos.recent.length === 0)) && (
              <p className="empty-line">No fresh listings.</p>
            )}
          </section>
        </aside>
      </div>
    </div>
  )
}
