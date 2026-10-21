import type { StrategyObservation } from './strategyLab'

/** Explanations of the existing gates, never an additional probability model. */
export function recoveryChecklist(row: StrategyObservation) {
  const m = row.metrics
  return [
    { label:'Business health', passed:m.financialHealth === 'healthy', detail:m.financialHealth === 'healthy' ? 'Reported profit, cash flow and balance-sheet checks passed' : m.financialHealth === 'deteriorating' ? 'Reported deterioration needs reassessment' : 'Financial evidence needs review' },
    { label:'Valuation', passed:m.valuationStatus === 'supported', detail:String(m.valuationSummary ?? 'Dated valuation evidence is not available') },
    { label:'Report trend', passed:['improving','stable'].includes(String(m.reportTrend)), detail:`${String(m.reportTrend ?? 'Not established')} across ${m.reportObservations ?? 0} comparable reports` },
    { label:'Chart confirmation', passed:m.stabilising === true, detail:m.stabilising === true ? 'Higher low and average reclaimed' : `Wait for a higher low and a close above ${typeof m.sma10 === 'number' ? m.sma10.toFixed(2) : 'the 10-session average'}` },
    { label:'Selloff cause', passed:m.newsAssessment === 'transient', detail:m.newsAssessment === 'transient' ? 'Headlines suggest a temporary setback; verify the source' : m.newsAssessment === 'structural' ? 'Possible lasting damage to the business' : 'A company-specific cause is not established' },
    { label:'Risk and events', passed:typeof m.scenarioRewardRisk === 'number' && m.scenarioRewardRisk >= 1.5 && typeof m.stopDistancePct === 'number' && m.stopDistancePct > 0 && m.stopDistancePct <= 18 && !m.earningsRisk,
      detail:m.earningsRisk ? 'Upcoming earnings need reassessment' : `${typeof m.scenarioRewardRisk === 'number' ? m.scenarioRewardRisk.toFixed(1) : '—'}× scenario reward/risk · ${typeof m.stopDistancePct === 'number' ? m.stopDistancePct.toFixed(1) : '—'}% to invalidation` },
  ]
}
