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

const COLORS = { good: 'var(--green)', warn: 'var(--amber)', bad: 'var(--red)', info: 'var(--accent)' }

export function Badge({ kind }: { kind: SetupKind }) {
  const { text, tone } = LABELS[kind]
  return (
    <span style={{ border: `1px solid ${COLORS[tone]}`, color: COLORS[tone], borderRadius: 999, padding: '1px 8px', fontSize: 12, marginRight: 4 }}>
      {text}
    </span>
  )
}
