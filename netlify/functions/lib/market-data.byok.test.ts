// BYOK, DURING THE TRANSITION (engine/device-key).
//
// The key moved to the reader's own device (IndexedDB → `x-groq-api-key`), and
// the server-stored `${ns}llm` blob is the thing being retired. Retired is not
// the same as gone: a licensee who saved a key before this release still has
// working AI on every device they already use, and the response tells the
// client where the key came from so Settings can ask for it on-device once.
//
// These pin the ladder — header > server env (admin/house) > stored blob — and
// prove the stored branch announces itself while the device branch stays silent.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { routeRequest } from '../market-data.mts'
import { appStore } from './storeProvider'

const llmMock = vi.hoisted(() => ({ callLlm: vi.fn(), modelFor: vi.fn(() => 'openai/gpt-oss-120b') }))
vi.mock('./llm', () => llmMock)

const authOverride = vi.hoisted(() => ({ value: null as null | { level: 'admin' | 'user'; ns: string; house?: boolean } }))
vi.mock('./auth', async () => {
  const actual = await vi.importActual<typeof import('./auth')>('./auth')
  return {
    ...actual,
    authenticate: async (...args: Parameters<typeof actual.authenticate>) => authOverride.value ?? actual.authenticate(...args),
  }
})

const DEVICE_KEY = 'gsk_deviceKEY0123456789abcdefghij'
const STORED_KEY = 'gsk_storedKEY0123456789abcdefghij'
const USER = { level: 'user' as const, ns: 'u:deadbeef:' }

const env = { APP_TOKEN: 'secret', FINNHUB_API_KEY: 'fk' }
const deps = { yahoo: vi.fn(), finnhub: vi.fn() }

/** `evaluate-note` is the thinnest LLM route there is — one param, one call,
 * no market data — so it isolates the key ladder and nothing else. */
const note = (deviceKey?: string) =>
  routeRequest(
    new URL('http://x/api/market?type=evaluate-note&text=momentum%20fades%20on%20Fridays'),
    new Headers({ 'x-app-token': 'secret', ...(deviceKey ? { 'x-groq-api-key': deviceKey } : {}) }),
    env,
    deps as never,
  )

const probe = (deviceKey?: string) =>
  routeRequest(
    new URL('http://x/api/market?type=llm-probe'),
    new Headers({ 'x-app-token': 'secret', ...(deviceKey ? { 'x-groq-api-key': deviceKey } : {}) }),
    env,
    deps as never,
  )

const envSeen = () => llmMock.callLlm.mock.calls[0][1] as Record<string, unknown>

beforeEach(async () => {
  llmMock.callLlm.mockReset()
  llmMock.callLlm.mockResolvedValue({ text: 'A blunt take.', provider: 'groq' })
  authOverride.value = USER
  await appStore.write(`${USER.ns}llm`, {})
})

describe('BYOK key ladder — the device header is preferred', () => {
  it('the header WINS over a server-stored key, and the answer carries no migration hint', async () => {
    await appStore.write(`${USER.ns}llm`, { groqKey: STORED_KEY })
    const body = await (await note(DEVICE_KEY)).json()
    expect(body.ok).toBe(true)
    expect(envSeen().GROQ_API_KEY).toBe(DEVICE_KEY)
    expect(envSeen().strict).toBe(true) // BYOK never falls through to the owner's keys
    expect(body.data.llmKeySource).toBeUndefined()
  })

  it('the header wins for an ADMIN caller too — the owner can test a licensee key as one', async () => {
    authOverride.value = { level: 'admin', ns: '' }
    await note(DEVICE_KEY)
    expect(envSeen().GROQ_API_KEY).toBe(DEVICE_KEY)
    expect(envSeen().strict).toBe(true)
  })

  it('and for a house licence, which otherwise rides the server env', async () => {
    authOverride.value = { ...USER, house: true }
    await note(DEVICE_KEY)
    expect(envSeen().GROQ_API_KEY).toBe(DEVICE_KEY)
  })
})

describe('BYOK key ladder — the stored key still answers, and says so', () => {
  it('no header + a stored key: the old copy serves the request AND flags itself', async () => {
    await appStore.write(`${USER.ns}llm`, { groqKey: STORED_KEY })
    const body = await (await note()).json()
    expect(body.ok).toBe(true)
    expect(body.data.take).toBe('A blunt take.')
    expect(envSeen().GROQ_API_KEY).toBe(STORED_KEY)
    expect(envSeen().strict).toBe(true)
    expect(body.data.llmKeySource).toBe('server') // the client's cue to migrate
  })

  it('neither key: the existing honesty message, unchanged, and the model is never called', async () => {
    const body = await (await note()).json()
    expect(body.ok).toBe(true)
    expect(body.data.take).toMatch(/^Add your own AI key in Settings/)
    expect(body.data.llmKeySource).toBeUndefined()
    expect(llmMock.callLlm).not.toHaveBeenCalled()
  })

  it('a MALFORMED header is a refusal, not a silent fall-back to the stored key', async () => {
    await appStore.write(`${USER.ns}llm`, { groqKey: STORED_KEY })
    const body = await (await note('not-a-groq-key')).json()
    expect(body.data.take).toMatch(/^Add your own AI key in Settings/)
    expect(llmMock.callLlm).not.toHaveBeenCalled()
  })

  it('the stored copy is never echoed back — only its existence, elsewhere', async () => {
    await appStore.write(`${USER.ns}llm`, { groqKey: STORED_KEY })
    const text = await (await note()).text()
    expect(text).not.toContain(STORED_KEY)
  })
})

describe('type=llm-probe — validity on evidence, stored nowhere', () => {
  it('round-trips a candidate key and reports the provider and model it reached', async () => {
    const res = await probe(DEVICE_KEY)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data).toEqual({ provider: 'groq', model: 'openai/gpt-oss-120b' })
    expect(envSeen().GROQ_API_KEY).toBe(DEVICE_KEY)
    // nothing was written: the probe is a test, not a save
    expect(await appStore.read(`${USER.ns}llm`)).toEqual({})
  })

  it('400s with no header at all — there is nothing to test', async () => {
    const res = await probe()
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('no-key')
    expect(llmMock.callLlm).not.toHaveBeenCalled()
  })

  it('400s a key of the wrong shape without spending a Groq call', async () => {
    const res = await probe('sk-openai-style')
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid-key')
    expect(llmMock.callLlm).not.toHaveBeenCalled()
  })

  it('400s when Groq itself rejects the key, carrying the reason', async () => {
    llmMock.callLlm.mockRejectedValue(new Error('groq 401 invalid_api_key'))
    const res = await probe(DEVICE_KEY)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/invalid_api_key/)
  })

  it('an ADMIN with no header is not told the server env is "their" key', async () => {
    authOverride.value = { level: 'admin', ns: '' }
    expect((await probe()).status).toBe(400)
  })
})
