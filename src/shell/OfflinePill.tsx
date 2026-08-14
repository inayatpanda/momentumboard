// OfflinePill (DS-13, CX-6): the app-wide "you're looking at cached data"
// surface. useSlice reports each mounted slice's health here; the pill shows
// when ANY mounted slice is offline, stamped with the OLDEST offline data age.
// The registry is module-level so the pill needs no context plumbing.

import { useSyncExternalStore } from 'react'

interface Health {
  offline: boolean
  fetchedAt: number | null
}

const registry = new Map<string, Health>()
const listeners = new Set<() => void>()
let snapshot: { offline: boolean; oldest: number | null } = { offline: false, oldest: null }

function recompute() {
  const off = [...registry.values()].filter(h => h.offline)
  const next = {
    offline: off.length > 0,
    oldest: off.length ? Math.min(...off.map(h => h.fetchedAt ?? Number.MAX_SAFE_INTEGER)) : null,
  }
  if (next.offline !== snapshot.offline || next.oldest !== snapshot.oldest) {
    snapshot = next
    listeners.forEach(l => l())
  }
}

export function reportSliceHealth(key: string, health: Health | null): void {
  if (health === null) registry.delete(key)
  else registry.set(key, health)
  recompute()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function OfflinePill() {
  const state = useSyncExternalStore(subscribe, () => snapshot)
  if (!state.offline) return null
  const stamp =
    state.oldest && state.oldest !== Number.MAX_SAFE_INTEGER
      ? new Date(state.oldest).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
      : null
  return (
    <div className="v2-offline pill" role="status">
      {stamp ? `offline — showing ${stamp} data` : 'offline'}
    </div>
  )
}
