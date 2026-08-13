import { appStore as blobAppStore } from './lib/storeProvider'
import { authenticate } from './lib/auth'
import type { Prediction } from '../../shared/engine/types'
import type { WeightsState, CalibrationState } from '../../shared/engine/calibration'
import type { RiskState } from '../../shared/engine/riskLadder'
import type { RosterEntry } from '../../shared/engine/roster'
import type { ChannelCredState } from '../../shared/engine/channelCred'
import { missLedgerSummary } from '../../shared/engine/missLedger'

// Read-only aggregation of everything the engine knows: the board, the
// scorecard, the learning state. The app renders this; the engine writes it.

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ ok: status === 200, data }), {
    status,
    // This payload contains the authenticated ledger and portfolio reads. It
    // must never sit in a shared CDN cache, and run diagnostics need to be live.
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })

/** THE LEDGER PROJECTION: one stored Prediction, slimmed to what the
 * accountability pane needs — every id, level, flag and outcome, but NOT the
 * heavy per-factor breakdown (that stays behind the daily board's evidence
 * toggle). PURE + exported so the projection can be tested without a blob
 * store: a field dropped here is a field the reader's history loses forever,
 * and that has happened before (recon §6.5). */
export function ledgerRow(p: Prediction) {
  return {
    id: p.id,
    date: p.date,
    sym: p.sym,
    side: p.side,
    grade: p.grade,
    probability: p.probability,
    provisional: p.provisional,
    shadow: p.shadow ?? false,
    composite: p.composite,
    capUsdM: p.capUsdM ?? null,
    entry: p.entry,
    stop: p.stop,
    target: p.target,
    expectedMovePct: p.expectedMovePct,
    stage: p.stage,
    regime: p.regime,
    // The factor vector behind `composite`. Without it a conviction
    // inversion can only be RECONSTRUCTED from the note text — which is
    // how the short-side inversion (2026-07-28) had to be diagnosed.
    // score+weight only: `detail` is prose and would bloat 30 days of rows.
    factors: p.factors
      ? Object.fromEntries(Object.entries(p.factors).map(([k, f]) => [k, { score: f.score, weight: f.weight }]))
      : undefined,
    worldTape: p.worldTape,
    earningsRisk: p.earningsRisk,
    overlay: p.overlay,
    outcome5: p.outcome5,
    outcome10: p.outcome10,
    instrument: p.instrument,
    paperOnly: p.paperOnly,
    // The row KIND, carried so a historical row keeps the containment its
    // board day gave it. An observation cleared every gate and an ISA could
    // never place it, so it is not a second opinion on a position anybody
    // took — and the Journal's "engine disagrees" flag must go on respecting
    // that after the row has aged out of today's board into this projection.
    // (nearMiss deliberately absent: a near miss never enters the ledger.)
    observation: p.observation ?? false,
    note: p.note,
    // The engine's own two sentences (voice.ts). They ride the slim
    // projection for the same reason `note` does: this is the ONLY
    // narration a historical row keeps, and a ledger card that can no
    // longer say what the call believed cannot be audited against what
    // then happened. Undefined on near misses and on every row published
    // before the fields existed — the UI reads them as optional.
    thesis: p.thesis,
    falsifier: p.falsifier,
  }
}

export default async (req: Request) => {
  const auth = await authenticate(req.headers, { APP_TOKEN: process.env.APP_TOKEN }, blobAppStore)
  if (!auth) return new Response(JSON.stringify({ ok: false, error: 'unauthorised' }), { status: 401 })

  const [board, scorecard, weights, calibration, riskState, roster, rosterLog, channelCred, newsToneHistory, holdingsReads, predIndex, openTrace, runStatus] = await Promise.all([
    blobAppStore.read<{
      date: string
      generatedAt: number
      regime: string
      board: Prediction[]
      worldTape?: { tone: string; votes: { on: number; off: number }; detail: string }
      newsTone?: { score: number; label: string; hits: number }
    }>('engine-board'),
    blobAppStore.read('engine-scorecard'),
    blobAppStore.read<WeightsState>('engine-weights'),
    blobAppStore.read<CalibrationState>('engine-calibration'),
    blobAppStore.read<RiskState>('risk-state'),
    blobAppStore.read<RosterEntry[]>('engine-roster'),
    blobAppStore.read<{ date: string; joined: string[]; dropped: { sym: string; why: string }[] }[]>('engine-roster-log'),
    blobAppStore.read<ChannelCredState>('channel-credibility'),
    blobAppStore.read<{ date: string; score: number; label: string }[]>('news-tone-history'),
    // the engine's daily read-only opinion on every REAL T212 holding — surfaced
    // here so the Desk gets it in the /api/engine call it already makes (no extra
    // round-trip, and it belongs with the rest of the engine aggregation)
    blobAppStore.read<{ sym: string; stage: string | null; entryQuality: string | null; note: string | null; capacityPct: number | null; pplPct: number | null; quantity: number }[]>('holdings-reads'),
    blobAppStore.read<string[]>('predictions-index'),
    // the open book: yesterday's still-open calls walked against daily closes
    // (traceOpenIdeas) — display-only, written by the same predict run as the board
    blobAppStore.read<{ date: string; generatedAt: number; entries: import('../../shared/engine/openTrace').OpenTraceEntry[] }>('open-trace'),
    blobAppStore.read<{ startedAt: number; updatedAt: number; phase: string; completedAt?: number; failedAt?: number; error?: string; graded?: number; boardSize?: number; rosterSize?: number; holdingsCount?: number; regime?: string }>('engine-run-status'),
  ])

  const [paperBook, paperMonths, patternSightings, eventRadar, intradayFlagsBlob, missLedgerBlob] = await Promise.all([
    blobAppStore.read('paper-book'),
    blobAppStore.read('paper-months'),
    blobAppStore.read<import('../../shared/engine/patternScore').PatternSighting[]>('pattern-sightings'),
    // the event radar: dated earnings binaries the engine tracks, with the shape
    // going in (written by buildBoard). Display-only — never a call.
    blobAppStore.read<{ date: string; generatedAt: number; entries: { sym: string; name?: string | null; date: string; hour?: string; daysToPrint: number; stage: string | null; entryQuality: string | null; rs21: number | null; note: string | null }[] }>('event-radar'),
    // intraday entry flags: today's live-scan blob (alert-check writes it in two
    // session windows). Display-only — the morning's setups at today's prices.
    blobAppStore.read<import('./lib/intradayFlags').IntradayFlagsBlob>('intraday-flags'),
    // THE REGRET LEDGER (shared/engine/missLedger.ts): what the gates turned down
    // and what it went on to do. Served as the bounded SUMMARY, never the raw
    // blob — the blob carries per-gate example lists that grow for months and
    // nothing on the client has a use for them. Display-only, like everything
    // else here; no gate has ever moved because of it (that is Stage 3c).
    blobAppStore.read('miss-ledger'),
  ])

  // pattern scorecard: rolled up at read time (pure + cheap) from the sweep's
  // sightings log — the Ledger's "do the shapes pay?" section
  const { patternScorecard } = await import('../../shared/engine/patternScore')
  const patternScore = patternSightings?.length ? patternScorecard(patternSightings) : []

  // The LEDGER: the last 30 dates of predictions, SLIMMED (ledgerRow above).
  // Newest date first. Each date reads one blob; fail-soft to an empty day.
  const ledgerDates = ((predIndex ?? []).slice(-30)).reverse()
  const ledger = await Promise.all(
    ledgerDates.map(async date => {
      const preds = (await blobAppStore.read<Prediction[]>(`predictions:${date}`)) ?? []
      return { date, predictions: preds.map(ledgerRow) }
    }),
  )

  return json({
    // board carries worldTape + newsTone inline (written by buildBoard); the
    // news-tone history is surfaced as a bounded tail for the display-only trend.
    board,
    openTrace: openTrace ?? null,
    eventRadar: eventRadar ?? null,
    // only today's flags — a stale blob from a prior session must not show as live
    intradayFlags: intradayFlagsBlob && intradayFlagsBlob.date === new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date()) ? intradayFlagsBlob : null,
    runStatus: runStatus ?? null,
    patternScore,
    ledger,
    paperBook: paperBook ?? null,
    paperMonths: paperMonths ?? [],
    newsToneHistory: (newsToneHistory ?? []).slice(-30),
    // the owner's REAL broker book is not shared reading: plain licensees get
    // null (they have their own per-ns Positions page); admin + house devices
    // — the owner's own — keep the Desk holdings pane
    holdingsReads: auth.level === 'admin' || auth.house ? (holdingsReads ?? null) : null,
    // the scorecard travels whole, so `byPostMortem` — how the engine loses, by
    // setup × regime × class — reaches the client with it (Stage 3b Task 2)
    scorecard,
    // …and the other half of the same honesty: what it never called. null until
    // the first trace day matures, so the panel prints nothing rather than a zero.
    missLedger: missLedgerSummary(missLedgerBlob),
    weights: weights ? { base: weights.base, current: weights.current, history: weights.history.slice(-10) } : null,
    // `referenceBase` travels with the buckets [spec §9]: it is the bar every grade
    // on the board was measured against, and a reader looking at "42% · B" cannot
    // check the letter without it. null when no seed ever swept one — the client
    // then says nothing about a bar rather than inventing the pooled base as one.
    calibration: calibration
      ? {
          buckets: calibration.buckets,
          brier: calibration.brier.slice(-30),
          seeded: calibration.seeded ?? false,
          modelVersion: calibration.modelVersion ?? null,
          referenceBase: calibration.referenceBase ?? null,
          evidence: calibration.evidence ?? null,
        }
      : null,
    riskState,
    roster: roster ? { entries: roster, changes: (rosterLog ?? []).slice(-7) } : null,
    channelCred: Object.fromEntries(
      Object.entries(channelCred ?? {}).map(([ch, e]) => [ch, { graded: e.graded, hits: e.hits, avgExcess: e.graded ? Math.round((e.sumExcess / e.graded) * 10) / 10 : null }]),
    ),
  })
}
