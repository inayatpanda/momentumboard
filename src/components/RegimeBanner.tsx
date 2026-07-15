import type { RegimeColor } from '../../shared/types'

// the word "tape" alone read as jargon — carry the regime colour in the label
// so the pill explains itself without the hover tooltip (phones never see it)
const COPY: Record<RegimeColor, string> = {
  green: 'Green tape — full size',
  amber: 'Amber tape — half size',
  red: 'Red tape — defensive',
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
