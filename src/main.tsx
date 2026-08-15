import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { seedFreeTierToken } from './lib/api'
import { normaliseDesktopPath } from './lib/platform'
// ORDER IS LOAD-BEARING: site.css first, tokens.css second. The two collide on
// --bg/--text (equal :root specificity, last-wins), and tokens.css must win —
// the owner rejected the legacy cream light theme outright, and the public
// site is "retoken only" by the ratified plan. The legacy-ONLY names
// (--blue/--panel/--muted/…) have no counterpart in tokens.css and keep
// feeding the surviving quant panels either way.
import './styles/site.css' // public site + the legacy tokens the quant panels paint with
import './styles/tokens.css' // v2 tokens + self-hosted @font-face — WINS the collisions
import './lib/installPrompt' // register the beforeinstallprompt catcher before the event can fire

// Licence-by-link: opening https://<site>/?key=<licence> unlocks this device
// for life. The key is stored, the URL is scrubbed, storage is pinned.
const params = new URLSearchParams(location.search)
const key = params.get('key')
if (key) {
  localStorage.setItem('mb-token', key.trim())
  // when this key was claimed — the boot check gives fresh unlocks a grace
  // window instead of burning the token on one stale-replica 401 (App.tsx)
  localStorage.setItem('mb-token-at', String(Date.now()))
  params.delete('key')
  // Welcome links are app-intent links. Ordinary visits to `/` remain the
  // website, while a valid key lands directly in the dedicated app surface.
  const path = location.pathname.startsWith('/app') ? location.pathname : '/app/'
  history.replaceState(null, '', path + (params.size ? `?${params}` : ''))
}
navigator.storage?.persist?.().catch(() => {})

// The DMG free tier: a tokenless desktop install seeds the shared licence and
// opens straight onto Today — no gate. SYNCHRONOUS and after the ?key= consume
// above, so App() never sees a tokenless first render and a personal unlock
// link always wins. No-op in web builds (no VITE_FREE_TOKEN).
seedFreeTierToken()
// Desktop shell: land the router inside its /app base (blank-pane fix) —
// after the ?key= consume, before React reads location.
normaliseDesktopPath()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
