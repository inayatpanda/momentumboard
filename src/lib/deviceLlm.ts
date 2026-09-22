import { db } from './db'

const GROQ_KEY_SETTING = 'groqApiKey'

/**
 * The Groq credential is deliberately kept in this browser profile's IndexedDB.
 * It is never mirrored by configMirror and never written to the server store.
 */
export async function getDeviceGroqKey(): Promise<string | null> {
  const row = await db.settings.get(GROQ_KEY_SETTING)
  const key = row?.value.trim() ?? ''
  return key || null
}

export async function hasDeviceGroqKey(): Promise<boolean> {
  return !!(await getDeviceGroqKey())
}

export async function setDeviceGroqKey(key: string): Promise<void> {
  const clean = key.trim()
  if (!/^gsk_[A-Za-z0-9_-]{12,196}$/.test(clean)) throw new Error('invalid-key')
  await db.settings.put({ key: GROQ_KEY_SETTING, value: clean })
}

export async function clearDeviceGroqKey(): Promise<void> {
  await db.settings.delete(GROQ_KEY_SETTING)
}

/** Only attach the credential to endpoints that actually invoke an LLM. */
export async function deviceLlmHeader(keyOverride?: string): Promise<Record<string, string>> {
  const key = keyOverride?.trim() || (await getDeviceGroqKey())
  return key ? { 'x-groq-api-key': key } : {}
}
