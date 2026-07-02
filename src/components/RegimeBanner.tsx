import type { RegimeColor } from '../../shared/types'

const COPY: Record<RegimeColor, string> = {
  green: 'Regime: GREEN — tape supports longs',
  amber: 'Regime: AMBER — half size, A-grade setups only',
  red: 'Regime: RED — defensive; no new longs',
}

export function RegimeBanner({ regime }: { regime: RegimeColor | null }) {
  if (!regime) return null
  const color = regime === 'green' ? 'var(--green)' : regime === 'amber' ? 'var(--amber)' : 'var(--red)'
  return (
    <div style={{ background: color, color: '#0b0e14', padding: '6px 12px', borderRadius: 8, fontWeight: 600, marginBottom: 12 }}>
      {COPY[regime]}
    </div>
  )
}
