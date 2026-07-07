import { describe, expect, it } from 'vitest'
import { parseStooqCsv, stooqSymbol } from './stooq'

describe('stooqSymbol', () => {
  it('maps US, LSE and majors; refuses what it cannot map', () => {
    expect(stooqSymbol('AAPL')).toBe('aapl.us')
    expect(stooqSymbol('BRK.B')).toBe('brk-b.us')
    expect(stooqSymbol('VOD.L')).toBe('vod.uk')
    expect(stooqSymbol('BTC-USD')).toBe('btcusd')
    expect(stooqSymbol('^VIX')).toBeNull()
    expect(stooqSymbol('ES=F')).toBeNull()
    expect(stooqSymbol('SOL-USD')).toBeNull()
  })
})

describe('parseStooqCsv', () => {
  it('parses daily rows into candles and drops junk', () => {
    const csv = 'Date,Open,High,Low,Close,Volume\n2026-07-03,100,102,99,101.5,1200000\n2026-07-06,101,103,100,102.25,900000\nbad,row,,,,\n'
    const candles = parseStooqCsv(csv)
    expect(candles).toHaveLength(2)
    expect(candles[1]).toMatchObject({ o: 101, c: 102.25, v: 900000 })
    expect(new Date(candles[0].t * 1000).toISOString().slice(0, 10)).toBe('2026-07-03')
  })
  it('garbage in → [] out', () => {
    expect(parseStooqCsv('No data')).toEqual([])
    expect(parseStooqCsv('')).toEqual([])
  })
})
