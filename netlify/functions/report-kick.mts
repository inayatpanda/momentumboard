// Weekday 05:20 UTC (06:20 UK): kick the prediction engine, which grades
// yesterday, scores today's board, then chains to the newspaper composer
// itself — the paper always publishes, engine or no engine.
export default async () => {
  await fetch(`${process.env.URL ?? 'https://thestreetsignal.netlify.app'}/.netlify/functions/predict-background`, {
    method: 'POST',
    headers: { 'x-app-token': process.env.APP_TOKEN ?? '' },
  }).catch(() => {})
  return new Response('kicked')
}

export const config = { schedule: '20 5 * * 1-5' }
