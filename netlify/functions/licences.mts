import type { Context } from '@netlify/functions'
import { blobAppStore, type AppStore } from './lib/store'
import { authenticate, generateLicenceKey, hash8, type Licence } from './lib/auth'

// Licence management: admin list/generate/revoke, plus two PUBLIC routes —
// a rate-limited 7-day trial mint (the landing page's "free access") and a
// cheap token check (lets the client detect an expired trial on boot).
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const TRIAL_DAYS = 7
const TRIAL_PER_IP_WEEK = 2 // same device asking again inside a week = go get a licence
const TRIAL_GLOBAL_PER_DAY = 25 // circuit breaker against scripted minting

export async function routeLicences(
  method: string,
  headers: Headers,
  bodyText: string | null,
  env: { APP_TOKEN?: string; URL?: string },
  store: AppStore,
  check = false,
): Promise<Response> {
  const nowSec = Math.floor(Date.now() / 1000)

  // PUBLIC: token check — 200 with the level, or 401 (revoked/expired/unknown).
  // The client calls this on boot so a lapsed trial lands on the landing page
  // instead of a screen full of failed requests.
  if (method === 'GET' && check) {
    const who = await authenticate(headers, env, store)
    return who ? json(200, { ok: true, data: { level: who.level } }) : json(401, { ok: false, error: 'invalid-or-expired' })
  }

  // PUBLIC: self-served trial. No auth by design; abuse is bounded by the
  // per-IP and global caps, and every trial expires server-side in auth.ts.
  if (method === 'POST' && bodyText) {
    let wantsTrial = false
    try {
      wantsTrial = (JSON.parse(bodyText) as { trial?: boolean }).trial === true
    } catch {
      /* not JSON — falls through to the admin routes' own parsing */
    }
    if (wantsTrial) {
      const ip = headers.get('x-nf-client-connection-ip') ?? headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
      const ipHash = await hash8(ip)
      const issues = ((await store.read<{ ipHash: string; at: number }[]>('trial-issues')) ?? []).filter(i => nowSec - i.at < 7 * 86_400)
      if (issues.filter(i => i.ipHash === ipHash).length >= TRIAL_PER_IP_WEEK) return json(429, { ok: false, error: 'trial-limit' })
      if (issues.filter(i => nowSec - i.at < 86_400).length >= TRIAL_GLOBAL_PER_DAY) return json(429, { ok: false, error: 'trial-limit' })
      const trialLicences = (await store.read<Licence[]>('licences')) ?? []
      const lic: Licence = { key: generateLicenceKey(), label: `trial-${ipHash}`, createdAt: nowSec, expiresAt: nowSec + TRIAL_DAYS * 86_400, trial: true }
      trialLicences.push(lic)
      await store.write('licences', trialLicences)
      await store.write('trial-issues', [...issues, { ipHash, at: nowSec }])
      return json(200, { ok: true, data: { key: lic.key, expiresAt: lic.expiresAt } })
    }
  }

  const auth = await authenticate(headers, env, store)
  if (auth?.level !== 'admin') return json(401, { ok: false, error: 'admin-only' })

  const licences = (await store.read<Licence[]>('licences')) ?? []

  if (method === 'GET') {
    return json(200, { ok: true, data: licences.map(l => ({ ...l, unlockLink: `${env.URL ?? 'https://thestreetsignal.netlify.app'}/?key=${l.key}` })) })
  }

  if (method === 'POST') {
    const label = (bodyText ? (JSON.parse(bodyText) as { label?: string }).label : '') || `licence-${licences.length + 1}`
    // the cap protects the Helm-issued seats — self-served trials don't count against it
    if (licences.filter(l => !l.revoked && !l.trial).length >= 25) return json(400, { ok: false, error: 'licence-cap' })
    const lic: Licence = { key: generateLicenceKey(), label: label.slice(0, 40), createdAt: Math.floor(Date.now() / 1000) }
    licences.push(lic)
    await store.write('licences', licences)
    return json(200, { ok: true, data: { ...lic, unlockLink: `${env.URL ?? 'https://thestreetsignal.netlify.app'}/?key=${lic.key}` } })
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
  routeLicences(
    req.method,
    req.headers,
    req.method === 'GET' ? null : await req.text(),
    { APP_TOKEN: process.env.APP_TOKEN, URL: process.env.URL },
    blobAppStore,
    new URL(req.url).searchParams.get('check') === '1',
  )
