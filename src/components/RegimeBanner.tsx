import type { RegimeColor } from '../../shared/types'

const COPY: Record<RegimeColor, string> = {
  green: 'Tape: long OK',
  amber: 'Tape: half size',
  red: 'Tape: defensive',
}

export function RegimeBanner({ regime }: { regime: RegimeColor | null }) {
  if (!regime) return null
  return (
    <span className={`regime ${regime}`} title={
      regime === 'green' ? 'SPY & QQQ above rising 20/50-day averages — tape supports longs'
      : regime === 'amber' ? 'Mixed index structure — half size, A-grade setups only'
      : 'Index breakdown — defensive; no new longs'
    }>
      <span className="dot" />
      {COPY[regime]}
    </span>
  )
}
