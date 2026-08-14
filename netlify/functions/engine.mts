import { appStore as blobAppStore } from './lib/storeProvider'
import { authenticate } from './lib/auth'
import type { Prediction } from '../../shared/engine/types'
import type { WeightsState, CalibrationState } from '../../shared/engine/calibration'
import type { RiskState } from '../../shared/engine/riskLadder'
import type { RosterEntry } from '../../shared/engine/roster'
import type { ChannelCredState } from '../../shared/engine/channelCred'
import { MISS_LEDGER_KEY, missLedgerExamples, missLedgerSummary } from '../../shared/engine/missLedger'
import { GATE_STATE_KEY, gateStateStructured, gateStateSummary, type GateOverride } from '../../shared/engine/gateState'
import { FUNNEL_TRACE_INDEX_KEY, PUBLISHED_GATES, funnelTraceKey, traceRowKey, type FunnelTrace, type FunnelNearMiss } from '../../shared/engine/funnelTrace'
import { onDemandVerdict, type OnDemandVerdict } from './lib/onDemandVerdict'
import { getCached, setCached } from './lib/cache'
import { fetchYahooChart } from './lib/yahoo'
import type { Candle } from '../../shared/types'
import type { FactorName } from '../../shared/engine/types'
import type { RegimeColor } from '../../shared/types'

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
    // …and the other two ways a row was never sized. Without them a historical
    // watch row (or a row published under its own historical hit rate) arrives
    // on the journey page indistinguishable from a live sized call, and gets a
    // grade pill it never earned — the CX-13 rule, lost the moment a row aged
    // out of the board into this projection (Task 17 review, I4).
    watchOnly: p.watchOnly ?? false,
    belowBase: p.belowBase ?? false,
    // …and WHICH PARTITION the row was measured in (Stage 1c Phase B). Same
    // argument as `observation` one line up, with a sharper edge: without it a
    // crypto row's `excessPct` — an ABSOLUTE move against a structural spyPct of
    // 0 — is indistinguishable in this projection from an equity excess, and the
    // client's own avgExcess10 would average the two into one number that means
    // neither. One optional string is what keeps the two bases apart.
    cohort: p.cohort,
    // …and the experiment slot's record (Stage 3d), on the same argument as
    // `observation` above: it is a ROW KIND, and the ledger's own by-grade
    // breakdown cannot keep a wildcard out of the letter buckets without it.
    // Small and bounded (a gate name, a rung, one sentence, one count).
    wildcard: p.wildcard,
    note: p.note,
    // The engine's own two sentences (voice.ts). They ride the slim
    // projection for the same reason `note` does: this is the ONLY
    // narration a historical row keeps, and a ledger card that can no
    // longer say what the call believed cannot be audited against what
    // then happened. Undefined on near misses and on every row published
    // before the fields existed — the UI reads them as optional.
    thesis: p.thesis,
    falsifier: p.falsifier,
    // The loss's own obituary (Stage 3): class + one deterministic sentence
    // (+ the LLM line when composed). The exact field the recon flagged as
    // "written and read by nobody" outside the paper — the reader's history
    // keeps it now. Undefined on winners-without-postmortem and old rows.
    postMortem: p.postMortem,
    outcome21: p.outcome21,
  }
}

/** Today, Europe/London — the same stamp the intraday-flags guard has always
 * used inline; hoisted so the view slices apply the identical guard. */
const londonToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date())

// ---------------------------------------------------------------------------
// VIEW SLICES (PWA rebuild). Each view does ONLY its own reads and serves a
// narrow projection; the no-view aggregate below is unchanged and slated for
// deletion once the v2 shell has a clean production day (plan Task 26).
// Views are ALL-USERS by design: nothing privileged (holdingsReads) may ever
// ride one — the auth-split test drives that with a real licence.
// ---------------------------------------------------------------------------

/** ?view=board — what Today/Board render: ~9 reads instead of ~50. */
async function viewBoard() {
  const [board, intradayFlagsBlob, eventRadar, runStatus, riskState, calibration, predIndex, missLedgerBlob] = await Promise.all([
    blobAppStore.read<{ date?: string }>('engine-board'),
    blobAppStore.read<{ date: string }>('intraday-flags'),
    blobAppStore.read('event-radar'),
    blobAppStore.read('engine-run-status'),
    blobAppStore.read('risk-state'),
    blobAppStore.read<{ referenceBase?: number | null }>('engine-calibration'),
    blobAppStore.read<string[]>('predictions-index'),
    blobAppStore.read(MISS_LEDGER_KEY),
  ])

  // THE YESTERDAY STRIP (CX-18): the newest predictions day before the board's,
  // scored from its own rows, plus that day's costliest named regret — shipped
  // IN the board slice so a cold Today never depends on the learning slice.
  const ydate = (predIndex ?? []).filter(d => d !== (board?.date ?? null)).at(-1) ?? null
  let yesterday: { date: string; wins: number; losses: number; topRegret: { sym: string; excessPct: number; gate: string } | null } | null = null
  if (ydate) {
    const preds = (await blobAppStore.read<Prediction[]>(`predictions:${ydate}`)) ?? []
    // outcome10 is a PredOutcome object; `hit` is the side-adjusted verdict
    const graded = preds.filter(p => p.outcome10 != null)
    if (graded.length) {
      const regrets = missLedgerExamples(missLedgerBlob, 20)
      const dayExamples = (regrets?.topGates ?? [])
        .flatMap(g => g.examples.filter(e => e.date === ydate && e.excessPct > 0).map(e => ({ sym: e.sym, excessPct: e.excessPct, gate: g.gate as string })))
        .sort((a, b) => b.excessPct - a.excessPct)
      yesterday = {
        date: ydate,
        wins: graded.filter(p => p.outcome10!.hit).length,
        losses: graded.filter(p => !p.outcome10!.hit).length,
        topRegret: dayExamples[0] ?? null,
      }
    }
  }

  return {
    board: board ?? null,
    // only today's flags — a stale blob from a prior session must not show as live
    intradayFlags: intradayFlagsBlob && intradayFlagsBlob.date === londonToday() ? intradayFlagsBlob : null,
    eventRadar: eventRadar ?? null,
    runStatus: runStatus ?? null,
    riskState: riskState ?? null,
    referenceBase: calibration?.referenceBase ?? null,
    yesterday,
  }
}

const SYM_RE = /^[A-Z0-9.\-]{1,12}$/

/** Near-miss factor prose is ~85% of the record's bytes (recon §3.3a) — the
 * journey ships score+weight only, the same projection ledgerRow applies. */
const slimNearMiss = (m: FunnelNearMiss) => ({
  ...m,
  // FunnelNearMiss factors carry no weight (unlike Prediction's) — score only
  factors: Object.fromEntries(Object.entries(m.factors ?? {}).map(([k, f]) => [k, { score: f.score }])),
})

/** ?view=journey&sym= — one name's whole story: today's board row, the open-trace
 * verdict, its last-10-days funnel path, and every call on it in the 30-day
 * ledger window. THE funnel's first HTTP door. */
async function viewJourney(sym: string, days = 30) {
  const [traceIndex, predIndex, board, openTrace] = await Promise.all([
    blobAppStore.read<string[]>(FUNNEL_TRACE_INDEX_KEY),
    blobAppStore.read<string[]>('predictions-index'),
    blobAppStore.read<{ date: string; board: Prediction[] }>('engine-board'),
    blobAppStore.read<{ entries: { sym: string }[] }>('open-trace'),
  ])
  const traceDates = (traceIndex ?? []).slice(-10)
  const traces = await Promise.all(traceDates.map(d => blobAppStore.read<FunnelTrace>(funnelTraceKey(d))))
  const keys = [traceRowKey(sym), traceRowKey(sym, 'long'), traceRowKey(sym, 'short')]
  const funnel = traceDates.flatMap((date, i) => {
    const trace = traces[i]
    if (!trace) return []
    const rows = keys.filter(k => trace.rows?.[k]).map(k => ({ key: k, ...trace.rows[k] }))
    const miss = (trace.nearMisses ?? []).find(m => m.sym === sym)
    if (!rows.length && !miss) return []
    return [{ date, rows, nearMiss: miss ? slimNearMiss(miss) : null }]
  })

  const predDates = (predIndex ?? []).slice(-days)
  const predDays = await Promise.all(predDates.map(d => blobAppStore.read<Prediction[]>(`predictions:${d}`)))
  const calls = predDays
    .flatMap(day => (day ?? []).filter(p => p.sym === sym))
    .map(p => ({ ...ledgerRow(p), postMortem: p.postMortem ?? null, outcome21: p.outcome21 ?? null })) // null (not undefined) so an empty journey serialises honestly
    .reverse() // newest first

  return {
    sym,
    boardRow: board?.board?.find(p => p.sym === sym) ?? null,
    openTrace: openTrace?.entries?.find(e => e.sym === sym) ?? null,
    funnel,
    calls,
  }
}

// The four projections BOTH the aggregate and ?view=learning apply — one code
// path each, so the two reads can never drift apart.
const projectWeights = (w: WeightsState | null) => (w ? { base: w.base, current: w.current, history: w.history.slice(-10) } : null)
const projectCalibration = (c: CalibrationState | null) =>
  c
    ? {
        buckets: c.buckets,
        brier: c.brier.slice(-30),
        seeded: c.seeded ?? false,
        modelVersion: c.modelVersion ?? null,
        referenceBase: c.referenceBase ?? null,
        evidence: c.evidence ?? null,
      }
    : null
const projectRoster = (roster: RosterEntry[] | null, log: { date: string; joined: string[]; dropped: { sym: string; why: string }[] }[] | null) =>
  roster ? { entries: roster, changes: (log ?? []).slice(-7) } : null
const projectChannelCred = (cred: ChannelCredState | null) =>
  Object.fromEntries(
    Object.entries(cred ?? {}).map(([ch, e]) => [ch, { graded: e.graded, hits: e.hits, avgExcess: e.graded ? Math.round((e.sumExcess / e.graded) * 10) / 10 : null }]),
  )

/** ?view=learning — the Gates & learning page and the regret surface: the
 * structured gate timeline, the paper's own gate lines, the miss ledger WITH
 * its named examples, and the aggregate's projections of weights, scorecard,
 * roster, channel cred and calibration. */
async function viewLearning() {
  const [gateStateBlob, missLedgerBlob, weights, scorecard, roster, rosterLog, channelCred, calibration, config] = await Promise.all([
    blobAppStore.read(GATE_STATE_KEY),
    blobAppStore.read(MISS_LEDGER_KEY),
    blobAppStore.read<WeightsState>('engine-weights'),
    blobAppStore.read('engine-scorecard'),
    blobAppStore.read<RosterEntry[]>('engine-roster'),
    blobAppStore.read<{ date: string; joined: string[]; dropped: { sym: string; why: string }[] }[]>('engine-roster-log'),
    blobAppStore.read<ChannelCredState>('channel-credibility'),
    blobAppStore.read<CalibrationState>('engine-calibration'),
    blobAppStore.read<{ riskAppetite?: 'moderate' | 'aggressive' | null; gateOverride?: GateOverride | null }>('config'),
  ])
  return {
    // Config rides along so `current` is the engine's OWN effective value —
    // appetite preset, earned delta, owner pin, bounds clamp, all of it (CX-14).
    gateState: gateStateStructured(gateStateBlob, { riskAppetite: config?.riskAppetite ?? null, gateOverride: config?.gateOverride ?? null }),
    gateLines: gateStateSummary(gateStateBlob),
    regrets: missLedgerExamples(missLedgerBlob),
    weights: projectWeights(weights),
    scorecard: scorecard ?? null,
    roster: projectRoster(roster, rosterLog),
    channelCred: projectChannelCred(channelCred),
    calibration: projectCalibration(calibration),
  }
}

const VERDICT_CACHE_MS = 15 * 60 * 1000

/** ?view=verdict&sym= — the on-demand engine read for ANY symbol (DS-24: the
 * cache lives HERE, the computation stays pure). Candles ride the same
 * cache+yahoo path /api/market uses; the verdict itself is cached 15 min under
 * `verdict-cache:{SYM}` and is NEVER written into predictions:*. */
async function viewVerdict(sym: string) {
  const cacheKey = `verdict-cache:${sym}`
  const hit = await blobAppStore.read<{ at: number; verdict: OnDemandVerdict }>(cacheKey)
  if (hit && Date.now() - hit.at < VERDICT_CACHE_MS) return hit.verdict

  const candles = async (s: string): Promise<Candle[] | null> => {
    const key = `candles:${s}:1y`
    const cached = await getCached<{ candles: Candle[] }>(key)
    if (cached?.candles?.length) return cached.candles
    try {
      const data = await fetchYahooChart(s, '1y')
      await setCached(key, data, 900)
      return data.candles?.length ? data.candles : null
    } catch {
      return null
    }
  }

  const [weights, board] = await Promise.all([
    blobAppStore.read<WeightsState>('engine-weights'),
    blobAppStore.read<{ regime?: string }>('engine-board'),
  ])
  const regime: RegimeColor | 'unknown' =
    board?.regime === 'green' || board?.regime === 'amber' || board?.regime === 'red' ? board.regime : 'unknown'
  const verdict = await onDemandVerdict(sym, { candles }, { weights: (weights?.current ?? weights?.base ?? null) as Record<FactorName, number> | null, regime })
  await blobAppStore.write(cacheKey, { at: Date.now(), verdict })
  return verdict
}

/** ?view=funnel&date= — one day of "the engine said no", ranked by the
 * conviction each refusal stood on. Default = the newest trace day. */
async function viewFunnel(date: string | null) {
  const index = (await blobAppStore.read<string[]>(FUNNEL_TRACE_INDEX_KEY)) ?? []
  const day = date ?? index[index.length - 1] ?? null
  if (!day) return { date: null, missing: true, refusals: [], published: [], nearMisses: [] }
  const trace = await blobAppStore.read<FunnelTrace>(funnelTraceKey(day))
  if (!trace) return { date: day, missing: true, refusals: [], published: [], nearMisses: [] }
  const rows = Object.entries(trace.rows ?? {}).map(([key, r]) => ({ key, ...r }))
  return {
    date: day,
    gates: trace.gates,
    counts: trace.counts,
    emptySides: trace.emptySides,
    disabled: trace.disabled ?? false,
    // A published row is NOT a refusal (CX-1): "the engine said no" must never
    // list a call it made. Refusals rank by |core| — a strong short's signed
    // core is negative, and conviction is magnitude, not sign (CX-2).
    refusals: rows
      .filter(r => !PUBLISHED_GATES.has(r.gate))
      .sort((a, b) => (b.core == null ? Number.NEGATIVE_INFINITY : Math.abs(b.core)) - (a.core == null ? Number.NEGATIVE_INFINITY : Math.abs(a.core))),
    published: rows.filter(r => PUBLISHED_GATES.has(r.gate)),
    nearMisses: (trace.nearMisses ?? []).map(slimNearMiss),
  }
}

/** ?view=ledger&days=N — the Track record's food, same day shape as the
 * aggregate's `ledger` key so the client type is shared. Newest first. */
async function viewLedger(days: number) {
  const predIndex = (await blobAppStore.read<string[]>('predictions-index')) ?? []
  const dates = predIndex.slice(-days).reverse()
  const out = await Promise.all(
    dates.map(async date => {
      const preds = (await blobAppStore.read<Prediction[]>(`predictions:${date}`)) ?? []
      return { date, predictions: preds.map(ledgerRow) }
    }),
  )
  return { days: out }
}

export default async (req: Request) => {
  const auth = await authenticate(req.headers, { APP_TOKEN: process.env.APP_TOKEN }, blobAppStore)
  if (!auth) return new Response(JSON.stringify({ ok: false, error: 'unauthorised' }), { status: 401 })

  const url = new URL(req.url)
  const view = url.searchParams.get('view')
  if (view !== null) {
    if (view === 'board') return json(await viewBoard())
    if (view === 'journey') {
      const sym = (url.searchParams.get('sym') ?? '').toUpperCase()
      if (!SYM_RE.test(sym)) return json({ error: 'bad sym' }, 400)
      // ?days= widens the calls window up to the full retained index (CX-16) —
      // the StockPage's "load older calls" path. Default stays the 30-day read.
      const rawDays = url.searchParams.get('days')
      const parsedDays = rawDays === null || rawDays === '' ? 30 : Number(rawDays)
      const days = Math.min(250, Math.max(1, Number.isFinite(parsedDays) ? Math.floor(parsedDays) : 30))
      return json(await viewJourney(sym, days))
    }
    if (view === 'learning') return json(await viewLearning())
    if (view === 'verdict') {
      const sym = (url.searchParams.get('sym') ?? '').toUpperCase()
      if (!SYM_RE.test(sym)) return json({ error: 'bad sym' }, 400)
      return json(await viewVerdict(sym))
    }
    if (view === 'funnel') {
      const date = url.searchParams.get('date')
      if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'bad date' }, 400)
      return json(await viewFunnel(date))
    }
    if (view === 'ledger') {
      const raw = url.searchParams.get('days')
      const parsed = raw === null || raw === '' ? 7 : Number(raw)
      const days = Math.min(30, Math.max(1, Number.isFinite(parsed) ? Math.floor(parsed) : 7))
      return json(await viewLedger(days))
    }
    return json({ error: 'unknown view' }, 400)
  }

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

  const [paperBook, paperMonths, patternSightings, eventRadar, intradayFlagsBlob, missLedgerBlob, gateStateBlob] = await Promise.all([
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
    // nothing on the client has a use for them. Display-only HERE; the gate
    // feedback that reads the same blob lives in the grading pass (gateState.ts).
    blobAppStore.read(MISS_LEDGER_KEY),
    // …and what that ledger has since MOVED (shared/engine/gateState.ts): the
    // bounded summary of every gate notch and every gate held. Absent until a
    // gate has actually moved or been held, so the panel says nothing rather
    // than announcing that the gates are where they started.
    blobAppStore.read(GATE_STATE_KEY),
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
    intradayFlags: intradayFlagsBlob && intradayFlagsBlob.date === londonToday() ? intradayFlagsBlob : null,
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
    // the gates the ledger has moved, and the ones it has earned and not been
    // allowed to move yet — one line each, the SAME line the runlog and the
    // paper print (gateState.ts owns the sentence)
    gateState: gateStateSummary(gateStateBlob),
    weights: projectWeights(weights),
    // `referenceBase` travels with the buckets [spec §9]: it is the bar every grade
    // on the board was measured against, and a reader looking at "42% · B" cannot
    // check the letter without it. null when no seed ever swept one — the client
    // then says nothing about a bar rather than inventing the pooled base as one.
    calibration: projectCalibration(calibration),
    riskState,
    roster: projectRoster(roster, rosterLog),
    channelCred: projectChannelCred(channelCred),
  })
}
