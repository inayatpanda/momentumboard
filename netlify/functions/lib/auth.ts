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
}

export interface AuthResult {
  level: 'admin' | 'user'
  ns: string // storage namespace prefix: '' for admin, 'u:<id>:' for licensees
}

async function hash8(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(buf)].slice(0, 4).map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function authenticate(headers: Headers, env: { APP_TOKEN?: string }, store: AppStore): Promise<AuthResult | null> {
  const token = headers.get('x-app-token')
  if (!token) return null
  if (env.APP_TOKEN && token === env.APP_TOKEN) return { level: 'admin', ns: '' }
  const licences = (await store.read<Licence[]>('licences')) ?? []
  const lic = licences.find(l => l.key === token && !l.revoked)
  if (!lic) return null
  return { level: 'user', ns: `u:${await hash8(lic.key)}:` }
}

export function generateLicenceKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18))
  return 'mb_' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}
