import { describe, it, expect } from 'vitest'
import { parseInfoTable, diff13F } from './edgar'

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
})
