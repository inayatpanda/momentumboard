import { describe, it, expect, vi } from 'vitest'
import { routeReport } from '../report.mts'
import { memoryStore } from './store'

const env = { REPORT_TOKEN: 'rt', TELEGRAM_BOT_TOKEN: 'bot', TELEGRAM_CHAT_ID: '42', URL: 'https://site' }
const auth = new Headers({ 'x-report-token': 'rt' })

describe('report endpoint', () => {
  it('GET serves a placeholder when no report exists', async () => {
    const res = await routeReport('GET', new Headers(), null, env, memoryStore())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('No report yet')
  })

  it('PUT requires the report token', async () => {
    const res = await routeReport('PUT', new Headers(), '<html></html>', env, memoryStore())
    expect(res.status).toBe(401)
  })

  it('PUT stores the article, GET serves it, telegram link fires', async () => {
    const store = memoryStore()
    const tg = vi.fn(async () => {})
    const put = await routeReport('PUT', auth, '<html><body>Morning brief</body></html>', env, store, tg)
    expect(put.status).toBe(200)
    expect(tg).toHaveBeenCalledWith('bot', '42', expect.stringContaining('https://thestreetsignal.rqai.co.uk/report'))
    const get = await routeReport('GET', new Headers(), null, env, store)
    expect(await get.text()).toContain('Morning brief')
  })

  it('rejects non-HTML or oversized bodies', async () => {
    expect((await routeReport('PUT', auth, 'no tags here', env, memoryStore())).status).toBe(400)
  })
})
