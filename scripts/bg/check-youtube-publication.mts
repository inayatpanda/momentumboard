import { appendFile } from 'node:fs/promises'
import { configureStoreForScript } from '../lib/configureStore'
import { appStore } from '../../netlify/functions/lib/storeProvider'
import { readTranscriptIndex } from '../../netlify/functions/lib/videoTranscriptStore'
import type { VideoExtract } from '../../netlify/functions/lib/videoTrends'
import { isFollowedChannel, withDefaults } from '../../shared/channels'
import { videoKey } from '../../shared/youtubeCaptions.mjs'

async function main() {
  await configureStoreForScript()
  const [transcripts, extracts] = await Promise.all([readTranscriptIndex(appStore), appStore.read<VideoExtract[]>('video-extracts')])
  const cloud = transcripts.filter(t => t.source === 'github')
  const config = await appStore.read<{ ytChannels?: { id: string; name: string }[] }>('config')
  const followed = withDefaults(config?.ytChannels)
  const published = (extracts ?? []).filter(e => ['github', 'gemini-video'].includes(e.via ?? '') && isFollowedChannel(e, followed)).sort((a,b) => b.at-a.at)
  const ready = new Set(published.map(e => videoKey(e.url)))
  const report = {
    cloudTranscripts: cloud.length, cloudAnalysesInApp: published.length,
    awaitingAnalysis: cloud.filter(t => !ready.has(videoKey(t.url))).length,
    latestPublishedAt: published.reduce((n, e) => Math.max(n, e.at), 0) || null,
    // Only public video identities and counts; never transcripts or credentials.
    latestVideos: published.slice(0,3).map(e => ({ url: e.url, tickers: e.tickers.length, claims: e.claims?.length ?? 0, method: e.via, coverage: e.nativeTranscript?.progress ?? e.coverage })),
  }
  console.log(JSON.stringify(report))
  if (process.env.APP_TOKEN) {
    const response = await fetch('https://thestreetsignal.rqai.co.uk/api/market?type=street', {
      headers: { 'x-app-token': process.env.APP_TOKEN }, redirect: 'error', signal: AbortSignal.timeout(30_000),
    })
    const body = await response.json().catch(() => null) as { ok?: boolean; data?: { videos?: { url: string; via?: string }[]; videoIngestion?: { githubRunner?: { status: string; saved: number; unavailable: number } } } } | null
    if (!response.ok || !body?.ok || !Array.isArray(body.data?.videos)) throw new Error('app-feed-unavailable')
    const visible = new Set(body.data.videos.map(v => videoKey(v.url)))
    const missing = published.slice(0,3).filter(v => !visible.has(videoKey(v.url)))
    if (missing.length) throw new Error('saved-findings-not-visible')
    console.log(JSON.stringify({
      verifiedRecentPublications: Math.min(published.length,3),
      appHttpStatus: response.status,
      cloudVideosInFeed: body.data.videos.filter(v => ['github', 'gemini-video'].includes(v.via ?? '')).length,
      cloudStatusInApp: body.data.videoIngestion?.githubRunner?.status ?? null,
    }))
  }
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `### App publication\n\n${report.cloudTranscripts} recent cloud transcripts; ${report.cloudAnalysesInApp} cloud analyses available in The street → Videos; ${report.awaitingAnalysis} awaiting analysis.\n`)
}
main().catch(() => { console.error('Publication verification unavailable'); process.exitCode = 1 })
