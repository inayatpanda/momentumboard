import { useEffect, useState } from 'react'
import { syncFromServer } from './lib/sync'
import { seedStarterWatchlist } from './lib/starter'
import { Landing } from './screens/Landing'
import { AppGate } from './screens/AppGate'
import { EnginePage, FaqPage, LedgerPage, PaperPage, siteRouteFor } from './screens/SitePages'
// The v2 shell IS the app (plan Task 24). Static import on purpose: it folds
// the shell + base.css into the entry, so a first-visit install that goes
// offline before opening still has the whole app (the walkthrough's precache
// covers the entry closure). AppShell owns its own <Suspense> for the lazy
// routes, so this component needs none.
import AppShell from './shell/AppShell'
import { clearToken, getToken, validateAccess } from './lib/api'
import { isDesktopShell } from './lib/platform'

/** The surfaces this component still owns after the cutover deletion wave:
 *  the public website, the licence front door, and the boot-time sync. Every
 *  in-app screen and all navigation belong to <AppShell/> (src/shell/). */
export default function App() {
  // `/` is always the public website; `/app/` is the product/PWA. Keeping the
  // surfaces on separate paths stops an installed PWA claiming a normal visit
  // to the website and makes the reader's intent explicit.
  //
  // …except in the desktop shell, which has no address bar and can only ever
  // boot at `/`. Downloading and opening a Mac app IS the intent this path
  // exists to read, so the shell starts on the product — otherwise every
  // launch would show the marketing page, and its "download the Mac app"
  // buttons, from inside the Mac app. An unlicensed shell still gets a front
  // door: AppGate, which is the app's own, as the comment below already said.
  const [surface, setSurface] = useState<'site' | 'app'>(() =>
    isDesktopShell() || location.pathname.startsWith('/app') ? 'app' : 'site',
  )
  // licence gate: no token → the public landing page. main.tsx consumes ?key=
  // unlock links before React mounts, so licensed arrivals never see it.
  const [licensed, setLicensed] = useState(() => !!getToken())
  const enterApp = () => {
    // The URL is cosmetic in the desktop shell — there is no address bar and
    // the next launch loads index.html regardless — and a custom protocol is
    // not obliged to accept a path change, so never let it break the unlock.
    try {
      history.replaceState(null, '', '/app/')
    } catch {
      /* the shell's local protocol refused the path — the surface below is what matters */
    }
    setSurface('app')
    setLicensed(true)
  }

  // boot check: a token the server rejects (revoked, or an expired trial) sends
  // the reader back to the landing page instead of a screen of failed requests.
  // Offline resolves valid — never lock a licensed reader out of cached data.
  // MOUNT-ONLY on purpose: a trial minted seconds ago can 401 on a stale Blobs
  // replica (eventual consistency); re-validating on the unlock transition
  // silently bounced fresh trials back to the landing. By the next visit the
  // write has long propagated, so the boot check still catches real expiry.
  useEffect(() => {
    if (!getToken()) return
    validateAccess().then(ok => {
      if (!ok) {
        // a key claimed minutes ago can 401 off a stale Blobs replica even
        // with the server's strong-read retry — never burn a fresh unlock on
        // one bad answer; real expiry/revocation still catches the next boot
        const claimedAt = Number(localStorage.getItem('mb-token-at') ?? 0)
        if (Date.now() - claimedAt < 15 * 60_000) return
        clearToken()
        setLicensed(false)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // phone ↔ desktop: pull server state on launch. Starter seeding runs AFTER
  // the pull, so an existing watchlist is never polluted — a truly first launch
  // gets the classics instead of a blank page.
  //
  // No remount tick any more: `syncFromServer` announces its own slice
  // invalidation (DS-10/CX-22, src/lib/sync.ts), and the v2 screens read the
  // watchlist when they mount, which happens after this on a normal launch.
  useEffect(() => {
    if (!licensed || surface !== 'app') return
    syncFromServer().then(() => seedStarterWatchlist().catch(() => false))
  }, [licensed, surface])

  // The public URL stays the public website even on a licensed device. A clear
  // Open app action moves to `/app/`; licence links do this automatically.
  // Sub-pages (/engine, /paper, /ledger, /faq) are real URLs — the netlify.toml
  // catch-all serves index.html and the path picks the page here.
  if (surface === 'site') {
    const page = siteRouteFor(location.pathname)
    if (page === 'engine') return <EnginePage />
    if (page === 'paper') return <PaperPage />
    if (page === 'ledger') return <LedgerPage />
    if (page === 'faq') return <FaqPage />
    return <Landing licensed={licensed} onUnlocked={enterApp} />
  }

  // an unlicensed device AT /app/ gets the app's own front door — never the
  // marketing website (that lives on the site surface above; the two are
  // different things, especially inside the desktop shell)
  if (!licensed) {
    return <AppGate onUnlocked={enterApp} />
  }

  return <AppShell />
}
