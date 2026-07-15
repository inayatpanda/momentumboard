import { blobAppStore } from './lib/store'
import { authenticate } from './lib/auth'
import type { Prediction } from '../../shared/engine/types'
import type { WeightsState, CalibrationState } from '../../shared/engine/calibration'
import type { RiskState } from '../../shared/engine/riskLadder'
import type { RosterEntry } from '../../shared/engine/roster'
import type { ChannelCredState } from '../../shared/engine/channelCred'

// Read-only aggregation of everything the engine knows: the board, the
// scorecard, the learning state. The app renders this; the engine writes it.

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ ok: status === 200, data }), {
    status,
    // This payload contains the authenticated ledger and portfolio reads. It
    // must never sit in a shared CDN cache, and run diagnostics need to be live.
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  })

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

  const [paperBook, paperMonths, patternSightings] = await Promise.all([
    blobAppStore.read('paper-book'),
    blobAppStore.read('paper-months'),
    blobAppStore.read<import('../../shared/engine/patternScore').PatternSighting[]>('pattern-sightings'),
  ])

  // pattern scorecard: rolled up at read time (pure + cheap) from the sweep's
  // sightings log — the Ledger's "do the shapes pay?" section
  const { patternScorecard } = await import('../../shared/engine/patternScore')
  const patternScore = patternSightings?.length ? patternScorecard(patternSightings) : []

  // The LEDGER: the last 30 dates of predictions, SLIMMED — every id, level and
  // outcome the accountability pane needs, but NOT the heavy per-factor
  // breakdown (that stays behind the daily board's evidence toggle). Newest
  // date first. Each date reads one blob; fail-soft to an empty day.
  const ledgerDates = ((predIndex ?? []).slice(-30)).reverse()
  const ledger = await Promise.all(
    ledgerDates.map(async date => {
      const preds = (await blobAppStore.read<Prediction[]>(`predictions:${date}`)) ?? []
      return {
        date,
        predictions: preds.map(p => ({
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
          worldTape: p.worldTape,
          earningsRisk: p.earningsRisk,
          overlay: p.overlay,
          outcome5: p.outcome5,
          outcome10: p.outcome10,
          instrument: p.instrument,
          paperOnly: p.paperOnly,
          note: p.note,
        })),
      }
    }),
  )

  return json({
    // board carries worldTape + newsTone inline (written by buildBoard); the
    // news-tone history is surfaced as a bounded tail for the display-only trend.
    board,
    openTrace: openTrace ?? null,
    runStatus: runStatus ?? null,
    patternScore,
    ledger,
    paperBook: paperBook ?? null,
    paperMonths: paperMonths ?? [],
    newsToneHistory: (newsToneHistory ?? []).slice(-30),
    holdingsReads: holdingsReads ?? null,
    scorecard,
    weights: weights ? { base: weights.base, current: weights.current, history: weights.history.slice(-10) } : null,
    calibration: calibration ? { buckets: calibration.buckets, brier: calibration.brier.slice(-30), seeded: calibration.seeded ?? false, modelVersion: calibration.modelVersion ?? null, evidence: calibration.evidence ?? null } : null,
    riskState,
    roster: roster ? { entries: roster, changes: (rosterLog ?? []).slice(-7) } : null,
    channelCred: Object.fromEntries(
      Object.entries(channelCred ?? {}).map(([ch, e]) => [ch, { graded: e.graded, hits: e.hits, avgExcess: e.graded ? Math.round((e.sumExcess / e.graded) * 10) / 10 : null }]),
    ),
  })
}
