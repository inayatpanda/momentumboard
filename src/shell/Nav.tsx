// The v2 nav (plan Task 10): ONE component, CSS decides the surface — bottom
// tab bar under 1024px, left rail at ≥1024px (the old TabBar's proven split,
// src/index.css:9-13's warning honoured). Exactly the five ratified labels.

import { Link, useLocation } from 'wouter'
import { NAV_ROUTES, ROUTES } from './routes'

const ICONS: Record<string, string> = {
  today: '◆',
  stocks: '≋',
  intel: '¶',
  record: '✓',
  more: '⋯',
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
  return (
    <nav className="v2-nav" aria-label="Primary">
      {NAV_ROUTES.map(r => (
        <Link key={r.key} href={r.path} className={active === r.key ? 'v2-tab on' : 'v2-tab'} aria-current={active === r.key ? 'page' : undefined}>
          <span className="v2-tab-icon" aria-hidden>
            {ICONS[r.key]}
          </span>
          <span className="v2-tab-label">{r.label}</span>
        </Link>
      ))}
    </nav>
  )
}
