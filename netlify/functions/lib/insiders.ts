import { exchangeFor } from '../../../shared/symbols'

export interface InsiderSummary {
  symbol: string
  buyers: string[]
  totalBought: number // shares
  totalValueUsd: number // where price reported
  isCluster: boolean // ≥2 distinct insiders buying in the window, or > $250k
  latest: { name: string; shares: number; date: string }[]
}

interface FinnhubTx {
  name: string
  change: number
  transactionDate: string
  transactionCode: string
  transactionPrice: number
  isDerivative: boolean
}

/** Open-market insider BUYS (Form 4 code 'P') over the last ~90 days, per US symbol.
 * Clustered buying — several insiders purchasing — is one of the few signals
 * with real empirical support. Sales are ignored: they happen for many reasons. */
export async function fetchInsiderBuys(
  symbols: string[],
  finnhubKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<InsiderSummary[]> {
  const usSymbols = symbols.filter(s => exchangeFor(s) === 'US').slice(0, 15)
  const out: InsiderSummary[] = []
  await Promise.all(
    usSymbols.map(async symbol => {
      try {
        const res = await fetchFn(`https://finnhub.io/api/v1/stock/insider-transactions?symbol=${symbol}&token=${finnhubKey}`)
        if (!res.ok) return
        const j = (await res.json()) as { data?: FinnhubTx[] }
        const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10)
        const buys = (j.data ?? []).filter(t => !t.isDerivative && t.transactionCode === 'P' && t.change > 0 && t.transactionDate >= cutoff)
        if (!buys.length) return
        const buyers = [...new Set(buys.map(b => b.name))]
        const totalBought = buys.reduce((s, b) => s + b.change, 0)
        const totalValueUsd = buys.reduce((s, b) => s + b.change * (b.transactionPrice || 0), 0)
        out.push({
          symbol,
          buyers,
          totalBought,
          totalValueUsd,
          isCluster: buyers.length >= 2 || totalValueUsd > 250_000,
          latest: buys.slice(0, 5).map(b => ({ name: b.name, shares: b.change, date: b.transactionDate })),
        })
      } catch {
        /* one symbol failing must not kill the sweep */
      }
    }),
  )
  return out.sort((a, b) => Number(b.isCluster) - Number(a.isCluster) || b.totalValueUsd - a.totalValueUsd)
}
