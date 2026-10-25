import { useState } from 'react'
import { apiUrl, setToken } from '../lib/api'
import { humanError } from '../lib/format'

// Recovery after an automatic free-access connection/limit failure. Existing
// owner/reader keys are optional and validated before replacing this device.

export function AppGate({ onUnlocked,error:initialError,onRetry }: { onUnlocked: () => void;error?:string|null;onRetry?:()=>void }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(initialError??null)
  const [key, setKey] = useState('')

  const unlock = async () => {
    // accept a bare key OR a whole pasted unlock link (…/?key=mb_…)
    const raw = key.trim()
    const fromLink = raw.match(/[?&]key=([^&\s]+)/)
    const token = (fromLink ? fromLink[1] : raw).trim()
    if (!token || pending) return
    setPending(true);setError(null)
    try{
      const response=await fetch(apiUrl('/api/licences?check=1'),{headers:{'x-app-token':token}})
      if(!response.ok)throw new Error('That saved access key is no longer valid. You can use free access instead.')
      setToken(token)
    // Preserve the legacy claim timestamp for existing installed clients.
    localStorage.setItem('mb-token-at', String(Date.now()))
      onUnlocked()
    }catch(err){setError(humanError(err));setPending(false)}
  }

  return (
    <div className="app-gate">
      <div className="app-gate-card">
        <h1 className="app-gate-name">
          The Street <span>Signal</span>
        </h1>
        <p className="app-gate-sub">Free access. No sign-up or licence key needed.</p>
        {error && <p className="app-gate-error" role="alert">{error}</p>}
        {onRetry && <button className="app-gate-trial" onClick={onRetry}>Try again</button>}
        <details><summary>Restore an existing access key</summary>
        <form
          className="app-gate-form"
          onSubmit={e => {
            e.preventDefault()
            void unlock()
          }}
        >
          <input
            type="password"
            placeholder="Licence key or unlock link"
            autoComplete="off"
            value={key}
            onChange={e => setKey(e.target.value)}
            aria-label="Licence key"
          />
          <button type="submit" className="app-gate-unlock" disabled={!key.trim()||pending}>
            {pending?'Checking…':'Restore access'}
          </button>
        </form>
        </details>
        <a className="app-gate-site" href="https://thestreetsignal.rqai.co.uk/" target="_blank" rel="noreferrer">
          About The Street Signal ↗
        </a>
      </div>
    </div>
  )
}
