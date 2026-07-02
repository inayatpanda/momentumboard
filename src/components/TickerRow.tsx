import type { Quote, SetupKind } from '../../shared/types'
import { fmtPrice, fmtPct } from '../lib/format'
import { Badge } from './Badge'

export interface Row {
  symbol: string
  quote: Quote | null
  rvol: number | null
  setups: SetupKind[]
}

export function TickerRow({ row, onRemove }: { row: Row; onRemove: () => void }) {
  const { symbol, quote, rvol, setups } = row
  return (
    <div style={{ background: 'var(--panel)', borderRadius: 10, padding: 12, marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong>{symbol}</strong>
        <span>
          {quote ? fmtPrice(quote.price, quote.currency) : '—'}{' '}
          {quote && (
            <span style={{ color: quote.changePct >= 0 ? 'var(--green)' : 'var(--red)' }}>{fmtPct(quote.changePct)}</span>
          )}
        </span>
      </div>
      <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {rvol != null && <span style={{ color: 'var(--muted)', fontSize: 12 }}>RVOL {rvol.toFixed(1)}x</span>}
        {setups.map(s => (
          <Badge key={s} kind={s} />
        ))}
        <button onClick={onRemove} aria-label={`Remove ${symbol}`} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer' }}>
          ✕
        </button>
      </div>
    </div>
  )
}
