import { useEffect, useState, type CSSProperties } from 'react'
import { db } from '../lib/db'
import { getEngine, getMovers, getTrending, type MoverRow } from '../lib/api'
import { mirrorConfig } from '../lib/configMirror'
import { fmtPct, humanError } from '../lib/format'
import { IconGear } from '../components/icons'
import { symbolHue } from '../components/TickerRow'

// MOVERS: the market-wide tape — top gainers, top losers, most active — as
// stacked T212-style rails (each carousel scrolls on its own), with the
// themes shouting in today's headlines. Everything is tappable (chart +
// engine read) and one tap from the watchlist. Each card carries the
// engine's stage read: a −14% falling knife and a −14% name basing for a
// turn are different trades.

const STAGE_TONE: Record<string, string> = {
  'early-reversal': 'good',
  pullback: 'good',
  weak: 'warn',
  extended: 'warn',
  exhausted: 'bad',
  'falling-knife': 'bad',
}

/** One snap-scrolling mover card. `onAdd` optional — the home-screen rail
 * omits the + so the card stays a pure tap-to-open target. */
export function MoverCard({ r, watched, onOpen, onAdd }: {
  r: MoverRow
  watched?: boolean
  onOpen: (sym: string) => void
  onAdd?: (sym: string) => void
}) {
  const up = (r.changePct ?? 0) >= 0
  return (
    <div
      className="rail-card mover-card"
      role="button"
      tabIndex={0}
      onClick={() => onOpen(r.sym)}
      onKeyDown={e => e.key === 'Enter' && onOpen(r.sym)}
    >
      <span className="mover-card-top">
        <span className="avatar-sq sm" style={{ '--h': symbolHue(r.sym) } as CSSProperties} aria-hidden="true">
          {r.sym.slice(0, 2)}
        </span>
        <span className="mover-card-sym">{r.sym}</span>
        {onAdd && (
          <button
            className="mover-add"
            aria-label={watched ? `${r.sym} on watchlist` : `Add ${r.sym} to watchlist`}
            disabled={watched}
            onClick={e => {
              e.stopPropagation()
              onAdd(r.sym)
            }}
          >
            {watched ? '✓' : '+'}
          </button>
        )}
      </span>
      {r.name && <span className="mover-card-name">{r.name}</span>}
      {r.price != null && <span className="rc-price">{r.price >= 100 ? r.price.toFixed(0) : r.price.toFixed(2)}</span>}
      {r.changePct != null && (
        <span className={`rc-chg ${up ? 'up' : 'down'}`}>
          {up ? '↗' : '↘'} {Math.abs(r.changePct).toFixed(2)}%
        </span>
      )}
      {r.stage && (
        <span className="mover-card-tags">
          <span className={`badge ${STAGE_TONE[r.stage] ?? ''}`}>{r.stage.replace('-', ' ')}</span>
        </span>
      )}
    </div>
  )
}

function MoverRail({ title, rows, watch, onOpen, onAdd }: {
  title: string
  rows: MoverRow[]
  watch: Set<string>
  onOpen: (sym: string) => void
  onAdd: (sym: string) => void
}) {
  if (!rows.length) return null
  return (
    <section className="mover-rail">
      <h3 className="section-title">
        {title}
        <span className="eyebrow">{Math.min(rows.length, 10)} names</span>
      </h3>
      <div className="rail" aria-label={title}>
        {rows.slice(0, 10).map(r => (
          <MoverCard key={r.sym} r={r} watched={watch.has(r.sym)} onOpen={onOpen} onAdd={onAdd} />
        ))}
      </div>
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
      <div className="content">
        {themes.length > 0 && (
          <div className="mover-strip">
            <span className="eyebrow">In the news</span>
            <div className="trend-strip">
              {themes.map(t => (
                <span key={t.key} className="trend-chip mover-theme">{t.name.toLowerCase()}</span>
              ))}
            </div>
          </div>
        )}
        {trending && trending.watchlist.length > 0 && (
          <div className="mover-strip">
            <span className="eyebrow">Trending in your watchlist</span>
            <div className="trend-strip" aria-label="Trending in your watchlist">
              {trending.watchlist.slice(0, 6).map(t => (
                <span key={t.sym} className="trend-chip">
                  {t.sym} <em className={t.changePct >= 0 ? 'up-text' : 'down-text'}>{fmtPct(t.changePct)}</em>
                </span>
              ))}
            </div>
          </div>
        )}
        <MoverRail title="Top gainers" rows={movers?.gainers ?? []} watch={watch} onOpen={onOpen} onAdd={add} />
        <MoverRail title="Top losers" rows={movers?.losers ?? []} watch={watch} onOpen={onOpen} onAdd={add} />
        <MoverRail title="Most active" rows={movers?.actives ?? []} watch={watch} onOpen={onOpen} onAdd={add} />
        {!movers && !error && (
          <div className="rail" aria-hidden>
            {[0, 1, 2, 3].map(i => <div key={i} className="skeleton" style={{ flex: '0 0 148px', height: 118 }} />)}
          </div>
        )}
        {error && <p className="empty-line">Movers unavailable — {humanError(error)}.</p>}
        {movers && !movers.gainers.length && !movers.losers.length && !movers.actives.length && (
          <p className="empty-line">The screeners came back empty — likely closed market or a rate-limit. Try again in a few minutes.</p>
        )}
        <footer className="foot">
          US session movers from Yahoo screeners, cached ~10 min. Tap a card for the chart and engine read; + adds it to your watchlist.
        </footer>
      </div>
    </>
  )
}
