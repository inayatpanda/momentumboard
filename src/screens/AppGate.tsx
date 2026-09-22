import { useState } from 'react'
import { unlockWithPassword } from '../lib/api'

// THE APP GATE: what an unlicensed device sees at /app/ — the app's own front
// door, NOT the marketing website. The site (Landing/SitePages) is a separate
// surface for reading ABOUT the product; opening the app must feel like an
// app: nameplate, key field, trial button, done. Born of the desktop shell
// opening onto the full webpage ("those are two different things").

export function AppGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [password, setPassword] = useState('')

  const unlock = async () => {
    if (!password.trim() || pending) return
    setError(null)
    setPending(true)
    try {
      await unlockWithPassword(password)
      localStorage.setItem('mb-token-at', String(Date.now()))
      onUnlocked()
    } catch {
      setError('Incorrect password. Check it and try again.')
      setPending(false)
    }
  }

  return (
    <div className="app-gate">
      <div className="app-gate-card">
        <h1 className="app-gate-name">
          The Street <span>Signal</span>
        </h1>
        <p className="app-gate-sub">Friends preview — enter the shared password once on this device.</p>
        <form
          className="app-gate-form"
          onSubmit={e => {
            e.preventDefault()
            void unlock()
          }}
        >
          <input
            type="password"
            placeholder="Shared password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={e => setPassword(e.target.value)}
            aria-label="Shared password"
          />
          <button type="submit" className="app-gate-unlock" disabled={pending || !password.trim()}>
            {pending ? 'Checking…' : 'Enter'}
          </button>
        </form>
        {error && (
          <p className="app-gate-error" role="alert">
            {error}
          </p>
        )}
        <a className="app-gate-site" href="https://thestreetsignal.rqai.co.uk/" target="_blank" rel="noreferrer">
          About The Street Signal ↗
        </a>
      </div>
    </div>
  )
}
