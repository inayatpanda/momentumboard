import { describe, it, expect, vi } from 'vitest'

vi.mock('./marketCache', () => ({ cachedQuote: vi.fn(async (sym: string) => (sym === 'PATH' ? { price: 12.6 } : null)) }))
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

  // 2026-07-24/25 outage: the composer runs in GitHub Actions, where a MISSING
  // `secrets.REPORT_PUBLISH_TOKEN` arrives as '' rather than undefined, so the
  // H-1 fallback never fired and every morning publish 401'd.
  it('PUT still accepts REPORT_TOKEN when REPORT_PUBLISH_TOKEN is present but blank', async () => {
    const blank = { ...env, REPORT_PUBLISH_TOKEN: '' }
    const tg = vi.fn(async () => {})
    const res = await routeReport('PUT', auth, '<html><body>Morning brief</body></html>', blank, memoryStore(), tg)
    expect(res.status).toBe(200)
  })

  it('PUT rejects when neither publish token is set', async () => {
    const none = { ...env, REPORT_TOKEN: '', REPORT_PUBLISH_TOKEN: '' }
    expect((await routeReport('PUT', auth, '<html></html>', none, memoryStore())).status).toBe(401)
  })
})

// The paper prints fixed levels; the strip says where price is NOW. It is filled
// when the page is SERVED, so the stored edition (and therefore the PDF and the
// emailed copy) keeps no stale price.
describe('call-status strip on a served edition', () => {
  const marker = '<span data-call-status="PATH"></span>'
  const seedEdition = async () => {
    const store = memoryStore()
    await store.write('report:2026-07-22', { html: `<html><body>call${marker}</body></html>`, at: 1_000 })
    await store.write('report-calls:2026-07-22', [{ sym: 'PATH', side: 'long', entry: 12.04, stop: 11.03, target: 13.2 }])
    return store
  }

  it('fills the strip when the edition is viewed', async () => {
    const res = await routeReport('GET', new Headers(), null, env, await seedEdition(), undefined, new URL('http://x/report?date=2026-07-22'))
    const html = await res.text()
    expect(html).toContain('from entry')
    expect(html).not.toContain('data-call-status') // never leave a raw marker on screen
  })

  it('leaves a DOWNLOAD as a clean snapshot, with no live price baked in', async () => {
    const res = await routeReport('GET', new Headers(), null, env, await seedEdition(), undefined, new URL('http://x/report?date=2026-07-22&download=1'))
    expect(await res.text()).not.toContain('from entry')
  })

  it('serves the paper untouched when the edition has no stored levels', async () => {
    const store = memoryStore()
    await store.write('report:2026-07-21', { html: `<html><body>x${marker}</body></html>`, at: 1_000 })
    const res = await routeReport('GET', new Headers(), null, env, store, undefined, new URL('http://x/report?date=2026-07-21'))
    expect(await res.text()).toContain(marker) // nothing to fill, nothing broken
  })
})
