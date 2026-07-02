// Daily report-pick tracking. Persistence maths is deterministic on purpose:
// a ticker surviving several INDEPENDENT morning analyses is a stronger signal
// than one day's conviction — and the thresholds must apply identically daily.

export interface Pick {
  ticker: string
  side: 'long' | 'short'
  playbook?: string
  conviction?: string
}

export interface DailyPicks {
  date: string // YYYY-MM-DD; one entry per report
  regime?: string
  picks: Pick[]
}

export interface Persistence {
  ticker: string
  side: 'long' | 'short'
  appearances: number // in the last 7 reports
  streak: number // consecutive most-recent reports
  latestConviction?: string
  persistent: boolean // streak ≥3 OR ≥4 of last 7
}

export function validatePicks(raw: unknown): DailyPicks | null {
  const d = raw as DailyPicks
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d.date ?? '') || !Array.isArray(d.picks)) return null
  const picks = d.picks
    .filter(p => typeof p?.ticker === 'string' && (p.side === 'long' || p.side === 'short'))
    .slice(0, 8)
    .map(p => ({ ticker: p.ticker.toUpperCase().slice(0, 12), side: p.side, playbook: p.playbook, conviction: p.conviction }))
  return { date: d.date, regime: typeof d.regime === 'string' ? d.regime : undefined, picks }
}

export function computePersistence(history: DailyPicks[]): Persistence[] {
  const recent = [...history].sort((a, b) => a.date.localeCompare(b.date)).slice(-7)
  if (!recent.length) return []
  const key = (p: Pick) => `${p.ticker}|${p.side}`
  const all = new Map<string, Persistence>()

  for (const day of recent) {
    for (const p of day.picks) {
      const k = key(p)
      const cur = all.get(k) ?? { ticker: p.ticker, side: p.side, appearances: 0, streak: 0, persistent: false }
      cur.appearances++
      cur.latestConviction = p.conviction ?? cur.latestConviction
      all.set(k, cur)
    }
  }
  // streak: walk back from the most recent report
  for (const cur of all.values()) {
    let streak = 0
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].picks.some(p => p.ticker === cur.ticker && p.side === cur.side)) streak++
      else break
    }
    cur.streak = streak
    cur.persistent = streak >= 3 || cur.appearances >= 4
  }
  return [...all.values()].sort((a, b) => b.streak - a.streak || b.appearances - a.appearances)
}

/** Tickers that became persistent BECAUSE of the latest report — ping-worthy. */
export function newlyPersistent(history: DailyPicks[]): Persistence[] {
  const now = computePersistence(history).filter(p => p.persistent)
  const beforeKeys = new Set(
    computePersistence(history.slice(0, -1))
      .filter(p => p.persistent)
      .map(p => `${p.ticker}|${p.side}`),
  )
  return now.filter(p => !beforeKeys.has(`${p.ticker}|${p.side}`))
}
