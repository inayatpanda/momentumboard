import type { AppStore } from '../../netlify/functions/lib/storeProvider'
import { discoverVideos } from '../../netlify/functions/lib/youtube'
import { recordInboxVideos } from '../../netlify/functions/lib/videoTranscriptStore'
import { withDefaults } from '../../shared/channels'

/** Each cloud run discovers uploads independently of the app and the Mac. */
export async function discoverFollowedVideos(store: AppStore, now: number, fetchFn: typeof fetch = fetch) {
  const config = await store.read<{ ytChannels?: { id: string; name: string }[] }>('config')
  const found = await discoverVideos(withDefaults(config?.ytChannels), now, fetchFn, 30)
  const added = await recordInboxVideos(store, found.videos, now)
  await store.write('video-channel-discovery:v1', { at: now, lookbackDays: 30, channels: found.channels })
  return { discovered: found.videos.length, added, checkedChannels: found.channels.length, unavailableChannels: found.channels.filter(c => c.status !== 'ok').length }
}
