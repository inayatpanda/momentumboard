import type { SetupKind } from '../../shared/types'

const LABELS: Record<SetupKind, { text: string; tone: 'good' | 'warn' | 'bad' | 'info' }> = {
  basing: { text: 'Basing', tone: 'info' },
  divergence: { text: 'Divergence', tone: 'info' },
  reclaim: { text: 'Reclaim', tone: 'good' },
  pullbackZone: { text: 'Pullback zone', tone: 'good' },
  breakoutWatch: { text: 'Breakout watch', tone: 'info' },
  breakoutLive: { text: 'Breakout live', tone: 'good' },
  overextended: { text: 'Overextended', tone: 'warn' },
  fallingKnife: { text: 'Falling knife', tone: 'bad' },
}

export function Badge({ kind }: { kind: SetupKind }) {
  const { text, tone } = LABELS[kind]
  return <span className={`badge ${tone}`}>{text}</span>
}
