import { describe, expect, it } from 'vitest'
import { adjustedReturn, buildHistoricalStudy, historicalStats, parseHistoryTape, type HistoryTape } from './longHistory'
import type { HistoricalTrade } from '../../shared/engine/historyEvidence'

const json = () => ({ chart: { result: [{ meta: { symbol: 'SPY' }, timestamp: [1577975400, 1578061800, 1578321000], indicators: { quote: [{ open: [100, 100, 100], high: [101, 101, 101], low: [99, 99, 99], close: [100, 100, 100], volume: [100, 100, 100] }], adjclose: [{ adjclose: [90, 90, 91] }] } }] } })
describe('long-history input and measurement', () => {
  it('requires actual bars and adjustment data and excludes the current session', () => {
    const raw = json(), now = 1578321000 + 1000
    expect(parseHistoryTape(raw, 'SPY', now).candles).toHaveLength(2)
    expect(parseHistoryTape(raw, 'SPY', now).adjustment).toEqual([.9, .9])
    raw.chart.result[0].indicators.quote[0].open[0] = NaN
    expect(() => parseHistoryTape(raw, 'SPY', now)).toThrow('invalid')
    expect(() => parseHistoryTape(json(), 'AAPL', now)).toThrow('missing history')
    const noAdjustment = json(); noAdjustment.chart.result[0].indicators.adjclose = []
    expect(() => parseHistoryTape(noAdjustment, 'SPY', now)).toThrow('missing history')
  })
  it('can retain a same-day bar for the current scanner without admitting future timestamps', () => {
    expect(parseHistoryTape(json(), 'SPY', 1578321000 + 1000, { includeCurrentDay: true }).candles).toHaveLength(3)
    expect(parseHistoryTape(json(), 'SPY', 1578321000 - 1, { includeCurrentDay: true }).candles).toHaveLength(2)
    expect(parseHistoryTape(json(), 'SPY', 1578321000 + 1000).candles).toHaveLength(2)
  })
  it('credits dividend adjustments to longs and debits them to shorts on the same dates', () => {
    expect(adjustedReturn(100, 100, .9, .91)).toBeCloseTo(1.111111)
    expect(adjustedReturn(100, 100, .9, .91, true)).toBeCloseTo(-1.111111)
    expect(adjustedReturn(100 * 1.001, 100 * .999, 1, 1)).toBeCloseTo(-.1998002)
  })
  it('does not treat hundreds of correlated stock picks as hundreds of time periods', () => {
    const t: HistoricalTrade = { sym: 'AAPL', signalAt: Date.UTC(2020, 0, 2) / 1000, endAt: Date.UTC(2020, 0, 5) / 1000, returnPct: 2, marketPct: 1 }
    expect(historicalStats(Array(500).fill(t))).toMatchObject({ n: 500, quarters: 1, excessPp: 1, uncertaintyPp: null })
    const rows = Array.from({ length: 16 }, (_, q) => ({ ...t, signalAt: Date.UTC(2020, q * 3, 2) / 1000 }))
    expect(historicalStats(rows).uncertaintyPp).toEqual([1, 1])
    expect(historicalStats(rows)).toEqual(historicalStats(rows))
  })
  it('enters after the signal and matches every benchmark session, without compressing missing days', () => {
    const days: number[] = []
    for (let t = Date.UTC(2018, 0, 1) / 1000; days.length < 650; t += 86400) if (![0, 6].includes(new Date(t * 1000).getUTCDay())) days.push(t + 14 * 3600)
    const tape = (sym: string, growth: number): HistoryTape => ({ sym, fetchedAt: 0, adjustment: days.map(() => 1), candles: days.map((t, i) => { const c = 100 * growth ** i; return { t, o: c * 1.01, h: c * 1.02, l: c * .99, c, v: 1000000 } }) })
    const stock = tape('AAPL', 1.001), spy = tape('SPY', 1.0005), now = Date.UTC(2021, 0, 1) / 1000
    const result = buildHistoricalStudy([stock], spy, now, 'test').strategies.find(s => s.key === 'trend-price')!
    expect(result.stats.n).toBeGreaterThan(0)
    expect(result.stats.meanReturnPct).toBeCloseTo((1.001 ** 19 * .999 / (1.01 * 1.001) - 1) * 100)
    expect(result.stats.meanMarketPct).toBeCloseTo((1.0005 ** 19 * .999 / (1.01 * 1.001) - 1) * 100)
    const sector=tape('XLK',1.002)
    const matched=buildHistoricalStudy([stock],spy,now,'sector',()=>{},[],[sector]).strategies.find(s=>s.key==='trend-price')!
    expect(matched.stats.excessPp).toBeGreaterThan(0)
    expect(matched.sectorStats!.excessPp).toBeLessThan(0)
    expect(matched.sectorStats!.n).toBe(matched.stats.n)
    expect(matched.sectorStatus).toBe('behind')
    sector.candles.splice(550,1);sector.adjustment.splice(550,1)
    const gap=buildHistoricalStudy([stock],spy,now,'gap',()=>{},[],[sector]).strategies.find(s=>s.key==='trend-price')!
    expect(gap.stats.n).toBe(matched.stats.n)
    expect(gap.missingSectorN).toBeGreaterThan(0)
    spy.candles.splice(530, 1); spy.adjustment.splice(530, 1)
    const missing = buildHistoricalStudy([stock], spy, now, 'test').strategies.find(s => s.key === 'trend-price')!
    expect(missing.missingN).toBeGreaterThan(0)
  })
  it('preserves the pre-extraction historical results for every strategy', () => {
    const days:number[]=[]
    for(let t=Date.UTC(2018,0,1)/1000;days.length<800;t+=86400)if(![0,6].includes(new Date(t*1000).getUTCDay()))days.push(t+14*3600)
    const tape=(sym:string,fn:(i:number)=>number):HistoryTape=>({sym,fetchedAt:0,adjustment:days.map((_,i)=>.95+i*.00005),candles:days.map((t,i)=>{const c=fn(i);return {t,o:c*1.005,h:c*1.01,l:c*.99,c,v:i%40===30?3000000:1000000}})})
    const stock=tape('AAPL',i=>(110+25*Math.sin(i/14)+i*.01)*(i%40===29?.88:i%40===30?.93:1))
    const spy=tape('SPY',i=>100+i*.03),sector=tape('XLK',i=>100+i*.05)
    const result=buildHistoricalStudy([stock],spy,Date.UTC(2022,0,1)/1000,'fixture',()=>{},[],[sector])
    const rounded=(value:number|null|undefined)=>value==null?null:Number(value.toFixed(8))
    // Fixed outputs recorded from the original inline predicates before they
    // moved into the shared rules. No thresholds are fitted to these results.
    expect(result.strategies.map(s=>[s.key,s.stats.n,rounded(s.stats.meanReturnPct),rounded(s.stats.excessPp),rounded(s.sectorStats?.excessPp),s.unknownFinancialN??0])).toEqual([
      ['direction-core',36,-.27834264,.35798171,.33284457,0],
      ['direction-gated',0,null,null,null,0],
      ['pullback-price',2,-3.66497253,-4.83268497,-5.61325616,0],
      ['trend-price',3,-22.03601068,-21.91081723,-22.15074199,0],
      ['big-drop-price',2,-3.66497253,-4.83268497,-5.61325616,0],
      ['healthy-drop',0,null,null,null,31],
      ['healthy-value-drop',0,null,null,null,31],
      ['quality-trend',0,null,null,null,19],
      ['quality-value',0,null,null,null,275],
      ['quarterly-recovery',0,null,null,null,31],
      ['sector-leader',6,5.4300057,5.55290232,5.31016624,0],
      ['shock-rebound',6,-2.94682212,-2.82066313,-3.05940051,0],
    ])
  })
})
