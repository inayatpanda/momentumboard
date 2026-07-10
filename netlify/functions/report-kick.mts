import { isUsMarketHoliday } from '../../shared/usMarketHolidays'

// Daily 05:20 UTC (06:20 UK). Weekdays kick the prediction engine, which
// grades yesterday, scores today's board, then chains to the newspaper
// composer itself — the paper always publishes, engine or no engine.
// Weekends skip the engine — no new session to score, and a duplicate board
// off Friday's close would pollute calibration — and go straight to the
// composer for the weekend / week-ahead edition. US market holidays get the
// same treatment: NYSE closed means no new close to score, so a holiday
// routes to the composer too (a holiday edition still publishes) rather than
// re-scoring the prior close as if it were today's. 05:20 UTC is still
// pre-market in New York, so the UTC calendar date IS the NY calendar date.
export default async () => {
  const now = new Date()
  const day = now.getUTCDay()
  const isoDate = now.toISOString().slice(0, 10)
  const fn = day === 0 || day === 6 || isUsMarketHoliday(isoDate) ? 'report-compose-background' : 'predict-background'
  await fetch(`${process.env.URL ?? 'https://thestreetsignal.netlify.app'}/.netlify/functions/${fn}`, {
    method: 'POST',
    headers: { 'x-app-token': process.env.APP_TOKEN ?? '' },
  }).catch(() => {})
  return new Response('kicked')
}

export const config = { schedule: '20 5 * * *' }
