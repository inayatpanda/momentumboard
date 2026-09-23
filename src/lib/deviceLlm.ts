// The reader's Groq credential, held in THIS browser profile's IndexedDB.
//
// Preferred over the old server-stored copy, and the only place a key is
// written from now on: it is never mirrored by configMirror, never PUT to the
// server store, and never leaves the device except as a request header on the
// four endpoints that actually call an LLM.
//
// TRANSITION, NOT A CUTOVER (see netlify/functions/market-data.mts): licensees
// who stored a key on the server before this release keep working — the server
// still reads that copy when no header arrives, and says so via
// `llmKeySource: 'server'` so Settings can ask for it once, on-device. The
// server never hands the old key back, so migration is a re-entry, not a copy.

import { db } from './db'
import { DEVICE_LLM_HEADER, isGroqKeyShape } from '../../shared/llmKey'

const GROQ_KEY_SETTING = 'groqApiKey'

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
  if (!isGroqKeyShape(clean)) throw new Error('invalid-key')
  await db.settings.put({ key: GROQ_KEY_SETTING, value: clean })
}

export async function clearDeviceGroqKey(): Promise<void> {
  await db.settings.delete(GROQ_KEY_SETTING)
}

/** Only attach the credential to endpoints that actually invoke an LLM.
 * `keyOverride` is the Settings probe testing a key BEFORE it is stored. */
export async function deviceLlmHeader(keyOverride?: string): Promise<Record<string, string>> {
  const key = keyOverride?.trim() || (await getDeviceGroqKey())
  return key ? { [DEVICE_LLM_HEADER]: key } : {}
}
