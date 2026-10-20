import { discoverFollowedVideos } from '../lib/discoverFollowedVideos'
import { appendFile } from 'node:fs/promises'
import { configureStoreForScript } from '../lib/configureStore'
import { appStore } from '../../netlify/functions/lib/storeProvider'
import { fetchCaptionTranscript } from '../../shared/youtubeCaptions.mjs'
// Shared with the optional Mac collector; these programs run on the Actions VM.
// @ts-expect-error plain Node module
import { fetchLibraryCaptions } from '../local/captions-library.mjs'
// @ts-expect-error plain Node module
import { fetchAudioTranscript } from '../local/audio-transcript.mjs'
import { collectGithubVideos } from '../lib/githubVideoCapture'
import { withDefaults } from '../../shared/channels'

async function main() {
  if (process.env.STORE_BACKEND !== 'd1') throw new Error('d1-required')
  await configureStoreForScript()
  console.log(JSON.stringify({ discovery: await discoverFollowedVideos(appStore, Math.floor(Date.now() / 1000)) }))
  const config = await appStore.read<{ ytChannels?: { id: string; name: string }[] }>('config')
  const deadlineMs = Date.now() + 30 * 60_000
  const result = await collectGithubVideos(appStore, {
    followedChannels: withDefaults(config?.ytChannels),
    captions: fetchCaptionTranscript, library: fetchLibraryCaptions,
    audio: url => fetchAudioTranscript(url, { deadlineMs: Math.min(deadlineMs, Date.now() + 12 * 60_000), maxDurationSec: 5400 }),
    deadline: Math.floor(deadlineMs / 1000),
  })
  console.log(JSON.stringify(result ?? { status: 'another-collector-running' }))
  if (process.env.GITHUB_STEP_SUMMARY && result) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `### YouTube capture\n\nChecked ${result.attempted}; saved ${result.saved} (${result.captions} captions, ${result.speech} speech transcripts); already available ${result.reused}; unavailable ${result.unavailable}.\n\nUnavailable videos stay queued for a later attempt. No video, audio or transcript artifacts are uploaded to GitHub.\n`)
  }
}
main().catch(() => { console.error('Cloud capture failed; inspect Tracking for the last confirmed progress.'); process.exitCode = 1 })
