import { useEffect, useState } from 'react'
import { getT212, getT212KeyStatus } from '../lib/api'
import { IconGear } from '../components/icons'

// MY POSITIONS: the reader's OWN Trading 212 book, per licence namespace —
// every licensee who has connected their own T212 API key (Settings → Trading
// 212) gets their book here; nobody ever sees anyone else's (the /api/t212
// route is ns-isolated server-side). This page took over from the paper's
// old "Portfolio Desk" section: positions are private reading, not print.

type Book = Awaited<ReturnType<typeof getT212>>
type Pos = NonNullable<Book['positions']>[number]

// "changes since your last visit": a per-device snapshot in localStorage —
// honest scope (this device, your eyes only), zero server surface
const SNAP_KEY = 'mb-pos-snapshot'
interface Snap {
  at: number
  positions: { symbol: string; quantity: number }[]
}

export function diffBook(prev: Snap | null, current: Pos[]): { added: string[]; closed: string[]; resized: { symbol: string; from: number; to: number }[] } {
  if (!prev) return { added: [], closed: [], resized: [] }
  const before = new Map(prev.positions.map(p => [p.symbol, p.quantity]))
  const now = new Map(current.map(p => [p.symbol, p.quantity]))
  return {
    added: current.filter(p => !before.has(p.symbol)).map(p => p.symbol),
    closed: prev.positions.filter(p => !now.has(p.symbol)).map(p => p.symbol),
    resized: current
      .filter(p => before.has(p.symbol) && Math.abs((before.get(p.symbol)! - p.quantity) / (before.get(p.symbol)! || 1)) > 0.01)
      .map(p => ({ symbol: p.symbol, from: before.get(p.symbol)!, to: p.quantity })),
  }
}

export function Positions({ onOpen, onOpenSettings }: { onOpen: (symbol: string) => void; onOpenSettings: () => void }) {
  const [book, setBook] = useState<Book | null>(null)
  const [keySource, setKeySource] = useState<'env' | 'own' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [changes, setChanges] = useState<ReturnType<typeof diffBook> | null>(null)
  const [snapAt, setSnapAt] = useState<number | null>(null)

  useEffect(() => {
    getT212KeyStatus()
      .then(s => setKeySource(s.source))
      .catch(() => {})
    getT212()
      .then(d => {
        setBook(d)
        if (d.unconfigured || !d.positions) return
        // diff against the last visit's snapshot, then roll the snapshot
        let prev: Snap | null = null
        try {
          prev = JSON.parse(localStorage.getItem(SNAP_KEY) ?? 'null') as Snap | null
        } catch {
          /* corrupt snapshot = no diff */
        }
        setChanges(diffBook(prev, d.positions))
        setSnapAt(prev?.at ?? null)
        localStorage.setItem(SNAP_KEY, JSON.stringify({ at: Date.now(), positions: d.positions.map(p => ({ symbol: p.symbol, quantity: p.quantity })) } satisfies Snap))
      })
      .catch(e => setError(String((e as Error)?.message ?? e)))
  }, [])

  const positions = book?.positions ?? []
  const anyChange = changes && (changes.added.length || changes.closed.length || changes.resized.length)

  return (
    <>
      <header className="topbar">
        <span className="brand">My positions</span>
        <button className="gear" onClick={onOpenSettings} aria-label="Settings"><IconGear /></button>
      </header>
      <div className="content">
        {book?.unconfigured && (
          <section className="digest-section">
            <h3 className="section-title">Connect your Trading 212</h3>
            <p className="empty-line">
              Your book, your eyes only: add your own Trading 212 API key (T212 app → Settings → API → read scopes) and this page shows your live
              positions and what changed between visits. Keys are stored against your licence alone.
            </p>
            <button className="mini-btn" onClick={onOpenSettings}>Open Settings → Trading 212</button>
          </section>
        )}
        {error && !book && <p className="empty-line">Positions unavailable — {error}.</p>}

        {positions.length > 0 && (
          <>
            {anyChange ? (
              <section className="digest-section" style={{ marginBottom: 12 }}>
                <h3 className="section-title">Since your last visit{snapAt ? ` — ${new Date(snapAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}</h3>
                {changes!.added.map(s => (
                  <div key={`a-${s}`} className="perf-row"><span><span className="badge good">new</span> {s}</span></div>
                ))}
                {changes!.closed.map(s => (
                  <div key={`c-${s}`} className="perf-row"><span><span className="badge bad">closed</span> {s}</span></div>
                ))}
                {changes!.resized.map(r => (
                  <div key={`r-${r.symbol}`} className="perf-row">
                    <span><span className="badge">{r.to > r.from ? 'added to' : 'trimmed'}</span> {r.symbol}</span>
                    <span className="num" style={{ color: 'var(--muted)', fontSize: 12 }}>{r.from} → {r.to}</span>
                  </div>
                ))}
              </section>
            ) : (
              changes && snapAt != null && <p className="empty-line" style={{ marginBottom: 10 }}>No changes since your last visit.</p>
            )}

            <section className="digest-section">
              <h3 className="section-title">
                Positions ({positions.length}){keySource === 'env' ? '' : ' · your key'}
                {book?.at ? <span className="badge" style={{ marginLeft: 8 }}>as of {new Date(book.at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> : null}
              </h3>
              {positions.map(p => (
                <div key={p.symbol} className="perf-row led-clickable" role="button" tabIndex={0} onClick={() => onOpen(p.symbol)} onKeyDown={e => e.key === 'Enter' && onOpen(p.symbol)}>
                  <span>
                    <strong>{p.symbol}</strong> <span className="led-n">×{p.quantity}</span>
                  </span>
                  <span className="num" style={{ fontSize: 13 }}>
                    {p.averagePrice} → {p.currentPrice}{' '}
                    {p.pplPct != null && (
                      <span className={p.pplPct >= 0 ? 'up-text' : 'down-text'}>
                        {p.pplPct >= 0 ? '+' : ''}
                        {p.pplPct}%
                      </span>
                    )}
                  </span>
                </div>
              ))}
              <p className="empty-line" style={{ fontSize: 11 }}>
                Prices in each instrument's own currency, refreshed on load (~1 min cache). Private to this licence — positions never appear in the
                morning report.
              </p>
            </section>
          </>
        )}
        {book && !book.unconfigured && positions.length === 0 && <p className="empty-line">Connected — no open positions right now.</p>}
        {!book && !error && (
          <div aria-hidden style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[0, 1, 2].map(i => <div key={i} className="skeleton" style={{ height: 36 }} />)}
          </div>
        )}
      </div>
    </>
  )
}
