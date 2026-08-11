import { useEffect, useState } from 'react'
import { getEngine, getMovers, getCandles, getIpos, type EngineData, type EnginePrediction } from '../lib/api'
import type { Candle } from '../../shared/types'
import { detectPatterns, type PatternHit } from '../../shared/patterns'
import { capBand, fmtPct, humanError } from '../lib/format'
import { capClassBreakdown, flattenLedger } from '../lib/ledgerStats'
import { engineLevelLines } from '../lib/engineLevels'
import { callStatus, type CallState } from '../../shared/engine/callStatus'
import { PriceChart } from '../components/PriceChart'
import { RsiChart } from '../components/RsiChart'
import { RegimeBanner } from '../components/RegimeBanner'
import { GradeChip } from '../components/GradeChip'
import { FLAG_LABEL, FLAG_BADGE, flattenIntradayFlags } from '../components/EngineBoard'

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

const STATE_BADGE: Record<Exclude<CallState, 'live'>, { cls: string; label: string }> = {
  'through-stop': { cls: 'bad', label: 'through stop' },
  'at-target': { cls: 'good', label: 'at target' },
  extended: { cls: 'warn', label: 'extended' },
}

/** Where the price actually is, against the call's own levels. The levels line
 * above is fixed at publication — and `entry` is a PRE-OPEN quote, so it is the
 * previous session's close. Without this line a reader cannot tell an available
 * setup from one that has already run or been invalidated. Last close, not a
 * live tick: this is a swing board, and the candles are already loaded. */
export function CallNow({ call, candles }: { call: EnginePrediction; candles: Candle[] }) {
  const last = candles.length ? candles[candles.length - 1].c : null
  const s = last == null ? null : callStatus(call, last)
  if (!s) return null
  const badge = s.state === 'live' ? null : STATE_BADGE[s.state]
  const tone = s.pctFromEntry >= 0 ? 'var(--green)' : 'var(--red)'
  return (
    <div className="chart-card-now">
      now {s.price.toFixed(2)} ·{' '}
      <span style={{ color: tone }}>
        {s.pctFromEntry >= 0 ? '+' : ''}
        {s.pctFromEntry.toFixed(1)}% from entry
      </span>{' '}
      · {s.pctToStop >= 0 ? `stop ${s.pctToStop.toFixed(1)}% away` : `stop breached by ${Math.abs(s.pctToStop).toFixed(1)}%`}
      {badge && <span className={`badge ${badge.cls}`} style={{ marginLeft: 6 }}>{badge.label}</span>}
    </div>
  )
}

/** One call, one chart. The Desk is a chart wall now — every board name shows
 * its candles, MAs, engine levels and any classical pattern the detector sees,
 * instead of one giant chart for a single focused row. Click to expand. */
function ChartCard({ p, expanded, onToggle, onOpen }: { p: EnginePrediction; expanded: boolean; onToggle: (sym: string) => void; onOpen?: (sym: string) => void }) {
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
          {/* a near miss was never scored — a letter grade would be a fiction */}
          {p.nearMiss ? <span className="badge">near miss</span> : <GradeChip grade={p.grade} provisional={p.provisional} />}
          {/* the ticker itself is a door to the full stock page; the card body still toggles expand */}
          <b
            className={onOpen ? 'sym-link' : undefined}
            onClick={onOpen ? e => { e.stopPropagation(); onOpen(p.sym) } : undefined}
            title={onOpen ? `Open ${p.sym}` : undefined}
          >
            {p.sym}
          </b>
          {p.name && (
            <span
              title={p.name}
              style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12, marginLeft: 6, display: 'inline-block', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}
            >
              {p.name}
            </span>
          )}
          <span style={{ color: dirColor }}>{p.side === 'long' ? '▲' : '▼'}</span>
          {p.watchOnly && !p.nearMiss && <span className="badge warn">watch</span>}
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
      <CallNow call={p} candles={candles} />
      {candles.length ? (
        // pan/zoom only once you've chosen the card — collapsed cards are
        // pictures, so wheeling down the wall scrolls the page, not a chart
        <PriceChart candles={candles} priceLines={engineLevelLines(p)} height={expanded ? 340 : 190} interactive={expanded} />
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

// the whole deck survives unmounting (Desk ↔ Standard round trips) — coming
// back paints the last state instantly while load() refreshes it behind
let deskMemo: { data: EngineData; movers: MoversResponse | null; ipos: IposResponse | null } | null = null

export function Desk({ onStandard, onQuant, onOpen }: { onStandard: () => void; onQuant: () => void; onOpen?: (sym: string) => void }) {
  const [data, setData] = useState<EngineData | null>(deskMemo?.data ?? null)
  const [movers, setMovers] = useState<MoversResponse | null>(deskMemo?.movers ?? null)
  const [ipos, setIpos] = useState<IposResponse | null>(deskMemo?.ipos ?? null)
  const [loading, setLoading] = useState(!deskMemo)
  // separate from `loading`: a warm deck refreshes without blanking, but the
  // Refresh button must still visibly DO something ("does nothing" report)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [focus, setFocus] = useState<string | null>(null) // expanded chart card

  const load = () => {
    setLoading(!deskMemo) // a warm deck refreshes silently, no loading flash
    setRefreshing(true)
    setError(null)
    // IPOs are the least critical rail card — a failing calendar must never take
    // the whole desk down, so it is caught to null rather than joining the reject.
    Promise.all([getEngine(), getMovers(), getIpos().catch(() => null)])
      .then(([engine, mv, ip]) => {
        deskMemo = { data: engine, movers: mv, ipos: ip }
        setData(engine)
        setMovers(mv)
        setIpos(ip)
      })
      .catch(e => setError(humanError(e)))
      .finally(() => {
        setLoading(false)
        setRefreshing(false)
      })
  }

  useEffect(load, [])

  const boardData = data?.board ?? null
  const board = boardData?.board ?? []
  const large = board.filter(p => !p.smallCap)
  const small = board.filter(p => p.smallCap)

  const cohorts = capClassBreakdown(flattenLedger(data?.ledger ?? []))
  const catalysts = board.filter(p => p.catalyst)
  const radar = data?.eventRadar ?? null

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
        {/* settings lives on the rail now — the header gear duplicated it and
            its spoked icon read as a sun/theme toggle */}
        <button className="mini-btn ghost" onClick={load} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
        <button className="desk-switch" onClick={onQuant}>Quant</button>
        <button className="desk-switch" onClick={onStandard}>Standard view</button>
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
              <ChartCard key={p.id} p={p} expanded={focus === p.sym} onToggle={sym => setFocus(f => (f === sym ? null : sym))} onOpen={onOpen} />
            ))}
          </div>
        </main>

        <aside className="desk-rail">
          {(() => {
            // intraday flags: the morning setups flagged the moment price reaches
            // the level. Nothing before the first scan; an honest empty line after
            // a scan finds nothing. Rows open the stock page — not new calls.
            const blob = data?.intradayFlags
            if (!blob || blob.scans.length === 0) return null
            const flags = flattenIntradayFlags(blob)
            const lastAt = blob.scans[0]?.at
            const t = (sec: number) => new Date(sec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            return (
              <section className="card">
                <h3 className="section-title">Intraday flags</h3>
                {flags.length === 0 ? (
                  <p className="empty-line">Scanned {lastAt ? t(lastAt) : ''} — no clean intraday entries.</p>
                ) : (
                  <>
                    {flags.map(f => (
                      <div
                        key={`${f.sym}-${f.kind}`}
                        className="perf-row"
                        style={{ flexDirection: 'column', alignItems: 'stretch', gap: 2, cursor: onOpen ? 'pointer' : undefined }}
                        role="button"
                        tabIndex={0}
                        onClick={() => onOpen?.(f.sym)}
                        onKeyDown={e => e.key === 'Enter' && onOpen?.(f.sym)}
                      >
                        <span style={{ fontWeight: 700 }}>
                          {f.sym} <span className={`badge ${FLAG_BADGE[f.kind]}`}>{FLAG_LABEL[f.kind]}</span>
                          <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 11, marginLeft: 6 }}>flagged {t(f.at)}</span>
                        </span>
                        <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{f.detail}</span>
                      </div>
                    ))}
                    <p className="empty-line" style={{ fontSize: 10.5 }}>The morning setup at today's prices — not a new call, no new levels.</p>
                  </>
                )}
              </section>
            )
          })()}

          <section className="card">
            <h3 className="section-title">Track record — large vs small</h3>
            {cohorts.length === 0 && <p className="empty-line">No graded calls yet.</p>}
            {cohorts.map(c => (
              <div key={c.key} className="perf-row">
                <span>
                  {/* drop the redundant "· 0 graded" — the right side already says "none graded yet" */}
                  <span className="badge">{c.key}</span> ×{c.n}{c.graded > 0 ? ` · ${c.graded} graded` : ''}
                </span>
                <span>
                  {c.hitRate == null ? (
                    'none graded yet'
                  ) : (
                    <>
                      {Math.round(c.hitRate * 100)}% hit ·{' '}
                      <span className={(c.avgExcess10 ?? 0) >= 0 ? 'up-text' : 'down-text'}>{fmtPct(c.avgExcess10 ?? 0)}</span> @10d
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
            <h3 className="section-title">Event radar — earnings ahead</h3>
            {(!radar || radar.entries.length === 0) && <p className="empty-line">No tracked names print in the next fortnight.</p>}
            {radar?.entries.map(e => (
              <div
                key={`${e.sym}-${e.date}`}
                className="perf-row"
                style={{ flexDirection: 'column', alignItems: 'stretch', gap: 2, cursor: 'pointer' }}
                role="button"
                tabIndex={0}
                onClick={() => (onOpen ?? setFocus)(e.sym)}
                onKeyDown={ev => ev.key === 'Enter' && (onOpen ?? setFocus)(e.sym)}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                  <span style={{ fontWeight: 700 }}>
                    {e.sym}
                    {e.name && <span style={{ color: 'var(--muted)', fontWeight: 400, fontSize: 12 }}> · {e.name}</span>}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--muted)', flexShrink: 0 }}>{e.date} ({e.daysToPrint}d)</span>
                </div>
                <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                  {e.stage ?? 'no read'}
                  {e.rs21 != null && (
                    <span className={e.rs21 >= 0 ? 'up-text' : 'down-text'}> · RS {e.rs21 >= 0 ? '+' : ''}{e.rs21}pp</span>
                  )}
                </span>
              </div>
            ))}
            {radar && radar.entries.length > 0 && (
              <p className="empty-line" style={{ fontSize: 10.5 }}>The engine never bets a print — this is the shape going in.</p>
            )}
          </section>

          <section className="card">
            <h3 className="section-title">Movers</h3>
            {movers && movers.gainers.length > 0 && (
              <>
                <div className="empty-line" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '2px 0 4px' }}>Gainers</div>
                {movers.gainers.slice(0, 5).map(m => (
                  // movers are rarely board names — focusing a chart wall card
                  // that doesn't exist did nothing; open the real stock page
                  <div
                    key={`g-${m.sym}`}
                    className="perf-row"
                    style={{ cursor: 'pointer' }}
                    role="button"
                    tabIndex={0}
                    onClick={() => (onOpen ?? setFocus)(m.sym)}
                    onKeyDown={e => e.key === 'Enter' && (onOpen ?? setFocus)(m.sym)}
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
                    onClick={() => (onOpen ?? setFocus)(m.sym)}
                    onKeyDown={e => e.key === 'Enter' && (onOpen ?? setFocus)(m.sym)}
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
                    onClick={() => (onOpen ?? setFocus)(r.sym)}
                    onKeyDown={e => e.key === 'Enter' && (onOpen ?? setFocus)(r.sym)}
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
