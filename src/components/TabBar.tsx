const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
)

const TABS = [
  { key: 'watchlist', label: 'Watchlist', icon: 'M3 17l6-6 4 4 8-8M21 7v6h-6' },
  { key: 'charts', label: 'Charts', icon: 'M4 20V10M10 20V4M16 20v-9M22 20H2' },
  { key: 'journal', label: 'Journal', icon: 'M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3V4zM9 9h6M9 13h4' },
  { key: 'research', label: 'Research', icon: 'M4 5h16v14H4zM4 10h16M9 15h6' },
  { key: 'intel', label: 'Intel', icon: 'M12 2a7 7 0 017 7c0 3-2 5-3 6v3H8v-3c-1-1-3-3-3-6a7 7 0 017-7zM9 21h6' },
] as const

export function TabBar({ active, chartsReady = false, onNavigate }: { active: string; chartsReady?: boolean; onNavigate?: (tab: string) => void }) {
  const ready = (key: string) => key !== 'charts' || chartsReady
  return (
    <nav className="tabs" aria-label="Main">
      {TABS.map(t => (
        <button
          key={t.key}
          className={`tab ${active === t.key ? 'active' : ''}`}
          disabled={!ready(t.key)}
          onClick={() => onNavigate?.(t.key)}
          aria-current={active === t.key ? 'page' : undefined}
        >
          <Icon d={t.icon} />
          {t.label}
        </button>
      ))}
    </nav>
  )
}
