import type { PushSub } from '../push.mts'
import type { AppStore } from './store'

interface VapidEnv {
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
}

/** Sends a notification to every registered device; prunes dead subscriptions (404/410). */
export async function sendPushAll(store: AppStore, env: VapidEnv, payload: { title: string; body: string; url?: string }): Promise<number> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return 0
  const subs = (await store.read<PushSub[]>('push-subs')) ?? []
  if (!subs.length) return 0
  const webpush = (await import('web-push')).default
  webpush.setVapidDetails('mailto:inayatc2002@gmail.com', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY)
  const gone: string[] = []
  let sent = 0
  await Promise.all(
    subs.map(async sub => {
      try {
        await webpush.sendNotification(sub as never, JSON.stringify(payload), { TTL: 3600 })
        sent++
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode
        if (code === 404 || code === 410) gone.push(sub.endpoint)
      }
    }),
  )
  if (gone.length) await store.write('push-subs', subs.filter(s => !gone.includes(s.endpoint)))
  return sent
}
