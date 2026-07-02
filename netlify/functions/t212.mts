import type { Context } from '@netlify/functions'
import { blobAppStore } from './lib/store'
import { authenticate } from './lib/auth'
import { getCached, setCached } from './lib/cache'
import { fetchT212Positions } from './lib/t212lib'

// Trading 212 read-only integration. The user generates an API key in the T212
// app (Settings → API) with read scopes; it lives ONLY in Netlify env vars.
// We never place orders: portfolio and cash reads only. The fetch + normalization
// live in ./lib/t212lib so the daily engine run can reuse them.

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export default async (req: Request, _context: Context) => {
  const auth = await authenticate(req.headers, { APP_TOKEN: process.env.APP_TOKEN }, blobAppStore)
  if (auth?.level !== 'admin') return json(401, { ok: false, error: 'admin-only' }) // it is YOUR brokerage account

  if (!process.env.T212_API_KEY) return json(200, { ok: true, data: { unconfigured: true } })

  const hit = await getCached<unknown>('t212-portfolio')
  if (hit) return json(200, { ok: true, data: hit })

  const positions = await fetchT212Positions({
    T212_API_KEY: process.env.T212_API_KEY,
    T212_SECRET_KEY: process.env.T212_SECRET_KEY,
    T212_HOST: process.env.T212_HOST,
  })
  if (!positions) return json(502, { ok: false, error: 't212-fetch-failed' })

  const data = { unconfigured: false, positions, at: Math.floor(Date.now() / 1000) }
  await setCached('t212-portfolio', data, 60)
  return json(200, { ok: true, data })
}
