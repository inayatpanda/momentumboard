// Names for assets outside the index directory. SOUN verified 26 Oct 2026:
// https://investors.soundhound.com/ (Nasdaq: SOUN).
// Additional identities: investors.rigetti.com/ir-resources/investor-faqs,
// investors.ionq.com/resources/investor-faqs, investors.sofi.com (26 Oct 2026).
const extraNames: Record<string, string> = { SOUN: 'SoundHound AI', RGTI: 'Rigetti Computing', IONQ: 'IonQ', SOFI: 'SoFi Technologies', XLF: 'Financial Select Sector SPDR Fund', SPY: 'SPDR S&P 500 ETF', QQQ: 'Invesco QQQ Trust', TLT: 'iShares 20+ Year Treasury Bond ETF', GLD: 'SPDR Gold Shares', SLV: 'iShares Silver Trust', USO: 'United States Oil Fund', 'BTC-USD': 'Bitcoin', 'ETH-USD': 'Ethereum', 'SOL-USD': 'Solana' }
export function stockName(symbol: string, supplied?: string | null): string | null {
  const name = supplied?.trim()
  return extraNames[symbol.toUpperCase()] ?? (name && name.toUpperCase() !== symbol.toUpperCase() ? name : null)
}
export function stockLabel(symbol: string, name?: string | null): string {
  const company = stockName(symbol, name)
  return company ? `${company} (${symbol})` : symbol
}
