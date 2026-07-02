export type Exchange = 'US' | 'LSE' | 'CRYPTO'

/** AAPL → US; 3LTS.L → LSE; BTC-USD → CRYPTO (Yahoo crypto symbols use a dash). */
export function exchangeFor(symbol: string): Exchange {
  if (symbol.includes('-')) return 'CRYPTO'
  if (symbol.includes('.')) return 'LSE'
  return 'US'
}

/** Everything except plain US equities is served by Yahoo. */
export const isYahooSymbol = (symbol: string) => exchangeFor(symbol) !== 'US'
