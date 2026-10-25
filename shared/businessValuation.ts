import type { BusinessHealthSnapshot } from './businessHealth'
import { sectorFinancialPolicy, type ValuationCapitalization } from './sectorFinancials'

/** Annual reported multiples, not forward estimates or intrinsic value.
 * Untimed screener market caps deliberately cannot enter this calculation. */
export function assessBusinessValuation(snapshot: BusinessHealthSnapshot | null | undefined, cap: ValuationCapitalization | null | undefined, sector: string | null | undefined, nowSec: number) {
  const diagnostics = { missing: [] as string[], failed: [] as string[] }
  const result: { status: 'supported' | 'demanding' | 'unknown'; pe: number | null; fcfYieldPct: number | null; priceToBook: number | null; summary: string; gaps: string[]; diagnostics?: typeof diagnostics } =
    { status: 'unknown', pe: null, fcfYieldPct: null, priceToBook: null, summary: 'Valuation evidence unavailable.', gaps: [], diagnostics }
  const missing = (text:string) => { result.gaps.push(text); diagnostics.missing.push(text) }
  const policy = sectorFinancialPolicy(sector)
  if (!snapshot || !cap || snapshot.sym.toUpperCase() !== cap.sym.toUpperCase() || cap.currency !== 'USD' || snapshot.currency !== 'USD' ||
      !Number.isFinite(cap.marketCapUsdM) || cap.marketCapUsdM <= 0 || !Number.isFinite(cap.observedAt) || cap.observedAt > nowSec || nowSec - cap.observedAt > 86_400) {
    missing('Valuation needs a matching USD market capitalization observed within 24 hours and dated USD filings.')
    return result
  }
  const value = (key: 'netIncome' | 'freeCashFlow' | 'totalEquity', maxAge: number) => {
    const e = snapshot.evidence[key], n = snapshot.metrics[key]
    const age = e ? (nowSec - Date.parse(`${e.periodEnd}T00:00:00Z`) / 1000) / 86_400 : Infinity
    return e && e.availableAt <= nowSec && e.unit === 'USD' && age >= 0 && age <= maxAge && n != null && Number.isFinite(n) && n > 0 ? n : null
  }
  const marketCap = cap.marketCapUsdM * 1e6
  const income = value('netIncome', 550), fcf = value('freeCashFlow', 550), equity = value('totalEquity', 180)
  result.pe = income ? marketCap / income : null
  result.fcfYieldPct = fcf ? fcf / marketCap * 100 : null
  result.priceToBook = equity ? marketCap / equity : null
  if (!policy || policy.specialist) missing(policy?.specialist ?? 'Sector classification is not established for the valuation screen.')
  else if (result.pe == null || result.fcfYieldPct == null || snapshot.evidence.netIncome?.periodEnd !== snapshot.evidence.freeCashFlow?.periodEnd) {
    result.gaps.push('Positive, comparable annual earnings and free cash flow are required; negative or missing values are not cheap multiples.')
    for(const key of ['netIncome','freeCashFlow'] as const){
      const e=snapshot.evidence[key],n=snapshot.metrics[key]
      const age=e?(nowSec-Date.parse(`${e.periodEnd}T00:00:00Z`)/1000)/86400:Infinity
      const known=!!e&&e.availableAt<=nowSec&&e.unit==='USD'&&age>=0&&age<=550&&n!=null&&Number.isFinite(n)
      if(!known)diagnostics.missing.push(`${key==='netIncome'?'Annual profit':'Annual free cash flow'}: a dated comparable value is unavailable for valuation.`)
      else if(n!<=0)diagnostics.failed.push(`${key==='netIncome'?'Annual profit':'Annual free cash flow'} must be positive for this valuation rule.`)
    }
    if(snapshot.evidence.netIncome?.periodEnd!==snapshot.evidence.freeCashFlow?.periodEnd)diagnostics.missing.push('Annual profit and free cash flow cover different reporting periods.')
  }
  else {
    result.status = result.pe <= policy.maxAnnualPE && result.fcfYieldPct >= policy.minAnnualFcfYield ? 'supported' : 'demanding'
    result.summary = `${policy.label}: annual P/E ${result.pe.toFixed(1)}× (ceiling ${policy.maxAnnualPE}×); annual free-cash-flow yield ${result.fcfYieldPct.toFixed(1)}% (floor ${policy.minAnnualFcfYield}%).`
    if(result.status==='demanding')diagnostics.failed.push(result.summary)
  }
  return result
}
