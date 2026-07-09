export function fmtPrice(price: number, currency: string): string {
  if (currency === 'GBp') return `${price.toFixed(1)}p`
  const sym = currency === 'GBP' ? '£' : currency === 'USD' ? '$' : `${currency} `
  const num = price >= 1000 ? price.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : price.toFixed(2)
  return `${sym}${num}`
}

export function fmtPct(p: number): string {
  const sign = p >= 0 ? '+' : '−'
  return `${sign}${Math.abs(p).toFixed(2)}%`
}

/** Market-cap band from $M — identification chip for engine calls. */
export function capBand(capUsdM: number | null | undefined): string | null {
  if (capUsdM == null) return null
  if (capUsdM < 300) return 'micro cap'
  if (capUsdM < 2000) return 'small cap'
  if (capUsdM < 10_000) return 'mid cap'
  return 'large cap'
}

/** Large- vs small-cap cohort from $M — matches the engine's `smallCap` flag. */
export function capCohort(capUsdM: number | null | undefined): 'Large-cap' | 'Small-cap' | 'Unknown' {
  if (capUsdM == null) return 'Unknown'
  if (capUsdM < 2000) return 'Small-cap'
  return 'Large-cap'
}

/** Raw fetch/parse exceptions must never reach the screen — "SyntaxError:
 * Unexpected token '<'" is developer console text, not product copy. */
export function humanError(raw: unknown): string {
  const s = String((raw as Error)?.message ?? raw ?? '')
  if (/unexpected token|not valid json|<!doctype|json\.parse/i.test(s)) return 'live data unavailable right now'
  if (/failed to fetch|networkerror|load failed|network request/i.test(s)) return 'no connection — will retry'
  if (/http-401|http-403|unauthori[sz]ed/i.test(s)) return 'licence check failed — re-enter your key in Settings'
  if (/http-429/.test(s)) return 'rate-limited upstream — back shortly'
  if (/http-5\d\d|502|503/.test(s)) return 'server hiccup — retrying shortly'
  return s.length > 90 ? `${s.slice(0, 90)}…` : s || 'something went wrong'
}
