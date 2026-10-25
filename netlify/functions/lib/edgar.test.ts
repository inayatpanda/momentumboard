import { describe, it, expect } from 'vitest'
import { parseInfoTable, fetchFundMoves, diff13F, matchSmartMoney, matchesIssuer, normIssuer, type FundMoves } from './edgar'

const xml = `<informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">
<infoTable><nameOfIssuer>APPLE INC</nameOfIssuer><value>1000000</value><shrsOrPrnAmt><sshPrnamt>5000</sshPrnamt></shrsOrPrnAmt></infoTable>
<infoTable><nameOfIssuer>APPLE INC</nameOfIssuer><value>500000</value><shrsOrPrnAmt><sshPrnamt>2500</sshPrnamt></shrsOrPrnAmt></infoTable>
<infoTable><nameOfIssuer>OCCIDENTAL PETE</nameOfIssuer><value>200000</value><shrsOrPrnAmt><sshPrnamt>9000</sshPrnamt></shrsOrPrnAmt></infoTable>
</informationTable>`

describe('parseInfoTable', () => {
  it('aggregates duplicate issuers across table entries', () => {
    const h = parseInfoTable(xml)
    const apple = h.find(x => x.issuer === 'APPLE INC')!
    expect(apple.shares).toBe(7500)
    expect(apple.value).toBe(1_500_000)
    expect(h).toHaveLength(2)
  })
})

describe('institutional evidence guards', () => {
  it('does not label option exposure or debt principal as shares bought', () => {
    const block = (extra: string) => `<infoTable><nameOfIssuer>APPLE INC</nameOfIssuer><value>100</value><sshPrnamt>10</sshPrnamt>${extra}</infoTable>`
    expect(parseInfoTable(block('<putCall>Put</putCall>') + block('<putCall>CALL</putCall>') + block('<sshPrnamtType>PRN</sshPrnamtType>') + block('<sshPrnamtType>SH</sshPrnamtType>'))).toEqual([{issuer:'APPLE INC',value:100,shares:10}])
  })
  it('does not turn a failed prior filing download into an all-new portfolio', async () => {
    const fetcher: typeof fetch = async input => {
      const url = String(input)
      if (url.includes('/submissions/')) return Response.json({filings:{recent:{form:['13F-HR','13F-HR'],accessionNumber:['new','old'],filingDate:['2026-08-15','2026-05-15']}}})
      if (url.endsWith('index.json')) return Response.json({directory:{item:[{name:'holdings.xml'}]}})
      return url.includes('/old/') ? new Response('Unavailable',{status:503}) : new Response(xml)
    }
    expect(await fetchFundMoves('123','Test',fetcher)).toBeNull()
  })
})

describe('diff13F', () => {
  const prior = [
    { issuer: 'APPLE INC', shares: 1000, value: 100 },
    { issuer: 'CHEVRON', shares: 500, value: 50 },
  ]
  const current = [
    { issuer: 'APPLE INC', shares: 1500, value: 160 }, // +50%
    { issuer: 'NVIDIA', shares: 200, value: 90 }, // new
  ]
  it('classifies new, increased and exited positions', () => {
    const m = diff13F('Test Fund', '2026-05-15', current, prior)
    expect(m.newPositions.map(h => h.issuer)).toEqual(['NVIDIA'])
    expect(m.increased[0]).toMatchObject({ issuer: 'APPLE INC', pctChange: 50 })
    expect(m.exited.map(h => h.issuer)).toEqual(['CHEVRON'])
  })

  it('a quarter-to-quarter respelling is NOT a new+exited pair', () => {
    // the live Berkshire bug: "CHEVRON CORP" one filing, "CHEVRON CORP NEW"
    // the next read as "bought Chevron, sold Chevron Corp New"
    const m = diff13F(
      'Test Fund',
      '2026-05-15',
      [{ issuer: 'CHEVRON CORPORATION', shares: 500, value: 50 }],
      [{ issuer: 'CHEVRON CORP NEW', shares: 500, value: 50 }],
    )
    expect(m.newPositions).toEqual([])
    expect(m.exited).toEqual([])
    expect(m.increased).toEqual([]) // same share count — not an add either
  })

  it('share classes that normalise together merge instead of double-counting', () => {
    const m = diff13F(
      'Test Fund',
      '2026-05-15',
      [
        { issuer: 'ALPHABET INC CL A', shares: 100, value: 10 },
        { issuer: 'ALPHABET INC CL C', shares: 200, value: 20 },
      ],
      [{ issuer: 'ALPHABET INC CL A', shares: 100, value: 10 }],
    )
    // 300 total vs 100 prior = a 200% increase on the merged line
    expect(m.increased[0]).toMatchObject({ pctChange: 200 })
    expect(m.newPositions).toEqual([])
  })
})

describe('matchesIssuer (conservative: a miss is fine, a wrong match is not)', () => {
  it('matches via the alias map through SEC-abbreviated / suffixed names', () => {
    expect(matchesIssuer('OXY', null, normIssuer('OCCIDENTAL PETE CORP'))).toBe(true)
    expect(matchesIssuer('BAC', null, normIssuer('BANK AMER CORP'))).toBe(true)
    expect(matchesIssuer('CVX', null, normIssuer('CHEVRON CORP NEW'))).toBe(true)
    expect(matchesIssuer('AXP', null, normIssuer('AMER EXPRESS CO'))).toBe(true)
  })
  it('matches via exact normalised equality with the Finnhub company name', () => {
    expect(matchesIssuer('SHOP', 'Shopify Inc', normIssuer('SHOPIFY INC'))).toBe(true)
  })
  it('does NOT match unrelated names that merely share a prefix', () => {
    // AAPL alias 'APPLE' must not grab "Apple Hospitality REIT"
    expect(matchesIssuer('AAPL', 'Apple Inc', normIssuer('APPLE HOSPITALITY REIT INC'))).toBe(false)
    expect(matchesIssuer('V', null, normIssuer('VISANET HOLDINGS'))).toBe(false)
    expect(matchesIssuer('XYZ', 'Some Unknown Co', normIssuer('NVIDIA CORP'))).toBe(false)
  })
})

describe('matchSmartMoney', () => {
  const moves: FundMoves[] = [
    { fund: 'Berkshire Hathaway', filedAt: '2026-05-15', newPositions: [{ issuer: 'OCCIDENTAL PETE CORP', shares: 1, value: 1 }], increased: [], exited: [] },
    { fund: 'Scion Asset Management', filedAt: '2026-05-10', newPositions: [], increased: [], exited: [{ issuer: 'NVIDIA CORP', shares: 1, value: 1 }] },
  ]

  it('aggregates buys and exits by fund with the latest relevant filing date', () => {
    const oxy = matchSmartMoney('OXY', 'Occidental Petroleum Corp', moves)!
    expect(oxy.bought).toEqual(['Berkshire Hathaway'])
    expect(oxy.exited).toEqual([])
    expect(oxy.filedAt).toBe('2026-05-15')

    const nvda = matchSmartMoney('NVDA', 'NVIDIA Corp', moves)!
    expect(nvda.exited).toEqual(['Scion Asset Management'])
    expect(nvda.bought).toEqual([])
  })

  it('returns null when no tracked fund touched the name', () => {
    expect(matchSmartMoney('TSLA', 'Tesla Inc', moves)).toBeNull()
  })
})
