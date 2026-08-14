// THE ON-DEMAND READ (PWA rebuild): "ask about any stock" answered by the
// ENGINE, not the LLM. Pure assembly over the exact functions buildBoard uses —
// technicalStage for the chart read, technicalFactor/momentumFactor for the two
// price factors, coreCompositeOf for the composite — so this read can never
// fork from the board's arithmetic. Factors that need universe or social
// context (sector ranks, news batches, channel calls…) are NOT recomputed here:
// they return null and are NAMED in `nulls`, because a partial read that says
// which eyes were closed is honest and one that quietly guesses is not.
//
// This is NEVER a call: no grade, no probability, no entry/stop/target. It is
// a lean plus the evidence, capped with a note that says exactly that. It is
// never written into predictions:* and never feeds calibration (DS-24 pins the
// 15-minute cache at the VIEW layer, not here — this function stays pure).

import type { Candle } from '../../../shared/types'
import type { FactorName, FactorScore } from '../../../shared/engine/types'
import type { RegimeColor } from '../../../shared/types'
import { technicalStage } from '../../../shared/technicals'
import { momentumFactor, technicalFactor } from '../../../shared/engine/factors'
import { coreCompositeOf } from '../../../shared/engine/composite'
import { atr } from '../../../shared/indicators'

export const ON_DEMAND_NOTE =
  'On-demand read — not one of today’s calls. The engine ran its price factors on this tape just now; context factors were not computed and no calibrated grade applies.'

export interface VerdictDeps {
  /** Daily candles for a symbol — 'SPY' is asked for too (momentum's benchmark). */
  candles(sym: string): Promise<Candle[] | null>
}

export interface VerdictContext {
  /** The live factor weights (engine-weights.current). Null when the table is
   * missing — the core then reads null rather than being invented. */
  weights: Record<FactorName, number> | null
  regime: RegimeColor | 'unknown'
}

export interface OnDemandVerdict {
  sym: string
  onDemand: true
  at: string
  unavailable?: true
  lean: 'long' | 'short' | 'none'
  core: number | null
  stage: string | null
  computed: { name: FactorName; score: number | null; detail: string }[]
  nulls: FactorName[]
  lastClose: number | null
  atr: number | null
  note: string
}

const NOT_ON_DEMAND: FactorScore = { score: null, detail: 'not computed on demand' }

export async function onDemandVerdict(sym: string, deps: VerdictDeps, ctx: VerdictContext): Promise<OnDemandVerdict> {
  const at = new Date().toISOString()
  const [candles, spy] = await Promise.all([deps.candles(sym), deps.candles('SPY')])
  if (!candles || !candles.length) {
    return { sym, onDemand: true, at, unavailable: true, lean: 'none', core: null, stage: null, computed: [], nulls: [], lastClose: null, atr: null, note: ON_DEMAND_NOTE }
  }

  const read = technicalStage(sym, candles)
  const factors: Record<FactorName, FactorScore> = {
    technical: technicalFactor(read),
    momentum: momentumFactor(candles.map(c => c.c), spy ? spy.map(c => c.c) : null),
    sector: NOT_ON_DEMAND,
    seasonality: NOT_ON_DEMAND,
    social: NOT_ON_DEMAND,
    channels: NOT_ON_DEMAND,
    insiders: NOT_ON_DEMAND,
    news: NOT_ON_DEMAND,
    smartMoney: NOT_ON_DEMAND,
    catalyst: NOT_ON_DEMAND,
  }

  const core = ctx.weights ? coreCompositeOf(factors, ctx.weights, ctx.regime) : null
  const atrSeries = atr(candles)
  const atrNow = atrSeries.length ? (atrSeries[atrSeries.length - 1] ?? null) : null

  return {
    sym,
    onDemand: true,
    at,
    lean: core == null || core === 0 ? 'none' : core > 0 ? 'long' : 'short',
    core,
    stage: read?.stage ?? null,
    computed: (['technical', 'momentum'] as const).map(name => ({ name, ...factors[name] })),
    // EVERY closed eye is named, the attempted price factors included — a short
    // tape that nulls the chart read shows up here, not just in `computed`.
    nulls: (Object.keys(factors) as FactorName[]).filter(n => factors[n].score == null),
    lastClose: candles[candles.length - 1]?.c ?? null,
    atr: atrNow,
    note: ON_DEMAND_NOTE,
  }
}
