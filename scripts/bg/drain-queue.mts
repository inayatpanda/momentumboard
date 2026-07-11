// The work-queue drain, GitHub Actions edition (cron ~every 15 min). Netlify's
// scheduled functions (alert-check, watchdog) enqueue long jobs into the
// `work-queue` blob — video analysis, event dossiers, a compose retry — and
// this worker executes them by calling the SAME handler modules the old
// background-function HTTP kicks used to reach. Leased so overlapping runs
// (or a manual dispatch during the cron) can't double-process.

import { acquireLease, blobAppStore, releaseLease } from '../../netlify/functions/lib/store'

interface WorkItem {
  id: string
  kind: 'video' | 'dossier' | 'compose'
  body: unknown
  at: number
  attempts: number
}

const MAX_ITEMS_PER_RUN = 8
const MAX_ATTEMPTS = 3

const adminReq = (body?: unknown) =>
  new Request('https://actions.local/', {
    method: 'POST',
    headers: { 'x-app-token': process.env.APP_TOKEN ?? '', 'content-type': 'application/json' },
    ...(body != null ? { body: JSON.stringify(body) } : {}),
  })

const runItem = async (item: WorkItem): Promise<boolean> => {
  try {
    if (item.kind === 'video') {
      const { default: handler } = await import('../../netlify/functions/video-analyze-background.mts')
      const res = await handler(adminReq(item.body))
      console.log(`video ${((item.body as { title?: string })?.title ?? '').slice(0, 60)}: ${res.status}`)
      return res.status < 400
    }
    if (item.kind === 'dossier') {
      const { default: handler } = await import('../../netlify/functions/event-dossier-background.mts')
      const res = await handler(adminReq(item.body))
      console.log(`dossier: ${res.status}`)
      return res.status < 400
    }
    if (item.kind === 'compose') {
      const { default: handler } = await import('../../netlify/functions/report-compose-background.mts')
      const res = await handler(adminReq())
      console.log(`compose retry: ${res.status}`)
      return res.status < 400
    }
    console.log(`unknown work kind ${(item as { kind?: string }).kind} — dropping`)
    return true
  } catch (e) {
    console.error(`work item ${item.kind} threw:`, e)
    return false
  }
}

const run = async () => {
  const nowSec = Math.floor(Date.now() / 1000)
  const lease = await acquireLease(blobAppStore, 'lease:queue-worker', nowSec, 12 * 60)
  if (!lease) {
    console.log('another worker holds the lease — exiting')
    return
  }
  try {
    const queue = (await blobAppStore.read<WorkItem[]>('work-queue')) ?? []
    if (!queue.length) {
      console.log('queue empty')
      return
    }
    const batch = queue.slice(0, MAX_ITEMS_PER_RUN)
    console.log(`draining ${batch.length} of ${queue.length} item(s)…`)
    const done = new Set<string>()
    const failed = new Set<string>()
    for (const item of batch) {
      if (await runItem(item)) done.add(item.id)
      else failed.add(item.id)
    }
    // re-read before writing: alert-check may have enqueued while we worked
    const fresh = (await blobAppStore.read<WorkItem[]>('work-queue')) ?? []
    const next = fresh
      .filter(i => !done.has(i.id))
      .map(i => (failed.has(i.id) ? { ...i, attempts: (i.attempts ?? 0) + 1 } : i))
      .filter(i => {
        if ((i.attempts ?? 0) >= MAX_ATTEMPTS) {
          console.log(`dropping ${i.kind} ${i.id} after ${i.attempts} attempts`)
          return false
        }
        return true
      })
    await blobAppStore.write('work-queue', next)
    console.log(`done: ${done.size} ok, ${failed.size} failed, ${next.length} left in queue`)
  } finally {
    await releaseLease(blobAppStore, 'lease:queue-worker', lease)
  }
}

run().catch(e => {
  console.error('drain-queue failed:', e)
  process.exit(1)
})
