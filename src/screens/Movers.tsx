import { useEffect, useState } from 'react'
import { db } from '../lib/db'
import { getEngine, getMovers, getTrending, type MoverRow } from '../lib/api'
import { mirrorConfig } from '../lib/configMirror'
import { capBand, fmtPct, humanError } from '../lib/format'
import { IconGear } from '../components/icons'
import { SubNav } from '../components/TabBar'

// MOVERS: the market-wide tape — top gainers, top losers, most active — with
// the themes shouting in today's headlines. Everything is tappable (chart +
// engine read) and one tap from the watchlist. Each row carries the engine's
// stage read: a −14% falling knife and a −14% name basing for a turn are
// different trades.

const STAGE_TONE: Record<string, string> = {
  'early-reversal': 'good',
  pullback: 'good',
  weak: 'warn',
  extended: 'warn',
  exhausted: 'bad',
  'falling-knife': 'bad',
}

function MoverList({ title, rows, watch, onOpen, onAdd }: {
  title: string
  rows: MoverRow[]
  watch: Set<string>
  onOpen: (sym: string) => void
  onAdd: (sym: string) => void
}) {
  if (!rows.length) return null
  return (
    <section className="digest-section">
      <h3 className="section-title">{title}</h3>
      {rows.map(r => (
        <div
          key={r.sym}
          className="perf-row"
          style={{ cursor: 'pointer', gap: 8 }}
          role="button"
          tabIndex={0}
          onClick={() => onOpen(r.sym)}
          onKeyDown={e => e.key === 'Enter' && onOpen(r.sym)}
        >
          <span style={{ minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ fontWeight: 700 }}>{r.sym}</span>
            {r.name && (
              <span style={{ color: 'var(--faint)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
            )}
            {capBand(r.capUsdM) && <span className="badge" style={{ flex: '0 0 auto' }}>{capBand(r.capUsdM)}</span>}
            {r.stage && (
              <span className={`badge ${STAGE_TONE[r.stage] ?? ''}`} style={{ flex: '0 0 auto' }}>{r.stage.replace('-', ' ')}</span>
            )}
          </span>
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, flex: '0 0 auto' }}>
            {r.price != null && <span className="num" style={{ fontSize: 12.5 }}>{r.price >= 100 ? r.price.toFixed(0) : r.price.toFixed(2)}</span>}
            {r.changePct != null && (
              <span className={r.changePct >= 0 ? 'up-text' : 'down-text'} style={{ fontSize: 12.5, minWidth: 52, textAlign: 'right' }}>{fmtPct(r.changePct)}</span>
            )}
            <button
              className="mini-btn ghost"
              style={{ fontSize: 14, width: 30, height: 30, padding: 0, borderRadius: 999, lineHeight: 1 }}
              aria-label={watch.has(r.sym) ? `${r.sym} on watchlist` : `Add ${r.sym} to watchlist`}
              disabled={watch.has(r.sym)}
              onClick={e => {
                e.stopPropagation()
                onAdd(r.sym)
              }}
            >
              {watch.has(r.sym) ? '✓' : '+'}
            </button>
          </span>
        </div>
      ))}
    </section>
  )
}

export function Movers({ onOpen, onOpenSettings }: { onOpen: (symbol: string) => void; onOpenSettings: () => void }) {
  const [movers, setMovers] = useState<Awaited<ReturnType<typeof getMovers>> | null>(null)
  const [themes, setThemes] = useState<{ key: string; name: string; hits: number }[]>([])
  const [trending, setTrending] = useState<Awaited<ReturnType<typeof getTrending>>['current']>(null)
  const [watch, setWatch] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getMovers().then(setMovers).catch(e => setError(String(e?.message ?? e)))
    getEngine().then(d => setThemes(d.board?.themes ?? [])).catch(() => {})
    getTrending().then(t => setTrending(t.current)).catch(() => {})
    db.watchlist.toArray().then(list => setWatch(new Set(list.map(i => i.symbol))))
  }, [])

  const add = async (sym: string) => {
    if (watch.has(sym) || watch.size >= 30) return
    await db.watchlist.put({ symbol: sym, addedAt: Date.now(), riskClass: 'normal', category: 'Movers' })
    setWatch(s => new Set([...s, sym]))
    mirrorConfig()
  }

  return (
    <>
      <header className="topbar">
        <span className="brand">Movers</span>
        <button className="gear" onClick={onOpenSettings} aria-label="Settings"><IconGear /></button>
      </header>
      <SubNav />
      <div className="content digest-cols">
        {themes.length > 0 && (
          <p className="board-strip">
            <span>in the news: {themes.map(t => t.name.toLowerCase()).join(' · ')}</span>
          </p>
        )}
        {trending && trending.watchlist.length > 0 && (
          <div className="trend-strip" aria-label="Trending in your watchlist">
            {trending.watchlist.slice(0, 6).map(t => (
              <span key={t.sym} className="trend-chip">
                {t.sym} <em className={t.changePct >= 0 ? 'up-text' : 'down-text'}>{fmtPct(t.changePct)}</em>
              </span>
            ))}
          </div>
        )}
        <MoverList title="Top gainers" rows={movers?.gainers ?? []} watch={watch} onOpen={onOpen} onAdd={add} />
        <MoverList title="Top losers" rows={movers?.losers ?? []} watch={watch} onOpen={onOpen} onAdd={add} />
        <MoverList title="Most active" rows={movers?.actives ?? []} watch={watch} onOpen={onOpen} onAdd={add} />
        {!movers && !error && (
          <div aria-hidden style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[0, 1, 2, 3, 4].map(i => <div key={i} className="skeleton" style={{ height: 40 }} />)}
          </div>
        )}
        {error && <p className="empty-line">Movers unavailable — {humanError(error)}.</p>}
        {movers && !movers.gainers.length && !movers.losers.length && !movers.actives.length && (
          <p className="empty-line">The screeners came back empty — likely closed market or a rate-limit. Try again in a few minutes.</p>
        )}
        <footer className="foot">
          US session movers from Yahoo screeners, cached ~10 min. Tap a row for the chart and engine read; + adds it to your watchlist.
        </footer>
      </div>
    </>
  )
}
