import type { Context } from '@netlify/functions'
import { blobAppStore, type AppStore } from './lib/store'
import { CANONICAL_SITE } from './lib/site'
import { scopedToken } from './lib/auth'

// The Helm integration (Option A): one stable, read-only contract The Helm's
// pull-agent hits on a schedule to archive every edition, pick, event, the
// scorecard, and the owner's own trading data (journal trades, notes, config)
// into its own SQLite. StreetSignal never depends on The Helm — it just serves;
// The Helm pulls when the laptop is awake.
//
//   GET /api/export?summary=1        → cheap card payload for the Helm dashboard
//   GET /api/export?since=<unixSec>  → everything changed since (incremental)
//   GET /api/export                  → full snapshot (first backfill)
//
// Auth: the REPORT_TOKEN (the read-only external-reader credential) or APP_TOKEN.
//
// Helm's POST always inserts (auto-increment id) — it does NOT upsert by a
// caller key. So the pull-agent must get-or-create per record. The natural,
// stable srcId for each collection is noted inline on the payload below.

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
  env: { APP_TOKEN?: string; REPORT_TOKEN?: string; HELM_EXPORT_TOKEN?: string },
  store: AppStore,
): Promise<Response> {
  const tok = headers.get('x-report-token') || headers.get('x-app-token')
  // audit H-1: prefer a dedicated HELM_EXPORT_TOKEN; fall back to REPORT_TOKEN
  // until the owner sets it + updates the Helm app to send it.
  const exportTok = scopedToken(env.HELM_EXPORT_TOKEN, env.REPORT_TOKEN)
  const ok = (!!exportTok && tok === exportTok) || (!!env.APP_TOKEN && tok === env.APP_TOKEN)
  if (!ok) return json(401, { ok: false, error: 'unauthorized' })

  const now = Math.floor(Date.now() / 1000)
  const history = (await store.read<HistoryEntry[]>('composed-history')) ?? []
  const latest = history[history.length - 1] ?? null
  const scorecard = await store.read<unknown>('pick-stats')

  // Reach: desktop downloads (download.mts) + app boots (licences.mts check
  // route, web vs desktop-shell split, per-licence-label) + the licence book
  // itself — keys withheld, labels only. How many have it, who actually reads.
  const downloads = (await store.read<unknown>('download-stats')) ?? null
  const access = (await store.read<unknown>('access-stats')) ?? null
  const licenceBook = ((await store.read<{ label: string; createdAt: number; revoked?: boolean; trial?: boolean; expiresAt?: number }[]>('licences')) ?? []).map(
    l => ({ label: l.label, createdAt: l.createdAt, revoked: !!l.revoked, trial: !!l.trial, expiresAt: l.expiresAt ?? null }),
  )

  // cheap summary for the dashboard card — no heavy HTML
  const summary = {
    app: 'thestreetsignal', // Helm app-id — matches the site name; onboard this in The Helm
    site: CANONICAL_SITE,
    reportUrl: `${CANONICAL_SITE}/report`,
    latestEdition: latest
      ? { date: latest.date, headline: latest.headline, standfirst: latest.standfirst, regime: latest.regime, ideas: latest.ideas }
      : null,
    scorecard: scorecard ?? null,
    reach: { downloads, access, licences: licenceBook },
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

  // Trading data — the owner's own irreplaceable records, for the private mirror.
  // Trades ride the journal-backup blob's `at` watermark (rewritten on every
  // journal change). Config has no per-record modified-time, so it and its notes
  // ride along on every pull — the agent's get-or-create keeps that idempotent.
  const backup = await store.read<{ trades?: unknown[]; at?: number }>('journal-backup')
  const trades = backup && (backup.at ?? 0) > since ? backup.trades ?? [] : []

  const configBlob = (await store.read<{ notes?: unknown[] } & Record<string, unknown>>('config')) ?? null
  const notes = configBlob?.notes ?? []
  // config as a single settings/watchlist doc, with notes split into their own
  // collection above (avoids double-storing them).
  const config = configBlob ? (({ notes: _drop, ...rest }) => rest)(configBlob) : null

  return json(200, {
    ok: true,
    data: {
      summary,
      editions, // [{date, at, html}]     — srcId: date
      picks, // [{date, regime, picks}]    — srcId: date
      events, // [{kind, name, at, ...}]   — srcId: `${at}:${name}`
      trades, // [{id, ...}]               — srcId: id (present when journal changed since `since`)
      notes, // [{id, kind, text, ...}]    — srcId: id
      config, // single settings/watchlist doc (notes stripped) — srcId: 'current'
      now, // store this as the next `since` watermark
    },
  })
}

export default async (req: Request, _context: Context) =>
  routeExport(new URL(req.url), req.headers, { APP_TOKEN: process.env.APP_TOKEN, REPORT_TOKEN: process.env.REPORT_TOKEN, HELM_EXPORT_TOKEN: process.env.HELM_EXPORT_TOKEN }, blobAppStore)
