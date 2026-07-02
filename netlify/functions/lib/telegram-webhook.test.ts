import { describe, it, expect, vi } from 'vitest'
import { routeTelegramWebhook } from '../telegram-webhook.mts'
import { memoryStore } from './store'

const env = { REPORT_TOKEN: 'sec', TELEGRAM_BOT_TOKEN: 'bot', TELEGRAM_CHAT_ID: '42', URL: 'https://x' }
const auth = new Headers({ 'x-telegram-bot-api-secret-token': 'sec' })
const msg = (text: string, chat = 42) => JSON.stringify({ message: { chat: { id: chat }, text } })

describe('telegram webhook', () => {
  it('rejects wrong secret and ignores strangers', async () => {
    expect((await routeTelegramWebhook(new Headers(), msg('/status'), env, memoryStore())).status).toBe(401)
    const send = vi.fn()
    await routeTelegramWebhook(auth, msg('/status', 999), env, memoryStore(), send as never)
    expect(send).not.toHaveBeenCalled()
  })
  it('/mute stores a mute window and /unmute clears it', async () => {
    const store = memoryStore()
    const send = vi.fn(async () => {})
    await routeTelegramWebhook(auth, msg('/mute 3'), env, store, send as never)
    expect(await store.read<number>('mute-until')).toBeGreaterThan(Date.now() / 1000 + 10_000)
    await routeTelegramWebhook(auth, msg('/unmute'), env, store, send as never)
    expect(await store.read<number>('mute-until')).toBe(0)
    expect(send).toHaveBeenCalledTimes(2)
  })
  it('/portfolio summarises the snapshot', async () => {
    const store = memoryStore()
    await store.write('portfolio', { capital: 5000, openPositions: [{ symbol: 'AAPL', positionValue: 900, entryPrice: 100, stop: 95 }], stats: { realizedPnl: 120, winRate: 0.6 } })
    const send = vi.fn(async (_bot: string, _chat: string, _text: string) => {})
    await routeTelegramWebhook(auth, msg('/portfolio'), env, store, send as never)
    const text = send.mock.calls[0][2]
    expect(text).toContain('AAPL £900')
    expect(text).toContain('win 60%')
  })
})
