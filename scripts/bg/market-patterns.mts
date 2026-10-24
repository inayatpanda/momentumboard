// Five free public price series. No paid APIs, credentials for market data or LLM calls.
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { PATTERN_ASSETS } from '../../shared/engine/marketPatterns'
import { parsePatternTape, buildMarketPatterns, type PatternTape } from '../lib/marketPatterns'
import { configureStoreForScript } from '../lib/configureStore'
import { appStore, acquireLease, releaseLease } from '../../netlify/functions/lib/storeProvider'
import type { EngineLabSnapshot } from '../../shared/engine/strategyLab'
const now = Math.floor(Date.now() / 1000), tapes: PatternTape[] = []
const start = Date.UTC(new Date(now * 1000).getUTCFullYear() - 20, 0, 1) / 1000
for (const { symbol } of PATTERN_ASSETS) {
  let tape: PatternTape | undefined
  for (let attempt = 0; attempt < 3 && !tape; attempt++) {
    try {
      const res = await fetch(`https://${attempt === 1 ? 'query2' : 'query1'}.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${start}&period2=${now}&interval=1d&events=div%2Csplits&includeAdjustedClose=true`, { headers: { 'User-Agent': 'Mozilla/5.0 (StreetSignal research)' }, signal: AbortSignal.timeout(25000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      tape = parsePatternTape(await res.json(), symbol, now)
    } catch (e) { console.warn(`${symbol}: ${String(e)}`); if (attempt < 2) await new Promise(r => setTimeout(r, 1500 * (attempt + 1))) }
  }
  if (!tape) throw new Error(`${symbol} unavailable; preserving previous snapshot`)
  tapes.push(tape)
}
const digest = createHash('sha256').update(JSON.stringify(tapes)).digest('hex')
const snapshot = buildMarketPatterns(tapes, now, digest)
await mkdir('.history-cache', { recursive: true })
await writeFile('.history-cache/market-patterns.json', JSON.stringify(snapshot, null, 2))
console.log(JSON.stringify({ from: snapshot.dataFrom, through: snapshot.dataThrough, dates: snapshot.observations, seasons: snapshot.seasonal.length, similar: snapshot.similar.map(s => s.date) }))
if (process.argv.includes('--publish')) {
  await configureStoreForScript()
  const key = 'lease:predict-background', lease = await acquireLease(appStore, key, Math.floor(Date.now() / 1000), 120)
  if (!lease) throw new Error('Engine busy; retry publication later')
  try {
    await appStore.write('engine-market-patterns', snapshot)
    const lab = await appStore.read<EngineLabSnapshot>('engine-lab')
    if (lab?.learning) {
      lab.learning.marketPatterns = snapshot
      await appStore.write('engine-research-learning', lab.learning)
      await appStore.write('engine-lab', lab)
    }
    console.log('Market patterns published')
  } finally { await releaseLease(appStore, key, lease) }
}
