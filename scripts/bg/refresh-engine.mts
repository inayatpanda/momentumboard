// Manual research refresh: no newspaper, messaging, or brokerage operations.
import { configureStoreForScript } from '../lib/configureStore'
import { acquireLease, releaseLease, appStore } from '../../netlify/functions/lib/storeProvider'
import { buildBoard, defaultDeps } from '../../netlify/functions/lib/engine'

await configureStoreForScript()
const startedAt = Math.floor(Date.now() / 1000)
const key = 'lease:predict-background'
const lease = await acquireLease(appStore, key, startedAt, 15 * 60)
if (!lease) throw new Error('Another engine run is active; retry after it completes.')
try {
  await appStore.write('engine-run-status', { startedAt, updatedAt: startedAt, phase: 'building-board', manualRefresh: true })
  const built = await buildBoard(appStore, defaultDeps({ FINNHUB_API_KEY: process.env.FINNHUB_API_KEY }), startedAt)
  const completedAt = Math.floor(Date.now() / 1000)
  await appStore.write('engine-run-status', { startedAt, updatedAt: completedAt, completedAt, phase: 'completed', manualRefresh: true,
    boardSize: built.board.filter(b => !b.nearMiss && !b.observation).length, rosterSize: built.rosterSize, regime: built.regime })
  console.log(JSON.stringify({ completed: true, date: new Date(startedAt * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' }), rows: built.board.length, regime: built.regime }))
} catch (error) {
  const failedAt = Math.floor(Date.now() / 1000)
  await appStore.write('engine-run-status', { startedAt, updatedAt: failedAt, failedAt, phase: 'failed', manualRefresh: true })
  throw error
} finally {
  await releaseLease(appStore, key, lease)
}
