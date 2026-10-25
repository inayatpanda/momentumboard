import { lazy, Suspense, useEffect, useState } from 'react'
import { syncFromServer } from './lib/sync'
import { seedStarterWatchlist } from './lib/starter'
// The v2 shell IS the app (plan Task 24). Static import on purpose: it folds
// the shell + base.css into the entry, so a first-visit install that goes
// offline before opening still has the whole app (the walkthrough's precache
// covers the entry closure). AppShell owns <Suspense> for its lazy routes;
// the separate public-site boundary lives below.
import AppShell from './shell/AppShell'
import { getToken, validateAccess, provisionFreeAccess, reloadForAccess } from './lib/api'
import { isDesktopShell } from './lib/platform'
import { ChunkRecoveryBoundary } from './shell/ChunkRecoveryBoundary'

// Public marketing pages are a separate surface. Product/PWA launches should
// not download their prose and page-specific styles before Today can render.
const PublicSite = lazy(() => import('./screens/PublicSite'))
const AppGate=lazy(()=>import('./screens/AppGate').then(module=>({default:module.AppGate})))

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
  // Public pages remain public. Product visits receive free device access;
  // existing owner/reader credentials continue to use their own stored data.
  const [access,setAccess]=useState<'checking'|'ready'|'error'>('checking')
  const [error,setError]=useState<string|null>(null)
  const [attempt,setAttempt]=useState(0)
  const licensed=!!getToken()
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
  }

  // Verify existing access before syncing. Missing or expired legacy access
  // receives a separate free identity; old personal data stays in its old DB.
  useEffect(()=>{
    if(surface!=='app')return
    let active=true
    setAccess('checking');setError(null)
    void(async()=>{
      try{
        if(getToken() && await validateAccess()){
          if(active)setAccess('ready')
          return
        }
        if(!active)return
        await provisionFreeAccess()
        // Rebind module-level storage to the new device, retaining deep links.
        if(active)reloadForAccess()
      }catch(err){if(active){setError(err instanceof Error?err.message:'Could not open StreetSignal. Please try again.');setAccess('error')}}
    })()
    return()=>{active=false}
  },[surface,attempt])

  // phone ↔ desktop: pull server state on launch. Starter seeding runs AFTER
  // the pull, so an existing watchlist is never polluted — a truly first launch
  // gets the classics instead of a blank page.
  //
  // No remount tick any more: `syncFromServer` announces its own slice
  // invalidation (DS-10/CX-22, src/lib/sync.ts), and the v2 screens read the
  // watchlist when they mount, which happens after this on a normal launch.
  useEffect(() => {
    if (access!=='ready' || surface !== 'app') return
    syncFromServer().then(() => seedStarterWatchlist().catch(() => false))
  }, [access, surface])

  // The public URL stays the public website even on a licensed device. A clear
  // Open app action moves to `/app/`; licence links do this automatically.
  // Sub-pages (/engine, /paper, /ledger, /faq) are real URLs — the netlify.toml
  // catch-all serves index.html and the path picks the page here.
  if (surface === 'site') {
    return <ChunkRecoveryBoundary>
      <Suspense fallback={<main style={{ padding: 32 }} role="status">Loading StreetSignal…</main>}>
        <PublicSite licensed={licensed} onUnlocked={enterApp} />
      </Suspense>
    </ChunkRecoveryBoundary>
  }

  // Account creation is automatic. Only connection/limit failures show retry
  // controls; saved owner/reader keys remain an optional recovery path.
  if(access==='checking')return <main className="app-gate" role="status"><div className="app-gate-card"><h1>Opening StreetSignal…</h1><p>Preparing your free access on this device.</p></div></main>
  if(access==='error')return <Suspense fallback={null}><AppGate onUnlocked={reloadForAccess} error={error} onRetry={()=>setAttempt(n=>n+1)}/></Suspense>

  return <AppShell />
}
