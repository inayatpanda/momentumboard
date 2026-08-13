import { describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'

// The detail screen's own data plumbing is not under test here — the eyebrow is.
// It renders `{symbol} · {exchangeFor(symbol)}`, so a symbol misclassified as
// CRYPTO is shown to the reader in those words.
vi.mock('../lib/api', () => ({
  getCandles: () => Promise.resolve({ candles: [], quote: null }),
  getNews: () => Promise.resolve([]),
  getTickerBrief: () => Promise.resolve(null),
  getSeasonality: () => Promise.resolve(null),
  getEngine: () => Promise.resolve({ board: null }),
  askDesk: () => Promise.resolve({ answer: '' }),
}))
vi.mock('../lib/db', () => ({
  db: { rules: { where: () => ({ equals: () => ({ toArray: () => Promise.resolve([]) }) }), put: async () => {}, delete: async () => {} } },
  getCapital: () => Promise.resolve(5000),
}))
vi.mock('../lib/configMirror', () => ({ mirrorConfig: () => {} }))
vi.mock('../components/PriceChart', () => ({ PriceChart: () => null }))
vi.mock('../components/RsiChart', () => ({ RsiChart: () => null }))

const { TickerDetail } = await import('./TickerDetail')

const eyebrowOf = async (symbol: string) => {
  const { container } = render(<TickerDetail symbol={symbol} onBack={() => {}} />)
  await waitFor(() => expect(container.querySelector('.eyebrow')).not.toBeNull())
  return container.querySelector('.eyebrow')!.textContent ?? ''
}

describe('TickerDetail — the venue in the header eyebrow', () => {
  it('shows BT-A.L as the LSE stock it is, not as CRYPTO', async () => {
    const text = await eyebrowOf('BT-A.L')
    expect(text).toContain('BT-A.L · LSE')
    expect(text).not.toContain('CRYPTO')
  })

  it('still shows a real pair as CRYPTO', async () => {
    expect(await eyebrowOf('ETH-USD')).toContain('ETH-USD · CRYPTO')
  })

  it('shows the dashed US share class as US', async () => {
    expect(await eyebrowOf('BRK-B')).toContain('BRK-B · US')
  })
})
