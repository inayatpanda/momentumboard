import { StockIdentity } from '../components/StockIdentity'
import { DataStatus } from './parts/DataStatus'
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
import { Link } from 'wouter'
import { useSlice } from '../lib/useSlice'
import { getSectors } from '../lib/api'
import { sectorSign, SectorTileBody } from './parts/SectorTile'
import { StockRow } from './parts/StockRow'

type Period = '1w' | '1m' | '3m'
const RS_FIELD: Record<Period, 'rs5' | 'rs21' | 'rs63'> = { '1w': 'rs5', '1m': 'rs21', '3m': 'rs63' }
const PERIODS: Period[] = ['1w', '1m', '3m']

/** THE SESSION COUNT BEHIND EACH TOGGLE, read off the server's own arithmetic
 * rather than from the label. netlify/functions/lib/sectors.ts computes each
 * field as `returnOver(sectorCandles, N) − returnOver(spy, N)` with N = 5 / 21
 * / 63 BARS — so "1m" is twenty-one sessions, not a calendar month, and the
 * unit is percentage points of return, not a percentage of anything. */
const RS_SESSIONS: Record<Period, number> = { '1w': 5, '1m': 21, '3m': 63 }

/** WHAT THE NUMBER ON A TILE IS (visibility wave, 2026-08-17). The grid printed
 * `5.2` and `-6.0` with no unit and no benchmark anywhere on the page — a
 * reader could not tell a percentage from a rank from a score. Verified against
 * computeSectorRows before it was written: SPY is the benchmark (the ETF, which
 * is what the server actually subtracts), the window is sessions, and the
 * difference of two percentage returns is percentage points. */
export function rsLegend(period: Period): string {
  return `Relative strength over the last ${RS_SESSIONS[period]} sessions — the sector ETF's return minus SPY's, in percentage points.`
}

export default function Sectors() {
  const { data, error, refresh, refreshing } = useSlice('sectors', getSectors)
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

      <p className="cc-reason stx-sector-legend">{rsLegend(period)}</p>

      {!data ? (
        <DataStatus label="Sector rotation" error={error} refresh={refresh} refreshing={refreshing} />
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
          <p className="sec-label">{activeRow.name} — stocks</p>
          {activeRow.members.length === 0 ? (
            <p className="cc-reason">No stocks are listed for this sector yet.</p>
          ) : (
            <div className="stx-watchlist">
              {activeRow.members.map(sym => (
                <StockRow key={sym} symbol={sym} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* WHAT IS INSIDE EACH ONE (visibility wave, 2026-08-17). The page ended
          at the tile grid and left two thirds of a desk screen blank, while the
          payload had been carrying every sector's constituents all along — the
          same `members` the tile expands. As plain links, not StockRows: a
          StockRow fetches its own three-month tape, and fifty-five of them is
          precisely the burst `sparkCachedOnly` exists to prevent. Hidden while
          a tile is open so the expanded sector is the only thing being read. */}
      {data && rows.length > 0 && !activeRow && (
        <div className="stx-sector-inside">
          <p className="sec-label">What's inside each one</p>
          {rows.map(row => (
            <div className="stx-sector-inside-row" key={row.sym}>
              <span className="stx-sector-inside-name">{row.name}</span>
              <span className="stx-sector-inside-syms">
                {row.members.length === 0
                  ? '—'
                  : row.members.map(sym => (
                      <Link key={sym} href={`/stock/${sym}`} className="pill">
                        <StockIdentity symbol={sym} />
                      </Link>
                    ))}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
