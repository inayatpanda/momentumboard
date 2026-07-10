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
  params.delete('key')
  history.replaceState(null, '', location.pathname + (params.size ? `?${params}` : ''))
}
navigator.storage?.persist?.().catch(() => {})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
