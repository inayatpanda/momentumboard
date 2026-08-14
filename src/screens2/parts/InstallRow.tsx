// InstallRow (plan Task 21) — shared by More and Settings: shown only while
// `beforeinstallprompt` says the app is installable (Android Chrome); an
// installed app / iOS Safari never see it (installPrompt.ts's own contract).

import { useEffect, useState } from 'react'
import { onInstallAvailable, promptInstall } from '../../lib/installPrompt'

export function InstallRow() {
  const [available, setAvailable] = useState(false)
  useEffect(() => onInstallAvailable(setAvailable), [])
  if (!available) return null
  return (
    <button type="button" className="menu-row" onClick={() => void promptInstall()}>
      <span className="icon-tile green" aria-hidden="true">
        ⇩
      </span>
      <span className="set-main">
        <span>Install the app</span>
        <span className="sub">Adds StreetSignal to your home screen — full screen, no browser bars.</span>
      </span>
      <span className="chev">›</span>
    </button>
  )
}
