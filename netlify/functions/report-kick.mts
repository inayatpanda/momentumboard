// Daily 05:20 UTC (06:20 UK). Weekdays kick the prediction engine, which
// grades yesterday, scores today's board, then chains to the newspaper
// composer itself — the paper always publishes, engine or no engine.
// Weekends skip the engine — no new session to score, and a duplicate board
// off Friday's close would pollute calibration — and go straight to the
// composer for the weekend / week-ahead edition.
export default async () => {
  const day = new Date().getUTCDay()
  const fn = day === 0 || day === 6 ? 'report-compose-background' : 'predict-background'
  await fetch(`${process.env.URL ?? 'https://thestreetsignal.netlify.app'}/.netlify/functions/${fn}`, {
    method: 'POST',
    headers: { 'x-app-token': process.env.APP_TOKEN ?? '' },
  }).catch(() => {})
  return new Response('kicked')
}

export const config = { schedule: '20 5 * * *' }
