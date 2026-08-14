// Theme control (plan Task 21) — the ONE place any v2 screen writes
// `mb-theme`, mirroring index.html's pre-paint boot script byte-for-byte (the
// SAME two theme-color hexes, #10131f/#f6f7fc — the v2 tokens' surface-2/bg,
// not the legacy v1 SettingsScreen's now-retired #0a0d0f/#f6f4ef) so a change
// made from More's cycle row or Settings' picker never fights what painted
// before first render.

export type ThemePref = 'auto' | 'dark' | 'light'
export const THEME_KEY = 'mb-theme'

export function getThemePref(): ThemePref {
  const v = localStorage.getItem(THEME_KEY)
  return v === 'dark' || v === 'light' ? v : 'auto'
}

export const resolvedDark = (pref: ThemePref): boolean =>
  pref === 'dark' || (pref === 'auto' && typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches)

/** Writes the preference AND re-runs the boot logic — dataset.theme + the
 * meta theme-color tag — so the change is visible without a reload. */
export function applyTheme(pref: ThemePref): void {
  localStorage.setItem(THEME_KEY, pref)
  const dark = resolvedDark(pref)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#10131f' : '#f6f7fc')
}
