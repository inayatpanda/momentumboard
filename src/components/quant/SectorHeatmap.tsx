// Panel 2 — Sector sentiment heatmap. One cell per sector ETF, tinted by 21-day
// relative strength (green = leading, red = lagging) and ALWAYS carrying the
// numeric rs21 + day %change so colour is never the sole encoding. Cells sort
// strongest-first; rotation flags trail underneath.

import type { getSectors, getQuotes } from '../../lib/api'

type Sectors = Awaited<ReturnType<typeof getSectors>>
type Quotes = Awaited<ReturnType<typeof getQuotes>>

// diverging tint: opacity scales with |rs21|; near-zero stays neutral so the
// cell reads as "flat", not "missing". k is a clamped, rounded integer percent.
function tint(rs21: number | null): string {
  const v = rs21 ?? 0
  const k = Math.min(100, Math.max(0, Math.round(Math.abs(v) * 8)))
  if (k === 0) return 'transparent'
  const color = v > 0 ? 'var(--green)' : 'var(--red)'
  return `color-mix(in srgb, ${color} ${k}%, transparent)`
}

function fmtSigned(p: number): string {
  return `${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(2)}%`
}

export function SectorHeatmap({ sectors, quotes, onOpen }: { sectors: Sectors | null; quotes: Quotes; onOpen?: (sym: string) => void }) {
  const rows = sectors?.rows ?? []
  const paired = rows
    .map((row, i) => ({ row, quote: quotes[i] ?? null }))
    .sort((a, b) => (b.row.rs21 ?? -Infinity) - (a.row.rs21 ?? -Infinity))

  const rotIn = sectors?.rotatingIn ?? []
  const rotOut = sectors?.rotatingOut ?? []

  return (
    <section className="card quant-panel">
      <h3 className="section-title">Sector sentiment</h3>
      {paired.length === 0 ? (
        <p className="empty-line">No sector data right now.</p>
      ) : (
        <>
          <div className="quant-heatmap">
            {paired.map(({ row, quote }) => {
              const rs = row.rs21
              const chg = quote?.changePct
              return (
                // a cell is also a door to the ETF's own chart page
                <div
                  key={row.sym}
                  className="quant-cell"
                  style={{ background: tint(rs), cursor: onOpen ? 'pointer' : undefined }}
                  role={onOpen ? 'button' : undefined}
                  tabIndex={onOpen ? 0 : undefined}
                  onClick={onOpen ? () => onOpen(row.sym) : undefined}
                  onKeyDown={onOpen ? e => e.key === 'Enter' && onOpen(row.sym) : undefined}
                >
                  <div className="quant-cell-top">
                    <span className="quant-cell-sym">{row.sym}</span>
                    <span className="quant-cell-rs num">{rs == null ? '—' : `rs ${rs.toFixed(1)}`}</span>
                  </div>
                  <div className="quant-cell-name">{row.name}</div>
                  <div className="quant-cell-chg num" style={{ color: chg == null ? 'var(--faint)' : chg >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {chg == null ? '—' : fmtSigned(chg)}
                  </div>
                </div>
              )
            })}
          </div>

          {(rotIn.length > 0 || rotOut.length > 0) && (
            <div className="quant-rotate">
              {rotIn.length > 0 && (
                <div className="quant-rotate-line">
                  <span className="quant-rotate-label" style={{ color: 'var(--green)' }}>rotating in</span>
                  {rotIn.map(s => (
                    <span key={s} className="badge good">{s}</span>
                  ))}
                </div>
              )}
              {rotOut.length > 0 && (
                <div className="quant-rotate-line">
                  <span className="quant-rotate-label" style={{ color: 'var(--red)' }}>rotating out</span>
                  {rotOut.map(s => (
                    <span key={s} className="badge bad">{s}</span>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
