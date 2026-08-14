// YesterdayStrip (plan Task 13) — "yesterday's verdicts" from the ratified
// Today-stack mockup. AMENDMENT: reads `board.yesterday` from the board slice
// alone (the server now stamps it there) — it does NOT fetch `ledger:2`, the
// brief's original data source. Renders nothing until the engine has a
// yesterday to report (first day, or a holiday with no prior session).

import type { BoardSlice } from '../../lib/apiViews'

export function YesterdayStrip({ yesterday }: { yesterday: BoardSlice['yesterday'] }) {
  if (!yesterday) return null
  const { wins, losses, topRegret } = yesterday
  return (
    <div className="card cc-yesterday">
      <span className="sec-label" style={{ margin: 0 }}>
        Yesterday
      </span>
      <span className="num">
        {wins} win{wins === 1 ? '' : 's'} · {losses} loss{losses === 1 ? '' : 'es'}
      </span>
      {topRegret && (
        <span>
          biggest regret <b>{topRegret.sym}</b>{' '}
          <span className="num">
            {topRegret.excessPct >= 0 ? '+' : ''}
            {topRegret.excessPct}%
          </span>
        </span>
      )}
    </div>
  )
}
