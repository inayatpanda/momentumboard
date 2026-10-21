/** Versioned research heuristics, not regulatory capital tests or fair values.
 * Sector membership is recorded when a forecast is published, never backfilled. */
export const SECTOR_FINANCIAL_VERSION = 'sector-cash-valuation-v1'
export interface SectorFinancialPolicy {
  label: string
  maxNetDebtToCashFlow: number
  minCashFlowLiquidity: number
  maxAnnualPE: number
  minAnnualFcfYield: number
  specialist?: string
}
const policy = (label: string, debt: number, liquidity: number, pe: number, yieldPct: number): SectorFinancialPolicy =>
  ({ label, maxNetDebtToCashFlow: debt, minCashFlowLiquidity: liquidity, maxAnnualPE: pe, minAnnualFcfYield: yieldPct })
const POLICIES: Record<string, SectorFinancialPolicy> = {
  XLK: policy('Technology', 2, 1, 30, 3.5),
  XLC: policy('Communication services', 2.5, 1, 25, 4),
  XLY: policy('Consumer discretionary', 2.5, 1, 25, 4),
  XLP: policy('Consumer staples', 3, 1, 25, 4),
  XLI: policy('Industrials', 3, 1, 22, 4.5),
  XLE: policy('Energy', 2, 1.2, 15, 6),
  XLB: policy('Materials', 2, 1.2, 18, 5.5),
  XLV: policy('Health care', 2.5, 1.2, 25, 4),
  XLU: { ...policy('Utilities', 4, 1, 20, 4), specialist: 'Utilities need interest coverage and regulated capital-spending/funding review; negative free cash flow alone is not a failure.' },
  XLF: { ...policy('Financials', 0, 0, 0, 0), specialist: 'Financials need a business-type review: bank capital and credit losses, insurer solvency/reserves, or asset-manager flows. Industrial cash-flow ratios cannot establish safety.' },
  XLRE: { ...policy('Real estate', 0, 0, 0, 0), specialist: 'Real estate needs a business-type review: REIT FFO/AFFO, occupancy, refinancing and distributions where applicable. Accounting earnings alone cannot establish value.' },
}
export const sectorFinancialPolicy = (sector?: string | null): SectorFinancialPolicy | null => sector ? POLICIES[sector] ?? null : null

export interface ValuationCapitalization {
  sym: string
  marketCapUsdM: number
  currency: 'USD'
  observedAt: number
  source: 'finnhub-profile'
}
