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
