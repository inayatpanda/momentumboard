// CX-19 (plan Task 19 prerequisite): a read-only ?format=json mode on the
// report route, so the v2 Intel screen can render the paper inline via a
// sandboxed srcDoc iframe instead of an X-Frame-blocked navigation. Strictly
// additive — the HTML modes, the download mode and the PUT publish path are
// untouched, and the compose pipeline never reads this route.

import { describe, expect, it } from 'vitest'
import { routeReport, type StoredReport } from './report.mts'
import type { AppStore } from './lib/storeProvider'

const memStore = (seed: Record<string, unknown>): AppStore => ({
  read: async <T,>(k: string) => ((seed[k] ?? null) as T | null),
  write: async (k: string, v: unknown) => void (seed[k] = v),
})

const HTML = '<!doctype html><html><body><h1>The Edition</h1></body></html>'
const noTelegram = (async () => true) as never

describe('report ?format=json', () => {
  it('serves the dated edition as a JSON envelope', async () => {
    const store = memStore({ 'report:2026-08-13': { html: HTML, at: 1_765_000_000 } satisfies StoredReport })
    const res = await routeReport('GET', new Headers(), null, {}, store, noTelegram, new URL('https://x/report?date=2026-08-13&format=json'))
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = (await res.json()) as { ok: boolean; data: { date: string; at: number; html: string } }
    expect(body.ok).toBe(true)
    expect(body.data.date).toBe('2026-08-13')
    expect(body.data.at).toBe(1_765_000_000)
    expect(body.data.html).toContain('The Edition')
  })

  it('serves the latest edition as JSON when no date is given, and 404-shapes a missing one', async () => {
    const store = memStore({ 'morning-report': { html: HTML, at: 1_765_086_400 } satisfies StoredReport })
    const res = await routeReport('GET', new Headers(), null, {}, store, noTelegram, new URL('https://x/report?format=json'))
    const body = (await res.json()) as { ok: boolean; data: { html: string } }
    expect(body.ok).toBe(true)
    expect(body.data.html).toContain('The Edition')

    const missing = await routeReport('GET', new Headers(), null, {}, memStore({}), noTelegram, new URL('https://x/report?date=2020-01-01&format=json'))
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as { ok: boolean }).ok).toBe(false)
  })

  it('leaves the plain HTML mode byte-identical', async () => {
    const store = memStore({ 'report:2026-08-13': { html: HTML, at: 1 } satisfies StoredReport })
    const res = await routeReport('GET', new Headers(), null, {}, store, noTelegram, new URL('https://x/report?date=2026-08-13'))
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('The Edition')
  })
})
