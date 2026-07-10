import { useEffect, useState } from 'react'
import { getEngine, getMovers, getCandles, getIpos, type EngineData, type EnginePrediction } from '../lib/api'
import type { Candle } from '../../shared/types'
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

function CallRow({ p, focused, onFocus }: { p: EnginePrediction; focused: boolean; onFocus: (sym: string) => void }) {
  const dir = p.side === 'long' ? '▲' : '▼'
  const dirColor = p.side === 'long' ? 'var(--green)' : 'var(--red)'
  return (
    <div
      className={`perf-row${focused ? ' is-focus' : ''}`}
      style={{ flexDirection: 'column', alignItems: 'stretch', gap: 3 }}
      role="button"
      tabIndex={0}
      onClick={() => onFocus(p.sym)}
      onKeyDown={e => e.key === 'Enter' && onFocus(p.sym)}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
          <GradeChip grade={p.grade} provisional={p.provisional} />
          {p.sym}
          <span style={{ color: dirColor }}>{dir}</span>
          <span className="badge">{capBand(p.capUsdM) ?? 'small cap'}</span>
        </span>
        <span style={{ color: 'var(--muted)', fontSize: 12, whiteSpace: 'nowrap' }}>
          {Math.round(p.probability * 100)}% · ~{p.expectedMovePct}%
        </span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--font-num)' }}>
        in {p.entry} · stop {p.stop} · tgt {p.target}
      </div>
      {p.catalyst && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 11.5 }}>
          <span className="badge gold">{p.catalyst.kind}</span>
          <span style={{ fontStyle: 'italic', color: 'var(--muted)' }}>{p.catalyst.reason}</span>
        </div>
      )}
    </div>
  )
}

export function Desk({ onStandard, onOpenSettings, onQuant }: { onStandard: () => void; onOpenSettings: () => void; onQuant: () => void }) {
  const [data, setData] = useState<EngineData | null>(null)
  const [movers, setMovers] = useState<MoversResponse | null>(null)
  const [ipos, setIpos] = useState<IposResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [focus, setFocus] = useState<string | null>(null)
  const [focusCandles, setFocusCandles] = useState<Candle[]>([])

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

  // default the focused chart once data has loaded and nothing is picked yet —
  // never again after that, so a background Refresh doesn't yank focus away.
  useEffect(() => {
    if (focus || !data) return
    setFocus(large[0]?.sym ?? small[0]?.sym ?? 'SPY')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, focus])

  useEffect(() => {
    if (!focus) return
    let alive = true
    getCandles(focus)
      .then(d => {
        if (alive) setFocusCandles(d.candles)
      })
      .catch(() => {
        if (alive) setFocusCandles([])
      })
    return () => {
      alive = false
    }
  }, [focus])

  const focusedCall = board.find(p => p.sym === focus) ?? null
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
          <div className="desk-sleeves">
            <section className="card desk-sleeve">
              <h3 className="section-title">
                Large-cap · catalyst &amp; news <span className="badge">{large.length}</span>
              </h3>
              {large.length === 0 && <p className="empty-line">No large-cap calls on the board today.</p>}
              {large.map(p => (
                <CallRow key={p.id} p={p} focused={p.sym === focus} onFocus={setFocus} />
              ))}
            </section>
            <section className="card desk-sleeve">
              <h3 className="section-title">
                Small-cap · momentum <span className="badge">{small.length}</span>
              </h3>
              {small.length === 0 && <p className="empty-line">No small-cap calls on the board today.</p>}
              {small.map(p => (
                <CallRow key={p.id} p={p} focused={p.sym === focus} onFocus={setFocus} />
              ))}
            </section>
          </div>

          <section className="card desk-chart">
            <h3 className="section-title">
              {focus ?? 'select a call'}
              {focusedCall && (
                <>
                  {' '}
                  <GradeChip grade={focusedCall.grade} provisional={focusedCall.provisional} />
                  <span style={{ color: focusedCall.side === 'long' ? 'var(--green)' : 'var(--red)' }}>
                    {focusedCall.side === 'long' ? '▲' : '▼'}
                  </span>
                  <span className="empty-line">
                    ~{focusedCall.expectedMovePct}% · {focusedCall.entry}/{focusedCall.stop}/{focusedCall.target}
                  </span>
                </>
              )}
            </h3>
            {focusCandles.length === 0 ? (
              <p className="empty-line">Select a call to chart it.</p>
            ) : (
              <>
                <PriceChart candles={focusCandles} priceLines={focusedCall ? engineLevelLines(focusedCall) : []} />
                <RsiChart candles={focusCandles} />
              </>
            )}
          </section>
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
