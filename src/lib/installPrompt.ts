// Android/Chrome fires `beforeinstallprompt` when the app is installable but
// not yet installed. Chrome buries its own entry in the ⋮ menu, so we stash
// the event and let the UI offer a real "Install the app" button. iOS never
// fires it (Safari only has Share → Add to Home Screen) — the button simply
// never appears there.

type BIPEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

let deferred: BIPEvent | null = null
const listeners = new Set<(available: boolean) => void>()

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault() // no mini-infobar; we present install ourselves
    deferred = e as BIPEvent
    listeners.forEach(l => l(true))
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    listeners.forEach(l => l(false))
  })
}

/** Subscribe to installability; fires immediately with the current state. */
export function onInstallAvailable(fn: (available: boolean) => void): () => void {
  listeners.add(fn)
  fn(!!deferred)
  return () => void listeners.delete(fn)
}

/** Show the native install dialog (must be called from a user gesture). */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false
  await deferred.prompt()
  const { outcome } = await deferred.userChoice
  if (outcome === 'accepted') deferred = null
  listeners.forEach(l => l(!!deferred))
  return outcome === 'accepted'
}
