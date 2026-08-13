import { acquireLease, appStore as blobAppStore, releaseLease } from './lib/storeProvider'
import { authenticate } from './lib/auth'
import { buildBoard, defaultDeps, gradeOutstanding, traceOpenIdeas } from './lib/engine'
import { internalFunctionUrl } from './lib/site'
import { validateConfig } from '../../shared/config'

// The engine's daily run, BEFORE the paper composes: grade what matured
// (that's the learning), curate the roster, score the board. Whatever happens,
// the composer is kicked afterwards — a dead engine must never kill the paper.

const SITE = process.env.URL ?? 'https://thestreetsignal.rqai.co.uk'

export default async (req: Request) => {
  const auth = await authenticate(req.headers, { APP_TOKEN: process.env.APP_TOKEN }, blobAppStore)
  if (auth?.level !== 'admin') return new Response('admin-only', { status: 401 })

  const nowSec = Math.floor(Date.now() / 1000)
  const leaseKey = 'lease:predict-background'
  const lease = await acquireLease(blobAppStore, leaseKey, nowSec, 15 * 60)
  if (!lease) return new Response('engine-run-already-in-progress', { status: 409 })
  const writeStatus = (phase: string, detail?: Record<string, unknown>) =>
    blobAppStore.write('engine-run-status', { startedAt: nowSec, updatedAt: Math.floor(Date.now() / 1000), phase, ...detail }).catch(() => {})
  await writeStatus('starting')
  const deps = defaultDeps({
    FINNHUB_API_KEY: process.env.FINNHUB_API_KEY,
    T212_API_KEY: process.env.T212_API_KEY,
    T212_SECRET_KEY: process.env.T212_SECRET_KEY,
    T212_HOST: process.env.T212_HOST,
  })
  let graded = 0
  let boardSize = -1
  let rosterSize = -1
  let holdingsCount = -1
  let failure: string | null = null
  try {
    const cfg = validateConfig(await blobAppStore.read('config'))
    graded = (await gradeOutstanding(blobAppStore, deps, nowSec, cfg)).graded
    await writeStatus('building-board', { graded })
    const built = await buildBoard(blobAppStore, deps, nowSec)
    // CALLS, not rows: a near miss cleared no gate and is not a call the run produced,
    // and a promoted observation is a row an ISA cannot place — neither is something
    // the reader can act on this morning. The watchdog's "N live calls" counts the
    // same way — the two must not disagree.
    boardSize = built.board.filter(b => !b.nearMiss && !b.observation).length
    rosterSize = built.rosterSize
    holdingsCount = built.holdingsCount
    // the £10k mock book trades the board it just built — fail-soft
    try {
      const { runPaperBook } = await import('./lib/paperBook')
      await writeStatus('paper-book', { graded, boardSize, rosterSize })
      const book = await runPaperBook(blobAppStore, deps, nowSec)
      console.log('PAPER-BOOK:', book.month, '| equity', book.history[book.history.length - 1]?.equity, '| open', book.positions.length, '| closed', book.closed.length)
    } catch (e) {
      console.error('PAPER-BOOK failed:', e)
    }
    // the open book: trace yesterday's still-open calls against today's board — fail-soft
    try {
      const { traced } = await traceOpenIdeas(blobAppStore, deps, nowSec)
      console.log('OPEN-TRACE:', traced, 'open calls re-checked')
    } catch (e) {
      console.error('OPEN-TRACE failed:', e)
    }
    console.log('PREDICT: graded', graded, '| board', boardSize, '| roster', rosterSize, '| holdings', holdingsCount, '| regime', built.regime)
    await writeStatus('completed', { completedAt: Math.floor(Date.now() / 1000), graded, boardSize, rosterSize, holdingsCount, regime: built.regime })
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e)
    console.error('PREDICT-FAILED:', e)
    await writeStatus('failed', { failedAt: Math.floor(Date.now() / 1000), error: failure.slice(0, 240), graded, boardSize, rosterSize, holdingsCount })
  } finally {
    try {
      const runlog = (await blobAppStore.read<unknown[]>('runlog')) ?? []
      runlog.push({ at: nowSec, kind: 'predict', ok: !failure && boardSize >= 0, error: failure?.slice(0, 160), graded, boardSize, rosterSize, holdingsCount })
      await blobAppStore.write('runlog', runlog.slice(-200))
      // chain to the composer regardless — it degrades to legacy mode without a
      // fresh board. The Actions orchestrator (scripts/bg/daily-run.mts) sets
      // SKIP_COMPOSE_CHAIN and runs the composer in-process instead: background
      // functions don't exist on the free plan, so this HTTP hop would 404 there.
      if (!process.env.SKIP_COMPOSE_CHAIN) {
        // Host-aware: `/.netlify/functions/...` on Netlify, `/api/fn/...` on
        // Pages/Workers — neither path exists on the other host (lib/site.ts).
        const composeUrl = internalFunctionUrl(SITE, 'report-compose-background')
        await fetch(composeUrl, {
          method: 'POST',
          headers: { 'x-app-token': process.env.APP_TOKEN ?? '' },
          // The chain is best-effort by design — the composer degrades to legacy
          // mode and the ledger is already written — but a kick that never lands
          // means no paper, and swallowing it silently is how you find that out
          // from a reader. One line, then carry on.
        }).catch(e => console.error('PREDICT: compose kick failed —', composeUrl, e))
      }
    } finally {
      await releaseLease(blobAppStore, leaseKey, lease)
    }
  }
  return new Response(boardSize >= 0 ? 'ok' : 'engine-failed-composer-kicked', { status: boardSize >= 0 ? 200 : 502 })
}
