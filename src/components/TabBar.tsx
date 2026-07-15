import { createContext, useEffect, useState } from 'react'

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
)

// Mobile: the four market-core tabs plus a T212-style "More" tab that opens
// the menu screen holding the reading sections (Intel/Research/Reports/
// Calendar), the Ledger and Settings. Desktop (≥1024px) hides More and shows
// every section directly in the left rail (.tab.sec is only hidden on mobile,
// .tab.more only on desktop — see index.css).
const TABS = [
  // the Desk row exists only where the Desk itself can render (≥1200px, see
  // .tab.desk-tab in index.css) — it keeps the rail present INSIDE the Desk,
  // so entering it no longer strands you away from every other tab
  { key: 'desk', label: 'Desk', icon: 'M3 3h8v8H3zM13 3h8v5h-8zM13 12h8v9h-8zM3 15h8v6H3z', sec: true },
  { key: 'watchlist', label: 'Watchlist', icon: 'M3 17l6-6 4 4 8-8M21 7v6h-6', sec: false },
  // The engine board is the product's daily answer, so it belongs in primary
  // mobile navigation instead of being buried two levels under More → Intel.
  { key: 'intel', label: 'Signals', icon: 'M12 2a7 7 0 017 7c0 3-2 5-3 6v3H8v-3c-1-1-3-3-3-6a7 7 0 017-7zM9 21h6', sec: false },
  { key: 'charts', label: 'Charts', icon: 'M4 20V10M10 20V4M16 20v-9M22 20H2', sec: false },
  { key: 'journal', label: 'Journal', icon: 'M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3V4zM9 9h6M9 13h4', sec: false },
  { key: 'movers', label: 'Movers', icon: 'M13 2L4 14h6l-1 8 9-12h-6l1-8z', sec: true },
  { key: 'research', label: 'Research', icon: 'M4 5h16v14H4zM4 10h16M9 15h6', sec: true },
  { key: 'reports', label: 'Reports', icon: 'M3 6h18v12H3zM3 7l9 6 9-6', sec: true },
  { key: 'calendar', label: 'Calendar', icon: 'M5 5h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2zM8 3v4m8-4v4M3 10h18M8 14h.5M12 14h.5M16 14h.5', sec: true },
  // desktop-only rail rows: with More hidden ≥1024px these had NO desktop
  // entrance at all — the track record and every setting were phone-only
  { key: 'ledger', label: 'Ledger', icon: 'M4 4h16v16H4zM8 8h8M8 12h8M8 16h5', sec: true },
  // the reader's own T212 book (per-licence key) — private reading, never print
  { key: 'positions', label: 'Positions', icon: 'M3 12h4l2-7 4 14 2-7h6', sec: true },
  // toothed cog, not spokes — spokes read as a sun/theme toggle
  { key: 'settings', label: 'Settings', icon: 'M12 9a3 3 0 100 6 3 3 0 000-6z M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z', sec: true },
] as const

// every destination that lives behind the More menu highlights the More tab
const MORE_KEYS = ['more', 'movers', 'research', 'reports', 'calendar', 'ledger', 'positions', 'settings']

// App provides { active, navigate }; consumed by TabBar and the More screen.
export const NavContext = createContext<{ active: string; navigate: (tab: string) => void }>({ active: '', navigate: () => {} })

/** The old under-header reading strip. The reading sections moved behind the
 * More tab; this stays exported only so screens compile until their own
 * restyle removes the mount. Renders nothing. */
export function SubNav() {
  return null
}

export function TabBar({ active, onNavigate }: { active: string; chartsReady?: boolean; onNavigate?: (tab: string) => void }) {
  // Desktop rail collapse: icons-only at 68px, remembered across launches.
  // The flag rides the ROOT element (data-rail) because the padded layouts
  // (.shell, .desk) live outside this component; mobile ignores it entirely
  // (every rule is scoped inside the ≥1024px block).
  const [collapsed, setCollapsed] = useState(() => typeof localStorage !== 'undefined' && localStorage.getItem('mb-rail') === 'collapsed')
  useEffect(() => {
    document.documentElement.dataset.rail = collapsed ? 'collapsed' : 'open'
  }, [collapsed])
  const toggleRail = () => {
    const next = !collapsed
    localStorage.setItem('mb-rail', next ? 'collapsed' : 'open')
    setCollapsed(next)
  }
  return (
    <nav className="tabs" aria-label="Main">
      {TABS.map(t => (
        <button
          key={t.key}
          className={`tab ${t.sec ? 'sec' : ''} ${t.key === 'desk' ? 'desk-tab' : ''} ${active === t.key ? 'active' : ''}`}
          onClick={() => onNavigate?.(t.key)}
          aria-current={active === t.key ? 'page' : undefined}
          title={collapsed ? t.label : undefined}
        >
          <Icon d={t.icon} />
          <span className="tab-label">{t.label}</span>
        </button>
      ))}
      <button
        className={`tab more ${MORE_KEYS.includes(active) ? 'active' : ''}`}
        onClick={() => onNavigate?.('more')}
        aria-current={MORE_KEYS.includes(active) ? 'page' : undefined}
      >
        <Icon d="M4 6h16M4 12h16M4 18h16" />
        <span className="tab-label">More</span>
      </button>
      <button className="tab rail-collapse" onClick={toggleRail} title={collapsed ? 'Expand navigation' : 'Collapse navigation'} aria-expanded={!collapsed}>
        <Icon d={collapsed ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6'} />
        <span className="tab-label">Collapse</span>
      </button>
    </nav>
  )
}
