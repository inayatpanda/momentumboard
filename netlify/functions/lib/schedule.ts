import { appStore as blobAppStore } from './storeProvider'

/**
 * Netlify scheduled functions are reachable at their public
 * `/.netlify/functions/<name>` URL, and Netlify's cron gives the handler no
 * secret to prove an invocation really came from the scheduler — the body only
 * carries `next_run`, a fixed string any caller can replay (the audit's C-1).
 * Rather than trust an unauthenticatable signal, we BOUND abuse: a
 * side-effecting run is allowed at most once per `windowSec`, tracked in a blob
 * slot. The genuine cron run is the first in its window and passes; a flood of
 * public hits is throttled to no-ops. An admin token (manual / CI trigger)
 * always bypasses the window.
 *
 * This is a rate BOUND, not authentication: a determined attacker can still
 * cause at most one run per window. The complete fix is to remove the public
 * trigger entirely and drive these from the authenticated CI runner — noted in
 * the overnight report for the owner to decide, since it trades Netlify-cron
 * reliability for GitHub-Actions cron drift.
 */
export async function claimScheduleSlot(
  name: string,
  windowSec: number,
  adminOk: boolean,
  store: Pick<typeof blobAppStore, 'read' | 'write'> = blobAppStore,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (adminOk) return true
  const key = `sched-slot:${name}`
  const last = await store.read<number>(key).catch(() => null)
  if (typeof last === 'number' && nowSec - last < windowSec) return false // already ran this window
  await store.write(key, nowSec).catch(() => {})
  return true
}
