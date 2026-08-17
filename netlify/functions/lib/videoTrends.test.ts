import { describe, it, expect } from 'vitest'
import { computeConsensus, parseExtract, type VideoExtract } from './videoTrends'

const NOW = 2_000_000_000
const DAY = 86_400

const ex = (channel: string, daysAgo: number, tickers: VideoExtract['tickers'], themes: string[] = []): VideoExtract => ({
  url: `u-${channel}-${daysAgo}`,
  title: 't',
  channel,
  at: NOW - daysAgo * DAY,
  tickers,
  themes,
})

describe('computeConsensus', () => {
  it('counts mentions, channels, stance balance and week-over-week shift', () => {
    const extracts = [
      ex('Josh', 1, [{ sym: 'NVDA', stance: 'bull', levels: [] }]),
      ex('Kevin', 2, [{ sym: 'NVDA', stance: 'bull', levels: [] }]),
      ex('Nash', 3, [{ sym: 'NVDA', stance: 'bear', levels: [] }]),
      // prior week: NVDA was net bearish → this week net bullish = shift
      ex('Josh', 9, [{ sym: 'NVDA', stance: 'bear', levels: [] }]),
      ex('Kevin', 10, [{ sym: 'NVDA', stance: 'bear', levels: [] }]),
    ]
    const { tickers } = computeConsensus(extracts, NOW)
    const nvda = tickers.find(t => t.sym === 'NVDA')!
    expect(nvda.mentions7d).toBe(3)
    expect(nvda.mentionsPrior7d).toBe(2)
    expect(nvda.channels).toBe(3)
    expect(nvda.net).toBe(1)
    expect(nvda.shifted).toBe(true)
    expect(nvda.crowded).toBe(false) // 3 mentions is below the crowding floor
  })

  it('flags one-sided heavy coverage as crowded (contrarian warning)', () => {
    const extracts = Array.from({ length: 6 }, (_, i) => ex(`ch${i}`, 1, [{ sym: 'TSLA', stance: 'bull' as const, levels: [] }]))
    const { tickers } = computeConsensus(extracts, NOW)
    expect(tickers[0].crowded).toBe(true)
  })

  // WHO said it, not just how many (The street page). `channels` has always
  // been a COUNT — "from 3 channels" — which tells the reader nothing about
  // whose read this is. The names were in the extracts all along.
  it('names the distinct channels behind each ticker, in first-seen order', () => {
    const extracts = [
      ex('Josh', 1, [{ sym: 'NVDA', stance: 'bull', levels: [] }]),
      ex('Gareth', 2, [{ sym: 'NVDA', stance: 'bull', levels: [] }]),
      // the same channel twice is still one voice
      ex('Josh', 3, [{ sym: 'NVDA', stance: 'bear', levels: [] }]),
    ]
    const nvda = computeConsensus(extracts, NOW).tickers.find(t => t.sym === 'NVDA')!
    expect(nvda.channels).toBe(2)
    expect(nvda.channelNames).toEqual(['Josh', 'Gareth'])
  })

  it('caps the named channels at six while the count keeps counting', () => {
    const extracts = Array.from({ length: 9 }, (_, i) => ex(`ch${i}`, 1, [{ sym: 'TSLA', stance: 'bull' as const, levels: [] }]))
    const tsla = computeConsensus(extracts, NOW).tickers[0]
    expect(tsla.channels).toBe(9)
    expect(tsla.channelNames).toHaveLength(6)
    expect(tsla.channelNames).toEqual(['ch0', 'ch1', 'ch2', 'ch3', 'ch4', 'ch5'])
  })

  it('aggregates themes over the last week', () => {
    const extracts = [ex('a', 1, [], ['ai-capex']), ex('b', 2, [], ['ai-capex', 'rate-cuts'])]
    const { themes } = computeConsensus(extracts, NOW)
    expect(themes[0]).toEqual({ theme: 'ai-capex', count7d: 2 })
  })
})

describe('parseExtract', () => {
  const meta = { url: 'u', title: 't', channel: 'c', at: 1 }
  it('parses clean JSON and normalizes fields', () => {
    const raw = 'Here you go: {"tickers":[{"sym":"nvda","stance":"bull","levels":[120.5]}],"themes":["ai-capex"]}'
    const e = parseExtract(raw, meta)!
    expect(e.tickers[0]).toEqual({ sym: 'NVDA', stance: 'bull', levels: [120.5] })
    expect(e.themes).toEqual(['ai-capex'])
  })
  it('defaults junk stances to neutral and rejects non-JSON', () => {
    expect(parseExtract('{"tickers":[{"sym":"X","stance":"moon"}],"themes":[]}', meta)!.tickers[0].stance).toBe('neutral')
    expect(parseExtract('no json here', meta)).toBeNull()
  })
})
