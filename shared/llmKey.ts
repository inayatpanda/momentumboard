// THE ONE PLACE the BYOK Groq credential's shape and transport are decided.
//
// Three files need the same two facts and must never drift: the device store
// (src/lib/deviceLlm.ts) validating what the reader typed, and the two server
// routes (market-data.mts, ai-insights.mts) deciding whether an inbound header
// is even worth sending to Groq. A regex copied three times is how a key that
// saves on the phone starts 400ing on the server.

/** Groq's own key shape: `gsk_` plus base64url-ish body. Deliberately a SHAPE
 * check, not a validity check — only Groq can say whether a key works, which
 * is what `type=llm-probe` is for. */
export const GROQ_KEY_RE = /^gsk_[A-Za-z0-9_-]{12,196}$/

export function isGroqKeyShape(key: string | null | undefined): boolean {
  return !!key && GROQ_KEY_RE.test(key.trim())
}

/** The header a device-held key rides on. Attached by `apiLlmGet` and by
 * nothing else, so it reaches ONLY the four endpoints that invoke an LLM.
 *
 * Adding it here is half the job: it is a custom header, so the desktop
 * shell's cross-origin calls preflight, and functions/cors.ts must list it in
 * `Access-Control-Allow-Headers` or BYOK silently dies on the DMG only. */
export const DEVICE_LLM_HEADER = 'x-groq-api-key'

/** Where the key that served a request came from. `'server'` is the migration
 * tell: the reader still has a key in the old server-side blob, so the client
 * shows the "move it to this device" notice. Absent means device (or the
 * owner's own server env, which is nobody's business to migrate). */
export type LlmKeySource = 'device' | 'server'
