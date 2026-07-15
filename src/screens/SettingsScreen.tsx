import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { db, getCapital, getChannels } from '../lib/db'
import { resolveChannel, getLicences, createLicence, revokeLicence, getLlmKeyStatus, putLlmKey, getT212KeyStatus, putT212Key, deleteT212Key, apiGet, putConfig, setToken } from '../lib/api'
import { mirrorConfig } from '../lib/configMirror'
import { enablePush, pushSupported, type PushStatus } from '../lib/push'
import { IconBack, IconBell, IconMoon, IconShare, IconSparkle, IconSun, IconSwap } from '../components/icons'
import { onInstallAvailable, promptInstall } from '../lib/installPrompt'
import type { AppConfig, ReportEdition, ReportRecipient } from '../../shared/config'

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

type Licence = Awaited<ReturnType<typeof getLicences>>[number]

/* Local one-off icons (same Lucide-stroke language as components/icons). */
const Svg = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width={17} height={17} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
)
const IconKey = () => <Svg d="M21 2l-9.4 9.4M15.5 7.5l3 3M11.6 11.6a5 5 0 11-7.07 7.07 5 5 0 017.07-7.07z" />
const IconGlobe = () => <Svg d="M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c2.5 2.4 3.9 5.5 3.9 9s-1.4 6.6-3.9 9c-2.5-2.4-3.9-5.5-3.9-9S9.5 5.4 12 3z" />

const hueOf = (s: string) => {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

/** ONE admin probe for the whole screen (the old ByoAiKey / LicenceManager /
 * ReportRecipients each probed getLicences() separately = 3 calls).
 * isAdmin: null = probe in flight (all gated sections hidden, matching the old
 * initial states), true = server accepted the stored token as admin,
 * false = normal licence / no token. */
function useIsAdmin() {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null)
  const [licences, setLicences] = useState<Licence[]>([])
  const reload = useCallback(
    () =>
      getLicences()
        .then(l => {
          setLicences(l)
          setIsAdmin(true)
        })
        .catch(() => setIsAdmin(false)),
    [],
  )
  useEffect(() => {
    reload()
  }, [reload])
  return { isAdmin, licences, reload }
}

function ByoAiKey({ isAdmin }: { isAdmin: boolean | null }) {
  // Licensees run AI features on THEIR OWN key (free at console.groq.com);
  // the owner's key lives in server env and is never used for licensees.
  const [hasKey, setHasKey] = useState(false)
  const [key, setKey] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    getLlmKeyStatus().then(s => setHasKey(s.hasKey)).catch(() => {})
  }, [])
  if (isAdmin !== false) return null // inverse gate: only NON-admin devices see this
  return (
    <section className="menu-group">
      <div className="menu-title">AI</div>
      <div className="menu-row set-static">
        <span className="icon-tile gold"><IconSparkle /></span>
        <span className="set-main">
          <span>Your AI key</span>
          <span className="sub">
            AI briefs and note feedback run on your own free Groq key (console.groq.com). {hasKey ? 'A key is saved for this licence.' : 'No key saved yet — AI features are off until you add one.'}
          </span>
        </span>
      </div>
      <div className="set-inrow">
        <input className="set-in" type="password" placeholder="gsk_..." value={key} onChange={e => setKey(e.target.value)} style={{ flex: 1 }} aria-label="Groq API key" />
        <button
          className="mini-btn"
          onClick={async () => {
            try {
              await putLlmKey(key.trim())
              setHasKey(!!key.trim())
              setKey('')
              setSaved(true)
              setTimeout(() => setSaved(false), 2500)
            } catch { /* leave input for retry */ }
          }}
        >
          {saved ? 'Saved' : 'Save'}
        </button>
      </div>
    </section>
  )
}

function InstallRow() {
  // shown only while the browser says the app is installable (Android Chrome);
  // installed app / iOS Safari never see it
  const [available, setAvailable] = useState(false)
  useEffect(() => onInstallAvailable(setAvailable), [])
  if (!available) return null
  return (
    <button className="menu-row" onClick={() => void promptInstall()}>
      <span className="icon-tile green"><IconShare /></span>
      <span className="set-main">
        <span>Install the app</span>
        <span className="sub">Adds StreetSignal to your home screen — full screen, no browser bars.</span>
      </span>
      <span className="chev">›</span>
    </button>
  )
}

function T212Connect() {
  // BYO Trading 212 (read-only): each licence connects its own key pair, stored
  // in its private namespace and validated live by the server before it lands.
  // The owner's account key lives in Netlify env — shown here as 'server key'.
  const [status, setStatus] = useState<{ connected: boolean; source: 'env' | 'own' | null } | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = () => getT212KeyStatus().then(setStatus).catch(() => {})
  useEffect(() => { load() }, [])
  if (!status) return null
  return (
    <section className="menu-group">
      <div className="menu-title">Trading 212</div>
      <div className="menu-row set-static">
        <span className="icon-tile"><IconSwap /></span>
        <span className="set-main">
          <span>{status.connected ? 'Connected' : 'Connect your Trading 212'}</span>
          <span className="sub">
            {status.source === 'env'
              ? 'Using the server key. Your live holdings appear in the Journal.'
              : status.connected
                ? 'Your holdings appear in the Journal, with the engine’s read on each.'
                : 'Read-only: in the T212 app go to Settings → API, create a key with the read scopes only, and paste the pair here. The app can see your portfolio, never trade it.'}
          </span>
        </span>
        {status.source === 'own' && (
          <button
            className="remove"
            aria-label="Disconnect Trading 212"
            onClick={async () => {
              await deleteT212Key().catch(() => {})
              setStatus({ connected: false, source: null })
            }}
          >
            ✕
          </button>
        )}
      </div>
      {!status.connected && (
        <>
          <div className="set-inrow">
            <input className="set-in" type="password" placeholder="API key" value={apiKey} onChange={e => setApiKey(e.target.value)} style={{ flex: 1 }} aria-label="Trading 212 API key" />
          </div>
          <div className="set-inrow">
            <input className="set-in" type="password" placeholder="Secret" value={secret} onChange={e => setSecret(e.target.value)} style={{ flex: 1 }} aria-label="Trading 212 secret" />
            <button
              className="mini-btn"
              disabled={busy || !apiKey.trim()}
              onClick={async () => {
                setBusy(true)
                setError('')
                try {
                  await putT212Key(apiKey.trim(), secret.trim())
                  setApiKey('')
                  setSecret('')
                  setStatus({ connected: true, source: 'own' })
                } catch (e) {
                  setError((e as Error).message === 'rejected' ? 'Trading 212 rejected that key — check the pair and its scopes.' : 'Could not save — try again.')
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy ? 'Checking…' : 'Connect'}
            </button>
          </div>
          {error && <p className="set-err" role="alert">{error}</p>}
        </>
      )}
    </section>
  )
}

/** Non-admin escape hatch: validate a candidate admin key WITHOUT touching the
 * stored licence token — only a server-accepted key replaces it. */
function AdminUnlock() {
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
      // Direct fetch with the CANDIDATE key — the stored token stays untouched
      // unless the server says this one is the admin key.
      const res = await fetch('/api/licences', { headers: { 'x-app-token': candidate } })
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
      <button className="menu-row" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="icon-tile amber"><IconKey /></span>
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
            onChange={e => { setKey(e.target.value); setErr(null) }}
            onKeyDown={e => { if (e.key === 'Enter') submit() }}
            aria-label="Admin key"
          />
          {err && <p className="set-err" role="alert">{err}</p>}
          <button className="btn-primary" disabled={busy || !key.trim()} onClick={submit}>
            {busy ? 'Checking…' : 'Unlock'}
          </button>
        </div>
      )}
    </section>
  )
}

function LicenceManager({ licences, reload }: { licences: Licence[]; reload: () => Promise<void> }) {
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <section className="menu-group">
      <div className="menu-title">Licences</div>
      {licences.filter(l => !l.revoked).map(l => (
        <div key={l.key} className="menu-row set-static">
          <span className="icon-tile"><IconKey /></span>
          <span className="set-main">
            <span>{l.label}</span>
            <span className="sub num">{l.key.slice(0, 10)}… · {new Date(l.createdAt).toLocaleDateString()}</span>
          </span>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button
              className="mini-btn ghost"
              onClick={() => {
                navigator.clipboard?.writeText(l.unlockLink)
                if (navigator.share) navigator.share({ title: 'StreetSignal access', url: l.unlockLink }).catch(() => {})
              }}
            >
              Copy link
            </button>
            <button className="remove" onClick={async () => { await revokeLicence(l.key); reload() }} aria-label={`Revoke ${l.label}`}>✕</button>
          </span>
        </div>
      ))}
      <div className="set-inrow">
        <input className="set-in" placeholder="New licence label (e.g. Dad's phone)" value={label} onChange={e => setLabel(e.target.value)} style={{ flex: 1 }} aria-label="Licence label" />
        <button
          className="mini-btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await createLicence(label)
              setLabel('')
              reload()
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? '…' : 'Generate'}
        </button>
      </div>
      <p className="set-note">
        Each licence unlocks the app with its OWN watchlist and data. Licensees get everything except your Telegram alerts and the personalised morning report. Revoking a key locks that user out instantly. Your key is the admin key; this panel exists only for you.
      </p>
    </section>
  )
}

const EDITION_LABEL: Record<ReportEdition, string> = { morning: 'Morning paper', premarket: 'Pre-market', evening: 'Evening' }

function ReportRecipients() {
  // Admin-managed extra recipients, per-edition: each address picks which of
  // the three daily sends (morning paper / pre-market / evening) it receives.
  // Lives in AppConfig (reportRecipients) and round-trips through the same
  // /api/config PUT — read-modify-write against the freshest server copy.
  // validateConfig migrates legacy bare-string lists to all-three on read.
  // Rendered only when the shared admin probe has already succeeded.
  const [recipients, setRecipients] = useState<ReportRecipient[]>([])
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    apiGet<AppConfig | null>('/api/config')
      .then(cfg => setRecipients(cfg?.reportRecipients ?? []))
      .catch(() => {})
  }, [])

  const persist = async (next: ReportRecipient[]) => {
    setBusy(true)
    try {
      const current = (await apiGet<AppConfig | null>('/api/config').catch(() => null)) ?? { watchlist: [], rules: [], ytChannels: [], capital: 5000 }
      await putConfig({ ...current, reportRecipients: next })
      setRecipients(next)
    } finally {
      setBusy(false)
    }
  }

  const addRecipient = async () => {
    const addr = email.trim().toLowerCase()
    if (!EMAIL_RE.test(addr)) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    // new recipients start with just the morning paper — the flagship send;
    // the intraday bulletins are one tap each
    if (!recipients.some(r => r.email === addr)) await persist([...recipients, { email: addr, editions: ['morning'] }])
    setEmail('')
  }

  const removeRecipient = async (addr: string) => {
    await persist(recipients.filter(r => r.email !== addr))
  }

  const toggleEdition = async (addr: string, ed: ReportEdition) => {
    await persist(
      recipients.map(r =>
        r.email === addr ? { ...r, editions: r.editions.includes(ed) ? r.editions.filter(e => e !== ed) : [...r.editions, ed] } : r,
      ),
    )
  }

  return (
    <section className="menu-group">
      <div className="menu-title">Briefing recipients</div>
      {recipients.map(r => (
        <div key={r.email} className="menu-row set-static" style={{ flexWrap: 'wrap', rowGap: 6 }}>
          <span className="avatar-dot set-ava" style={{ '--h': hueOf(r.email) } as CSSProperties}>{r.email[0]?.toUpperCase()}</span>
          <span className="set-main"><span>{r.email}</span></span>
          <button className="remove" onClick={() => removeRecipient(r.email)} disabled={busy} aria-label={`Remove ${r.email}`}>✕</button>
          <span style={{ flexBasis: '100%', display: 'flex', gap: 6, paddingLeft: 44 }}>
            {(Object.keys(EDITION_LABEL) as ReportEdition[]).map(ed => (
              <button
                key={ed}
                className={`badge ${r.editions.includes(ed) ? 'info' : ''}`}
                style={{ cursor: 'pointer', background: r.editions.includes(ed) ? undefined : 'transparent' }}
                onClick={() => toggleEdition(r.email, ed)}
                disabled={busy}
                aria-pressed={r.editions.includes(ed)}
              >
                {EDITION_LABEL[ed]}
              </button>
            ))}
          </span>
        </div>
      ))}
      <div className="set-inrow">
        <input
          className="set-in"
          type="email"
          placeholder="name@example.com"
          value={email}
          onChange={e => { setEmail(e.target.value); setInvalid(false) }}
          style={{ flex: 1 }}
          aria-label="Add report recipient email"
        />
        <button className="mini-btn" disabled={busy} onClick={addRecipient}>{busy ? '…' : 'Add'}</button>
      </div>
      {invalid && <p className="set-err" role="alert">Enter a valid email address.</p>}
      <p className="set-note">
        Each address picks which of the three daily sends it receives — morning paper, pre-market brief, evening report. Added on top of the
        REPORT_EMAIL_TO env recipients (who always get everything).
      </p>
    </section>
  )
}

function NotificationRow() {
  const [status, setStatus] = useState<PushStatus | 'idle' | 'working'>(
    typeof Notification !== 'undefined' && Notification.permission === 'granted' && pushSupported() ? 'granted' : 'idle',
  )
  const label =
    status === 'granted' ? 'App notifications ON for this device'
    : status === 'working' ? 'Enabling…'
    : status === 'denied' ? 'Blocked. Allow notifications in browser settings'
    : status === 'needs-install' ? 'Install to Home Screen first (Share → Add to Home Screen), then tap again'
    : status === 'unsupported' ? 'Not supported in this browser'
    : status === 'error' ? 'Failed. Try again'
    : 'Enable app notifications on this device'
  return (
    <section className="menu-group">
      <div className="menu-title">Notifications</div>
      <button
        className="menu-row"
        disabled={status === 'granted' || status === 'working'}
        onClick={async () => {
          setStatus('working')
          setStatus(await enablePush())
        }}
      >
        <span className="icon-tile"><IconBell /></span>
        <span className="set-main">
          <span>{label}</span>
          <span className="sub">Alerts arrive as native notifications on every enabled device. Telegram stays on as the reliable backup; /mute silences both.</span>
        </span>
        {status === 'granted' ? <span className="sub">On</span> : <span className="chev">›</span>}
      </button>
    </section>
  )
}

function AppearanceGroup() {
  const [pref, setPref] = useState(localStorage.getItem('mb-theme') ?? 'auto')
  const apply = (p: string) => {
    localStorage.setItem('mb-theme', p)
    setPref(p)
    const dark = p === 'dark' || (p === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0a0d0f' : '#f6f4ef')
  }
  const resolvedDark =
    pref === 'dark' || (pref === 'auto' && typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches)
  return (
    <section className="menu-group">
      <div className="menu-title">Appearance</div>
      <div className="menu-row set-static">
        <span className={`icon-tile ${resolvedDark ? '' : 'amber'}`.trim()}>{resolvedDark ? <IconMoon /> : <IconSun />}</span>
        <span className="set-main"><span>Theme</span></span>
        <div className="seg" role="group" aria-label="Theme">
          {(['auto', 'light', 'dark'] as const).map(p => (
            <button key={p} className={pref === p ? 'active' : ''} onClick={() => apply(p)}>
              {p === 'auto' ? 'Auto' : p === 'light' ? 'Light' : 'Dark'}
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

export function SettingsScreen({ onBack }: { onBack: () => void }) {
  const [capital, setCapital] = useState('5000')
  const [channels, setChannels] = useState<{ id: string; name: string }[]>([])
  const [newHandle, setNewHandle] = useState('')
  const [resolving, setResolving] = useState(false)
  const { isAdmin, licences, reload } = useIsAdmin()

  useEffect(() => {
    getCapital().then(c => setCapital(String(c)))
    getChannels().then(setChannels)
  }, [])

  const saveCapital = async () => {
    const v = parseFloat(capital)
    if (Number.isFinite(v) && v > 0) {
      await db.settings.put({ key: 'capital', value: String(v) })
      mirrorConfig()
    }
  }

  const addChannel = async () => {
    if (!newHandle.trim() || resolving) return
    setResolving(true)
    try {
      const ch = await resolveChannel(newHandle.trim())
      const next = [...channels.filter(c => c.id !== ch.id), ch]
      setChannels(next)
      await db.settings.put({ key: 'ytChannels', value: JSON.stringify(next) })
      setNewHandle('')
      mirrorConfig()
    } catch {
      /* not found: leave input for correction */
    } finally {
      setResolving(false)
    }
  }

  const removeChannel = async (id: string) => {
    const next = channels.filter(c => c.id !== id)
    setChannels(next)
    await db.settings.put({ key: 'ytChannels', value: JSON.stringify(next) })
    mirrorConfig()
  }

  return (
    <>
      <header className="topbar">
        <button className="back" onClick={onBack} aria-label="Back"><IconBack /></button>
        <span className="brand">Settings</span>
      </header>
      <div className="content">
        <AppearanceGroup />

        <NotificationRow />

        <section className="menu-group">
          <div className="menu-title">Trading</div>
          <div className="menu-row set-static">
            <span className="icon-tile green set-glyph" aria-hidden="true">£</span>
            <span className="set-main">
              <span>Capital</span>
              <span className="sub">Drives sizing, risk banners, and the reports.</span>
            </span>
            <input className="set-in set-cap num" inputMode="decimal" value={capital} onChange={e => setCapital(e.target.value)} onBlur={saveCapital} aria-label="Capital setting" />
          </div>
          {channels.map(c => (
            <div key={c.id} className="menu-row set-static">
              <span className="avatar-dot set-ava" style={{ '--h': hueOf(c.id) } as CSSProperties}>{c.name[0]?.toUpperCase()}</span>
              <span className="set-main"><span>{c.name}</span></span>
              <button className="remove" onClick={() => removeChannel(c.id)} aria-label={`Remove ${c.name}`}>✕</button>
            </div>
          ))}
          <div className="set-inrow">
            <input className="set-in" placeholder="Add channel by @handle" value={newHandle} onChange={e => setNewHandle(e.target.value)} style={{ flex: 1 }} aria-label="Add channel handle" />
            <button className="mini-btn" onClick={addChannel} disabled={resolving}>{resolving ? '…' : 'Add'}</button>
          </div>
          <p className="set-note">Channels feed the alert engine, the consensus tracker, and AI video watching.</p>
        </section>

        <T212Connect />

        <ByoAiKey isAdmin={isAdmin} />

        {isAdmin === false && <AdminUnlock />}
        {isAdmin === true && (
          <>
            <LicenceManager licences={licences} reload={reload} />
            <ReportRecipients />
          </>
        )}

        <section className="menu-group">
          <div className="menu-title">App</div>
          <InstallRow />
          <a className="menu-row" href="/" target="_blank" rel="noopener noreferrer">
            <span className="icon-tile"><IconGlobe /></span>
            <span className="set-main">
              <span>Open website in browser</span>
              <span className="sub">Opens the site outside the installed app</span>
            </span>
            <span className="chev">↗</span>
          </a>
        </section>

        <footer className="foot">Journal backup and export live on the Journal tab.</footer>
      </div>
    </>
  )
}
