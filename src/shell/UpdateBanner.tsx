// UpdateBanner (DS-6, CX-8/9): the ONLY way a new service worker takes over a
// live session. No skipWaiting, no clientsClaim — the reader chooses, or the
// new version arrives on the next cold open.

import { useRegisterSW } from 'virtual:pwa-register/react'

export function UpdateBanner() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW()
  if (!needRefresh) return null
  return (
    <div className="v2-update card" role="alert">
      <span>New version ready.</span>
      <button className="pill accent" onClick={() => void updateServiceWorker(true)}>
        Reload
      </button>
    </div>
  )
}
