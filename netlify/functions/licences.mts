import type { Context } from '@netlify/functions'
import { blobAppStore, type AppStore } from './lib/store'
import { authenticate, generateLicenceKey, type Licence } from './lib/auth'

// Admin-only licence management: list, generate, revoke.
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export async function routeLicences(
  method: string,
  headers: Headers,
  bodyText: string | null,
  env: { APP_TOKEN?: string; URL?: string },
  store: AppStore,
): Promise<Response> {
  const auth = await authenticate(headers, env, store)
  if (auth?.level !== 'admin') return json(401, { ok: false, error: 'admin-only' })

  const licences = (await store.read<Licence[]>('licences')) ?? []

  if (method === 'GET') {
    return json(200, { ok: true, data: licences.map(l => ({ ...l, unlockLink: `${env.URL ?? 'https://streetsignal.netlify.app'}/?key=${l.key}` })) })
  }

  if (method === 'POST') {
    const label = (bodyText ? (JSON.parse(bodyText) as { label?: string }).label : '') || `licence-${licences.length + 1}`
    if (licences.filter(l => !l.revoked).length >= 25) return json(400, { ok: false, error: 'licence-cap' })
    const lic: Licence = { key: generateLicenceKey(), label: label.slice(0, 40), createdAt: Math.floor(Date.now() / 1000) }
    licences.push(lic)
    await store.write('licences', licences)
    return json(200, { ok: true, data: { ...lic, unlockLink: `${env.URL ?? 'https://streetsignal.netlify.app'}/?key=${lic.key}` } })
  }

  if (method === 'DELETE') {
    const key = bodyText ? (JSON.parse(bodyText) as { key?: string }).key : null
    const lic = licences.find(l => l.key === key)
    if (!lic) return json(404, { ok: false, error: 'not-found' })
    lic.revoked = true
    await store.write('licences', licences)
    return json(200, { ok: true })
  }

  return json(405, { ok: false, error: 'method-not-allowed' })
}

export default async (req: Request, _context: Context) =>
  routeLicences(req.method, req.headers, req.method === 'GET' ? null : await req.text(), { APP_TOKEN: process.env.APP_TOKEN, URL: process.env.URL }, blobAppStore)
