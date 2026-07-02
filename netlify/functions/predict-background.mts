import { blobAppStore } from './lib/store'
import { authenticate } from './lib/auth'
import { buildBoard, defaultDeps, gradeOutstanding } from './lib/engine'
import { validateConfig } from '../../shared/config'

// The engine's daily run, BEFORE the paper composes: grade what matured
// (that's the learning), curate the roster, score the board. Whatever happens,
// the composer is kicked afterwards — a dead engine must never kill the paper.

const SITE = process.env.URL ?? 'https://streetsignal.netlify.app'

export default async (req: Request) => {
  const auth = await authenticate(req.headers, { APP_TOKEN: process.env.APP_TOKEN }, blobAppStore)
  if (auth?.level !== 'admin') return new Response('admin-only', { status: 401 })

  const nowSec = Math.floor(Date.now() / 1000)
  const deps = defaultDeps({ FINNHUB_API_KEY: process.env.FINNHUB_API_KEY })
  let graded = 0
  let boardSize = -1
  let rosterSize = -1
  try {
    const cfg = validateConfig(await blobAppStore.read('config'))
    graded = (await gradeOutstanding(blobAppStore, deps, nowSec, cfg)).graded
    const built = await buildBoard(blobAppStore, deps, nowSec)
    boardSize = built.board.length
    rosterSize = built.rosterSize
    console.log('PREDICT: graded', graded, '| board', boardSize, '| roster', rosterSize, '| regime', built.regime)
  } catch (e) {
    console.error('PREDICT-FAILED:', e)
  } finally {
    const runlog = (await blobAppStore.read<unknown[]>('runlog')) ?? []
    runlog.push({ at: nowSec, kind: 'predict', graded, boardSize, rosterSize })
    await blobAppStore.write('runlog', runlog.slice(-200))
    // chain to the composer regardless — it degrades to legacy mode without a fresh board
    await fetch(`${SITE}/.netlify/functions/report-compose-background`, {
      method: 'POST',
      headers: { 'x-app-token': process.env.APP_TOKEN ?? '' },
    }).catch(() => {})
  }
  return new Response(boardSize >= 0 ? 'ok' : 'engine-failed-composer-kicked', { status: boardSize >= 0 ? 200 : 502 })
}
