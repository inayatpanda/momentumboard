import { getToken } from './api'

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)))
}

export type PushStatus = 'granted' | 'denied' | 'unsupported' | 'needs-install' | 'error'

export async function enablePush(): Promise<PushStatus> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    // iPhone Safari exposes PushManager only once the PWA runs from the Home Screen
    const iOS = /iPhone|iPad/.test(navigator.userAgent)
    return iOS && !window.matchMedia('(display-mode: standalone)').matches ? 'needs-install' : 'unsupported'
  }
  try {
    const perm = await Notification.requestPermission()
    if (perm !== 'granted') return 'denied'
    const reg = await navigator.serviceWorker.ready
    const keyRes = await fetch('/api/push')
    const { data } = (await keyRes.json()) as { data: { publicKey: string | null } }
    if (!data.publicKey) return 'error'
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(data.publicKey) as BufferSource }))
    const res = await fetch('/api/push', {
      method: 'POST',
      headers: { 'x-app-token': getToken() ?? '', 'content-type': 'application/json' },
      body: JSON.stringify(sub),
    })
    return res.ok ? 'granted' : 'error'
  } catch {
    return 'error'
  }
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window
}
