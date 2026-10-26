import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('./email', () => ({ sendReportEmail: vi.fn(async () => true), recipientsForEdition: vi.fn(() => []) }))
vi.mock('./marketCache', () => ({ cachedQuote: vi.fn(async () => null) }))
vi.mock('./pushSend', () => ({ sendPushAll: vi.fn(async () => {}) }))
import { sendReportEmail } from './email'
import { routeReport } from '../report.mts'
import { composeBulletin } from './bulletins'
import { memoryStore } from './store'

const env = { REPORT_TOKEN: 'test', TELEGRAM_BOT_TOKEN: 'bot', TELEGRAM_CHAT_ID: 'owner' }
afterEach(() => vi.restoreAllMocks())
describe('brief delivery integration', () => {
  it('sends a concise email and useful Telegram, retaining the complete archived report', async () => {
    const store = memoryStore(), tg = vi.fn(async (_bot: string, _chat: string, _text: string) => {})
    const html = '<html><body>FULL DETAILED NEWSPAPER</body></html>'
    const res = await routeReport('PUT', new Headers({ 'x-report-token': 'test' }), html, env, store, tg)
    expect(res.status).toBe(200)
    expect((await store.read<{html:string}>('morning-report'))!.html).toBe(html)
    expect(tg).toHaveBeenCalledTimes(1)
    expect(tg.mock.calls[0][2]).toContain('What changed')
    const email = vi.mocked(sendReportEmail).mock.calls.at(-1)!
    expect(email[2]).toContain('See the evidence')
    expect(email[2]).not.toContain('FULL DETAILED NEWSPAPER')
    expect(email[2]).toContain('Read the full daily report')
  })
  it('stores strong and repeated picks without extra promotional messages', async () => {
    const store = memoryStore(), tg = vi.fn(async () => {})
    const headers = new Headers({ 'x-report-token': 'test', 'content-type': 'application/json' })
    for (const date of ['2026-10-24', '2026-10-25', '2026-10-26']) {
      const res = await routeReport('PUT', headers, JSON.stringify({ date, picks: [{ ticker: 'TEST', side: 'long', strength: 'strong' }] }), env, store, tg)
      expect(res.status).toBe(200)
    }
    expect(tg).not.toHaveBeenCalled()
    expect(await store.read('report-picks')).toHaveLength(3)
  })
  it('produces a usable intraday brief when providers fail, without an LLM call', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    const b = await composeBulletin('evening', memoryStore(), {}, Date.parse('2026-10-26T17:00:00Z') / 1000)
    expect(b.text).toContain('Your afternoon update')
    expect(b.text).toContain('Fresh market quotes are unavailable')
    expect(b.text.length).toBeLessThan(4096)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('ff_calendar_thisweek.json')
  })
})
