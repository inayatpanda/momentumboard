// Local-only seeder: fetches 2y of Yahoo candles for a broad liquid universe,
// replays the technical/momentum factors through the engine, and writes the
// starting weights + calibration to shared/engine/seed.json (committed).
// Run: npm run seed-engine
import { writeFileSync } from 'node:fs'
import { SECTORS, SECTOR_MEMBERS } from '../netlify/functions/lib/sectors'
import { parseYahooChart } from '../netlify/functions/lib/yahoo'
import { seedFromHistory } from '../shared/engine/backtest'
import type { Candle } from '../shared/types'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function fetchCandles2y(sym: string): Promise<Candle[] | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=2y&interval=1d`
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (MomentumBoard)' } })
    if (!res.ok) return null
    return parseYahooChart(await res.json(), sym).candles
  } catch {
    return null
  }
}

const universe = [...new Set([...Object.values(SECTOR_MEMBERS).flat(), ...SECTORS.map(s => s.sym)])]

const spy = await fetchCandles2y('SPY')
if (!spy) throw new Error('SPY candles unavailable — cannot seed')

const bySym = new Map<string, Candle[]>()
for (const sym of universe) {
  const candles = await fetchCandles2y(sym)
  if (candles && candles.length > 100) bySym.set(sym, candles)
  await sleep(200)
}
console.log(`fetched ${bySym.size}/${universe.length} symbols`)

const { weights, calibration } = seedFromHistory(bySym, spy)
const totalN = Object.values(calibration.buckets).reduce((s, b) => s + b.n, 0)
console.log(`graded ${totalN} synthetic outcomes across ${Object.keys(calibration.buckets).length} buckets`)
console.log('weights:', weights.current)

writeFileSync(
  new URL('../shared/engine/seed.json', import.meta.url),
  JSON.stringify({ generatedAt: new Date().toISOString(), symbols: bySym.size, weights, calibration }, null, 1),
)
console.log('wrote shared/engine/seed.json')
