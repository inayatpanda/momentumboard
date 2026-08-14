// SectorTile body (plan Task 16) — the sector-rotation tile's shared visual:
// name + one RS number, tinted by sign only (--long/--short at low alpha,
// NEVER a third hue). Split out from Stocks.tsx's rail card so the Sectors
// see-all page (Sectors.tsx) can reuse the exact same look while wiring a
// different interaction underneath it — the rail's tile is a `Link` straight
// to /stock/SYM, the see-all grid's tile is a toggle button that expands the
// sector's real members in place (CX-24) — the wrapper differs, the tint math
// and markup for what's INSIDE it does not.

export function sectorSign(rs: number | null): 'pos' | 'neg' {
  return rs != null && rs < 0 ? 'neg' : 'pos'
}

export function SectorTileBody({ name, rs }: { name: string; rs: number | null }) {
  return (
    <>
      <span className="stx-sector-name">{name}</span>
      <span className="num stx-sector-rs">{rs != null ? rs.toFixed(1) : '—'}</span>
    </>
  )
}
