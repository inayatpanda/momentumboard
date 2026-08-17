// Am I running inside the desktop shell?
//
// The Tauri wrap ships this project's own `dist` inside the .app and serves it
// from the webview's local protocol, so the SAME bundle boots at two very
// different URLs: `https://thestreetsignal.rqai.co.uk/...` on the web, and
// `tauri://localhost/` (macOS) or `http://tauri.localhost/` (Windows/Linux) on
// the desktop. Those are the same two origins functions/_middleware.ts allows
// through CORS; keep the two lists in step.
//
// This matters for exactly one decision. App.tsx reads `location.pathname` to
// choose between the public website and the product, and the shell can only
// ever open at `/` — so without this check, launching the desktop app would
// land on the marketing page every single time, complete with two "download
// the Mac app" buttons that cannot work from inside the Mac app.

/** Pure form, for the tests: the two origins, split as `location` exposes them.
 * Matched as PAIRS — a hostname alone proves nothing, since any site could
 * serve itself from `tauri.localhost` under https. */
export function isDesktopShellLocation(protocol: string, hostname: string): boolean {
  return (protocol === 'tauri:' && hostname === 'localhost') || (protocol === 'http:' && hostname === 'tauri.localhost')
}

/** True inside the Tauri desktop shell, false in every browser. */
export const isDesktopShell = (): boolean => isDesktopShellLocation(location.protocol, location.hostname)

/** The desktop shell loads at `tauri://localhost/` — but the app's router
 * mounts at base `/app` (the web's product path). Outside that base nothing
 * matches and the catch-all redirect spins silently: the chrome renders, the
 * pane stays blank (the first free-tier DMG launch, live-observed — the
 * pre-free-tier launch check only ever saw the AppGate, which renders outside
 * the router). Normalise the path BEFORE React mounts; replaceState on the
 * local protocol is same-origin and navigates nothing. Returns whether it
 * rewrote, for the test. */
export function normaliseDesktopPath(): boolean {
  if (!isDesktopShell() || location.pathname.startsWith('/app')) return false
  history.replaceState(null, '', '/app/')
  return true
}

/** The external href a click means to open, or null when the click is the
 * app's own business. Pure, for the tests: an anchor (or a child of one)
 * whose href is http(s) on a DIFFERENT origin than `origin`. Everything else
 * — in-app links, hash jumps, mailto — returns null and is left alone. */
export function externalHrefFrom(target: EventTarget | null, origin: string): string | null {
  const el = target instanceof Element ? target.closest('a[href]') : null
  const href = el?.getAttribute('href')
  if (!href) return null
  try {
    const url = new URL(href, origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin === new URL(origin).origin ? null : url.href
  } catch {
    return null
  }
}

const defaultOpen = (url: string): void => {
  // resolved lazily so the web build never even loads the plugin chunk
  void import('@tauri-apps/plugin-opener').then(m => m.openUrl(url)).catch(() => {})
}

/** THE "NONE IS CLICKABLE" FIX (owner 2026-08-17). Tauri denies new-window
 * requests by default, so every `target="_blank"` news link in the Mac app
 * silently did nothing. Inside the shell, clicks on external http(s) anchors
 * are cancelled and handed to the OS browser via the opener plugin instead.
 * Installed from main.tsx beside the path rewrite; a no-op on the web.
 * Returns a disposer, for the tests. */
export function installExternalLinkOpener(open: (url: string) => void = defaultOpen, inShell: boolean = isDesktopShell()): () => void {
  if (!inShell) return () => {}
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const href = externalHrefFrom(e.target, location.origin)
    if (!href) return
    e.preventDefault()
    open(href)
  }
  document.addEventListener('click', onClick)
  return () => document.removeEventListener('click', onClick)
}
