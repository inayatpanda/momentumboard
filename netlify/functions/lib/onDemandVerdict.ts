// THE ON-DEMAND READ (PWA rebuild): "ask about any stock" answered by the
// ENGINE, not the LLM. Pure assembly over the exact functions buildBoard uses —
// technicalStage for the chart read, technicalFactor/momentumFactor/
// bandwidthFactor for the three price factors, coreCompositeOf for the
// composite — so this read can never
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
import { bandwidthFactor, momentumFactor, technicalFactor } from '../../../shared/engine/factors'
import { coreCompositeOf } from '../../../shared/engine/composite'
import { atr } from '../../../shared/indicators'
import { isCryptoSymbol } from '../../../shared/symbols'

export const ON_DEMAND_NOTE =
  'On-demand read — not one of today’s calls. The engine ran its price factors on this tape just now; context factors were not computed and no calibrated grade applies.'

/** THE CRYPTO CONTAINMENT'S SENTENCE (crypto-v2 wave, finding 1). Said in the
 * lane's own terms — its clock, its calibration, its missing benchmark — and
 * ending by naming the surface that DOES read the pair, so the answer is a
 * redirection rather than a shrug. */
export const CRYPTO_CONTAINED_NOTE =
  'The crypto lane reads this pair on its own clock — its own calibration, a 14-bar horizon and no benchmark at all. This desk runs the equity engine’s factors, so it would answer about a market it does not measure: ask the board, not the on-demand desk.'

/** EVERY FACTOR ON THIS DESK IS AN EQUITY FACTOR. `technicalStage` reads equity
 * session windows, `momentumFactor` measures relative strength against SPY, the
 * weights are the equity table and the regime is the board's SPY+QQQ read. Run
 * over a coin they produce a `lean` that no partition ever measured — and
 * VerdictHero prints a lean as the engine's answer.
 *
 * So a crypto pair is CONTAINED here, exactly as it is at every other decision
 * site (`isCryptoSymbol`, shared/symbols.ts — the one predicate, never a second
 * spelling of it). This is deliberately NOT a crypto on-demand pipeline: the
 * lane runs on completed bars on its own schedule, and a desk that recomputed it
 * ad hoc would be a second crypto engine with no calibration behind it.
 *
 * NOT `unavailable`. That word means "the engine could not price this name" and
 * is false here — the lane prices it every morning. `contained: true` is its own
 * state, and the note says which door to use. */
export function containedCryptoVerdict(sym: string): OnDemandVerdict {
  return {
    sym,
    onDemand: true,
    at: new Date().toISOString(),
    unavailable: undefined,
    contained: true,
    lean: 'none',
    core: null,
    stage: null,
    computed: [],
    nulls: [],
    lastClose: null,
    atr: null,
    note: CRYPTO_CONTAINED_NOTE,
  }
}

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
  /** The pair belongs to the crypto lane and this desk refused to read it — a
   * different state from `unavailable`, and never both (see
   * `containedCryptoVerdict`). Every numeric field is empty on such a verdict. */
  contained?: true
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
  // FIRST, and before a single fetch: a coin never reaches the equity factors.
  // The view layer contains it too (engine.mts) so the blob reads are skipped as
  // well; this guard is the one that cannot be bypassed by a new caller.
  if (isCryptoSymbol(sym)) return containedCryptoVerdict(sym)
  const at = new Date().toISOString()
  const [candles, spy] = await Promise.all([deps.candles(sym), deps.candles('SPY')])
  if (!candles || !candles.length) {
    return { sym, onDemand: true, at, unavailable: true, lean: 'none', core: null, stage: null, computed: [], nulls: [], lastClose: null, atr: null, note: ON_DEMAND_NOTE }
  }

  const read = technicalStage(sym, candles)
  const factors: Record<FactorName, FactorScore> = {
    technical: technicalFactor(read),
    momentum: momentumFactor(candles.map(c => c.c), spy ? spy.map(c => c.c) : null, candles),
    // the third price factor, computed here for the same reason as the other two:
    // this read must never fork from the board's arithmetic. It is null under 140
    // closes, which `nulls` below then names.
    bandwidth: bandwidthFactor(candles.map(c => c.c)),
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
    computed: (['technical', 'momentum', 'bandwidth'] as const).map(name => ({ name, ...factors[name] })),
    // EVERY closed eye is named, the attempted price factors included — a short
    // tape that nulls the chart read shows up here, not just in `computed`.
    nulls: (Object.keys(factors) as FactorName[]).filter(n => factors[n].score == null),
    lastClose: candles[candles.length - 1]?.c ?? null,
    atr: atrNow,
    note: ON_DEMAND_NOTE,
  }
}
