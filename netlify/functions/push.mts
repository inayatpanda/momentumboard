import type { Context } from '@netlify/functions'
import { blobAppStore, type AppStore } from './lib/store'

// Web Push device registry. GET serves the public VAPID key (not a secret);
// POST (app token) registers this device's subscription. Up to 6 devices.

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export interface PushSub {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export async function routePush(
  method: string,
  headers: Headers,
  bodyText: string | null,
  env: { APP_TOKEN?: string; VAPID_PUBLIC_KEY?: string },
  store: AppStore,
): Promise<Response> {
  if (method === 'GET') {
    return json(200, { ok: true, data: { publicKey: env.VAPID_PUBLIC_KEY ?? null } })
  }
  if (!env.APP_TOKEN || headers.get('x-app-token') !== env.APP_TOKEN) return json(401, { ok: false, error: 'unauthorized' })

  if (method === 'POST') {
    let sub: PushSub
    try {
      sub = JSON.parse(bodyText ?? '')
    } catch {
      return json(400, { ok: false, error: 'invalid-json' })
    }
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return json(400, { ok: false, error: 'invalid-subscription' })
    const subs = ((await store.read<PushSub[]>('push-subs')) ?? []).filter(s => s.endpoint !== sub.endpoint)
    subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } })
    await store.write('push-subs', subs.slice(-6))
    return json(200, { ok: true, data: { devices: subs.length } })
  }

  if (method === 'DELETE') {
    const endpoint = bodyText ? (JSON.parse(bodyText) as { endpoint?: string }).endpoint : null
    const subs = ((await store.read<PushSub[]>('push-subs')) ?? []).filter(s => s.endpoint !== endpoint)
    await store.write('push-subs', subs)
    return json(200, { ok: true, data: { devices: subs.length } })
  }

  return json(405, { ok: false, error: 'method-not-allowed' })
}

export default async (req: Request, _context: Context) =>
  routePush(
    req.method,
    req.headers,
    req.method === 'GET' ? null : await req.text(),
    { APP_TOKEN: process.env.APP_TOKEN, VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY },
    blobAppStore,
  )
