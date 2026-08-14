// OfflinePill (DS-13, CX-6): the app-wide "you're looking at cached data"
// surface. useSlice reports each mounted slice's health here; the pill shows
// when ANY mounted slice is offline, stamped with the OLDEST offline data age.
// The registry is module-level so the pill needs no context plumbing.
//
// KEYED BY HOOK INSTANCE, NOT BY SLICE KEY (final wave, D1). One slice key can
// have several mounted readers — the desk holds two of 'board' at once, Today
// and the BoardColumn — and a registry keyed by the slice key gave them one
// shared entry that EITHER unmount deleted. So a Today that had gone offline
// went silent the moment the other component unmounted, and the reader was left
// looking at cached rows with nothing saying so. Each hook now owns its own row
// and deletes only its own; the key rides along inside the health so the
// aggregate can still be read per slice if it ever needs to be.

import { useSyncExternalStore } from 'react'

export interface Health {
  /** The slice this instance is reading — carried for diagnostics, not keyed on. */
  key: string
  offline: boolean
  fetchedAt: number | null
}

/** instanceId → that hook's health. See the note above on why not `key`. */
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

/** `instanceId` is one MOUNTED HOOK, stable for that hook's whole life (see
 * useSlice's `instanceId` ref). Passing null retires that one instance. */
export function reportSliceHealth(instanceId: string, health: Health | null): void {
  if (health === null) registry.delete(instanceId)
  else registry.set(instanceId, health)
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
