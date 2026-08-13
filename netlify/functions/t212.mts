import type { Context } from '@netlify/functions'
import { appStore as blobAppStore, type AppStore } from './lib/storeProvider'
import { authenticate } from './lib/auth'
import { getCached, setCached } from './lib/cache'
import { fetchT212Positions } from './lib/t212lib'

// Trading 212 read-only integration, per account:
//  - The OWNER's key lives ONLY in Netlify env vars (T212_API_KEY/_SECRET_KEY).
//  - LICENSEES may connect their own key pair (BYO, like the AI key): stored in
//    their private namespace blob `${ns}t212`, used only for their requests,
//    validated LIVE against T212 before it is ever stored.
// We never place orders: portfolio and cash reads only. The fetch +
// normalization live in ./lib/t212lib so the daily engine run can reuse them.
//
//   GET    /api/t212           → cached portfolio (60s, namespace-keyed)
//   GET    /api/t212?view=key  → { connected, source: 'env'|'own'|null } (never echoes keys)
//   PUT    /api/t212           → { apiKey, secret? } validate + store own key
//   DELETE /api/t212           → disconnect own key

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface StoredT212 {
  apiKey?: string
  secret?: string
}

export async function routeT212(
  req: Request,
  env: { APP_TOKEN?: string; T212_API_KEY?: string; T212_SECRET_KEY?: string; T212_HOST?: string },
  store: AppStore,
  deps: { fetchPositions?: typeof fetchT212Positions; cacheGet?: typeof getCached; cacheSet?: typeof setCached } = {},
): Promise<Response> {
  const fetchPositions = deps.fetchPositions ?? fetchT212Positions
  const cacheGet = deps.cacheGet ?? getCached
  const cacheSet = deps.cacheSet ?? setCached

  const auth = await authenticate(req.headers, env, store)
  if (!auth) return json(401, { ok: false, error: 'unauthorized' })
  const { ns } = auth
  // the env key pair is the OWNER's brokerage account — admin only, never licensees
  const envCreds = auth.level === 'admin' && env.T212_API_KEY ? { T212_API_KEY: env.T212_API_KEY, T212_SECRET_KEY: env.T212_SECRET_KEY, T212_HOST: env.T212_HOST } : null

  const url = new URL(req.url)
  const method = req.method.toUpperCase()

  if (method === 'GET' && url.searchParams.get('view') === 'key') {
    if (envCreds) return json(200, { ok: true, data: { connected: true, source: 'env' } })
    const own = await store.read<StoredT212>(`${ns}t212`)
    return json(200, { ok: true, data: { connected: !!own?.apiKey, source: own?.apiKey ? 'own' : null } }) // never echo the key itself
  }

  if (method === 'PUT') {
    if (envCreds) return json(400, { ok: false, error: 'env-configured' }) // the owner manages the key in Netlify env
    const body = (await req.text().then(t => (t ? JSON.parse(t) : {})).catch(() => null)) as StoredT212 | null
    const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : ''
    const secret = typeof body?.secret === 'string' ? body.secret.trim() : ''
    if (!apiKey || apiKey.length > 200 || secret.length > 200) return json(400, { ok: false, error: 'invalid-key' })
    // validate against T212 BEFORE storing — a key that can't read a portfolio never lands
    const positions = await fetchPositions({ T212_API_KEY: apiKey, T212_SECRET_KEY: secret || undefined, T212_HOST: env.T212_HOST })
    if (!positions) return json(400, { ok: false, error: 't212-rejected' })
    await store.write(`${ns}t212`, { apiKey, ...(secret ? { secret } : {}) })
    await cacheSet(`${ns}t212-portfolio`, { unconfigured: false, positions, at: Math.floor(Date.now() / 1000) }, 60)
    return json(200, { ok: true })
  }

  if (method === 'DELETE') {
    if (envCreds) return json(400, { ok: false, error: 'env-configured' })
    await store.write(`${ns}t212`, {})
    await cacheSet(`${ns}t212-portfolio`, null, 1) // don't serve a stale portfolio after disconnect
    return json(200, { ok: true })
  }

  // GET portfolio — resolve creds: owner env pair, else the caller's own stored pair
  let creds = envCreds
  if (!creds) {
    const own = await store.read<StoredT212>(`${ns}t212`)
    if (own?.apiKey) creds = { T212_API_KEY: own.apiKey, T212_SECRET_KEY: own.secret, T212_HOST: env.T212_HOST }
  }
  if (!creds) return json(200, { ok: true, data: { unconfigured: true } })

  const cacheKey = `${ns}t212-portfolio` // ns-keyed: one reader's holdings must never serve another's request
  const hit = await cacheGet<unknown>(cacheKey)
  if (hit) return json(200, { ok: true, data: hit })

  const positions = await fetchPositions(creds)
  if (!positions) return json(502, { ok: false, error: 't212-fetch-failed' })

  const data = { unconfigured: false, positions, at: Math.floor(Date.now() / 1000) }
  await cacheSet(cacheKey, data, 60)
  return json(200, { ok: true, data })
}

export default async (req: Request, _context: Context) =>
  routeT212(
    req,
    {
      APP_TOKEN: process.env.APP_TOKEN,
      T212_API_KEY: process.env.T212_API_KEY,
      T212_SECRET_KEY: process.env.T212_SECRET_KEY,
      T212_HOST: process.env.T212_HOST,
    },
    blobAppStore,
  )
