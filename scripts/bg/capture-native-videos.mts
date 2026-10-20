import { configureStoreForScript } from '../lib/configureStore'
import { acquireLease, appStore, releaseLease } from '../../netlify/functions/lib/storeProvider'
import { nativeDraftText, publishNativeDraft, readNativeVideo, type NativeVideoDraft } from '../../netlify/functions/lib/nativeVideo'
import { reserveSocialBudget } from '../../netlify/functions/lib/socialBudget'
import { readStoredTranscript, type InboxVideo } from '../../netlify/functions/lib/videoTranscriptStore'
import { enqueueSocialJobs, finishSocialAttempt, socialJobId } from '../../netlify/functions/lib/socialJobs'
import { setCached } from '../../netlify/functions/lib/cache'
import { videoKey } from '../../shared/youtubeCaptions.mjs'

async function main() {
  await configureStoreForScript()
  const target = process.env.VIDEO_ID
  if (target && !/^[A-Za-z0-9_-]{11}$/.test(target)) throw new Error('invalid-target')
  const now = Math.floor(Date.now() / 1000)
  const lease = await acquireLease(appStore, 'lease:github-native-videos', now, 12 * 60)
  if (!lease) throw new Error('native-running')
  const status = { at: now, running: true, published: 0, attempted: 0, failed: 0, reused: 0, capped: false, status: 'running' }
  try {
    await appStore.write('video-native-runner', status)
    const inbox = await appStore.read<InboxVideo[]>('video-inbox') ?? []
    const candidates = inbox.filter(v => !target || videoKey(v.url) === target).sort((a, b) => (b.publishedAt ?? b.at) - (a.publishedAt ?? a.at))
    if (target && !candidates.length) throw new Error('target-not-discovered')
    let processed = 0
    for (const video of candidates) {
      if (processed >= 2) break
      const id = videoKey(video.url)
      const existingExtract = await appStore.read<{ nativeTranscript?: unknown }>(`video-extract:v1:${id}`)
      if (existingExtract && (!target || !existingExtract.nativeTranscript)) continue
      let draft = await appStore.read<NativeVideoDraft>(`video-native-draft:${id}`)
      const hadWords = !!await readStoredTranscript(appStore, video.url)
      // Caption-backed jobs stay on the normal extraction lane. A saved native
      // draft can be published without another API call, even after a restart.
      if (!draft && hadWords) continue
      processed++
      if (!draft || !nativeDraftText(draft)) {
        if (new Date().getUTCHours() < 8 || !await reserveSocialBudget(appStore, 'gemini-extract', Math.floor(Date.now() / 1000))) {
          status.capped = true
          break
        }
        status.attempted++
        try {
          draft = await readNativeVideo(video.url, process.env.GEMINI_API_KEY ?? '')
          await appStore.write(`video-native-draft:${id}`, draft)
        } catch (error) {
          status.failed++
          const reason = /^native-[a-z0-9-]+$/.test((error as Error).message) ? (error as Error).message : 'native-read-failed'
          console.log(JSON.stringify({ videoId: id, ok: false, reason }))
          continue
        }
      } else status.reused++
      const publication = await publishNativeDraft(appStore, draft, video, Math.floor(Date.now() / 1000))
      if (publication === 'published') status.published++
      await enqueueSocialJobs(appStore, [{ ...video, mode: 'extract' }], now)
      await finishSocialAttempt(appStore, socialJobId(video.url), { ok: true }, Math.floor(Date.now() / 1000))
      await setCached('street-wire:v3', null, 0)
      // Verify this exact URL through the application's authenticated feed.
      // Credentials/source text never leave this job or enter public logs.
      const response = await fetch('https://thestreetsignal.rqai.co.uk/api/market?type=street', {
        headers: { 'x-app-token': process.env.APP_TOKEN ?? '' }, redirect: 'error', signal: AbortSignal.timeout(30_000),
      })
      const body = await response.json() as { ok?: boolean; data?: { videos?: { url: string; via?: string; tickers?: unknown[]; nativeTranscript?: { characters: number } }[] } }
      const visible = body.data?.videos?.find(v => videoKey(v.url) === id && v.via === 'gemini-video')
      console.log(JSON.stringify({
        videoId: id, transcriptExistedBeforePublication: hadWords, publication, appHttpStatus: response.status,
        appVisible: !!visible, characters: nativeDraftText(draft)?.length,
        findings: visible?.tickers?.length ?? 0, nativeTranscriptVisible: !!visible?.nativeTranscript,
      }))
      if (!response.ok || !body.ok || !visible || !visible.nativeTranscript) throw new Error('publication-not-visible')
    }
    status.status = 'complete'
  } catch {
    status.status = 'error'
    throw new Error('native-run-incomplete')
  } finally {
    status.running = false
    status.at = Math.floor(Date.now() / 1000)
    try {
      await appStore.write('video-native-runner', status)
      await setCached('street-wire:v3', null, 0)
    } finally { await releaseLease(appStore, 'lease:github-native-videos', lease) }
    console.log(JSON.stringify(status))
  }
}
main().catch(() => { console.error('Native video run incomplete; inspect app Tracking.'); process.exitCode = 1 })
