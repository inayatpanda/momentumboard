// YesterdayStrip (plan Task 13) — "yesterday's verdicts" from the ratified
// Today-stack mockup. AMENDMENT: reads `board.yesterday` from the board slice
// alone (the server now stamps it there) — it does NOT fetch `ledger:2`, the
// brief's original data source. Renders nothing until the engine has a
// yesterday to report (first day, or a holiday with no prior session).

import type { BoardSlice } from '../../lib/apiViews'
import { shortDateWithWeekday } from '../../lib/format'

const score = (wins: number, losses: number) => `${wins} win${wins === 1 ? '' : 's'} · ${losses} loss${losses === 1 ? '' : 'es'}`

export function YesterdayStrip({ yesterday }: { yesterday: BoardSlice['yesterday'] }) {
  if (!yesterday) return null
  const { date, horizon, wins, losses, equity, crypto, topRegret } = yesterday
  return (
    <div className="card cc-yesterday">
      {/* THE DAY, BY NAME. A grade lands 5 or 10 sessions after the call, so the
          day the server can actually report on is rarely the calendar day before
          — printing its score under a bare "Yesterday" would attribute it to the
          wrong session. The date is the label; the label is the date. */}
      <span className="sec-label" style={{ margin: 0 }}>
        {date ? shortDateWithWeekday(date) : 'Yesterday'}
      </span>
      {/* THE PARTITION (crypto-v2 wave, finding 5). An equity verdict is an
          excess over SPY across ten sessions; a cohort verdict is an absolute
          move across fourteen crypto bars. One line summing both means neither,
          and a weekend on which only the coins graded read as a generic engine
          result over a market that was shut. The split is shown only when a
          cohort row actually graded; otherwise the day speaks with one voice,
          exactly as it always has. A slice cached before the server sent the
          split has neither field, and falls back to the flat census. */}
      {crypto ? (
        <>
          {equity && (equity.wins > 0 || equity.losses > 0) && <span className="num">equity {score(equity.wins, equity.losses)}</span>}
          <span className="num">crypto {score(crypto.wins, crypto.losses)}</span>
        </>
      ) : (
        <span className="num">{score(wins, losses)}</span>
      )}
      {/* …AND WHICH CLOCK. A five-session verdict and a ten-session one are two
          different measurements, and the strip may be reporting either; a slice
          cached before the server sent the horizon claims neither. */}
      {horizon && <span className="cc-reason">over {horizon} sessions</span>}
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
