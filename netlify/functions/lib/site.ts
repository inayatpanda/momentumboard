// The paper's ONE public address. Every link a reader can see or tap —
// licence unlock links, Telegram replies, report emails, OG tags, the Helm
// dashboard — uses this constant, NOT process.env.URL: Netlify's URL var is
// whatever the dashboard considers the primary domain (it silently reverts to
// *.netlify.app if the custom domain is ever unset or demoted), and outward
// links must never depend on that setting. Internal self-invocations
// (function → function fetches) keep env.URL so deploy previews still work.
export const CANONICAL_SITE = 'https://thestreetsignal.rqai.co.uk'
