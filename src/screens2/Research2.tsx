// Research2 (plan Task 21; CX-23) — a thin v2 adapter for the desk's
// research artifacts. Reads through `useSlice`, one card per dataset the
// legacy src/screens/Research.tsx fetched — EXCEPT its <EnginePanel/> mount,
// which is gone: that machinery now lives in Track record (scorecard,
// calibration, the ledger, regrets) and Gates & learning (the tunables, the
// weights, the roster). Nothing here imports EnginePanel, useMarketData or
// the legacy TabBar.

import { useState } from 'react'
import { Link } from 'wouter'
import { useSlice } from '../lib/useSlice'
import { getAiRead, getEventDossiers, getOutcomes, getPickStats, getPicks } from '../lib/api'
import { relativeStamp, shortDateWithWeekday } from '../lib/format'
import { MarkdownLite } from './parts/MarkdownLite'

/** THE SERVER'S OWN SENTENCE, quoted here only so the display can refuse to
 * print it. `/api/ai` answers a keyless caller with `unconfigured: true`, but
 * an older cached slice carries the same fact as this bare string in `text` —
 * either way it is deployment plumbing, and a reader has no gateway to
 * configure. (Visibility wave, 2026-08-17.) */
const SERVER_UNCONFIGURED = 'AI gateway not configured on this site.'

/** What the reader is told when there is no AI read. Deliberately says the
 * page below is still whole: the desk's numbers are computed server-side and
 * owe the LLM nothing, so a missing read is a missing garnish, not a missing
 * page. */
export const AI_READ_UNAVAILABLE = "The desk's AI read isn't available on this account — the day's data below is complete without it."

/** One place that decides what the AI-read card says, so the "absent read"
 * cases cannot each invent their own wording. `isRead` is the difference
 * between prose the model wrote (which earns the provider footnote and the
 * stamp) and our own explanation of its absence (which earns neither). */
export function aiReadCopy(d: { text?: string; unconfigured?: boolean; empty?: boolean }): { body: string; isRead: boolean } {
  const text = d.text?.trim()
  if (text && text !== SERVER_UNCONFIGURED) return { body: text, isRead: true }
  if (d.empty) return { body: 'Add tickers to your watchlist first.', isRead: false }
  return { body: AI_READ_UNAVAILABLE, isRead: false }
}

function AiReadCard() {
  const { data } = useSlice('research:aiRead', getAiRead)
  const copy = data ? aiReadCopy(data) : null
  // WHEN the desk read it (visibility wave). The payload has always carried
  // `at`; nothing rendered it, so a read cached three days ago looked like
  // this morning's.
  const stamp = data?.at ? relativeStamp(data.at) : ''
  return (
    <section className="card rs2-section" aria-label="AI read">
      <p className="sec-label">AI read{copy?.isRead && stamp ? ` · ${stamp}` : ''}</p>
      {!data || !copy ? (
        <div className="skeleton" style={{ height: 60 }} />
      ) : (
        <>
          <p className="cc-reason">{copy.body}</p>
          {copy.isRead && <p className="cc-reason rs2-fine">AI interpretation ({data.provider}). Not a prediction, not advice.</p>}
        </>
      )}
    </section>
  )
}

function EventsSection() {
  const { data } = useSlice('research:events', getEventDossiers)
  const events = data ?? []
  if (data && events.length === 0) return null
  return (
    <section aria-label="Event assessments">
      <p className="sec-label">Event assessments</p>
      {!data ? (
        <div className="skeleton" style={{ height: 100 }} />
      ) : (
        events.map(e => (
          <div className="card rs2-section" key={e.sym + e.at}>
            <div className="rs2-event-head">
              <strong>{e.kind === 'shock' ? e.name : `${e.name} stretched`}</strong>
              {e.kind === 'shock' && e.movePct != null && <span className={`pill ${e.movePct >= 0 ? 'long' : 'short'} num`}>{e.movePct >= 0 ? '+' : ''}{e.movePct}%</span>}
              {e.kind === 'stretch' && (e.zScore != null || e.rsi != null) && (
                <span className="pill num">
                  {e.zScore != null ? `${e.zScore}σ` : ''}
                  {e.rsi != null ? ` RSI ${e.rsi}` : ''}
                </span>
              )}
              <span className="cc-reason">{new Date(e.at * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            {/* the assessment is written as a numbered list with bold heads —
                straight into a <p> it arrived as one wall with literal
                asterisks in it (visibility wave, 2026-08-17) */}
            <MarkdownLite text={e.assessment} className="cc-reason rs2-assessment" />
            <p className="cc-reason rs2-fine">Magnitude scenarios are grounded in measured historical analogues. Assessment, not advice.</p>
          </div>
        ))
      )}
    </section>
  )
}

const PICK_PAGE = 10

function PicksSection() {
  const { data } = useSlice('research:picks', getPicks)
  const [visible, setVisible] = useState(PICK_PAGE)
  const rows = data?.persistence ?? []
  if (data && rows.length === 0) return null
  return (
    <section aria-label="Pick persistence">
      <p className="sec-label">Pick persistence{data ? ` (${data.reports} reports)` : ''}</p>
      {!data ? (
        <div className="skeleton" style={{ height: 100 }} />
      ) : (
        <div className="card rs2-section">
          {rows.slice(0, visible).map(p => (
            <div className="rs2-row" key={p.ticker + p.side}>
              <span>
                {p.ticker} <span className={`pill ${p.side === 'long' ? 'long' : 'short'}`}>{p.side}</span>
                {p.persistent && <span className="pill accent">persistent</span>}
              </span>
              <span className="cc-reason num">
                {p.streak > 1 ? `${p.streak} in a row` : `${p.appearances} of last 7`}
                {p.latestConviction ? ` · grade ${p.latestConviction}` : ''}
              </span>
            </div>
          ))}
          {visible < rows.length && (
            <button type="button" className="stx-showmore" onClick={() => setVisible(rows.length)}>
              Show more ({rows.length - visible})
            </button>
          )}
          <p className="cc-reason rs2-fine">A pick surviving several independent analyses is stronger evidence than one day's conviction.</p>
        </div>
      )}
    </section>
  )
}

function ScorecardSection() {
  const { data } = useSlice('research:pickStats', getPickStats)
  const rows = data?.scores ?? []
  if (data && rows.length === 0) return null
  return (
    <section aria-label="Scorecard">
      <p className="sec-label">Scorecard — is the research earning?</p>
      {!data ? (
        <div className="skeleton" style={{ height: 100 }} />
      ) : (
        <div className="card rs2-section">
          {rows.slice(0, 8).map(s => (
            <div className="rs2-row" key={s.bucket}>
              <span>
                {s.bucket} <span className="cc-reason num">×{s.n}</span>
              </span>
              {s.win5 != null ? (
                <span className="num">
                  <span className={`pill ${s.avg5! >= 0 ? 'long' : 'short'}`}>{s.avg5! >= 0 ? '+' : ''}{s.avg5!.toFixed(1)}% @5d</span> {Math.round(s.win5 * 100)}% win
                </span>
              ) : (
                <span className="cc-reason">too recent to score</span>
              )}
            </div>
          ))}
          <p className="cc-reason rs2-fine">Every pick scored against what price actually did. Below ~30 scored picks, treat as noise.</p>
        </div>
      )}
    </section>
  )
}

function OutcomesSection() {
  const { data } = useSlice('research:outcomes', getOutcomes)
  const days = data ?? []
  if (data && days.length === 0) return null
  return (
    <section aria-label="Track record, day by day">
      <p className="sec-label">The track record, day by day</p>
      {!data ? (
        <div className="skeleton" style={{ height: 100 }} />
      ) : (
        <div className="card rs2-section">
          {days.slice(0, 10).map(d => (
            <div className="rs2-row" key={d.date}>
              <span>
                <Link href="/more/calendar">{shortDateWithWeekday(d.date)}</Link>
                {d.regime && <span className={`pill ${d.regime === 'green' ? 'accent' : ''}`}>{d.regime}</span>}
              </span>
              <span className="rs2-day-picks">
                {d.picks.map(p => (
                  <span key={p.ticker + p.side} className="num">
                    {p.ticker}
                    {p.side === 'short' ? '↓' : ''}
                    {p.f5 != null && <em className={p.f5 >= 0 ? 'long' : 'short'} style={{ fontStyle: 'normal' }}>
                      {' '}
                      {p.f5 >= 0 ? '+' : ''}
                      {p.f5.toFixed(1)}%
                    </em>}
                  </span>
                ))}
              </span>
            </div>
          ))}
          <p className="cc-reason rs2-fine">Each date's picks, and the 5-session move after the call.</p>
        </div>
      )}
    </section>
  )
}

export default function Research2() {
  return (
    <div className="rs2">
      <h1>Research</h1>
      <AiReadCard />
      <EventsSection />
      <PicksSection />
      <ScorecardSection />
      <OutcomesSection />
      <footer className="rs2-fine">Research, measured. Nothing here predicts.</footer>
    </div>
  )
}
