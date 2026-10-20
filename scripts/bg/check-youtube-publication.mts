import { appendFile } from 'node:fs/promises'
import { configureStoreForScript } from '../lib/configureStore'
import { appStore } from '../../netlify/functions/lib/storeProvider'
import { readTranscriptIndex } from '../../netlify/functions/lib/videoTranscriptStore'
import type { VideoExtract } from '../../netlify/functions/lib/videoTrends'
import { videoKey } from '../../shared/youtubeCaptions.mjs'

async function main() {
  await configureStoreForScript()
  const [transcripts, extracts] = await Promise.all([readTranscriptIndex(appStore), appStore.read<VideoExtract[]>('video-extracts')])
  const cloud = transcripts.filter(t => t.source === 'github')
  const published = (extracts ?? []).filter(e => e.via === 'github')
  const ready = new Set(published.map(e => videoKey(e.url)))
  const report = {
    cloudTranscripts: cloud.length, cloudAnalysesInApp: published.length,
    awaitingAnalysis: cloud.filter(t => !ready.has(videoKey(t.url))).length,
    latestPublishedAt: published.reduce((n, e) => Math.max(n, e.at), 0) || null,
    // Only public video identities and counts; never transcripts or credentials.
    latestVideos: published.slice(-3).map(e => ({ url: e.url, tickers: e.tickers.length, claims: e.claims?.length ?? 0 })),
  }
  console.log(JSON.stringify(report))
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `### App publication\n\n${report.cloudTranscripts} recent cloud transcripts; ${report.cloudAnalysesInApp} cloud analyses available in The street → Videos; ${report.awaitingAnalysis} awaiting analysis.\n`)
}
main().catch(() => { console.error('Publication verification unavailable'); process.exitCode = 1 })
