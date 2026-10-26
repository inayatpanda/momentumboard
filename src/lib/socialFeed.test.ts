import { describe, expect, it } from 'vitest'
import { filterStreetVideos, latestStreetVideos } from './socialFeed'
import type { StreetVideo } from './api'

const video = (changes: Partial<StreetVideo> = {}): StreetVideo => ({
  url: 'https://youtu.be/abcdefghijk', title: 'The next quarter', channel: 'Research channel', at: 100,
  tickers: [{ sym: 'AAPL', company: 'Apple', stance: 'bull' }], themes: ['earnings'],
  ...changes,
})

describe('social feed', () => {
  it('deduplicates alternate YouTube URLs using the latest analysis without changing the input', () => {
    const rows = [video(), video({ url: 'https://www.youtube.com/watch?v=abcdefghijk&t=40', at: 200 })]
    expect(latestStreetVideos(rows)).toEqual([rows[1]])
    expect(rows[0].at).toBe(100)
  })
  it('combines company, topic and channel filters', () => {
    const rows = [video(), video({ channel: 'Other', tickers: [{ sym: 'NVDA', stance: 'bull' }] })]
    expect(filterStreetVideos(rows, 'Research channel', 'Apple earnings', false)).toEqual([rows[0]])
    expect(filterStreetVideos(rows, 'Other', 'AAPL', false)).toEqual([])
  })
  it('finds a company by its directory name when the video only has a ticker', () => {
    const rows = [video({tickers:[{sym:'PLTR',stance:'bull'}]})]
    expect(filterStreetVideos(rows, '', 'Palantir', false, new Map([['PLTR','Palantir Technologies']]))).toEqual(rows)
  })
  it('does not mistake third-party, unmatched or unidentified statements for sourced claims', () => {
    const matched = { sourceMatch: 'matched', identityMatched: true } as NonNullable<StreetVideo['claims']>[number]
    const rows = [
      video({ claims: [matched] }),
      video({ claims: [matched], provenance: 'third-party' }),
      video({ claims: [{ ...matched, identityMatched: false }] }),
      video(),
    ]
    expect(filterStreetVideos(rows, '', '', true)).toEqual([rows[0]])
  })
})
