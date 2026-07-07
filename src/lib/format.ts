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
