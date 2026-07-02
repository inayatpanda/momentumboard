// Weekday 05:35 UTC (06:35 UK): kick the newspaper composer. The composer is a
// background function (15-min budget); this scheduled shim just dispatches it.
export default async () => {
  await fetch(`${process.env.URL ?? 'https://momentumboard-inayat.netlify.app'}/.netlify/functions/report-compose-background`, {
    method: 'POST',
    headers: { 'x-app-token': process.env.APP_TOKEN ?? '' },
  }).catch(() => {})
  return new Response('kicked')
}

export const config = { schedule: '35 5 * * 1-5' }
