import { describe, expect, it } from 'vitest'
import { routeTelegramWebhook } from '../telegram-webhook.mts'
import type { AppStore } from './store'
import type { Licence } from './auth'

const ENV = { REPORT_TOKEN: 'rt', TELEGRAM_BOT_TOKEN: 'bt', TELEGRAM_CHAT_ID: '42', URL: 'https://x.test' }

function harness(seed: Record<string, unknown> = {}) {
  const blobs = new Map<string, unknown>(Object.entries(seed))
  const store = {
    read: async <T>(k: string) => (blobs.get(k) as T) ?? null,
    write: async (k: string, v: unknown) => void blobs.set(k, v),
  } as unknown as AppStore
  const sent: string[] = []
  const send = async (_t: string, _c: string, msg: string) => void sent.push(msg)
  const fire = (text: string, chatId = 42) =>
    routeTelegramWebhook(
      new Headers({ 'x-telegram-bot-api-secret-token': 'rt' }),
      JSON.stringify({ message: { chat: { id: chatId }, text } }),
      ENV,
      store,
      send as never,
    )
  return { blobs, sent, fire }
}

describe('Helm licence commands', () => {
  it('/key <label> mints a perpetual licence and replies with the unlock link', async () => {
    const { blobs, sent, fire } = harness()
    await fire('/key PK')
    const lics = blobs.get('licences') as Licence[]
    expect(lics).toHaveLength(1)
    expect(lics[0]).toMatchObject({ label: 'PK' })
    expect(lics[0].expiresAt).toBeUndefined()
    expect(lics[0].trial).toBeUndefined()
    expect(sent[0]).toContain(`https://thestreetsignal.rqai.co.uk/?key=${lics[0].key}`)
  })

  it('/key without a label shows usage and mints nothing', async () => {
    const { blobs, sent, fire } = harness()
    await fire('/key')
    expect(blobs.get('licences')).toBeUndefined()
    expect(sent[0]).toContain('Usage: /key')
  })

  it('/key refuses past the 25 active non-trial cap', async () => {
    const seed = Array.from({ length: 25 }, (_, i) => ({ key: `mb_${i}`, label: `l${i}`, createdAt: 1 }))
    const { blobs, sent, fire } = harness({ licences: seed })
    await fire('/key overflow')
    expect((blobs.get('licences') as Licence[]).length).toBe(25)
    expect(sent[0]).toContain('cap')
  })

  it('/keys lists active licences only (and is not swallowed by /key)', async () => {
    const { sent, fire } = harness({
      licences: [
        { key: 'mb_aaaaaaaaaa', label: 'PK', createdAt: 1 },
        { key: 'mb_bbbbbbbbbb', label: 'dead', createdAt: 1, revoked: true },
      ] satisfies Licence[],
    })
    await fire('/keys')
    expect(sent[0]).toContain('PK')
    expect(sent[0]).not.toContain('dead')
    expect(sent[0]).not.toContain('Usage: /key')
  })

  it('/revoke by label revokes exactly one; ambiguous labels are refused', async () => {
    const seed: Licence[] = [
      { key: 'mb_aaaa1', label: 'PK', createdAt: 1 },
      { key: 'mb_bbbb2', label: 'twin', createdAt: 1 },
      { key: 'mb_cccc3', label: 'twin', createdAt: 1 },
    ]
    const { blobs, sent, fire } = harness({ licences: seed })
    await fire('/revoke PK')
    expect((blobs.get('licences') as Licence[]).find(l => l.label === 'PK')?.revoked).toBe(true)
    await fire('/revoke twin')
    expect(sent[1]).toContain('Ambiguous')
    expect((blobs.get('licences') as Licence[]).filter(l => l.label === 'twin' && l.revoked)).toHaveLength(0)
    await fire('/revoke mb_bbbb')
    expect((blobs.get('licences') as Licence[]).find(l => l.key === 'mb_bbbb2')?.revoked).toBe(true)
  })

  it('ignores licence commands from any other chat id', async () => {
    const { blobs, sent, fire } = harness()
    await fire('/key intruder', 666)
    expect(blobs.get('licences')).toBeUndefined()
    expect(sent).toHaveLength(0)
  })

  it('/house toggles the house flag on exactly one licence', async () => {
    const seed: Licence[] = [
      { key: 'mb_aaaa1', label: 'inayat-mac-m5', createdAt: 1 },
      { key: 'mb_bbbb2', label: 'PK', createdAt: 1 },
    ]
    const { blobs, sent, fire } = harness({ licences: seed })
    await fire('/house inayat-mac-m5')
    expect((blobs.get('licences') as Licence[]).find(l => l.label === 'inayat-mac-m5')?.house).toBe(true)
    expect((blobs.get('licences') as Licence[]).find(l => l.label === 'PK')?.house).toBeUndefined()
    expect(sent[0]).toContain('house licence')
    // toggle back off
    await fire('/house inayat-mac-m5')
    expect((blobs.get('licences') as Licence[]).find(l => l.label === 'inayat-mac-m5')?.house).toBe(false)
    // no match → helpful reply, nothing mutated
    await fire('/house ghost')
    expect(sent[2]).toContain('No active licence')
  })
})
