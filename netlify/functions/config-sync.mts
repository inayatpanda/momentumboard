import type { Context } from '@netlify/functions'
import { validateConfig, type AppConfig } from '../../shared/config'
import { appStore as blobAppStore, type AppStore } from './lib/storeProvider'
import { authenticate } from './lib/auth'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export async function routeConfig(
  url: URL,
  method: string,
  headers: Headers,
  bodyText: string | null,
  env: { APP_TOKEN?: string; REPORT_TOKEN?: string },
  store: AppStore,
): Promise<Response> {
  const auth = await authenticate(headers, env, store) // admin OR licensed user
  // read-only views are also open to the research routine's report token
  const reportOk = !!env.REPORT_TOKEN && headers.get('x-report-token') === env.REPORT_TOKEN
  if (!auth && !(method === 'GET' && reportOk)) return json(401, { ok: false, error: 'unauthorized' })
  const ns = auth?.ns ?? '' // licensees get their own config/portfolio namespace

  if (method === 'GET') {
    if (url.searchParams.get('view') === 'signals') {
      const signals = (await store.read<unknown[]>('signal-log')) ?? []
      return json(200, { ok: true, data: signals })
    }
    if (url.searchParams.get('view') === 'videos') {
      const analyses = (await store.read<unknown[]>('video-analyses')) ?? []
      return json(200, { ok: true, data: analyses.slice(-10).reverse() })
    }
    if (url.searchParams.get('view') === 'notes') {
      const cfg = await store.read<{ notes?: unknown[] }>(`${ns}config`)
      return json(200, { ok: true, data: cfg?.notes ?? [] })
    }
    if (url.searchParams.get('view') === 'month') {
      // density map for the calendar: which days have a report / picks / alerts / events
      const month = url.searchParams.get('month') ?? new Date().toISOString().slice(0, 7)
      const [index, picksHistory, history, dossiers] = await Promise.all([
        store.read<string[]>('report-index'),
        store.read<{ date: string; picks: unknown[] }[]>('report-picks'),
        store.read<{ at: number }[]>('alert-history'),
        store.read<{ at: number }[]>('event-dossiers'),
      ])
      const days: Record<string, { r?: boolean; p?: number; a?: number; e?: number }> = {}
      const bump = (date: string, k: 'p' | 'a' | 'e') => {
        if (!date.startsWith(month)) return
        days[date] = days[date] ?? {}
        days[date][k] = (days[date][k] ?? 0) + 1
      }
      for (const d of index ?? []) if (d.startsWith(month)) (days[d] = days[d] ?? {}).r = true
      for (const d of picksHistory ?? []) if (d.date.startsWith(month)) { days[d.date] = days[d.date] ?? {}; days[d.date].p = d.picks.length }
      for (const h of history ?? []) bump(new Date(h.at * 1000).toISOString().slice(0, 10), 'a')
      for (const e of dossiers ?? []) bump(new Date(e.at * 1000).toISOString().slice(0, 10), 'e')
      return json(200, { ok: true, data: days })
    }
    if (url.searchParams.get('view') === 'day') {
      // everything the system produced on one date — the calendar's day ledger
      const date = url.searchParams.get('date')
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(400, { ok: false, error: 'bad-date' })
      const dayStart = Date.parse(date) / 1000
      const dayEnd = dayStart + 86_400
      const inDay = (at: number) => at >= dayStart && at < dayEnd
      const [index, picksHistory, history, dossiers, videos] = await Promise.all([
        store.read<string[]>('report-index'),
        store.read<{ date: string; regime?: string; picks: { ticker: string; side: string; conviction?: string; strength?: string; priceAtPick?: number }[] }[]>('report-picks'),
        store.read<{ text: string; tier: string; at: number }[]>('alert-history'),
        store.read<{ kind: string; name: string; assessment: string; at: number }[]>('event-dossiers'),
        store.read<{ title?: string; channel?: string; url: string; at: number }[]>('video-analyses'),
      ])
      const dayPicks = (picksHistory ?? []).find(d => d.date === date)
      return json(200, {
        ok: true,
        data: {
          date,
          hasReport: (index ?? []).includes(date),
          regime: dayPicks?.regime ?? null,
          picks: dayPicks?.picks ?? [],
          alerts: (history ?? []).filter(h => inDay(h.at)).slice(-30),
          events: (dossiers ?? []).filter(e => inDay(e.at)).map(e => ({ kind: e.kind, name: e.name, assessment: e.assessment.slice(0, 400), at: e.at })),
          videos: (videos ?? []).filter(v => inDay(v.at)).map(v => ({ title: v.title, channel: v.channel, url: v.url })),
        },
      })
    }
    if (url.searchParams.get('view') === 'llm-key') {
      // NEVER echoes the key itself — not the value, not a prefix, not a
      // length. Existence only, plus where it lives, so Settings can tell a
      // licensee still on the old server-stored copy to move it on-device.
      const creds = await store.read<{ groqKey?: string }>(`${ns}llm`)
      const hasKey = !!creds?.groqKey
      return json(200, { ok: true, data: { hasKey, llmKeySource: hasKey ? 'server' : null } })
    }
    if (url.searchParams.get('view') === 'sectors') {
      const { getCached } = await import('./lib/cache')
      return json(200, { ok: true, data: (await getCached('sector-rotation')) ?? null })
    }
    if (url.searchParams.get('view') === 'events') {
      const dossiers = (await store.read<unknown[]>('event-dossiers')) ?? []
      return json(200, { ok: true, data: dossiers.slice(-5).reverse() })
    }
    if (url.searchParams.get('view') === 'trending') {
      const [current, timeline] = await Promise.all([store.read('trending'), store.read('trending-timeline')])
      return json(200, { ok: true, data: { current: current ?? null, timeline: (timeline as unknown[])?.slice(-12) ?? [] } })
    }
    if (url.searchParams.get('view') === 'outcomes') {
      const { perDayOutcomes } = await import('./lib/picks')
      const { cachedCandles } = await import('./lib/marketCache')
      const history = ((await store.read<unknown[]>('report-picks')) ?? []) as Parameters<typeof perDayOutcomes>[0]
      const symbols = [...new Set(history.flatMap(d => d.picks.map(p => p.ticker)))].slice(0, 40)
      const pairs = await Promise.all(symbols.map(async s => [s, await cachedCandles(s)] as const))
      const candlesBySymbol = new Map(pairs.filter((p): p is [string, NonNullable<(typeof pairs)[0][1]>] => p[1] !== null))
      return json(200, { ok: true, data: perDayOutcomes(history, candlesBySymbol).slice(0, 14) })
    }
    if (url.searchParams.get('view') === 'scorecard') {
      const { getCached } = await import('./lib/cache')
      const cached = await getCached('pick-stats')
      if (cached) return json(200, { ok: true, data: cached })
      const { scorePicks } = await import('./lib/picks')
      const { cachedCandles } = await import('./lib/marketCache')
      const history = ((await store.read<unknown[]>('report-picks')) ?? []) as Parameters<typeof scorePicks>[0]
      const symbols = [...new Set(history.flatMap(d => d.picks.map(p => p.ticker)))].slice(0, 40)
      const pairs = await Promise.all(symbols.map(async s => [s, await cachedCandles(s)] as const))
      const candlesBySymbol = new Map(pairs.filter((p): p is [string, NonNullable<(typeof pairs)[0][1]>] => p[1] !== null))
      return json(200, { ok: true, data: { scores: scorePicks(history, candlesBySymbol), reports: history.length } })
    }
    if (url.searchParams.get('view') === 'picks') {
      const { computePersistence } = await import('./lib/picks')
      const history = ((await store.read<unknown[]>('report-picks')) ?? []) as Parameters<typeof computePersistence>[0]
      return json(200, { ok: true, data: { persistence: computePersistence(history), reports: history.length, latest: history[history.length - 1] ?? null } })
    }
    if (url.searchParams.get('view') === 'consensus') {
      const { computeConsensus } = await import('./lib/videoTrends')
      const extracts = ((await store.read<unknown[]>('video-extracts')) ?? []) as Parameters<typeof computeConsensus>[0]
      return json(200, { ok: true, data: computeConsensus(extracts, Math.floor(Date.now() / 1000)) })
    }
    if (url.searchParams.get('view') === 'runlog') {
      const runlog = (await store.read<unknown[]>('runlog')) ?? []
      return json(200, { ok: true, data: runlog.slice(-20) })
    }
    if (url.searchParams.get('view') === 'history') {
      const history = (await store.read<unknown[]>('alert-history')) ?? []
      return json(200, { ok: true, data: history.slice(-50).reverse() })
    }
    return json(200, { ok: true, data: await store.read(`${ns}config`) })
  }

  if (url.searchParams.get('view') === 'llm-key') {
    // READABLE, NOT WRITABLE. The stored copy stays legible to the LLM routes
    // so licensees who saved one before the device path existed keep working,
    // but nothing writes a NEW one: the key belongs in the reader's own
    // IndexedDB (src/lib/deviceLlm.ts), and the server holding a provider
    // credential is the thing this release is retiring.
    if (method === 'DELETE') {
      await store.write(`${ns}llm`, {})
      return json(200, { ok: true })
    }
    if (method === 'PUT') return json(410, { ok: false, error: 'device-only-key' })
  }

  if (method === 'PUT') {
    const cfg = validateConfig(bodyText ? JSON.parse(bodyText) : null)
    if (!cfg) return json(400, { ok: false, error: 'invalid-config' })
    // Merge-on-write: the phone's config mirror builds its payload from the local
    // watchlist/rules/notes only — it never carries the engine-only fields. Without
    // this merge a routine phone sync would WIPE the seeded levMap, the manual risk
    // pin and the favourite channels. Preserve each stored value when the incoming
    // body left it out; an explicit value (incl. an explicit null override) replaces.
    const stored = await store.read<AppConfig>(`${ns}config`)
    const merged: AppConfig = {
      ...cfg,
      levMap: cfg.levMap ?? stored?.levMap,
      favouriteChannels: cfg.favouriteChannels ?? stored?.favouriteChannels,
      riskRungOverride: cfg.riskRungOverride === undefined ? (stored?.riskRungOverride ?? null) : cfg.riskRungOverride,
      // the gate pins, on exactly the riskRungOverride contract (gateState.ts):
      // absent preserves whatever is stored, an explicit value — including an
      // explicit null — replaces it
      gateOverride: cfg.gateOverride === undefined ? (stored?.gateOverride ?? null) : cfg.gateOverride,
      // engine-only fields the phone mirror never carries — preserve like the above
      riskAppetite: cfg.riskAppetite ?? stored?.riskAppetite,
      reportRecipients: cfg.reportRecipients ?? stored?.reportRecipients,
      coreSleeve: cfg.coreSleeve ?? stored?.coreSleeve,
    }
    await store.write(`${ns}config`, merged)
    return json(200, { ok: true, data: merged })
  }

  return json(405, { ok: false, error: 'method-not-allowed' })
}

export default async (req: Request, _context: Context) =>
  routeConfig(
    new URL(req.url),
    req.method,
    req.headers,
    req.method === 'PUT' ? await req.text() : null,
    { APP_TOKEN: process.env.APP_TOKEN, REPORT_TOKEN: process.env.REPORT_TOKEN },
    blobAppStore,
  )
