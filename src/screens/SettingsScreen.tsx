import { useEffect, useState } from 'react'
import { db, getCapital, getChannels } from '../lib/db'
import { resolveChannel } from '../lib/api'
import { mirrorConfig } from '../lib/configMirror'
import { enablePush, pushSupported, type PushStatus } from '../lib/push'

function NotificationSettings() {
  const [status, setStatus] = useState<PushStatus | 'idle' | 'working'>(
    typeof Notification !== 'undefined' && Notification.permission === 'granted' && pushSupported() ? 'granted' : 'idle',
  )
  const label =
    status === 'granted' ? '✓ App notifications ON for this device'
    : status === 'working' ? 'Enabling…'
    : status === 'denied' ? 'Blocked. Allow notifications in browser settings'
    : status === 'needs-install' ? 'Install to Home Screen first (Share → Add to Home Screen), then tap again'
    : status === 'unsupported' ? 'Not supported in this browser'
    : status === 'error' ? 'Failed. Try again'
    : 'Enable app notifications on this device'
  return (
    <div>
      <button
        className="mini-btn"
        disabled={status === 'granted' || status === 'working'}
        onClick={async () => {
          setStatus('working')
          setStatus(await enablePush())
        }}
      >
        🔔 {label}
      </button>
      <p className="empty-line" style={{ fontSize: 11, marginTop: 4 }}>
        Alerts arrive as native notifications on every enabled device. Telegram stays on as the reliable backup; /mute silences both.
      </p>
    </div>
  )
}

export function SettingsScreen({ onBack }: { onBack: () => void }) {
  const [capital, setCapital] = useState('5000')
  const [channels, setChannels] = useState<{ id: string; name: string }[]>([])
  const [newHandle, setNewHandle] = useState('')
  const [resolving, setResolving] = useState(false)

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
        <button className="back" onClick={onBack} aria-label="Back">←</button>
        <span className="brand">Settings</span>
      </header>
      <div className="content">
        <h3 className="section-title">Notifications</h3>
        <NotificationSettings />

        <h3 className="section-title">Capital</h3>
        <div className="settings-grid">
          <label className="tf-full">Capital (£). Drives sizing, risk banners, and the reports.
            <input inputMode="decimal" value={capital} onChange={e => setCapital(e.target.value)} onBlur={saveCapital} aria-label="Capital setting" />
          </label>
        </div>

        <h3 className="section-title">Followed channels</h3>
        <div className="settings-grid">
          {channels.map(c => (
            <div key={c.id} className="chan-row">
              <span>{c.name}</span>
              <button className="remove" onClick={() => removeChannel(c.id)} aria-label={`Remove ${c.name}`}>✕</button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8 }}>
            <input placeholder="Add channel by @handle" value={newHandle} onChange={e => setNewHandle(e.target.value)} style={{ flex: 1 }} aria-label="Add channel handle" />
            <button className="mini-btn" onClick={addChannel} disabled={resolving}>{resolving ? '…' : 'Add'}</button>
          </div>
          <p className="empty-line" style={{ fontSize: 11 }}>Channels feed the alert engine, the consensus tracker, and AI video watching.</p>
        </div>

        <footer className="foot">Journal backup and export live on the Journal tab.</footer>
      </div>
    </>
  )
}
