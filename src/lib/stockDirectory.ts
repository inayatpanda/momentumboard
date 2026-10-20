import { useEffect, useState } from 'react'

export interface DirectoryStock { sym: string; name: string; exchange: string; sector: string | null }
export interface StockDirectory { generatedAt: string; rows: DirectoryStock[] }

const aliases: Record<string, string[]> = {
  Technology: ['Information Technology', 'Technology', 'Software & Computer Services', 'Software and Computer Services'],
  Healthcare: ['Health Care', 'Health Care Equipment & Services', 'Health care equipment & supplies', 'Pharmaceuticals & Biotechnology', 'Pharmaceuticals and Biotechnology'],
  Financials: ['Financials', 'Financial Services', 'Banking', 'Banking Services', 'Banks', 'General Financial', 'Insurance', 'Life Insurance', 'Non-life Insurance', 'Nonlife Insurance', 'Investment Banking and Brokerage Services'],
  'Funds & trusts': ['Investment Trusts', 'Collective Investments', 'Equity Investments', 'Hedge Funds'],
  'Consumer discretionary': ['Consumer Discretionary', 'General retailers', 'Retail', 'Retailers', 'Retail hospitality', 'Personal Goods', 'Personal Products', 'Travel & Leisure', 'Leisure Goods', 'Home Construction', 'Homebuilding & construction supplies', 'Household goods & home construction'],
  'Consumer staples': ['Consumer Staples', 'Beverages', 'Food & Drug Retailers', 'Food & drug retailing', 'Food & tobacco', 'Food Producers', 'Food and drink', 'Food, Beverage and Tobacco', 'Tobacco'],
  Industrials: ['Industrials', 'Aerospace & Defence', 'Construction', 'Engineering and Construction', 'Electronic & Electrical Equipment', 'Electronic equipment & parts', 'General Industrials', 'Industrial Engineering', 'Industrial Goods and Services', 'Industrial Support Services', 'Industrial Transportation', 'Support Services'],
  Materials: ['Materials', 'Basic Resources', 'Chemicals', 'Construction & Materials', 'Containers & packaging', 'Industrial Metals and Mining', 'Mining', 'Precious Metals and Mining'],
  Energy: ['Energy', 'Alternative Energy', 'Oil & Gas Producers', 'Oil, Gas and Coal'],
  Utilities: ['Utilities', 'Electricity', 'Electrical utilities & independent power producers', 'Gas, Water & Multiutilities', 'Multiline utilities'],
  'Real estate': ['Real Estate', 'Real Estate Investment & Services', 'Real Estate Investment Trusts'],
  Communications: ['Communication Services', 'Consumer Digital Services', 'Media', 'Mobile telecommunications', 'Telecomms', 'Telecommunications', 'Telecommunications services'],
}
const sectorLookup = new Map(Object.entries(aliases).flatMap(([name, values]) => values.map(v => [v.toLowerCase(), name] as const)))
export const directorySector = (sector: string | null) => sectorLookup.get(sector?.toLowerCase() ?? '') ?? 'Other'

let loading: Promise<StockDirectory> | undefined
export const loadStockDirectory = () => loading ??= import('../../shared/engine/discovery/universe.seed.json').then(m => m.default)
export function useStockDirectory() {
  const [data, setData] = useState<StockDirectory | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => { let alive = true; loadStockDirectory().then(d => { if (alive) setData(d) }).catch(() => { loading = undefined; if (alive) setError(true) }); return () => { alive = false } }, [])
  return { data, error }
}
export function searchStocks(rows: DirectoryStock[], query: string, sector = '', market = '') {
  const q = query.trim().toLowerCase()
  const company = (name: string) => name.toLowerCase().replace(/[.,]/g, '').replace(/\s+(inc|incorporated|corp|corporation|plc|ltd|limited)$/, '')
  return rows.filter(r => (!market || r.exchange === market) && (!sector || directorySector(r.sector) === sector)
    && (!q || r.sym.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)))
    .sort((a, b) => Number(b.sym.toLowerCase() === q) - Number(a.sym.toLowerCase() === q)
      || Number(company(b.name) === q) - Number(company(a.name) === q)
      || Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
}
