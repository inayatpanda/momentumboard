import { Component, type ErrorInfo, type ReactNode } from 'react'

const CHUNK_ERROR = /Failed to fetch dynamically imported module|Importing a module script failed|Loading chunk \d+ failed|ChunkLoadError/i

export function isChunkLoadError(error: unknown): boolean {
  return CHUNK_ERROR.test(error instanceof Error ? error.message : String(error))
}

/**
 * A deployed PWA can briefly have an older shell controlling a newer asset
 * set. Ask the waiting worker to take over before reloading so the retry uses
 * one coherent build rather than requesting a lazy chunk that no longer
 * exists.
 */
export async function loadLatestBuild(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.getRegistration()
    await registration?.update().catch(() => undefined)
    if (registration?.waiting) {
      const controlled = new Promise<void>(resolve => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true })
      })
      registration.waiting.postMessage({ type: 'SKIP_WAITING' })
      await Promise.race([controlled, new Promise<void>(resolve => setTimeout(resolve, 1_200))])
    }
  } catch {
    // A network-only browser still benefits from a normal reload below.
  }
  location.reload()
}

interface State {
  error: unknown | null
}

export class ChunkRecoveryBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    if (!isChunkLoadError(error)) console.error(error, info)
  }

  render() {
    if (!this.state.error) return this.props.children
    const chunkFailure = isChunkLoadError(this.state.error)
    return (
      <section className="v2-recovery card" role="alert">
        <div className="sec-label">{chunkFailure ? 'App update ready' : 'This screen could not open'}</div>
        <h2>{chunkFailure ? 'Load the latest StreetSignal build' : 'Try this screen again'}</h2>
        <p>
          {chunkFailure
            ? 'StreetSignal was updated while this copy was open. Reload once to keep every screen on the same version.'
            : 'The app hit an unexpected display error. Reloading will preserve your saved data.'}
        </p>
        <button className="pill accent" onClick={() => void loadLatestBuild()}>
          Update and reload
        </button>
      </section>
    )
  }
}
