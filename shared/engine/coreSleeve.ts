// The standing sleeve of famous, liquid names the engine looks at EVERY day —
// the fix for "GLW dropped 15% and the movers scanner never saw it". Names here
// are permanent candidates: no roster join gate, no largest-cap-first trim.
// Curation beats cleverness: T212-routable, household, liquid. Owner can extend
// via config.coreSleeve (union, never replace — the withDefaults pattern).
import { swingCapacity } from '../indicators'

export const DEFAULT_CORE_SLEEVE: string[] = [
  // US megacaps + household tech
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AVGO', 'AMD', 'INTC',
  'CRM', 'ORCL', 'ADBE', 'NFLX', 'QCOM', 'TXN', 'MU', 'AMAT', 'LRCX', 'KLAC',
  'NOW', 'UBER', 'ABNB', 'SHOP', 'SNOW', 'PANW', 'CRWD', 'ZS', 'DDOG', 'NET',
  // high-beta favourites / retail darlings
  'PLTR', 'COIN', 'MSTR', 'HOOD', 'SOFI', 'RBLX', 'DKNG', 'RIVN', 'LCID', 'SMCI',
  'ARM', 'DELL', 'IONQ', 'RGTI', 'AAOI', 'APP', 'CVNA', 'AFRM', 'UPST', 'RKLB',
  // US large-cap breadth: financials, health, industrials, energy, consumer
  'JPM', 'BAC', 'GS', 'MS', 'WFC', 'C', 'V', 'MA', 'AXP', 'BLK',
  'UNH', 'LLY', 'JNJ', 'PFE', 'MRK', 'ABBV', 'TMO', 'AMGN', 'GILD', 'CVS',
  'CAT', 'DE', 'BA', 'GE', 'HON', 'LMT', 'RTX', 'NOC', 'UPS', 'FDX',
  'XOM', 'CVX', 'COP', 'SLB', 'OXY', 'FCX', 'NEM', 'GLW', 'MMM', 'DOW',
  'WMT', 'COST', 'TGT', 'HD', 'LOW', 'MCD', 'SBUX', 'NKE', 'DIS', 'CMCSA',
  'PG', 'KO', 'PEP', 'PM', 'T', 'VZ', 'TMUS', 'CSCO', 'IBM', 'PYPL',
  // liquid UK large caps (T212-routable)
  'RR.L', 'BP.L', 'SHEL.L', 'AZN.L', 'GSK.L', 'HSBA.L', 'BARC.L', 'LLOY.L', 'VOD.L', 'BT-A.L',
  'GLEN.L', 'RIO.L', 'AAL.L', 'TSCO.L', 'MKS.L', 'IAG.L', 'RMV.L', 'BA.L', 'STAN.L', 'PRU.L',
]

export function sleeveWithDefaults(cfgSleeve: string[] | undefined | null): string[] {
  const out = [...DEFAULT_CORE_SLEEVE]
  const seen = new Set(out)
  for (const raw of cfgSleeve ?? []) {
    const sym = raw.toUpperCase()
    if (!seen.has(sym)) { seen.add(sym); out.push(sym) }
  }
  return out
}

export interface SleeveRank { sym: string; unusualness: number; typicalMovePct: number | null }

/** Rank sleeve names by how unusual today's move is vs the name's OWN typical
 * 10-session move. A calm megacap doing +4% outranks a biotech doing +4%. */
export function rankSleeve(closesBySym: Map<string, number[]>, topN: number): SleeveRank[] {
  const ranked: SleeveRank[] = []
  for (const [sym, closes] of closesBySym) {
    if (closes.length < 30) continue
    const last = closes[closes.length - 1]
    const prev = closes[closes.length - 2]
    if (!prev) continue
    const movePct = Math.abs((last / prev - 1) * 100)
    const typicalMovePct = swingCapacity(closes)
    ranked.push({ sym, unusualness: movePct / Math.max(typicalMovePct ?? 0.5, 0.5), typicalMovePct })
  }
  return ranked.sort((a, b) => b.unusualness - a.unusualness).slice(0, topN)
}
