import { useEffect, useState } from 'react'
import { db, getCapital, type NoteItem } from '../lib/db'
import { evaluateNote, getEngine, getQuotes, type EngineData } from '../lib/api'
import type { Quote } from '../../shared/types'
import { mirrorConfig } from '../lib/configMirror'
import { mirrorPortfolio, restoreBackup } from '../lib/portfolioMirror'
import { computeStats, exposureWarnings, tradePnl, type Trade } from '../../shared/journal'
import { getT212 } from '../lib/api'
import { TradeForm } from '../components/TradeForm'
import { RiskDial } from '../components/RiskDial'
import { GradeChip } from '../components/GradeChip'
import { Sparkline } from '../components/Sparkline'
import { IconSwap, IconWarn, IconNews, IconSparkle } from '../components/icons'
import { fmtPct } from '../lib/format'

const gbp = (v: number) => `${v < 0 ? '−' : ''}£${Math.abs(v).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`
// Neutral figures stay ink; only genuine gains/losses take market colour.
const pnlClass = (v: number) => (v > 0 ? 'up-text' : v < 0 ? 'down-text' : '')

// The engine's second opinion on a held name: today's live board call first, else
// the most recent live (non-shadow) ledger prediction within the last 10 sessions.
interface EngineView {
  grade: string
  provisional: boolean
  side: 'long' | 'short'
  entry: number
  stop: number
  target: number
  stage: string | null
  source: 'board' | 'ledger'
  // The board's last-resort row: the engine looked at this name and made NO
  // call, and it is on the board only so a side with nothing on it is not blank.
  // Its grade C is a placeholder it never earned, so the row is labelled rather
  // than graded here too — a held name must never be told the engine backs it
  // when the engine declined it. Near misses never enter the ledger, so only the
  // board branch can produce one.
  nearMiss: boolean
}

function engineViewFor(sym: string, engine: EngineData | null): EngineView | null {
  if (!engine) return null
  const call = engine.board?.board.find(p => p.sym === sym)
  if (call) {
    return { grade: call.grade, provisional: call.provisional, side: call.side, entry: call.entry, stop: call.stop, target: call.target, stage: call.stage, source: 'board', nearMiss: call.nearMiss === true }
  }
  const days = [...(engine.ledger ?? [])].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 10)
  for (const d of days) {
    const p = d.predictions.find(pr => pr.sym === sym && !pr.shadow)
    if (p) return { grade: p.grade, provisional: p.provisional, side: p.side, entry: p.entry, stop: p.stop, target: p.target, stage: p.stage, source: 'ledger', nearMiss: false }
  }
  return null
}

export function Journal() {
  const [trades, setTrades] = useState<Trade[]>([])
  const [capital, setCapital] = useState(5000)
  const [closing, setClosing] = useState<string | null>(null)
  const [exitPrice, setExitPrice] = useState('')
  const [notes, setNotes] = useState<NoteItem[]>([])
  const [noteText, setNoteText] = useState('')
  const [noteKind, setNoteKind] = useState<'observation' | 'lesson' | 'hypothesis'>('observation')
  const [engine, setEngine] = useState<EngineData | null>(null)
  const [quotes, setQuotes] = useState<Record<string, Quote | null>>({})

  useEffect(() => {
    db.trades.toArray().then(setTrades)
    db.notes.orderBy('at').reverse().toArray().then(setNotes)
    getCapital().then(setCapital)
    getEngine().then(setEngine).catch(() => {})
  }, [])

  const addNote = async () => {
    const text = noteText.trim()
    if (!text) return
    const note: NoteItem = { id: `n-${Date.now()}`, text, kind: noteKind, at: Math.floor(Date.now() / 1000) }
    await db.notes.put(note)
    setNotes(n => [note, ...n])
    setNoteText('')
    mirrorConfig() // the morning analyst reads these (lightly) and will push back when data disagrees
    evaluateNote(text, noteKind)
      .then(async take => {
        await db.notes.update(note.id, { aiTake: take })
        setNotes(n => n.map(x => (x.id === note.id ? { ...x, aiTake: take } : x)))
      })
      .catch(() => {})
  }

  const open = trades.filter(t => t.exitPrice == null).sort((a, b) => b.openedAt - a.openedAt)
  const closed = trades.filter(t => t.exitPrice != null).sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))

  // Live prices for open names via the existing quote flow — these drive the
  // unrealised P&L and the distances to both the user's and the engine's stops.
  const openSymbols = [...new Set(open.map(t => t.symbol))]
  useEffect(() => {
    if (openSymbols.length === 0) {
      setQuotes({})
      return
    }
    let alive = true
    getQuotes(openSymbols)
      .then(qs => {
        if (!alive) return
        const map: Record<string, Quote | null> = {}
        openSymbols.forEach((s, i) => (map[s] = qs[i] ?? null))
        setQuotes(map)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSymbols.join(',')])
  const stats = computeStats(trades)
  const warnings = exposureWarnings(open, capital, Math.floor(Date.now() / 1000))

  const add = async (t: Trade) => {
    await db.trades.put(t)
    setTrades(x => [...x, t])
    mirrorPortfolio()
  }

  const close = async (id: string) => {
    const px = parseFloat(exitPrice)
    if (!Number.isFinite(px) || px <= 0) return
    const t = trades.find(x => x.id === id)
    if (!t) return
    const updated = { ...t, exitPrice: px, closedAt: Math.floor(Date.now() / 1000) }
    await db.trades.put(updated)
    setTrades(x => x.map(y => (y.id === id ? updated : y)))
    setClosing(null)
    setExitPrice('')
    mirrorPortfolio()
  }

  const remove = async (id: string) => {
    await db.trades.delete(id)
    setTrades(x => x.filter(y => y.id !== id))
    mirrorPortfolio()
  }

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(trades, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `streetsignal-journal-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
  }

  const importJson = async (file: File) => {
    try {
      const imported = JSON.parse(await file.text()) as Trade[]
      if (!Array.isArray(imported)) return
      await db.trades.bulkPut(imported)
      setTrades(await db.trades.toArray())
      mirrorPortfolio()
    } catch {
      /* bad file — ignore */
    }
  }

  return (
    <>
      <header className="topbar">
        <span className="brand">Journal</span>
        <span className="regime" style={{ marginLeft: 'auto' }}>£{capital.toLocaleString('en-GB')} capital</span>
      </header>
      <div className="content">
        {warnings.map(w => (
          <div key={w.code + (w.symbol ?? '')} className="risk-banner"><IconWarn /> {w.message}</div>
        ))}

        <div className="stat-grid">
          <div className="card stat-card">
            <span className="eyebrow">Realised P&L</span>
            <strong className={`stat-val ${pnlClass(stats.realizedPnl)}`}>{gbp(stats.realizedPnl)}</strong>
          </div>
          <div className="card stat-card">
            <span className="eyebrow">Win rate</span>
            <strong className="stat-val">{stats.winRate == null ? '—' : `${Math.round(stats.winRate * 100)}%`}</strong>
            <span className="stat-sub">{stats.closedCount} closed</span>
          </div>
          <div className="card stat-card">
            <span className="eyebrow">Avg win</span>
            <strong className={`stat-val ${stats.avgWin == null ? '' : pnlClass(stats.avgWin)}`}>{stats.avgWin == null ? '—' : gbp(stats.avgWin)}</strong>
          </div>
          <div className="card stat-card">
            <span className="eyebrow">Avg loss</span>
            <strong className={`stat-val ${stats.avgLoss == null ? '' : pnlClass(stats.avgLoss)}`}>{stats.avgLoss == null ? '—' : gbp(stats.avgLoss)}</strong>
          </div>
        </div>

        {closed.length >= 2 && (
          <div className="card" style={{ padding: '12px 14px' }}>
            <span className="eyebrow">Equity curve · realised P&L</span>
            <div style={{ marginTop: 6 }}>
              <Sparkline
                closes={[...closed].reverse().reduce<number[]>((acc, t) => [...acc, (acc[acc.length - 1] ?? 0) + tradePnl(t)!], [0])}
                width={320}
                height={48}
              />
            </div>
          </div>
        )}

        {Object.keys(stats.byPlaybook).length > 0 && (
          <div className="playbook-row">
            {Object.entries(stats.byPlaybook).map(([k, v]) => (
              <span key={k} className={`badge ${v.expectancy >= 0 ? 'good' : 'bad'}`}>{k}: {gbp(v.expectancy)}/trade ({v.n})</span>
            ))}
          </div>
        )}

        <h3 className="section-title">Log a trade</h3>
        <RiskDial riskState={engine?.riskState ?? null} />
        <TradeForm onAdd={add} board={engine?.board?.board} riskState={engine?.riskState ?? undefined} capital={capital} />
        <button
          className="mini-btn ghost"
          style={{ marginTop: 8 }}
          onClick={async () => {
            try {
              const t212 = await getT212()
              if (t212.unconfigured) {
                alert('Connect Trading 212 first: open the T212 app → Settings → API (Beta) → generate a key with read scopes, then run: npx netlify env:set T212_API_KEY <key> and redeploy.')
                return
              }
              const openSymbols = new Set(trades.filter(t => t.exitPrice == null).map(t => t.symbol))
              const fresh = (t212.positions ?? []).filter(p => !openSymbols.has(p.symbol))
              for (const p of fresh) {
                const trade: Trade = {
                  id: `t212-${p.symbol}-${Date.now()}`,
                  symbol: p.symbol,
                  direction: 'long',
                  instrument: 'stock',
                  leverage: 1,
                  riskClass: 'normal',
                  playbook: 'B',
                  fromSuggestion: false,
                  units: p.quantity,
                  entryPrice: p.averagePrice,
                  stop: Math.round(p.averagePrice * 0.95 * 100) / 100,
                  positionValue: Math.round(p.averagePrice * p.quantity * 100) / 100,
                  thesis: 'Imported from Trading 212. Set your real stop.',
                  openedAt: Math.floor(Date.now() / 1000),
                }
                await db.trades.put(trade)
              }
              setTrades(await db.trades.toArray())
              mirrorPortfolio()
              alert(fresh.length ? `Imported ${fresh.length} position(s). Review each stop: defaults are entry −5%.` : 'All T212 positions are already in the journal.')
            } catch {
              alert('Trading 212 fetch failed. Check the API key and try again.')
            }
          }}
        >
          <IconSwap /> Import positions from Trading 212
        </button>

        {engine?.holdingsReads && engine.holdingsReads.length > 0 && (
          <details className="t212-holdings">
            <summary>
              T212 holdings ({engine.holdingsReads.length}) — engine read
            </summary>
            <div className="t212-holdings-list">
              {[...engine.holdingsReads]
                .sort((a, b) => Math.abs(b.pplPct ?? 0) - Math.abs(a.pplPct ?? 0))
                .map(h => (
                  <div key={h.sym} className="t212-holding-row">
                    <span className="t212-h-sym">{h.sym}</span>
                    <span className={`t212-h-ppl num ${pnlClass(h.pplPct ?? 0)}`}>
                      {h.pplPct == null ? '—' : fmtPct(h.pplPct)}
                    </span>
                    <span className="t212-h-stage">
                      {h.stage ?? 'no read'}
                      {h.entryQuality ? ` · ${h.entryQuality}` : ''}
                    </span>
                  </div>
                ))}
            </div>
            <p className="t212-holdings-foot">
              Read-only tracking, refreshed each morning. Use “Import positions” above to journal one for stop alerts.
            </p>
          </details>
        )}

        <h3 className="section-title">Open positions ({open.length})</h3>
        {open.map(t => {
          const cur = quotes[t.symbol]?.price ?? null
          const livePnl = cur != null ? ((cur - t.entryPrice) / t.entryPrice) * t.positionValue : null
          const livePct = cur != null ? ((cur - t.entryPrice) / t.entryPrice) * 100 : null
          const distYourStop = cur != null ? ((t.stop - cur) / cur) * 100 : null
          const ev = engineViewFor(t.symbol, engine)
          const distEngStop = ev && cur != null ? ((ev.stop - cur) / cur) * 100 : null
          const distEngTgt = ev && cur != null ? ((ev.target - cur) / cur) * 100 : null
          // a near miss is not a call, so it cannot disagree with one either —
          // the row's own label says the engine declined the name
          const conflict = ev != null && !ev.nearMiss && ev.side !== t.direction
          return (
          <div key={t.id} className="card">
            <div className="row-top">
              <span className="sym">{t.symbol} <span className="badge info">{t.playbook}</span> {t.instrument === 'etp' && <span className="badge warn">{t.leverage}x ETP</span>}</span>
              <span className="prices">
                {livePnl != null ? (
                  <>
                    <span className={`price ${pnlClass(livePnl)}`}>{gbp(livePnl)}</span>
                    <span className={`chg-pill pos-pill ${livePnl >= 0 ? 'up' : 'down'}`}>{fmtPct(livePct!)}</span>
                  </>
                ) : (
                  <span className="price">{gbp(t.positionValue)}</span>
                )}
              </span>
            </div>
            <div className="trade-meta">
              {gbp(t.positionValue)} in · at {t.entryPrice}
              {cur != null && <> · now <span className="num">{cur}</span></>} · your stop {t.stop}
              {distYourStop != null && <span className="num"> ({fmtPct(distYourStop)})</span>} · {new Date(t.openedAt * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
              {t.thesis && <em> — {t.thesis}</em>}
            </div>
            {ev ? (
              <div className="engine-read">
                {ev.nearMiss ? <span className="badge">near miss</span> : <GradeChip grade={ev.grade} provisional={ev.provisional} />}
                <span className="engine-read-lv num">
                  {ev.nearMiss ? 'nearest miss — not a call' : `engine ${ev.side === 'long' ? '▲ long' : '▼ short'}`} · stop {ev.stop}
                  {distEngStop != null && ` (${fmtPct(distEngStop)})`} · tgt {ev.target}
                  {distEngTgt != null && ` (${fmtPct(distEngTgt)})`}
                </span>
                {conflict && (
                  <span className="engine-conflict">engine disagrees{ev.stage ? ` — ${ev.stage}` : ''}</span>
                )}
              </div>
            ) : (
              <div className="engine-read no-read">no engine read</div>
            )}
            <div className="row-bottom">
              {closing === t.id ? (
                <>
                  <input className="exit-input" inputMode="decimal" placeholder="Exit price" value={exitPrice} onChange={e => setExitPrice(e.target.value)} autoFocus />
                  <button className="mini-btn" onClick={() => close(t.id)}>Confirm</button>
                  <button className="mini-btn ghost" onClick={() => setClosing(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <button className="mini-btn" onClick={() => { setClosing(t.id); setExitPrice('') }}>Close position</button>
                  <button className="remove" onClick={() => remove(t.id)} aria-label={`Delete ${t.symbol} trade`}>✕</button>
                </>
              )}
            </div>
          </div>
          )
        })}
        {open.length === 0 && <p className="empty-line">No open positions.</p>}

        <h3 className="section-title">Closed ({closed.length})</h3>
        {closed.slice(0, 15).map(t => {
          const pnl = tradePnl(t)!
          return (
            <div key={t.id} className="closed-row">
              <span>{t.symbol} <span className="badge info">{t.playbook}</span>{t.fromSuggestion && <IconNews size={11} />}</span>
              <span className={`chg-pill ${pnl >= 0 ? 'up' : 'down'}`}>
                {gbp(pnl)} ({fmtPct((pnl / t.positionValue) * 100)})
              </span>
            </div>
          )
        })}
        {closed.length === 0 && <p className="empty-line">No closed trades yet — expectancy per playbook appears after ~20.</p>}

        <h3 className="section-title">Observations &amp; lessons</h3>
        <div className="trade-form">
          <div className="tf-row">
            <label style={{ flex: 3 }}>What did you notice or learn?
              <input value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="e.g. Stocks seem to sell off into Friday closes" aria-label="Observation text" />
            </label>
            <label>Type
              <select value={noteKind} onChange={e => setNoteKind(e.target.value as typeof noteKind)}>
                <option value="observation">Observation</option>
                <option value="hypothesis">Hypothesis</option>
                <option value="lesson">Lesson</option>
              </select>
            </label>
          </div>
          <div className="tf-row tf-bottom">
            <span className="empty-line" style={{ fontSize: 11 }}>The analyst weighs these lightly, tests them, and will push back with data when you're wrong — as requested.</span>
            <button type="button" onClick={addNote}>Save</button>
          </div>
        </div>
        {notes.slice(0, 8).map(n => (
          <div key={n.id} className="card" style={{ marginTop: 8 }}>
            <div className="row-top">
              <span style={{ fontSize: 13.5 }}><span className="badge info">{n.kind}</span> {n.text}</span>
              <button className="remove" onClick={async () => { await db.notes.delete(n.id); setNotes(x => x.filter(y => y.id !== n.id)); mirrorConfig() }} aria-label="Delete note">✕</button>
            </div>
            {n.aiTake && <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6, marginBottom: 0 }}><IconSparkle /> {n.aiTake}</p>}
          </div>
        ))}

        <div className="journal-io">
          <button className="mini-btn ghost" onClick={exportJson}>Export JSON</button>
          <label className="mini-btn ghost">
            Import<input type="file" accept="application/json" hidden onChange={e => e.target.files?.[0] && importJson(e.target.files[0])} />
          </label>
          <button
            className="mini-btn ghost"
            onClick={async () => {
              if (!confirm('Restore trades/rules/watchlist from the server backup? Existing entries with the same ids are overwritten.')) return
              const r = await restoreBackup()
              if (r) {
                setTrades(await db.trades.toArray())
                alert(`Restored ${r.trades} trades (backup from ${new Date(r.at * 1000).toLocaleString('en-GB')}).`)
              } else alert('No server backup found yet.')
            }}
          >
            Restore from server
          </button>
        </div>
        <footer className="foot">Every change backs up privately to your own Netlify storage; the morning report sees only a summary.</footer>
      </div>
    </>
  )
}
