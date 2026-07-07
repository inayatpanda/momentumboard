import { blobAppStore } from './lib/store'
import { publishBulletin } from './lib/bulletins'

// ~45 min before the US open. Cron is UTC: 12:45 UTC = 13:45 UK / 08:45 ET in
// summer (BST/EDT); in winter the same cron lands 12:45 UK / 07:45 ET — still
// comfortably pre-open, so the drift is accepted rather than juggled.
export default async (req: Request) => {
  // fire only for the scheduler (body carries next_run) or the admin token —
  // an open URL that sends emails is a spam vector
  const body = await req.text().catch(() => '')
  const scheduled = body.includes('next_run')
  const admin = req.headers.get('x-app-token') === process.env.APP_TOKEN
  if (!scheduled && !admin) return new Response('forbidden', { status: 401 })
  await publishBulletin('premarket', blobAppStore).catch(e => console.error('BULLETIN-PREMARKET failed:', e))
  return new Response('ok')
}

export const config = { schedule: '45 12 * * 1-5' }
