// Sectors (plan Task 16; CX-24) — the "See all" landing for the Stocks
// rail's Sector-rotation tile. The server's relative strength is measured in
// SESSION counts (rs5/rs21/rs63 — lib/sectors.ts), never calendar days or
// weeks, so the period toggle reads "1w / 1m / 3m" and maps straight onto
// those three fields; nothing here reinterprets what the engine measured.
//
// Tapping a tile does NOT navigate — unlike the rail's tile (a Link straight
// to /stock/SYM), a tile here toggles the sector open in place, revealing its
// REAL constituent tickers (`members`, wired server-side from SECTOR_MEMBERS)
// as a list of full StockRow links. Tile visuals (name + RS number + sign
// tint) are shared with Stocks.tsx's rail card via parts/SectorTile.tsx.

import { useState } from 'react'
import { useSlice } from '../lib/useSlice'
import { getSectors } from '../lib/api'
import { sectorSign, SectorTileBody } from './parts/SectorTile'
import { StockRow } from './parts/StockRow'

type Period = '1w' | '1m' | '3m'
const RS_FIELD: Record<Period, 'rs5' | 'rs21' | 'rs63'> = { '1w': 'rs5', '1m': 'rs21', '3m': 'rs63' }
const PERIODS: Period[] = ['1w', '1m', '3m']

export default function Sectors() {
  const { data } = useSlice('sectors', getSectors)
  const [period, setPeriod] = useState<Period>('1m')
  const [selected, setSelected] = useState<string | null>(null)

  const rsField = RS_FIELD[period]
  const rows = data?.rows ?? []
  const activeRow = selected ? (rows.find(r => r.sym === selected) ?? null) : null

  return (
    <div className="stx">
      <h1>Sectors</h1>
      <div className="seg" role="group" aria-label="Relative-strength period">
        {PERIODS.map(p => (
          <button key={p} type="button" aria-pressed={period === p} onClick={() => setPeriod(p)}>
            {p}
          </button>
        ))}
      </div>

      {!data ? (
        <div className="skeleton" style={{ height: 64, marginTop: 12 }} />
      ) : rows.length === 0 ? (
        <p className="cc-reason">No sector data right now.</p>
      ) : (
        <div className="stx-sector-grid">
          {rows.map(row => (
            <button
              key={row.sym}
              type="button"
              className="card pressable stx-sector-tile"
              data-sign={sectorSign(row[rsField])}
              aria-pressed={selected === row.sym}
              onClick={() => setSelected(s => (s === row.sym ? null : row.sym))}
            >
              <SectorTileBody name={row.name} rs={row[rsField]} />
            </button>
          ))}
        </div>
      )}

      {activeRow && (
        <div className="stx-sector-members">
          <p className="sec-label">{activeRow.name} — constituents</p>
          {activeRow.members.length === 0 ? (
            <p className="cc-reason">No constituent symbols listed for this sector.</p>
          ) : (
            <div className="stx-watchlist">
              {activeRow.members.map(sym => (
                <StockRow key={sym} symbol={sym} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
