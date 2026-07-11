import { useState } from 'react'
import { setToken, startTrial } from '../lib/api'
import { humanError } from '../lib/format'

// THE APP GATE: what an unlicensed device sees at /app/ — the app's own front
// door, NOT the marketing website. The site (Landing/SitePages) is a separate
// surface for reading ABOUT the product; opening the app must feel like an
// app: nameplate, key field, trial button, done. Born of the desktop shell
// opening onto the full webpage ("those are two different things").

export function AppGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [key, setKey] = useState('')

  const unlock = () => {
    // accept a bare key OR a whole pasted unlock link (…/?key=mb_…)
    const raw = key.trim()
    const fromLink = raw.match(/[?&]key=([^&\s]+)/)
    const token = (fromLink ? fromLink[1] : raw).trim()
    if (!token) return
    setToken(token)
    // fresh-unlock grace: a just-minted key can 401 off a stale replica —
    // the boot check must not burn it (same contract as main.tsx ?key links)
    localStorage.setItem('mb-token-at', String(Date.now()))
    onUnlocked()
  }

  const trial = async () => {
    if (pending) return
    setError(null)
    setPending(true)
    try {
      await startTrial() // stores the token itself
      localStorage.setItem('mb-token-at', String(Date.now()))
      onUnlocked()
    } catch (err) {
      setError(humanError(err))
      setPending(false)
    }
  }

  return (
    <div className="app-gate">
      <div className="app-gate-card">
        <h1 className="app-gate-name">
          The Street <span>Signal</span>
        </h1>
        <p className="app-gate-sub">Enter your licence key once — this device stays unlocked.</p>
        <form
          className="app-gate-form"
          onSubmit={e => {
            e.preventDefault()
            unlock()
          }}
        >
          <input
            type="password"
            placeholder="Licence key or unlock link"
            autoComplete="off"
            autoFocus
            value={key}
            onChange={e => setKey(e.target.value)}
            aria-label="Licence key"
          />
          <button type="submit" className="app-gate-unlock" disabled={!key.trim()}>
            Unlock
          </button>
        </form>
        {error && (
          <p className="app-gate-error" role="alert">
            {error}
          </p>
        )}
        <div className="app-gate-or">No key yet?</div>
        <button className="app-gate-trial" onClick={trial} disabled={pending}>
          {pending ? 'Setting up your access…' : 'Start a free 7-day reader pass'}
        </button>
        <a className="app-gate-site" href="https://thestreetsignal.rqai.co.uk/" target="_blank" rel="noreferrer">
          About The Street Signal ↗
        </a>
      </div>
    </div>
  )
}
