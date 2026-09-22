// The v2 nav (plan Task 10): ONE component, CSS decides the surface — bottom
// tab bar under 1024px, left rail at ≥1024px (the old TabBar's proven split,
// src/index.css:9-13's warning honoured).
//
// The phone bar carries the six current primary destinations, including the
// routed Analytics screen. The RAIL has vertical room the phone does not, so owner iteration 2
// promoted three pages out of More onto it ("More section - we can bring more
// sections from it into main tabs shown outside on Nav bar"). Those three carry
// `railOnly` and are hidden below 1024px by CSS ALONE — no width check, no
// matchMedia, nothing that can disagree with the media query the rail skin is
// already gated on.

import { Link, useLocation } from 'wouter'
import { NAV_ROUTES, ROUTES } from './routes'

const ICONS: Record<string, string> = {
  today: '◆',
  stocks: '≋',
  intel: '¶',
  record: '✓',
  analytics: '⌁',
  more: '⋯',
}

/** The promoted rail entries all share `key: 'more'` — which is exactly what
 * keeps the phone's More tab lit inside their pages — so their glyphs are keyed
 * on PATH instead, and they'd otherwise all wear More's ellipsis. */
const RAIL_ICONS: Record<string, string> = {
  // ❝ — the page is what OTHER PEOPLE said, and every glyph already in use
  // (◆ ≋ ¶ ✓ ⌕ ▦ ≣ ⋯) means something else
  '/more/street': '❝',
  '/more/research': '⌕',
  '/more/calendar': '▦',
  '/more/paper': '≣',
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
  return hit?.key ?? 'today'
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
      {NAV_ROUTES.map(r => {
        const on = r.railOnly ? path === r.path : active === r.key
        const cls = ['v2-tab', r.railOnly ? 'rail-only' : '', on ? 'on' : ''].filter(Boolean).join(' ')
        return (
          <Link key={r.path} href={r.path} className={cls} aria-current={on ? 'page' : undefined}>
            <span className="v2-tab-icon" aria-hidden>
              {RAIL_ICONS[r.path] ?? ICONS[r.key]}
            </span>
            <span className="v2-tab-label">{r.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}
