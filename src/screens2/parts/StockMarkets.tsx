import { useEffect, useRef, useState } from 'react'
import { Link } from 'wouter'
import { useSlice } from '../../lib/useSlice'
import { useFlip } from '../../lib/useFlip'
import { getMovers, getSectors, type MoverRow } from '../../lib/api'
import { fmtPct } from '../../lib/format'
import { Sparkline } from '../../components/Sparkline'
import { useCachedSparkline } from './StockRow'
import { HRail } from './HRail'
import { isDeskWidth } from '../../shell/DeskLayout'
import { sectorSign, SectorTileBody } from './SectorTile'
import { CryptoWire } from './CryptoWire'

/** How many cards a rail shows — named once so the rail's own FLIP ordering
 * and its body can never disagree about which twelve those are. */
const railRows = (rows: MoverRow[]) => rows.slice(0, 12)

function RailSkeleton() {
  return (
    <>
      <div className="skeleton stx-rail-card" aria-hidden="true" />
      <div className="skeleton stx-rail-card" aria-hidden="true" />
      <div className="skeleton stx-rail-card" aria-hidden="true" />
    </>
  )
}

function RailMoverCard({ r, inWatchlist, onAdd }: { r: MoverRow; inWatchlist: boolean; onAdd: (sym: string) => void }) {
  const closes = useCachedSparkline(r.sym)
  const up = (r.changePct ?? 0) >= 0
  return (
    <div className="card pressable stx-rail-card" data-flip-key={r.sym}>
      <Link href={`/stock/${r.sym}`} className="stx-rail-card-link">
        <span className="stx-rail-card-top">{r.sym}</span>
        {closes && closes.length > 1 && <Sparkline closes={closes} width={100} height={26} />}
        <span className="num">{r.price != null ? r.price.toFixed(2) : '—'}</span>
        {r.changePct != null && <span className={`pill ${up ? 'long' : 'short'}`}><span className="num">{fmtPct(r.changePct)}</span></span>}
      </Link>
      {!inWatchlist && (
        <button className="stx-rail-add" onClick={() => onAdd(r.sym)} aria-label={`Add ${r.sym} to watchlist`}>
          +
        </button>
      )}
    </div>
  )
}

/** Owns the ONE 'movers' slice fetch, mounted only once EITHER rail below
 * has been scrolled into view — Top movers and Top losers both read off it,
 * so reaching Losers first never fires a second request for Movers. */
function MoversFetcher({ onData }: { onData: (d: { gainers: MoverRow[]; losers: MoverRow[] }) => void }) {
  const { data } = useSlice('movers', getMovers)
  useEffect(() => {
    if (data) onData({ gainers: data.gainers, losers: data.losers })
  }, [data, onData])
  return null
}

function MoversRails({ watchSymbols, onAdd }: { watchSymbols: Set<string>; onAdd: (sym: string) => void }) {
  const [requested, setRequested] = useState(isDeskWidth) // desk: eager — a pane with room shows its data, no scroll-into-view dance
  const [data, setData] = useState<{ gainers: MoverRow[]; losers: MoverRow[] } | null>(null)
  // REORDER MOTION (dynamism wave, feature 8), one ruler per rail: a refresh
  // re-ranks both, and the cards should slide to their new places rather than
  // teleport. The wrappers exist only to give each rail a container ref —
  // HRail owns its own markup and the cards stay direct children of `.hrail`.
  const gainersRef = useRef<HTMLDivElement>(null)
  const losersRef = useRef<HTMLDivElement>(null)
  const order = (kind: 'gainers' | 'losers') => (data ? railRows(data[kind]).map(r => r.sym).join(',') : '')
  useFlip(gainersRef, order('gainers'))
  useFlip(losersRef, order('losers'))

  const body = (kind: 'gainers' | 'losers') => {
    if (!data) return <RailSkeleton />
    const rows = railRows(data[kind])
    return rows.length ? (
      rows.map(r => <RailMoverCard key={r.sym} r={r} inWatchlist={watchSymbols.has(r.sym)} onAdd={onAdd} />)
    ) : (
      <p className="cc-reason">Nothing to show right now.</p>
    )
  }

  return (
    <>
      <div ref={gainersRef}>
        <HRail title="Top movers" seeAllPath="/stocks/movers" onVisible={() => setRequested(true)}>
          {body('gainers')}
        </HRail>
      </div>
      <div ref={losersRef}>
        <HRail title="Top losers" seeAllPath="/stocks/movers" onVisible={() => setRequested(true)}>
          {body('losers')}
        </HRail>
      </div>
      {requested && <MoversFetcher onData={setData} />}
    </>
  )
}

function SectorTile({ row }: { row: { sym: string; name: string; rs21: number | null } }) {
  return (
    <Link href={`/stock/${row.sym}`} className="card pressable stx-sector-tile" data-sign={sectorSign(row.rs21)}>
      <SectorTileBody name={row.name} rs={row.rs21} />
    </Link>
  )
}

function SectorsRailBody() {
  const { data } = useSlice('sectors', getSectors)
  if (!data) return <RailSkeleton />
  return data.rows.length ? (
    <>
      {data.rows.map(row => (
        <SectorTile key={row.sym} row={row} />
      ))}
    </>
  ) : (
    <p className="cc-reason">No sector data right now.</p>
  )
}

function SectorsRail() {
  const [requested, setRequested] = useState(isDeskWidth) // desk: eager — a pane with room shows its data, no scroll-into-view dance
  return (
    <HRail title="Sectors" seeAllPath="/stocks/sectors" onVisible={() => setRequested(true)}>
      {requested ? <SectorsRailBody /> : <RailSkeleton />}
    </HRail>
  )
}

export default function StockMarkets({ watchSymbols, onAdd }: { watchSymbols: Set<string>; onAdd: (sym: string) => void }) {
  return <div className="stx-desk-grid">
    <div><MoversRails watchSymbols={watchSymbols} onAdd={onAdd} /></div>
    <div className="stx-sectors-block"><SectorsRail /></div>
    <div className="stx-crypto-block"><CryptoWire /></div>
  </div>
}
