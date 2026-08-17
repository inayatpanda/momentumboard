// SettingsAdmin (plan Task 21) — licence status, the admin-unlock escape
// hatch, and the admin-only licence manager. Ported faithfully from the
// legacy src/screens/SettingsScreen.tsx (useIsAdmin:34-51, AdminUnlock:191-
// 249, LicenceManager:251-303) onto v2 tokens; the ONE admin probe for the
// whole Settings screen still lives here so a re-render never re-fires it.

import { useCallback, useEffect, useState } from 'react'
import { apiUrl, createLicence, getLicences, getToken, isSharedFreeToken, revokeLicence, setToken } from '../../lib/api'

type Licence = Awaited<ReturnType<typeof getLicences>>[number]

const Svg = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width={17} height={17} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
)
const IconKey = () => <Svg d="M21 2l-9.4 9.4M15.5 7.5l3 3M11.6 11.6a5 5 0 11-7.07 7.07 5 5 0 017.07-7.07z" />

/** isAdmin: null = probe in flight (every gated section hidden, matching the
 * legacy screen's initial states), true = the server accepted the stored
 * token as admin, false = a normal licence or no token.
 *
 * THE FREE TIER NEVER ASKS (visibility wave, 2026-08-17). The shared DMG token
 * is by construction not the admin key, so /api/licences can only ever answer
 * it 401 — which the live walkthrough caught firing three times on one Settings
 * paint. A request whose answer is already known is not a probe, it is noise in
 * the log and a red row in the reader's devtools. Answering it locally is also
 * the honest answer: false, immediately, with no round trip. */
export function useIsAdmin() {
  const free = isSharedFreeToken()
  const [isAdmin, setIsAdmin] = useState<boolean | null>(free ? false : null)
  const [licences, setLicences] = useState<Licence[]>([])
  const reload = useCallback(() => {
    if (free) {
      setIsAdmin(false)
      return Promise.resolve()
    }
    return getLicences()
      .then(l => {
        setLicences(l)
        setIsAdmin(true)
      })
      .catch(() => setIsAdmin(false))
  }, [free])
  useEffect(() => {
    reload()
  }, [reload])
  return { isAdmin, licences, reload }
}

export function LicenceStatusRow({ isAdmin }: { isAdmin: boolean | null }) {
  const token = getToken()
  const free = isSharedFreeToken()
  const tail = token ? token.slice(-6) : null
  // A SHARED TOKEN IS NOT A LICENCE ON THIS DEVICE. "A licence key is active on
  // this device, ending …97bd72" is true of the binary, not of the reader —
  // every free install carries the same six characters, and quoting them
  // invites the reader to treat a shared key as their own.
  const label = free ? 'Free preview' : isAdmin === null ? 'Checking licence…' : isAdmin ? 'Admin access' : 'Licensed device'
  const sub = free
    ? 'Free preview — licence binding comes later. Nothing on this device is tied to an account yet.'
    : isAdmin === null
      ? "Confirming this device's key with the server."
      : isAdmin
        ? 'This device holds the admin key — full control of this StreetSignal instance.'
        : tail
          ? `A licence key is active on this device, ending …${tail}.`
          : 'No licence key is stored on this device.'
  return (
    <section className="menu-group" aria-label="Licence status">
      <div className="menu-title">Licence</div>
      <div className="menu-row set-static">
        <span className="icon-tile">
          <IconKey />
        </span>
        <span className="set-main">
          <span>{label}</span>
          <span className="sub">{sub}</span>
        </span>
      </div>
    </section>
  )
}

/** Non-admin escape hatch: validate a candidate admin key WITHOUT touching
 * the stored licence token — only a server-accepted key replaces it. */
export function AdminUnlock() {
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    const candidate = key.trim()
    if (!candidate || busy) return
    setBusy(true)
    setErr(null)
    try {
      // Direct fetch with the CANDIDATE key — the stored token stays
      // untouched unless the server says this one is the admin key.
      const res = await fetch(apiUrl('/api/licences'), { headers: { 'x-app-token': candidate } })
      if (res.ok) {
        setToken(candidate)
        location.reload()
      } else {
        setErr("That isn't the admin key")
      }
    } catch {
      setErr('Network error — try again')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="menu-group">
      <div className="menu-title">Admin</div>
      <button type="button" className="menu-row" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="icon-tile amber">
          <IconKey />
        </span>
        <span className="set-main">
          <span>Unlock admin</span>
          <span className="sub">Unlocking replaces this device's licence key with the admin key.</span>
        </span>
        <span className="chev">{open ? '▾' : '›'}</span>
      </button>
      {open && (
        <div className="set-unlock">
          <input
            className="set-in"
            type="password"
            placeholder="Admin key"
            value={key}
            onChange={e => {
              setKey(e.target.value)
              setErr(null)
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') void submit()
            }}
            aria-label="Admin key"
          />
          {err && (
            <p className="set-err" role="alert">
              {err}
            </p>
          )}
          <button type="button" className="btn-primary" disabled={busy || !key.trim()} onClick={submit}>
            {busy ? 'Checking…' : 'Unlock'}
          </button>
        </div>
      )}
    </section>
  )
}

export function LicenceManager({ licences, reload }: { licences: Licence[]; reload: () => Promise<void> }) {
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <section className="menu-group">
      <div className="menu-title">Licences</div>
      {licences
        .filter(l => !l.revoked)
        .map(l => (
          <div key={l.key} className="menu-row set-static">
            <span className="icon-tile">
              <IconKey />
            </span>
            <span className="set-main">
              <span>{l.label}</span>
              <span className="sub num">
                {l.key.slice(0, 10)}… · {new Date(l.createdAt).toLocaleDateString()}
              </span>
            </span>
            <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <button
                type="button"
                className="mini-btn ghost"
                onClick={() => {
                  navigator.clipboard?.writeText(l.unlockLink)
                  if (navigator.share) navigator.share({ title: 'StreetSignal access', url: l.unlockLink }).catch(() => {})
                }}
              >
                Copy link
              </button>
              <button type="button" className="remove" onClick={() => void revokeLicence(l.key).then(reload)} aria-label={`Revoke ${l.label}`}>
                ✕
              </button>
            </span>
          </div>
        ))}
      <div className="set-inrow">
        <input className="set-in" placeholder="New licence label (e.g. Dad's phone)" value={label} onChange={e => setLabel(e.target.value)} style={{ flex: 1 }} aria-label="Licence label" />
        <button
          type="button"
          className="mini-btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await createLicence(label)
              setLabel('')
              await reload()
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? '…' : 'Generate'}
        </button>
      </div>
      <p className="set-note">
        Each licence unlocks the app with its OWN watchlist and data. Licensees get everything except your Telegram alerts and the personalised morning report. Revoking a key locks that user out
        instantly. Your key is the admin key; this panel exists only for you.
      </p>
    </section>
  )
}
