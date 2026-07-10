import { useContext } from 'react'
import { NavContext } from '../components/TabBar'
import { IconGear } from '../components/icons'

const Glyph = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
)

const Chevron = () => (
  <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 6l6 6-6 6" />
  </svg>
)

function Row({ icon, tint, label, sub, onTap }: { icon: string; tint?: string; label: string; sub?: string; onTap: () => void }) {
  return (
    <button className="menu-row" onClick={onTap}>
      <span className={`icon-tile ${tint ?? ''}`}>
        <Glyph d={icon} />
      </span>
      <span>
        {label}
        {sub && <span className="sub">{sub}</span>}
      </span>
      <Chevron />
    </button>
  )
}

/** T212-style menu screen behind the More tab: the reading sections, the
 * ledger, and settings — grouped rows with tinted icon tiles. */
export function More({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { navigate } = useContext(NavContext)
  return (
    <>
      <header className="topbar">
        <span className="brand">More</span>
        <button className="gear" onClick={onOpenSettings} aria-label="Settings"><IconGear /></button>
      </header>
      <div className="content">
        <div className="menu-group">
          <div className="menu-title">Markets</div>
          <Row icon="M12 2a7 7 0 017 7c0 3-2 5-3 6v3H8v-3c-1-1-3-3-3-6a7 7 0 017-7zM9 21h6" label="Intel" sub="Macro, sectors, congress & insiders, social" onTap={() => navigate('intel')} />
          <Row icon="M5 5h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2zM8 3v4m8-4v4M3 10h18" tint="amber" label="Calendar" sub="Earnings, IPOs and your day-by-day ledger" onTap={() => navigate('calendar')} />
        </div>
        <div className="menu-group">
          <div className="menu-title">The desk</div>
          <Row icon="M4 5h16v14H4zM4 10h16M9 15h6" tint="gold" label="Research" sub="Engine accountability and AI reads" onTap={() => navigate('research')} />
          <Row icon="M3 6h18v12H3zM3 7l9 6 9-6" tint="gold" label="Reports" sub="Every morning edition, archived" onTap={() => navigate('reports')} />
          <Row icon="M9 7h6m-6 4h6m-6 4h4M6 3h12a1 1 0 011 1v17l-3-2-3 2-4-2-3 2V4a1 1 0 011-1z" tint="green" label="Track record" sub="The prediction ledger, graded" onTap={() => navigate('ledger')} />
        </div>
        <div className="menu-group">
          <div className="menu-title">App</div>
          <Row icon="M12 15a3 3 0 100-6 3 3 0 000 6zm7.4-3a7.4 7.4 0 00-.1-1l2-1.6-2-3.4-2.4 1a7.4 7.4 0 00-1.7-1l-.4-2.6H10.2L9.8 6a7.4 7.4 0 00-1.7 1l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 000 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 001.7 1l.4 2.6h3.6l.4-2.6a7.4 7.4 0 001.7-1l2.4 1 2-3.4-2-1.6c.1-.3.1-.7.1-1z" label="Settings" sub="Theme, notifications, capital, channels, admin" onTap={onOpenSettings} />
        </div>
      </div>
    </>
  )
}
