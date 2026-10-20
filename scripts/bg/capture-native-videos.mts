import { discoverFollowedVideos } from '../lib/discoverFollowedVideos'
import { configureStoreForScript } from '../lib/configureStore'
import { appStore } from '../../netlify/functions/lib/storeProvider'
import { collectNativeVideos } from '../lib/nativeVideoQueue'
import { setCached } from '../../netlify/functions/lib/cache'
import { videoKey } from '../../shared/youtubeCaptions.mjs'

async function main() {
  await configureStoreForScript()
  console.log(JSON.stringify({ discovery: await discoverFollowedVideos(appStore, Math.floor(Date.now() / 1000)) }))
  const freeTierConfirmed = process.env.NATIVE_FREE_TIER_CONFIRMED === 'true'
  try {
    const status = await collectNativeVideos(appStore, {
      target: process.env.VIDEO_ID || undefined,
      cachedOnly: process.env.NATIVE_CACHED_ONLY === 'true',
      forceVideo: !!process.env.VIDEO_ID && process.env.NATIVE_FORCE_VIDEO === 'true',
      freeTierConfirmed, scheduled: freeTierConfirmed && process.env.NATIVE_SCHEDULE_ENABLED === 'true',
      key: process.env.GEMINI_YOUTUBE_FREE_API_KEY ?? '',
      log: data => console.log(JSON.stringify(data)),
      onPublish: async (video, kind, publication) => {
        // An existing older result may legitimately be outside the latest 30.
        // Only a new publication must appear immediately in the live feed.
        if (publication !== 'published') return
        await setCached('street-wire:v3', null, 0)
        const response = await fetch('https://thestreetsignal.rqai.co.uk/api/market?type=street', {
          headers: { 'x-app-token': process.env.APP_TOKEN ?? '' }, redirect: 'error', signal: AbortSignal.timeout(30_000),
        })
        const body = await response.json() as { ok?: boolean; data?: { videos?: { url: string; tickers?: unknown[]; nativeTranscript?: { progress?: unknown } }[] } }
        const visible = body.data?.videos?.find(v => videoKey(v.url) === videoKey(video.url))
        console.log(JSON.stringify({ videoId: videoKey(video.url), publication, method: kind, appHttpStatus: response.status,
          appVisible: !!visible, findings: visible?.tickers?.length ?? 0, progress: visible?.nativeTranscript?.progress }))
        if (!response.ok || !body.ok || !visible) throw new Error('native-publication-not-visible')
      },
    })
    console.log(JSON.stringify(status))
    if (status.failed && !status.published && !status.reused && !status.capped) process.exitCode = 1
  } finally { await setCached('street-wire:v3', null, 0) }
}
main().catch(() => { console.error('Free video run incomplete; saved sections remain available. Inspect app Tracking.'); process.exitCode = 1 })
