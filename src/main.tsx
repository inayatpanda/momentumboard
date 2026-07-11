import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
