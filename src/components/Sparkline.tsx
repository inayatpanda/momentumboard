export function Sparkline({ closes, width = 88, height = 30 }: { closes: number[]; width?: number; height?: number }) {
  if (closes.length < 2) return null
  const min = Math.min(...closes)
  const max = Math.max(...closes)
  const span = max - min || 1
  const stepX = width / (closes.length - 1)
  const pts = closes.map((c, i) => [i * stepX, height - 3 - ((c - min) / span) * (height - 6)] as const)
  const d = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const up = closes[closes.length - 1] >= closes[0]
  const color = up ? 'var(--green)' : 'var(--red)'
  const id = `sg-${up ? 'u' : 'd'}`
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L${width},${height} L0,${height} Z`} fill={`url(#${id})`} stroke="none" />
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
