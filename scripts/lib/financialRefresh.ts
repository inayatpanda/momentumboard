import type { BusinessHealthSnapshot } from '../../shared/businessHealth'
export function financialRefreshSymbols(watchlist: {symbol: string}[], sample: string[]): string[] {
  return [...new Set([...watchlist.map(w=>w.symbol.toUpperCase()), ...sample])]
    .filter(sym=>/^[A-Z][A-Z0-9.-]{0,14}$/.test(sym) && !sym.endsWith('.L') && !sym.endsWith('-USD')).slice(0,100)
}
export async function publishFinancialReports(symbols: string[], fetchReport: (sym:string)=>Promise<BusinessHealthSnapshot>,
  save: (sym:string,report:BusinessHealthSnapshot)=>Promise<void>, pause: ()=>Promise<void>) {
  let published=0,unavailable=0
  const gaps: Record<string,number> = {}
  for (const sym of symbols) {
    const report=await fetchReport(sym)
    // Never overwrite a good saved report with an outage or missing evidence.
    if (report.sym===sym && report.status!=='unavailable' && report.quarterly?.quarters.length) {await save(sym,report);published++}
    else { unavailable++; const reason=report.sym!==sym?'Symbol mismatch':report.gaps[0]??'Quarterly evidence unavailable'; gaps[reason]=(gaps[reason]??0)+1 }
    await pause()
  }
  return {checked:symbols.length,published,unavailable,provider:'SEC company facts',paidCalls:0,gaps}
}
