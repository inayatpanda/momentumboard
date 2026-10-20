import { useEffect, useState } from 'react'
import { db } from '../../lib/db'
import { mirrorConfig } from '../../lib/configMirror'

export function WatchStockButton({ symbol }: { symbol: string }) {
  const [watching, setWatching] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    setWatching(null)
    const read = () => void db.watchlist.get(symbol).then(row => { if (active) setWatching(!!row) })
    read(); window.addEventListener('mb-watchlist-changed', read)
    return () => { active = false; window.removeEventListener('mb-watchlist-changed', read) }
  }, [symbol])
  const toggle = async () => {
    setBusy(true); setError(false)
    try {
      if (watching) await db.watchlist.delete(symbol)
      else await db.watchlist.put({ symbol, addedAt: Date.now(), riskClass: 'normal' })
      setWatching(!watching); mirrorConfig(); window.dispatchEvent(new Event('mb-watchlist-changed'))
    } catch { setError(true) } finally { setBusy(false) }
  }
  return <div className="company-follow"><button type="button" aria-label={`${watching ? 'Unfollow' : 'Follow'} ${symbol}`} aria-pressed={watching === true} disabled={busy || watching === null} onClick={toggle}>{watching ? '✓ Following' : '+ Follow'}</button>{error && <small role="alert">Could not save. Try again.</small>}</div>
}
