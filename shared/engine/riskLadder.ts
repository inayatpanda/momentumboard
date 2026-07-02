// Risk-taking earns its way up and steps down fast: the rung is computed from
// the rolling scorecard, never from a feeling. Every change carries evidence.

export interface RiskState {
  rung: 0 | 1 | 2 | 3
  sinceDate: string
  gradedAtRung: number
  history: { date: string; from: number; to: number; evidence: string }[]
}

export const RUNG_RISK_PCT = [1.0, 1.25, 1.5, 2.0] as const

export interface OutcomeLite {
  hit: boolean
  stopped: boolean
  leveraged: boolean
}

export function initRisk(today: string): RiskState {
  return { rung: 0, sinceDate: today, gradedAtRung: 0, history: [] }
}

const PROMOTE_MIN_GRADED = 25
const PROMOTE_HIT_RATE = 0.55
const DEMOTE_HIT_RATE = 0.45
const DEMOTE_WINDOW = 20

const hitRate = (xs: OutcomeLite[]) => (xs.length ? xs.filter(o => o.hit).length / xs.length : 0)

/** recentOutcomes: chronological graded history (last ≤60, incl. this run's);
 * newCount: how many of those were graded in this run. */
export function computeRung(
  state: RiskState,
  recentOutcomes: OutcomeLite[],
  newCount: number,
  brierImproving: boolean,
  override: number | null,
  today: string,
): RiskState {
  const change = (to: number, evidence: string): RiskState => {
    const rung = Math.max(0, Math.min(3, to)) as RiskState['rung']
    if (rung === state.rung) return { ...state, gradedAtRung: state.gradedAtRung + newCount }
    const history = [...state.history, { date: today, from: state.rung, to: rung, evidence }].slice(-50)
    return { rung, sinceDate: today, gradedAtRung: 0, history }
  }

  if (override != null && override >= 0 && override <= 3) return change(override, 'manual override')

  const gradedAtRung = state.gradedAtRung + newCount

  const last20 = recentOutcomes.slice(-DEMOTE_WINDOW)
  if (last20.length >= DEMOTE_WINDOW && hitRate(last20) < DEMOTE_HIT_RATE) {
    return change(state.rung - 1, `cold: hit rate ${Math.round(hitRate(last20) * 100)}% over last ${DEMOTE_WINDOW}`)
  }
  const lev = recentOutcomes.filter(o => o.leveraged).slice(-3)
  if (lev.length === 3 && lev.every(o => o.stopped)) {
    return change(state.rung - 1, '3 consecutive leveraged calls stopped out')
  }

  const last25 = recentOutcomes.slice(-PROMOTE_MIN_GRADED)
  if (
    state.rung < 3 &&
    gradedAtRung >= PROMOTE_MIN_GRADED &&
    last25.length >= PROMOTE_MIN_GRADED &&
    hitRate(last25) >= PROMOTE_HIT_RATE &&
    brierImproving
  ) {
    return change(state.rung + 1, `earned: ${gradedAtRung} graded at R${state.rung}, hit rate ${Math.round(hitRate(last25) * 100)}%, calibration improving`)
  }

  return { ...state, gradedAtRung }
}

export type LevMap = Record<string, { long2x?: string; long3x?: string; short2x?: string; short3x?: string }>

export function leverageAllowed(rung: number, grade: 'A' | 'B' | 'C'): 0 | 2 | 3 {
  if (rung >= 3 && grade === 'A') return 3
  if (rung >= 2 && (grade === 'A' || grade === 'B')) return 2
  if (rung >= 1 && grade === 'A') return 2
  return 0
}

export function mapInstrument(
  side: 'long' | 'short',
  sym: string,
  grade: 'A' | 'B' | 'C',
  rung: number,
  levMap: LevMap,
): { ticker: string; leverage: number } | null {
  const max = leverageAllowed(rung, grade)
  if (!max) return null
  const m = levMap[sym]
  if (!m) return null
  if (max === 3) {
    const t3 = side === 'long' ? m.long3x : m.short3x
    if (t3) return { ticker: t3, leverage: 3 }
  }
  const t2 = side === 'long' ? m.long2x : m.short2x
  return t2 ? { ticker: t2, leverage: 2 } : null
}
