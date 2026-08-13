export type Exchange = 'US' | 'LSE' | 'CRYPTO'

/** AAPL → US; 3LTS.L → LSE; BTC-USD → CRYPTO. The SUFFIX is read before the
 * dash: `BT-A.L` carries a share-class dash AND a venue suffix, and the venue
 * wins — the old dash-first rule classified BT Group as a coin, handing it 24/7
 * market hours and the crypto news path (Stage-3a Task 3). A dash makes a
 * crypto pair only when what FOLLOWS it is a quote currency; `BRK-B` is a share
 * class, not a coin. */
const QUOTE_CURRENCY = /-(USD|USDT|GBP|EUR|BTC)$/
export function exchangeFor(symbol: string): Exchange {
  if (symbol.includes('.')) return 'LSE'
  if (QUOTE_CURRENCY.test(symbol)) return 'CRYPTO'
  return 'US'
}

/** Everything except plain US equities is served by Yahoo — and so are dashed
 * US share classes (BRK-B): the dash IS Yahoo's spelling, whatever the venue.
 * Routing deliberately did not move when the classification fix landed. */
export const isYahooSymbol = (symbol: string) => exchangeFor(symbol) !== 'US' || symbol.includes('-')
