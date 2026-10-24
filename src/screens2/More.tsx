import { IconMoon, IconSun } from '../components/icons'
// More (plan Task 21) — the T212-style grouped menu behind the More tab: the
// engine's own accountability page, the two thin reading adapters, and the
// app group (Settings, theme, install). Three groups, same .menu-group/
// .menu-row/.icon-tile shape the legacy More screen used, rebuilt on v2
// tokens — no NavContext, no gear button: wouter's own <Link> owns
// navigation now, and Settings is its own route (CX-3).

import { useState } from 'react'
import { Link } from 'wouter'
import { applyTheme, getThemePref, resolvedDark, type ThemePref } from '../lib/theme'
import { InstallRow } from './parts/InstallRow'

const Svg = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
)
const IconGate = () => <Svg d="M4 21V9l8-6 8 6v12M4 21h16M9 21v-6h6v6M4 9h16" />
const IconNews = () => <Svg d="M4 5h13v14H6a2 2 0 01-2-2V5zm13 4h3v8a2 2 0 01-2 2M7 9h7M7 13h7M7 17h4" />
const IconCalendar = () => <Svg d="M5 5h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2zM8 3v4m8-4v4M3 10h18" />
/** A speech bubble: The street is what other people said. */
const IconQuote = () => <Svg d="M21 12a8 8 0 01-8 8H8l-4 3v-4a8 8 0 015-15h4a8 8 0 018 8zM9 11h6M9 15h4" />
const IconGear = () => (
  <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
)

function Chevron() {
  return (
    <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}

function Row({ href, icon, tint, label, sub }: { href: string; icon: React.ReactNode; tint?: string; label: string; sub: string }) {
  return (
    <Link href={href} className="menu-row">
      <span className={`icon-tile ${tint ?? ''}`.trim()}>{icon}</span>
      <span className="set-main">
        <span>{label}</span>
        <span className="sub">{sub}</span>
      </span>
      <Chevron />
    </Link>
  )
}

const THEME_ORDER: ThemePref[] = ['auto', 'dark', 'light']
const THEME_LABEL: Record<ThemePref, string> = { auto: 'Auto', dark: 'Dark', light: 'Light' }

/** ONE button that cycles auto → dark → light → auto, writing `mb-theme` and
 * re-running the boot logic (lib/theme.ts) — Settings' own theme row keeps
 * the fuller three-way picker; this is the one-tap quick access. */
function ThemeRow() {
  const [pref, setPref] = useState<ThemePref>(getThemePref)
  const cycle = () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(pref) + 1) % THEME_ORDER.length]
    applyTheme(next)
    setPref(next)
  }
  return (
    <button type="button" className="menu-row" onClick={cycle}>
      <span className="icon-tile amber" aria-hidden="true">
        {resolvedDark(pref) ? <IconMoon size={18} /> : <IconSun size={18} />}
      </span>
      <span className="set-main">
        <span>Theme</span>
        <span className="sub">{THEME_LABEL[pref]} — tap to cycle</span>
      </span>
      <Chevron />
    </button>
  )
}

export default function More() {
  return (
    <div className="more2">
      <h1>More</h1>
      <div className="menu-group">
        <div className="menu-title">The engine</div>
        <Row href="/more/gates" icon={<IconGate />} label="How predictions work" sub="The checks we use and what we have learned" />
      </div>
      {/* every row in THIS group also sits on the desktop rail (routes.ts
          railOnly), so ≥1024px CSS hides the whole group — owner 2026-08-17:
          nothing may be listed twice on one screen. On the phone this group
          is these pages' only home. */}
      <div className="menu-group on-rail">
        <div className="menu-title">Reading</div>
        <Row href="/more/street" icon={<IconQuote />} tint="accent" label="YouTube & social" sub="Channel views, video summaries and stock mentions" />
        <Row href="/more/paper" icon={<IconNews />} label="Daily report" sub="Today's edition, and the archive" />
        <Row href="/more/research" icon={<IconNews />} tint="accent" label="Research" sub="Summaries, recurring ideas and their results" />
        <Row href="/more/calendar" icon={<IconCalendar />} tint="amber" label="Calendar" sub="Every day's paper, picks and notes" />
      </div>
      <div className="menu-group">
        <div className="menu-title">App</div>
        <Row href="/settings" icon={<IconGear />} label="Settings" sub="Licence, notifications, AI key" />
        <ThemeRow />
        <InstallRow />
      </div>
    </div>
  )
}
