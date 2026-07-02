export interface SizeInput {
  capital: number
  riskPct: number
  entry: number
  stop: number
  riskClass: 'normal' | 'speculative'
}

export interface SizeResult {
  riskAmount: number
  perUnitRisk: number
  units: number
  positionValue: number
  positionPctOfCapital: number
  warnings: string[]
}

const POSITION_CAP_PCT = 20

export function positionSize(i: SizeInput): SizeResult | null {
  if (i.entry <= 0 || i.stop <= 0 || i.stop === i.entry || i.capital <= 0) return null
  const warnings: string[] = []
  const effectiveRiskPct = i.riskClass === 'speculative' ? i.riskPct / 2 : i.riskPct
  const riskAmount = (i.capital * effectiveRiskPct) / 100
  const perUnitRisk = Math.abs(i.entry - i.stop)

  if (i.stop > i.entry) warnings.push('Stop is above entry — this sizes a short/inverse position, not a long.')
  if (perUnitRisk < i.entry * 0.001) warnings.push('Stop is very tight (<0.1% away) — normal noise will hit it.')

  let units = Math.floor(riskAmount / perUnitRisk)
  let positionValue = units * i.entry
  const cap = (i.capital * POSITION_CAP_PCT) / 100
  if (positionValue > cap) {
    units = Math.floor(cap / i.entry)
    positionValue = units * i.entry
    warnings.push(`Natural size exceeds the ${POSITION_CAP_PCT}% position cap — units capped; actual risk to stop is now below ${effectiveRiskPct}%.`)
  }

  return {
    riskAmount,
    perUnitRisk,
    units,
    positionValue,
    positionPctOfCapital: Math.round((positionValue / i.capital) * 1000) / 10,
    warnings,
  }
}
