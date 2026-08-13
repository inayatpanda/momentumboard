import { appStore as blobAppStore } from './lib/storeProvider'
import { publishBulletin } from './lib/bulletins'
import { isUsMarketHoliday } from '../../shared/usMarketHolidays'

// The 5pm-ish UK wrap: LSE just closed, US mid-session. Cron is UTC: 16:05 UTC
// = 17:05 UK in summer (BST); 16:05 UK in winter — accepted drift.
export default async (req: Request) => {
  // An open URL that sends bulletins is a spam vector. Reject non-scheduler /
  // non-admin requests, AND (since `next_run` is a guessable string, audit C-1)
  // rate-BOUND whatever passes to the real cadence: at most one send per window.
  const body = await req.text().catch(() => '')
  const admin = req.headers.get('x-app-token') === process.env.APP_TOKEN
  if (!admin && !body.includes('next_run')) return new Response('forbidden', { status: 401 })
  const { claimScheduleSlot } = await import('./lib/schedule')
  if (!(await claimScheduleSlot('bulletin-evening', 3600, admin))) return new Response('throttled', { status: 429 })
  // no US session to wrap up on a market holiday — "how the day went" would be noise
  if (isUsMarketHoliday(new Date().toISOString().slice(0, 10))) return new Response('holiday-skip')
  await publishBulletin('evening', blobAppStore).catch(e => console.error('BULLETIN-EVENING failed:', e))
  return new Response('ok')
}

export const config = { schedule: '5 16 * * 1-5' }
