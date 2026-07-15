import type { AppStore } from './store'

// Licensing: the site owner's APP_TOKEN is the ADMIN licence. Further licence
// keys are generated in-app (admin only) and grant user-level access with
// their own namespaced server data. Admin data keeps the legacy (unprefixed)
// keys so routines and history are untouched.

export interface Licence {
  key: string
  label: string
  createdAt: number
  revoked?: boolean
  expiresAt?: number // unix sec; absent = perpetual. Trials expire, Helm licences don't.
  trial?: boolean // self-served 7-day reader pass (landing page), not a Helm-issued licence
  house?: boolean // the owner's own device: AI features ride the server's keys (a plain licensee brings their own)
}

export interface AuthResult {
  level: 'admin' | 'user'
  ns: string // storage namespace prefix: '' for admin, 'u:<id>:' for licensees
  house?: boolean // carried from the licence — grants server-key LLM access without admin powers
}

export async function hash8(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(buf)].slice(0, 4).map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function authenticate(headers: Headers, env: { APP_TOKEN?: string }, store: AppStore): Promise<AuthResult | null> {
  const token = headers.get('x-app-token')
  if (!token) return null
  if (env.APP_TOKEN && token === env.APP_TOKEN) return { level: 'admin', ns: '' }
  let licences = (await store.read<Licence[]>('licences')) ?? []
  let lic = licences.find(l => l.key === token && !l.revoked)
  // MISS → one strong-consistency retry. Blob reads are eventual, so a key
  // minted moments ago can be absent from an edge replica — that stale 401
  // bounced brand-new readers straight off their unlock links (live-repro
  // 2026-07-11: a 2-minute-old licence 401'd, then validated fine). A miss is
  // rare, so the slower strong read costs nothing on the happy path.
  if (!lic && store.readStrong) {
    licences = (await store.readStrong<Licence[]>('licences')) ?? []
    lic = licences.find(l => l.key === token && !l.revoked)
  }
  if (!lic) return null
  if (lic.expiresAt && lic.expiresAt < Math.floor(Date.now() / 1000)) return null // trial lapsed — server says no
  return { level: 'user', ns: `u:${await hash8(lic.key)}:`, house: lic.house || undefined }
}

export function generateLicenceKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18))
  return 'mb_' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Freshest possible licence list — strong read when the store offers one. */
export async function readLicencesFresh(store: AppStore): Promise<Licence[]> {
  return (store.readStrong ? await store.readStrong<Licence[]>('licences') : null) ?? (await store.read<Licence[]>('licences')) ?? []
}

/** Add a licence with a verify-after-write loop. Plain read-modify-write LOST
 * half of ten rapid sequential mints on 2026-07-11 — each POST read a stale
 * replica missing the previous POST's key and overwrote it. Strong reads plus
 * a read-back retry make sequential mints safe; true simultaneous mints remain
 * theoretically racy but no longer silently so (callers get false back). */
export async function addLicenceVerified(store: AppStore, lic: Licence): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const list = await readLicencesFresh(store)
    if (!list.some(l => l.key === lic.key)) {
      list.push(lic)
      await store.write('licences', list)
    }
    const back = await readLicencesFresh(store)
    if (back.some(l => l.key === lic.key)) return true
  }
  return false
}
