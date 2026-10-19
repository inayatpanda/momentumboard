import type { StrategyObservation } from './strategyLab'

export interface RecoveryContext {
  sector?: { name: string; rs5: number | null; rs21: number | null; trend: 'in' | 'out' | 'flat' } | null
  worldTone: 'risk-on' | 'risk-off' | 'mixed' | null
  worldDetail?: string
  news?: { verdict: 'transient' | 'structural' | 'unclear'; reason: string; via?: 'llm' | 'heuristic' } | null
  catalyst?: { side: 'long' | 'short' | null; reason: string } | null
  earningsRisk: boolean
}

/** Context can stand a recovery hypothesis down. Correlated news, sector and
 * index moves never earn extra probability or promote an unverified business. */
export function withRecoveryContext(observation: StrategyObservation, context: RecoveryContext): StrategyObservation {
  const risks = [...observation.risks]
  const gaps = [...observation.dataGaps]
  let state = observation.state
  const sector = context.sector
  if (!sector) gaps.push('sector mapping or rotation data unavailable')
  if (!context.worldTone) gaps.push('international market context unavailable')
  const causeUnknown = !context.news || context.news.verdict === 'unclear'
  if (causeUnknown) gaps.push('the cause of the selloff is not independently established')
  if (context.news?.verdict === 'structural') {
    risks.unshift(`Possible broken business thesis in recent headlines: ${context.news.reason}; verify the original filing or announcement`)
    state = 'avoid'
  }
  if (context.catalyst?.side === 'short') risks.push(`Adverse news interpretation: ${context.catalyst.reason}`)
  if (context.earningsRisk) risks.unshift('earnings are inside the near-term calendar; wait for the report or reassess gap risk')
  if (sector?.trend === 'out') risks.push(`${sector.name} is losing relative momentum; the sector does not yet confirm recovery`)
  if (context.worldTone === 'risk-off') risks.push('international markets are risk-off; broad selling can overwhelm company quality')
  if (state === 'setup' && (causeUnknown || context.earningsRisk || context.catalyst?.side === 'short' || (sector?.trend === 'out' && context.worldTone === 'risk-off'))) state = 'watch'
  return {
    ...observation, state, risks: [...new Set(risks)], dataGaps: [...new Set(gaps)],
    metrics: {
      ...observation.metrics,
      sectorName: sector?.name ?? null,
      sectorRotation: sector?.trend ?? null,
      sectorRelative5Pct: sector?.rs5 ?? null,
      sectorRelative21Pct: sector?.rs21 ?? null,
      worldTone: context.worldTone,
      worldDetail: context.worldDetail ?? null,
      newsAssessment: context.news?.verdict ?? 'not checked',
      newsReason: context.news?.reason ?? null,
      newsMethod: context.news?.via ?? null,
      earningsRisk: context.earningsRisk,
    },
  }
}
