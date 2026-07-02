import type { Context } from '@netlify/functions'
import { blobAppStore, type AppStore } from './lib/store'

// The Helm integration (Option A): one stable, read-only contract The Helm's
// pull-agent hits on a schedule to archive every edition, pick, event and the
// scorecard into its own SQLite. StreetSignal never depends on The Helm — it
// just serves; The Helm pulls when the laptop is awake.
//
//   GET /api/export?summary=1        → cheap card payload for the Helm dashboard
//   GET /api/export?since=<unixSec>  → everything changed since (incremental)
//   GET /api/export                  → full snapshot (first backfill)
//
// Auth: the REPORT_TOKEN (the read-only external-reader credential) or APP_TOKEN.

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface StoredReport {
  html: string
  at: number
}
interface HistoryEntry {
  date: string
  headline: string
  standfirst: string
  regime: string
  ideas: { ticker: string; side: string; strength?: string }[]
}
interface PickDay {
  date: string
  regime?: string
  macro?: unknown
  at?: number
  picks: { ticker: string; side: string; conviction?: string; strength?: string; priceAtPick?: number; reasons?: string[] }[]
}

export async function routeExport(
  url: URL,
  headers: Headers,
  env: { APP_TOKEN?: string; REPORT_TOKEN?: string },
  store: AppStore,
): Promise<Response> {
  const tok = headers.get('x-report-token') || headers.get('x-app-token')
  const ok = (!!env.REPORT_TOKEN && tok === env.REPORT_TOKEN) || (!!env.APP_TOKEN && tok === env.APP_TOKEN)
  if (!ok) return json(401, { ok: false, error: 'unauthorized' })

  const now = Math.floor(Date.now() / 1000)
  const history = (await store.read<HistoryEntry[]>('composed-history')) ?? []
  const latest = history[history.length - 1] ?? null
  const scorecard = await store.read<unknown>('pick-stats')

  // cheap summary for the dashboard card — no heavy HTML
  const summary = {
    app: 'streetsignal', // stable Helm app-id; independent of the pretty URL
    site: 'https://thestreetsignal.netlify.app',
    reportUrl: 'https://thestreetsignal.netlify.app/report',
    latestEdition: latest
      ? { date: latest.date, headline: latest.headline, standfirst: latest.standfirst, regime: latest.regime, ideas: latest.ideas }
      : null,
    scorecard: scorecard ?? null,
    updatedAt: now,
  }

  if (url.searchParams.get('summary') === '1') return json(200, { ok: true, data: { summary, now } })

  const since = Number(url.searchParams.get('since') ?? 0) || 0

  // editions: pull the archived HTML for dates newer than `since`
  const index = (await store.read<string[]>('report-index')) ?? []
  const editions: { date: string; at: number; html: string }[] = []
  for (const date of index) {
    const rep = await store.read<StoredReport>(`report:${date}`)
    if (rep && rep.at > since) editions.push({ date, at: rep.at, html: rep.html })
  }

  const allPicks = (await store.read<PickDay[]>('report-picks')) ?? []
  const picks = allPicks.filter(p => (p.at ?? Date.parse(`${p.date}T00:00:00Z`) / 1000) > since)

  const allEvents = (await store.read<{ at: number }[]>('event-dossiers')) ?? []
  const events = allEvents.filter(e => e.at > since)

  return json(200, {
    ok: true,
    data: {
      summary,
      editions, // [{date, at, html}]
      picks, // [{date, regime, picks:[...]}]
      events, // [{kind, name, assessment, at, ...}]
      now, // store this as the next `since` watermark
    },
  })
}

export default async (req: Request, _context: Context) =>
  routeExport(new URL(req.url), req.headers, { APP_TOKEN: process.env.APP_TOKEN, REPORT_TOKEN: process.env.REPORT_TOKEN }, blobAppStore)
