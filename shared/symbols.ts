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

/** THE CONTAINMENT PREDICATE (Stage 1c Phase A) — the ONE test every engine
 * mechanism asks before it lets a name into a decision.
 *
 * Crypto trades a seven-day week. The engine's grade is a ten-SESSION excess
 * against SPY, its regime is read off SPY+QQQ, its risk rung and factor IC pool
 * one global stream, and its calibration buckets are an equity population — so a
 * crypto row scored by any of them is measured against a market it does not trade
 * in. Until the crypto cohort exists (Stage 1c Phase B: own calibration, own
 * clock, own regime, own reference) the honest answer is to REFUSE the name as a
 * candidate, and say so in the funnel trace under its own gate code
 * (`crypto-contained`, types.ts) so the record shows a decision rather than a
 * silence. Precedent: hypeCluster.ts, which has excluded crypto from cluster
 * detection for exactly this reason since Stage 1b.
 *
 * IT GUARDS DECISIONS, NEVER DISPLAY. Quotes, charts, watchlists, the reader's own
 * price/RVOL alert rules and the starter list's BTC-USD/ETH-USD are all untouched:
 * watching a coin costs the engine nothing and teaches it nothing.
 *
 * NOT plain `exchangeFor(sym) === 'CRYPTO'` — belt over braces. The suffix already
 * outranks the dash since Stage-3a Task 3 (`BT-A.L` is BT Group, not a coin), and
 * the no-dot guard keeps that true even if the classifier's ordering ever moves
 * again: a symbol carrying an exchange suffix is listed on that exchange, whatever
 * else is in the string. Upper-cased on the way in because containment must not be
 * defeated by a spelling — a lower-case `btc-usd` from a stored blob is the same
 * refusal. (`scripts/replay-window.ts` re-exports this; there is one predicate.) */
export const isCryptoSymbol = (symbol: string): boolean => {
  const s = symbol.toUpperCase()
  return !s.includes('.') && exchangeFor(s) === 'CRYPTO'
}

/** Everything except plain US equities is served by Yahoo — and so are dashed
 * US share classes (BRK-B): the dash IS Yahoo's spelling, whatever the venue.
 * Routing deliberately did not move when the classification fix landed. */
export const isYahooSymbol = (symbol: string) => exchangeFor(symbol) !== 'US' || symbol.includes('-')
