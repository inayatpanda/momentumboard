import { SectorIcon } from '../../components/SectorIcon'
import { IconCheck, IconPlus } from '../../components/ControlIcon'
import { useEffect, useState } from 'react'
import { Link } from 'wouter'
import { directorySector, searchStocks, type StockDirectory, type DirectoryStock } from '../../lib/stockDirectory'
import { useSlice } from '../../lib/useSlice'
import { getQuotes } from '../../lib/api'
import { StockRow } from './StockRow'

function DiscoveryRows({ rows, watchSymbols, onAdd }: { rows: DirectoryStock[]; watchSymbols: Set<string>; onAdd: (sym: string) => void }) {
  const symbols = rows.map(r => r.sym)
  const { data } = useSlice(`quotes:${symbols.join(',')}`, () => getQuotes(symbols))
  return <div className="discovery-results">{rows.map(r => <div className="discovery-result" key={r.sym}>
    <StockRow symbol={r.sym} name={r.name} quote={data?.find(q => q?.symbol === r.sym)} sparkCachedOnly />
    <button type="button" className="discovery-add" disabled={watchSymbols.has(r.sym)} aria-label={`${watchSymbols.has(r.sym) ? 'Watching' : 'Add'} ${r.sym}${watchSymbols.has(r.sym) ? '' : ' to watchlist'}`} onClick={() => onAdd(r.sym)}>{watchSymbols.has(r.sym) ? <IconCheck /> : <IconPlus />}</button>
  </div>)}</div>
}

export function StockDiscovery({ directory, query, sector, onSector, watchSymbols, onAdd, error }: {
  directory: StockDirectory | null; query: string; sector: string; onSector: (sector: string) => void; watchSymbols: Set<string>; onAdd: (sym: string) => void; error: boolean
}) {
  const [market, setMarket] = useState('')
  const [limit, setLimit] = useState(12)
  useEffect(() => setLimit(12), [query, sector, market])
  if (!directory) return <p role="status">{error ? 'The company directory could not load. You can still open a ticker using Search.' : 'Loading companies and sectors…'}</p>
  const matches = searchStocks(directory.rows, query, sector, market)
  const counts = new Map<string, number>()
  directory.rows.filter(r => !market || r.exchange === market).forEach(r => { const s = directorySector(r.sector); counts.set(s, (counts.get(s) ?? 0) + 1) })
  const browsing = !!query.trim() || !!sector
  return <section className="stock-discovery" aria-label="Discover stocks">
    <div className="discovery-heading"><div><h2>{query.trim() ? 'Search results' : sector || 'Explore sectors'}</h2>
      <p>{browsing ? `${matches.length.toLocaleString()} matching listings` : 'Find companies by what they do.'}</p></div>
      <label className="discovery-market">Market<select aria-label="Market" value={market} onChange={e => setMarket(e.target.value)}><option value="">US & UK</option><option value="US">US</option><option value="LSE">UK</option></select></label>
    </div>
    {sector && <button className="discovery-back" onClick={() => onSector('')}>← All sectors</button>}
    {!browsing ? <div className="sector-directory">{[...counts].sort((a, b) => b[1] - a[1]).map(([name, count]) =>
      <button key={name} onClick={() => onSector(name)} className="sector-directory-card">
        <span className="sector-directory-icon" aria-hidden="true"><SectorIcon sector={name} /></span>
        <strong>{name}</strong><span>{count} listings <span aria-hidden="true">↗</span></span>
      </button>)}</div> : <>
      {matches.length ? Array.from({ length: Math.ceil(Math.min(matches.length, limit) / 12) }, (_, page) => { const rows = matches.slice(page * 12, page * 12 + 12); return <DiscoveryRows key={rows.map(r => r.sym).join(',')} rows={rows} watchSymbols={watchSymbols} onAdd={onAdd} /> }) : <p>No companies match these filters.</p>}
      {matches.length > limit && <button className="discovery-more" onClick={() => setLimit(n => n + 12)}>Show 12 more</button>}
    </>}
    <p className="discovery-note">US & UK index directory · {directory.generatedAt.slice(0, 10)}. Counts are listings, not your portfolio allocation. <Link href="/stocks/sectors">Compare sector performance →</Link></p>
  </section>
}
