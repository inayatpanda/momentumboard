// Free published-forecast audit. No model API, messages or brokerage access.
import { configureStoreForScript } from '../lib/configureStore'
import { appStore, acquireLease, releaseLease } from '../../netlify/functions/lib/storeProvider'
import { cachedCandles } from '../../netlify/functions/lib/marketCache'
import { publishedAuditRecord } from '../../shared/engine/publishedMarketAudit'
import { buildMarketComparison } from '../../shared/engine/marketComparison'
import type { Prediction } from '../../shared/engine/types'
import type { EngineLabSnapshot, StrategyLabRecord } from '../../shared/engine/strategyLab'

await configureStoreForScript()
const now = Math.floor(Date.now() / 1000), key = 'lease:predict-background'
const lease = await acquireLease(appStore, key, now, 15 * 60)
if (!lease) throw new Error('Another engine run is active; retry after it completes.')
try {
  const index = ((await appStore.read<string[]>('predictions-index')) ?? []).sort().slice(-90)
  const previous = await appStore.read<{ records: StrategyLabRecord[] }>('engine-published-market-audit')
  const records = new Map((previous?.records ?? []).map(r => [r.id, r]))
  let inspected = 0, eligible = 0
  for (const date of index) {
    for (const p of (await appStore.read<Prediction[]>(`predictions:${date}`)) ?? []) {
      inspected++
      const r = publishedAuditRecord(p, null, now)
      if (!r) continue
      eligible++
      if (!records.has(r.id)) records.set(r.id, r)
    }
  }
  const spy = await cachedCandles('SPY')
  if (!spy?.length) throw new Error('SPY prices unavailable; preserving the previous market test.')
  // At most 60 free chart lookups. Reuse one tape across all calls for a symbol,
  // rotate unavailable feeds and retain prior outcomes verbatim.
  const unresolved = [...records.values()].filter(r => !r.outcome).sort((a, b) => (a.lastGradeAttemptAt ?? 0) - (b.lastGradeAttemptAt ?? 0) || a.availableAt - b.availableAt)
  const symbols = [...new Set(unresolved.map(r => r.sym))].slice(0, 60)
  for (const sym of symbols) {
    const tape = await cachedCandles(sym)
    for (const r of unresolved.filter(row => row.sym === sym)) {
      r.lastGradeAttemptAt = now
      // Reconstruct only the audit input, entirely from frozen original fields.
      const p = { id: r.id.replace(/^board-audit:/, ''), sym: r.sym, side: r.side, riskPct: 1,
        availableAt: r.availableAt, detectedAt: r.detectedAt, entry: r.entry, stop: r.stop, target: r.target,
        forecast: r.forecast } as unknown as Prediction
      const graded = publishedAuditRecord(p, tape, now, spy)
      if (graded?.outcome) r.outcome = graded.outcome
    }
  }
  const saved = [...records.values()].sort((a, b) => b.availableAt - a.availableAt).slice(0, 500)
  const coverage = { inspectedPublications: inspected, eligibleOriginalSizedCalls: eligible, publicationDates: index.length, retainedAuditRecords: saved.length }
  await appStore.write('engine-published-market-audit', { generatedAt: now, coverage, records: saved })
  const research = (await appStore.read<StrategyLabRecord[]>('engine-lab-ledger')) ?? []
  const comparison = buildMarketComparison([...research, ...saved], spy, now)
  comparison.auditCoverage = coverage
  const lab = await appStore.read<EngineLabSnapshot>('engine-lab')
  if (lab?.learning) {
    lab.learning.marketComparison = comparison
    await appStore.write('engine-research-learning', lab.learning)
    await appStore.write('engine-lab', lab)
  }
  await appStore.write('engine-market-comparison', comparison)
  console.log(JSON.stringify({ coverage, cohorts: comparison.cohorts, excludedUnverifiableN: comparison.excludedUnverifiableN }))
} finally { await releaseLease(appStore, key, lease) }
