// AskSheet (plan Task 18) — "Ask the desk" on the journey page: a bottom
// sheet that answers free-form questions about the open name. The ENGINE'S
// VERDICT IS AUTHORITATIVE — the LLM only narrates it and answers follow-ups
// within it, never a second opinion. Every request, first question and every
// follow-up alike, carries the same compact JSON of what the hero card is
// ALREADY showing (CX-20's pinned server-side context); the sheet never
// refetches journey/verdict data of its own to build it.
//
// The six-way shape here is deliberately the SAME branch VerdictHero.tsx
// reads (sized-live / unsized / refused / published-elsewhere / near-miss /
// on-demand / no-read) — a second, drifting copy of that law is exactly how
// two cards on this page could someday tell the reader two different things
// about the same name.

import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { GateCode } from '../../../shared/engine/types'
import type { EnginePrediction, OpenTraceEntry } from '../../lib/api'
import type { JourneyFunnelRow, VerdictRead } from '../../lib/apiViews'
import { askDesk } from '../../lib/api'
import { rowKind } from '../../lib/boardTaxonomy'
import { GATE_LABELS } from '../../lib/gateLabels'
import { humanError } from '../../lib/format'

/** Non-admin soft cap (plan Task 18): 20 asks/day, a plain localStorage
 * counter keyed by the calendar date. Soft on purpose — it protects the LLM
 * bill, not a hard wall; hitting it renders a friendly line instead of
 * sending, no fetch. */
export const ASK_DAILY_CAP = 20

const askCountKey = () => `mb-ask-count:${new Date().toISOString().slice(0, 10)}`

function askCountToday(): number {
  return Number(localStorage.getItem(askCountKey())) || 0
}

function bumpAskCount(): number {
  const n = askCountToday() + 1
  localStorage.setItem(askCountKey(), String(n))
  return n
}

export type AskState = 'sized' | 'unsized' | 'refused' | 'published-elsewhere' | 'near-miss' | 'on-demand' | 'no-read'

export interface AskContext {
  sym: string
  state: AskState
  grade: string | null
  side: 'long' | 'short' | null
  core: number | null
  gateLabel: string | null
  openTrace: { status: OpenTraceEntry['status']; verdict: OpenTraceEntry['verdict'] } | null
}

export interface AskHeroState {
  sym: string
  row?: EnginePrediction | null
  refusal?: { date: string; row: JourneyFunnelRow } | null
  published?: { date: string; gate: GateCode } | null
  nearMissDate?: string | null
  verdict?: VerdictRead | null
  openTrace?: OpenTraceEntry | null
}

/** Exactly the hero's own branch order — see VerdictHero.tsx. */
export function buildAskContext({ sym, row, refusal, published, nearMissDate, verdict, openTrace }: AskHeroState): AskContext {
  const openTraceCtx = openTrace ? { status: openTrace.status, verdict: openTrace.verdict } : null
  if (row) {
    const sized = rowKind(row) === 'sized-live'
    return { sym, state: sized ? 'sized' : 'unsized', grade: sized ? row.grade : null, side: row.side, core: row.composite, gateLabel: null, openTrace: openTraceCtx }
  }
  if (refusal) return { sym, state: 'refused', grade: null, side: refusal.row.side ?? null, core: refusal.row.core ?? null, gateLabel: GATE_LABELS[refusal.row.gate], openTrace: openTraceCtx }
  if (published) return { sym, state: 'published-elsewhere', grade: null, side: null, core: null, gateLabel: GATE_LABELS[published.gate], openTrace: openTraceCtx }
  if (nearMissDate) return { sym, state: 'near-miss', grade: null, side: null, core: null, gateLabel: null, openTrace: openTraceCtx }
  if (verdict) return { sym, state: 'on-demand', grade: null, side: verdict.lean === 'none' ? null : verdict.lean, core: verdict.core, gateLabel: null, openTrace: openTraceCtx }
  return { sym, state: 'no-read', grade: null, side: null, core: null, gateLabel: null, openTrace: openTraceCtx }
}

interface Turn {
  q: string
  answer: string
}

export function AskSheet({ open, onClose, ...hero }: AskHeroState & { open: boolean; onClose: () => void }) {
  const { sym } = hero
  const reduced = useReducedMotion()
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [error, setError] = useState<string | null>(null)
  const [count, setCount] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const triggerElementRef = useRef<Element | null>(null)

  // Rebuilt from whatever the page already has in hand — never a fetch of its
  // own — but stable across a session, so every follow-up pins the SAME block.
  const context = useMemo(
    () => buildAskContext(hero),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sym, hero.row, hero.refusal, hero.published, hero.nearMissDate, hero.verdict, hero.openTrace],
  )

  useEffect(() => {
    if (!open) return
    setCount(askCountToday())
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // A fresh sheet each time it opens — no stale thread from a different visit.
  useEffect(() => {
    if (!open) {
      setQ('')
      setTurns([])
      setError(null)
    }
  }, [open])

  // Focus management: capture the trigger element when opening, focus the input,
  // and restore focus to the trigger on close (if still in document).
  useEffect(() => {
    if (open) {
      triggerElementRef.current = document.activeElement as Element
      inputRef.current?.focus()
    }
  }, [open])

  useEffect(() => {
    if (open) return
    if (triggerElementRef.current && triggerElementRef.current.ownerDocument.contains(triggerElementRef.current)) {
      ;(triggerElementRef.current as HTMLElement).focus()
    }
  }, [open])

  const atCap = count >= ASK_DAILY_CAP

  const send = async (question: string) => {
    const trimmed = question.trim()
    if (!trimmed || busy) return
    if (askCountToday() >= ASK_DAILY_CAP) {
      setCount(askCountToday())
      return
    }
    setBusy(true)
    setError(null)
    setCount(bumpAskCount())
    try {
      const d = await askDesk(sym, trimmed, context)
      setTurns(t => [...t, { q: trimmed, answer: d.answer }])
      setQ('')
    } catch (e) {
      setError(humanError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="ask-scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reduced ? 0 : 0.16 }} />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={`Ask the desk about ${sym}`}
            className="ask-sheet"
            initial={reduced ? false : { y: '100%' }}
            animate={{ y: 0 }}
            transition={{ duration: reduced ? 0 : 0.22, ease: 'easeOut' }}
          >
            <div className="ask-head">
              <h2>Ask the desk · {sym}</h2>
              <span className="ask-cap num">
                {count}/{ASK_DAILY_CAP} today
              </span>
              <button type="button" className="ask-close" aria-label="Close" onClick={onClose}>
                ×
              </button>
            </div>

            <div className="ask-body">
              {turns.length === 0 && !busy && !atCap && (
                <p className="ask-note">Ask about entry, trend, levels — grounded in what the engine sees right now.</p>
              )}
              {turns.map((t, i) => (
                <div className="ask-turn" key={i}>
                  <p className="ask-q">“{t.q}”</p>
                  <p className="ask-a">{t.answer}</p>
                </div>
              ))}
              {busy && <p className="ask-note">Reading the chart…</p>}
              {error && <p className="ask-note">The desk couldn't answer — {error}.</p>}
              {atCap && <p className="ask-note">The desk is out of answers for today — back tomorrow.</p>}
            </div>

            {!atCap && (
              <form
                className="addform ask-form"
                onSubmit={e => {
                  e.preventDefault()
                  void send(q)
                }}
              >
                <input
                  ref={inputRef}
                  value={q}
                  onChange={e => setQ(e.target.value)}
                  placeholder={`Ask about ${sym}…`}
                  disabled={busy}
                  maxLength={400}
                  aria-label={`Ask a question about ${sym}`}
                  style={{ textTransform: 'none' }}
                />
                <button disabled={busy || !q.trim()}>{busy ? '…' : 'Ask'}</button>
              </form>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
