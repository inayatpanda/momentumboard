import { blobAppStore } from './lib/store'
import { publishBulletin } from './lib/bulletins'
import { isUsMarketHoliday } from '../../shared/usMarketHolidays'

// ~45 min before the US open. Cron is UTC: 12:45 UTC = 13:45 UK / 08:45 ET in
// summer (BST/EDT); in winter the same cron lands 12:45 UK / 07:45 ET — still
// comfortably pre-open, so the drift is accepted rather than juggled.
export default async (req: Request) => {
  // An open URL that sends bulletins is a spam vector. `next_run` is not a
  // secret (audit C-1) so we rate-BOUND public triggers to the real cadence:
  // at most one send per window, admin token bypasses.
  const admin = req.headers.get('x-app-token') === process.env.APP_TOKEN
  const { claimScheduleSlot } = await import('./lib/schedule')
  if (!(await claimScheduleSlot('bulletin-premarket', 3600, admin))) return new Response('throttled', { status: 429 })
  // no US open to call on a market holiday — a "pre-market brief" would be noise
  if (isUsMarketHoliday(new Date().toISOString().slice(0, 10))) return new Response('holiday-skip')
  await publishBulletin('premarket', blobAppStore).catch(e => console.error('BULLETIN-PREMARKET failed:', e))
  return new Response('ok')
}

export const config = { schedule: '45 12 * * 1-5' }
