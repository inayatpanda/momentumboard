// Panel 5 — Smart-money flow (13F). What the tracked funds bought and sold last
// filing. A net add-vs-exit split bar sits up top; each fund lists its biggest
// adds/new (green ▲) and exits (red ▼), capped so the card stays scannable. 13F
// data lags by up to a quarter — the caveat rides at the top, once.

import type { getSmartMoney } from '../../lib/api'

type SmartMoney = Awaited<ReturnType<typeof getSmartMoney>>

const CAP = 5

export function SmartMoneyPanel({ data }: { data: SmartMoney | null }) {
  const funds = data?.funds ?? []

  let inflow = 0
  let exited = 0
  for (const f of funds) {
    inflow += (f.newPositions?.length ?? 0) + (f.increased?.length ?? 0)
    exited += f.exited?.length ?? 0
  }
  const total = inflow + exited || 1

  return (
    <section className="card quant-panel">
      <h3 className="section-title">Large-investor holdings</h3>
      <p className="empty-line quant-cap">Quarter-end snapshots, published later. Share-count changes may include stock splits and share-class changes; they do not prove a purchase. Options and debt positions are excluded from this comparison.</p>
      {data?.lagNote && <p className="empty-line quant-cap" style={{ marginTop: 0 }}>{data.lagNote}</p>}

      {funds.length === 0 ? (
        <p className="empty-line">Comparable holdings reports are unavailable right now. This does not mean investors made no changes.</p>
      ) : (
        <>
          <div className="quant-net">
            <span className="quant-net-num" style={{ color: 'var(--green)' }}>{inflow} reported increases / new positions</span>
            <span className="quant-net-num" style={{ color: 'var(--red)' }}>{exited} positions no longer reported</span>
          </div>
          <div className="quant-net-bar">
            <div className="quant-net-seg" style={{ width: `${(inflow / total) * 100}%`, background: 'var(--green)' }} />
            <div className="quant-net-seg" style={{ width: `${(exited / total) * 100}%`, background: 'var(--red)' }} />
          </div>

          <div className="quant-funds">
            {funds.map((f, i) => {
              const added = [
                ...(f.increased ?? []).map(x => ({ issuer: x.issuer, pct: x.pctChange, kind: 'inc' as const })),
                ...(f.newPositions ?? []).map(x => ({ issuer: x.issuer, pct: null as number | null, kind: 'new' as const })),
              ].slice(0, CAP)
              const out = (f.exited ?? []).slice(0, CAP)
              // over ~two quarters without a filing = the fund stopped filing
              // (deregistered) — dim it and say so, don't look broken
              const stale = Date.now() - Date.parse(f.filedAt) > 200 * 86_400_000
              return (
                <div key={`${f.fund}-${i}`} className="quant-fund" style={stale ? { opacity: 0.6 } : undefined}>
                  <div className="quant-fund-head">
                    <span className="quant-fund-name">{f.fund}{stale && <span className="badge warn" style={{ marginLeft: 6 }}>no recent report</span>}</span>
                    <span className="quant-fund-date num">{f.filedAt}</span>
                  </div>
                  <div className="quant-fund-flows">
                    <ul className="quant-flow-list">
                      {added.length === 0 && <li className="empty-line">no adds</li>}
                      {added.map((a, j) => (
                        <li key={`a-${j}`}>
                          <span style={{ color: 'var(--green)' }}>▲</span> {a.issuer}
                          {a.kind === 'new' ? <span className="badge good">new</span> : a.pct != null ? <span className="quant-flow-pct num"> +{Math.abs(a.pct).toFixed(0)}%</span> : null}
                        </li>
                      ))}
                    </ul>
                    <ul className="quant-flow-list">
                      {out.length === 0 && <li className="empty-line">no exits</li>}
                      {out.map((e, j) => (
                        <li key={`e-${j}`}>
                          <span style={{ color: 'var(--red)' }}>▼</span> {e.issuer}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </section>
  )
}
