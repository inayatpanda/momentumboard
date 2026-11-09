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
    const body = await response.json().catch(() => null) as { ok?: boolean; data?: { videos?: { url: string; at?: number; via?: string }[]; videoIngestion?: { githubRunner?: { status: string; saved: number; unavailable: number } } } } | null
    if (!response.ok || !body?.ok || !Array.isArray(body.data?.videos)) throw new Error('app-feed-unavailable')
    const feed = body.data.videos
    const visible = new Set(feed.map(v => videoKey(v.url)))
    // The feed lists only the newest 30 videos from EVERY source, so
    // a busy local transcript runner can push older cloud reads off the end.
    // Only a cloud read newer than the oldest listed video ought to be visible.
    const feedTimes = feed.map(v => v.at).filter((n): n is number => typeof n === 'number')
    const oldestListed = feedTimes.length ? Math.min(...feedTimes) : 0
    const missing = published.slice(0,3).filter(v => v.at >= oldestListed && !visible.has(videoKey(v.url)))
    if (missing.length) throw new Error('saved-findings-not-visible')
    console.log(JSON.stringify({
      verifiedRecentPublications: published.slice(0,3).filter(v => v.at >= oldestListed).length,
      appHttpStatus: response.status,
      cloudVideosInFeed: body.data.videos.filter(v => ['github', 'gemini-video'].includes(v.via ?? '')).length,
      cloudStatusInApp: body.data.videoIngestion?.githubRunner?.status ?? null,
    }))
  }
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `### App publication\n\n${report.cloudTranscripts} recent cloud transcripts; ${report.cloudAnalysesInApp} cloud analyses available in The street → Videos; ${report.awaitingAnalysis} awaiting analysis.\n`)
}
// The reason is one of our own fixed codes (never a token or transcript text).
main().catch((e: unknown) => {
  const reason = e instanceof Error && /^[a-z-]+$/.test(e.message) ? e.message : 'unexpected-error'
  console.error(`Publication verification unavailable: ${reason}`); process.exitCode = 1
})
