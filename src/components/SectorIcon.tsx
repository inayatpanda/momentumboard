/** Small, consistent line symbols; sector identity never relies on colour. */
export function SectorIcon({ sector, size = 22 }: { sector: string; size?: number }) {
  const paths: Record<string, string> = {
    Technology: 'M7 7h10v10H7zM9 3v4m6-4v4M9 17v4m6-4v4M3 9h4m-4 6h4m10-6h4m-4 6h4',
    Healthcare: 'M9 3h6v6h6v6h-6v6H9v-6H3V9h6z',
    Financials: 'M3 9l9-6 9 6H3zm3 3v6m6-6v6m6-6v6M3 21h18',
    Energy: 'M13 2L4 14h7l-1 8 10-13h-7l0-7z',
    Industrials: 'M3 21V9l6 3V6l6 4V3h6v18H3zm4-4h2m4 0h2m4 0h1',
    'Real Estate': 'M4 21V6h10v15M14 11h6v10M2 21h20M7 9h4m-4 4h4m-4 4h4m6-3h1m-1 4h1',
    'Consumer Discretionary': 'M3 4h2l3 12h10l3-9H6M9 20h.01M17 20h.01',
    'Consumer Staples': 'M4 9h16l-2 12H6L4 9zm4 0l4-6 4 6M9 12v5m6-5v5',
    'Communication Services': 'M4 3h16v14h-9l-5 4v-4H4V3zm4 5h8m-8 4h6',
    Utilities: 'M12 2v9m-6-7a9 9 0 1012 0',
    Materials: 'M12 3l9 5v9l-9 5-9-5V8l9-5zm0 10l9-5m-9 5L3 8m9 5v9',
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[sector] ?? 'M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z'} /></svg>
}
