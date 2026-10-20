import type { CSSProperties } from 'react'
import { directorySector, type DirectoryStock } from '../../lib/stockDirectory'

export function watchSector(symbol: string, directory: DirectoryStock[]) {
  if (['BTC-USD', 'ETH-USD', 'SOL-USD'].includes(symbol)) return 'Crypto'
  return directorySector(directory.find(r => r.sym === symbol)?.sector ?? null)
}

export function WatchlistSectors({ symbols, directory, selected, onSelect }: {
  symbols: string[]; directory: DirectoryStock[]; selected: string; onSelect: (sector: string) => void
}) {
  const counts = new Map<string, number>()
  for (const symbol of symbols) { const sector = watchSector(symbol, directory); counts.set(sector, (counts.get(sector) ?? 0) + 1) }
  const sectors = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (!symbols.length) return null
  return <section className="watch-sector-card" aria-label="Watchlist sector distribution">
    <div className="discovery-heading"><h2>Your sectors</h2><span className="cc-reason">{sectors.length} groups</span></div>
    <div className="watch-sector-bar" aria-hidden="true">{sectors.map(([sector, count], i) => <span key={sector} style={{ flex: count, '--sector-colour': `hsl(${205 + i * 21} 48% ${42 + i % 3 * 10}%)` } as CSSProperties} />)}</div>
    <div className="watch-sector-filters" role="group" aria-label="Filter watchlist by sector">
      <button aria-pressed={!selected} onClick={() => onSelect('')}>All <span>{symbols.length}</span></button>
      {sectors.map(([sector, count]) => <button key={sector} aria-pressed={selected === sector} onClick={() => onSelect(selected === sector ? '' : sector)}>{sector}<span>{count}</span></button>)}
    </div>
    <p className="social-evidence__note">By number of watched listings, not money invested. Unclassified listings appear in Other.</p>
  </section>
}
