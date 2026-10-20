// The v2 nav (plan Task 10): ONE component, CSS decides the surface — bottom
// tab bar under 1024px, left rail at ≥1024px (the old TabBar's proven split,
// src/index.css:9-13's warning honoured).
//
// The PHONE bar is exactly the five ratified labels and nothing may change
// that. The RAIL has vertical room the phone does not, so owner iteration 2
// promoted three pages out of More onto it ("More section - we can bring more
// sections from it into main tabs shown outside on Nav bar"). Those three carry
// `railOnly` and are hidden below 1024px by CSS ALONE — no width check, no
// matchMedia, nothing that can disagree with the media query the rail skin is
// already gated on.

import { Link, useLocation } from 'wouter'
import { NAV_ROUTES, ROUTES } from './routes'
import { BrandMark } from '../components/BrandMark'

const ICONS: Record<string, string> = {
  today: 'M3 10.5 12 3l9 7.5M5 9v11h5v-6h4v6h5V9',
  stocks: 'M4 19V5m0 14h16M7 14l4-4 4 2 5-7',
  intel: 'M5 4h14v16H5zM8 8h8M8 12h8M8 16h5',
  record: 'M4 19h16M7 15V9m5 6V5m5 10v-3',
  more: 'M4 6h16M4 12h16M4 18h16',
}

/** The promoted rail entries all share `key: 'more'` — which is exactly what
 * keeps the phone's More tab lit inside their pages — so their glyphs are keyed
 * on PATH instead, and they'd otherwise all wear More's ellipsis. */
const RAIL_ICONS: Record<string, string> = {
  '/analytics': 'M4 19h16M6 16V9m6 7V4m6 12v-5',
  // A speech bubble distinguishes source commentary from the news page.
  '/more/street': 'M4 4h16v12H9l-5 4V4zM8 8h8M8 12h5',
  '/more/research': 'M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  '/more/calendar': 'M4 5h16v15H4zM8 3v4m8-4v4M4 10h16',
  '/more/paper': 'M5 3h14v18H5zM8 7h8M8 11h8M8 15h5',
}

/** Which nav key lights up for the current path. */
export function activeKeyFor(path: string): string {
  const hit = [...ROUTES].sort((a, b) => b.path.length - a.path.length).find(r => {
    if (r.path.includes(':')) {
      const prefix = r.path.slice(0, r.path.indexOf(':'))
      return path.startsWith(prefix)
    }
    return path === r.path || (r.path !== '/' && path.startsWith(r.path + '/'))
  })
  return hit?.key ?? 'stocks'
}

export function Nav() {
  const [path] = useLocation()
  const active = activeKeyFor(path)
  // A promoted page lights its OWN rail entry (by exact path — `key` is 'more'
  // for all three). The More tab stays lit too, because on the phone that is
  // the only tab these pages have and suppressing it in JS would change the
  // ratified bar; the rail dims the redundant parent in CSS instead, inside the
  // same ≥1024px query that reveals the promoted rows in the first place.
  const promoted = NAV_ROUTES.some(r => r.railOnly && path === r.path)
  return (
    <nav className={promoted ? 'v2-nav on-promoted' : 'v2-nav'} aria-label="Primary">
      <div className="nav-wordmark" aria-hidden="true"><BrandMark /> StreetSignal</div>
      {NAV_ROUTES.map(r => {
        const on = r.railOnly ? path === r.path : active === r.key
        const cls = ['v2-tab', r.railOnly ? 'rail-only' : '', on ? 'on' : ''].filter(Boolean).join(' ')
        return (
          <Link key={r.path} href={r.path} className={cls} aria-current={on ? 'page' : undefined}>
            <span className="v2-tab-icon" aria-hidden>
              <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={RAIL_ICONS[r.path] ?? ICONS[r.key]} /></svg>
            </span>
            <span className="v2-tab-label">{r.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
