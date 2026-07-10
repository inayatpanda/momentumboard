import { blobAppStore } from './lib/store'
import { publishBulletin } from './lib/bulletins'
import { isUsMarketHoliday } from '../../shared/usMarketHolidays'

// The 5pm-ish UK wrap: LSE just closed, US mid-session. Cron is UTC: 16:05 UTC
// = 17:05 UK in summer (BST); 16:05 UK in winter — accepted drift.
export default async (req: Request) => {
  // fire only for the scheduler (body carries next_run) or the admin token —
  // an open URL that sends emails is a spam vector
  const body = await req.text().catch(() => '')
  const scheduled = body.includes('next_run')
  const admin = req.headers.get('x-app-token') === process.env.APP_TOKEN
  if (!scheduled && !admin) return new Response('forbidden', { status: 401 })
  // no US session to wrap up on a market holiday — "how the day went" would be noise
  if (isUsMarketHoliday(new Date().toISOString().slice(0, 10))) return new Response('holiday-skip')
  await publishBulletin('evening', blobAppStore).catch(e => console.error('BULLETIN-EVENING failed:', e))
  return new Response('ok')
}

export const config = { schedule: '5 16 * * 1-5' }
