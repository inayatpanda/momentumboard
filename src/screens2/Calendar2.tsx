import '../styles/calendar.css'
// Calendar2 (plan Task 21; CX-23) — a thin v2 adapter. The legacy
// src/screens/CalendarScreen.tsx's own imports are already cutover-safe: the
// shared Dexie `db` (never dies), `getMonthMap`/`getDayLedger` from lib/api
// (the server routes stay), and the self-contained `components/icons` — no
// EnginePanel, no useMarketData, no legacy TabBar. So this wraps the proven
// month-map + day-ledger logic AS-IS rather than re-deriving it, and skins
// its `.topbar`/`.cal-*`/`.perf-row`/`.digest-section` classnames onto v2
// tokens (base.css's "calendar adapter" section) instead of rebuilding the
// grid from scratch. `onOpenSettings` is a no-op: Settings is its own v2
// route now (/settings), not a screen this page pushes to.

import { CalendarScreen } from '../screens/CalendarScreen'

export default function Calendar2() {
  return (
    <div className="cal2">
      <h1>Calendar</h1>
      <CalendarScreen onOpenSettings={() => {}} />
    </div>
  )
}
