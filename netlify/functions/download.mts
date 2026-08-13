import type { Context } from '@netlify/functions'
import { appStore as blobAppStore, type AppStore } from './lib/storeProvider'
import { hash8 } from './lib/auth'

// Free desktop downloads, counted. /download/mac|win 302s to the public
// releases repo (stable versionless asset names → the link always serves the
// newest release), after booking the download in `download-stats` — which the
// Helm reads via /api/export?summary=1. Licensing is NOT enforced here on
// purpose: the app itself gates with the licence wall on first launch, so an
// uncounted download is still a counted (and gated) reader at first boot.

const RELEASES = 'https://github.com/inayatpanda/streetsignal-releases/releases/latest/download'
export const ASSETS: Record<string, { file: string; label: string }> = {
  mac: { file: 'StreetSignal.dmg', label: 'macOS' },
  win: { file: 'StreetSignal-Setup.exe', label: 'Windows' },
}

export interface DownloadStats {
  totals: Record<string, number>
  byDay: Record<string, Record<string, number>> // date → platform → count
  // rough uniques: first-seen ip hashes per day (capped — a gauge, not an audit)
  uniques: Record<string, string[]>
}

export async function routeDownload(platform: string, headers: Headers, store: AppStore, nowSec: number): Promise<Response> {
  const asset = ASSETS[platform]
  if (!asset) return new Response('unknown platform — use /download/mac or /download/win', { status: 404 })

  // counting is best-effort and must never block the download itself
  try {
    const day = new Date(nowSec * 1000).toISOString().slice(0, 10)
    const ip = headers.get('x-nf-client-connection-ip') ?? headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
    const ipHash = await hash8(ip)
    const stats = (await store.read<DownloadStats>('download-stats')) ?? { totals: {}, byDay: {}, uniques: {} }
    stats.totals[platform] = (stats.totals[platform] ?? 0) + 1
    ;(stats.byDay[day] ??= {})[platform] = (stats.byDay[day][platform] ?? 0) + 1
    const uniq = (stats.uniques[day] ??= [])
    if (!uniq.includes(ipHash) && uniq.length < 500) uniq.push(ipHash)
    // keep a rolling ~90 days of daily detail; lifetime totals never reset
    const days = Object.keys(stats.byDay).sort()
    for (const d of days.slice(0, Math.max(0, days.length - 90))) {
      delete stats.byDay[d]
      delete stats.uniques[d]
    }
    await store.write('download-stats', stats)
  } catch {
    /* the reader gets their file regardless */
  }

  return new Response(null, { status: 302, headers: { location: `${RELEASES}/${asset.file}` } })
}

export default async (req: Request, _context: Context) => {
  const url = new URL(req.url)
  const platform = (url.searchParams.get('platform') ?? url.pathname.split('/').pop() ?? '').toLowerCase()
  return routeDownload(platform, req.headers, blobAppStore, Math.floor(Date.now() / 1000))
}
