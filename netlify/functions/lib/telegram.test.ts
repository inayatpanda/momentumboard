import { describe, it, expect, vi } from 'vitest'
import { sendTelegram } from './telegram'

describe('sendTelegram', () => {
  it('posts to the bot endpoint with chat id and text', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: true })))
    await sendTelegram('BOT123', '42', 'hello', fetchFn as unknown as typeof fetch)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.telegram.org/botBOT123/sendMessage')
    expect(JSON.parse(init.body as string)).toMatchObject({ chat_id: '42', text: 'hello' })
  })
  it('throws on telegram error responses', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: false, description: 'chat not found' })))
    await expect(sendTelegram('B', 'x', 'y', fetchFn as unknown as typeof fetch)).rejects.toThrow('chat not found')
  })
})
