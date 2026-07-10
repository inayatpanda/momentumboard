import { useEffect, useState } from 'react'
import { askDesk } from '../lib/api'
import { humanError } from '../lib/format'

// ASK THE DESK: free-form questions about the open ticker, answered by the
// LLM but grounded server-side in the chart evidence (stage, setups, RSI,
// returns, capacity, regime, live engine call, headlines) — the model
// narrates measured numbers, it never invents them.

const SUGGESTIONS = ['Good entry here?', 'Why is it moving?', 'Where would a stop go?']

// ClampText — long AI prose folds to ~6 lines behind a Read more/Less toggle.
// A cheap length heuristic (no layout measurement) decides whether to clamp;
// short answers render as a plain paragraph with no toggle. Shared by the
// desk answers here and the AI brief on the ticker detail screen.
export function ClampText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const long = text.length > 360 || (text.match(/\n/g)?.length ?? 0) >= 6
  return (
    <>
      <p className={long && !expanded ? 'clamped' : undefined}>{text}</p>
      {long && (
        <button type="button" className="clamp-toggle" aria-expanded={expanded} onClick={() => setExpanded(e => !e)}>
          {expanded ? 'Less' : 'Read more'}
        </button>
      )}
    </>
  )
}

export function AskDesk({ symbol }: { symbol: string }) {
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [qa, setQa] = useState<{ q: string; answer: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setQ('')
    setQa(null)
    setError(null)
  }, [symbol])

  const ask = async (question: string) => {
    const trimmed = question.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      const d = await askDesk(symbol, trimmed)
      setQa({ q: trimmed, answer: d.answer })
      setQ('')
    } catch (e) {
      setError(humanError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="ai-card" style={{ marginTop: 18 }}>
      <h3>Ask the desk · {symbol}</h3>
      <form
        className="addform"
        style={{ margin: '8px 0 6px' }}
        onSubmit={e => {
          e.preventDefault()
          ask(q)
        }}
      >
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder={`Ask about ${symbol}: entry, trend, levels…`}
          disabled={busy}
          maxLength={400}
          aria-label={`Ask a question about ${symbol}`}
          style={{ textTransform: 'none' }}
        />
        <button disabled={busy || !q.trim()}>{busy ? '…' : 'Ask'}</button>
      </form>
      {!qa && !busy && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {SUGGESTIONS.map(s => (
            <button key={s} className="mini-btn ghost" style={{ fontSize: 11.5 }} onClick={() => ask(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      {busy && <p className="ai-note">Reading the chart…</p>}
      {error && <p className="ai-note">The desk couldn't answer — {humanError(error)}.</p>}
      {qa && (
        <>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 4 }}>“{qa.q}”</p>
          <ClampText text={qa.answer} />
          <span className="ai-note">Grounded in this chart's measured read — stage, setups, returns, regime, engine call, headlines. Analysis, not advice.</span>
        </>
      )}
    </section>
  )
}
