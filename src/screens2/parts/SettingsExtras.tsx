// SettingsExtras (plan Task 21) — ported faithfully from the legacy
// src/screens/SettingsScreen.tsx: BYOK AI key (ByoAiKey:53-94, inverse-gated
// — non-admin only), admin-managed briefing recipients
// (ReportRecipients:307-404), push notifications (NotificationRow:406-438)
// and the theme picker (AppearanceGroup:440-467, now on lib/theme.ts so it
// can never drift from More's cycle row or index.html's boot script).

import { useEffect, useState, type CSSProperties } from 'react'
import { apiGet, deleteLegacyLlmKey, getLegacyLlmKeyStatus, probeGroqKey, putConfig } from '../../lib/api'
import { clearDeviceGroqKey, hasDeviceGroqKey, setDeviceGroqKey } from '../../lib/deviceLlm'
import { enablePush, pushSupported, type PushStatus } from '../../lib/push'
import { applyTheme, getThemePref, resolvedDark, type ThemePref } from '../../lib/theme'
import type { AppConfig, ReportEdition, ReportRecipient } from '../../../shared/config'

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

const Svg = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width={17} height={17} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
)
const IconSparkle = () => <Svg d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zM19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8L19 17z" />
const IconBell = () => <Svg d="M6 9a6 6 0 0112 0c0 5 2 6 2 6H4s2-1 2-6m4 9a2 2 0 004 0" />
const IconSun = () => <Svg d="M12 17a5 5 0 100-10 5 5 0 000 10zM12 1v3m0 16v3M4.2 4.2l2.1 2.1m11.4 11.4l2.1 2.1M1 12h3m16 0h3M4.2 19.8l2.1-2.1m11.4-11.4l2.1-2.1" />
const IconMoon = () => <Svg d="M21 12.8A9 9 0 1111.2 3 7 7 0 0021 12.8z" />

const hueOf = (s: string) => {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

/** Licensees run AI features on THEIR OWN key (free at console.groq.com); the
 * owner's key lives in server env and is never used for licensees. Inverse
 * gate: only NON-admin devices see this row. */
export function ByoAiKey({ isAdmin }: { isAdmin: boolean | null }) {
  const [hasKey, setHasKey] = useState(false)
  const [key, setKey] = useState('')
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [legacyRemoved, setLegacyRemoved] = useState(false)
  const [lastTest, setLastTest] = useState<{ provider: string; model: string; at: number } | null>(() => {
    try { return JSON.parse(localStorage.getItem('streetsignal-groq-status') ?? 'null') }
    catch { return null }
  })
  useEffect(() => {
    hasDeviceGroqKey().then(setHasKey).catch(() => {})
    getLegacyLlmKeyStatus().then(async s => {
      if (!s.hasLegacyServerKey) return
      await deleteLegacyLlmKey()
      setLegacyRemoved(true)
    }).catch(() => {})
  }, [])
  if (isAdmin !== false) return null
  return (
    <section className="menu-group">
      <div className="menu-title">AI</div>
      <div className="menu-row set-static">
        <span className="icon-tile accent">
          <IconSparkle />
        </span>
        <span className="set-main">
          <span>Your AI key</span>
          <span className="sub">
            {hasKey ? 'Groq is connected from this device.' : 'Add a Groq key to enable AI briefs, Ask the Desk, and note feedback on this device.'}
          </span>
        </span>
        {hasKey && (
          <button className="remove" aria-label="Disconnect Groq" onClick={async () => {
            await clearDeviceGroqKey()
            await deleteLegacyLlmKey().catch(() => {})
            setHasKey(false)
            setSaved(false)
            setLastTest(null)
            localStorage.removeItem('streetsignal-groq-status')
          }}>✕</button>
        )}
      </div>
      <div className="set-inrow">
        <input className="set-in" type="password" placeholder="gsk_..." value={key} onChange={e => setKey(e.target.value)} style={{ flex: 1 }} aria-label="Groq API key" />
        <button
          type="button"
          className="mini-btn"
          disabled={busy || !key.trim()}
          onClick={async () => {
            setBusy(true)
            setError('')
            try {
              const probe = await probeGroqKey(key.trim())
              await setDeviceGroqKey(key.trim())
              await deleteLegacyLlmKey().catch(() => {})
              setHasKey(true)
              const status = { provider: probe.provider, model: probe.model, at: Date.now() }
              setLastTest(status)
              localStorage.setItem('streetsignal-groq-status', JSON.stringify(status))
              setKey('')
              setSaved(true)
              setTimeout(() => setSaved(false), 2500)
            } catch (e) {
              setError((e as Error).message === 'invalid-key' ? 'That does not look like a Groq key.' : 'Groq rejected the key or could not be reached. Nothing was saved.')
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? 'Testing…' : saved ? 'Connected' : 'Save & test'}
        </button>
      </div>
      {error && <p className="set-err" role="alert">{error}</p>}
      {hasKey && lastTest && <p className="set-note">Last successful test: {lastTest.provider} · {lastTest.model} · {new Date(lastTest.at).toLocaleString('en-GB')}.</p>}
      {legacyRemoved && <p className="set-note">An older server-stored copy was removed. Re-enter the key here if you still want Groq on this device.</p>}
      <p className="set-note">Stored only in this app profile on this device. It is sent over TLS to StreetSignal only when an AI feature is used, never added to config sync or server storage.</p>
    </section>
  )
}

const EDITION_LABEL: Record<ReportEdition, string> = { morning: 'Morning paper', premarket: 'Pre-market', evening: 'Evening' }

/** Admin-managed extra recipients, per-edition. Rendered only once the
 * shared admin probe has already succeeded (Settings.tsx gates it). */
export function ReportRecipients() {
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
    if (!recipients.some(r => r.email === addr)) await persist([...recipients, { email: addr, editions: ['morning'] }])
    setEmail('')
  }

  const removeRecipient = async (addr: string) => {
    await persist(recipients.filter(r => r.email !== addr))
  }

  const toggleEdition = async (addr: string, ed: ReportEdition) => {
    await persist(recipients.map(r => (r.email === addr ? { ...r, editions: r.editions.includes(ed) ? r.editions.filter(e => e !== ed) : [...r.editions, ed] } : r)))
  }

  return (
    <section className="menu-group">
      <div className="menu-title">Briefing recipients</div>
      {recipients.map(r => (
        <div key={r.email} className="menu-row set-static" style={{ flexWrap: 'wrap', rowGap: 6 }}>
          <span className="avatar-dot set-ava" style={{ '--h': hueOf(r.email) } as CSSProperties}>
            {r.email[0]?.toUpperCase()}
          </span>
          <span className="set-main">
            <span>{r.email}</span>
          </span>
          <button type="button" className="remove" onClick={() => void removeRecipient(r.email)} disabled={busy} aria-label={`Remove ${r.email}`}>
            ✕
          </button>
          <span style={{ flexBasis: '100%', display: 'flex', gap: 6, paddingLeft: 44 }}>
            {(Object.keys(EDITION_LABEL) as ReportEdition[]).map(ed => (
              <button
                key={ed}
                type="button"
                className={`pill ${r.editions.includes(ed) ? 'accent' : ''}`}
                style={{ cursor: 'pointer', background: r.editions.includes(ed) ? undefined : 'transparent' }}
                onClick={() => void toggleEdition(r.email, ed)}
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
          onChange={e => {
            setEmail(e.target.value)
            setInvalid(false)
          }}
          style={{ flex: 1 }}
          aria-label="Add report recipient email"
        />
        <button type="button" className="mini-btn" disabled={busy} onClick={addRecipient}>
          {busy ? '…' : 'Add'}
        </button>
      </div>
      {invalid && (
        <p className="set-err" role="alert">
          Enter a valid email address.
        </p>
      )}
      <p className="set-note">
        Each address picks which of the three daily sends it receives — morning paper, pre-market brief, evening report. Added on top of the REPORT_EMAIL_TO env recipients (who always get
        everything).
      </p>
    </section>
  )
}

export function NotificationRow() {
  const [status, setStatus] = useState<PushStatus | 'idle' | 'working'>(
    typeof Notification !== 'undefined' && Notification.permission === 'granted' && pushSupported() ? 'granted' : 'idle',
  )
  const label =
    status === 'granted'
      ? 'App notifications ON for this device'
      : status === 'working'
        ? 'Enabling…'
        : status === 'denied'
          ? 'Blocked. Allow notifications in browser settings'
          : status === 'needs-install'
            ? 'Install to Home Screen first (Share → Add to Home Screen), then tap again'
            : status === 'unsupported'
              ? 'Not supported in this browser'
              : status === 'error'
                ? 'Failed. Try again'
                : 'Enable app notifications on this device'
  return (
    <section className="menu-group">
      <div className="menu-title">Notifications</div>
      <button
        type="button"
        className="menu-row"
        disabled={status === 'granted' || status === 'working'}
        onClick={async () => {
          setStatus('working')
          setStatus(await enablePush())
        }}
      >
        <span className="icon-tile">
          <IconBell />
        </span>
        <span className="set-main">
          <span>{label}</span>
          <span className="sub">Alerts arrive as native notifications on every enabled device. Telegram stays on as the reliable backup; /mute silences both.</span>
        </span>
        {status === 'granted' ? <span className="sub">On</span> : <span className="chev">›</span>}
      </button>
    </section>
  )
}

export function AppearanceGroup() {
  const [pref, setPref] = useState<ThemePref>(getThemePref)
  const apply = (p: ThemePref) => {
    applyTheme(p)
    setPref(p)
  }
  const dark = resolvedDark(pref)
  return (
    <section className="menu-group">
      <div className="menu-title">Appearance</div>
      <div className="menu-row set-static">
        <span className={`icon-tile ${dark ? '' : 'amber'}`.trim()}>{dark ? <IconMoon /> : <IconSun />}</span>
        <span className="set-main">
          <span>Theme</span>
        </span>
        <div className="seg" role="group" aria-label="Theme">
          {(['auto', 'light', 'dark'] as const).map(p => (
            <button key={p} type="button" aria-pressed={pref === p} onClick={() => apply(p)}>
              {p === 'auto' ? 'Auto' : p === 'light' ? 'Light' : 'Dark'}
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}
