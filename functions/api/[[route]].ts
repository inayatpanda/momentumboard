// Cloudflare Pages Functions — the /api/* catch-all.
//
// M2 of the Cloudflare migration. This file is a MOUNT POINT, not logic: the
// route table, the store selection and the env mapping all live in
// netlify/functions/lib/ so that the cron Worker and the tests share exactly
// one copy of them (and so that `tsc -b` and vitest, which already cover
// `netlify/`, cover them too).
//
// Netlify does this dispatch in netlify.toml's `[[redirects]]`. Pages has no
// equivalent for functions, so it becomes code — and `lib/router.test.ts`
// parses netlify.toml and fails if the two tables ever disagree.
//
// Everything under /api/ arrives here, including paths with no handler, which
// get a JSON 404 rather than falling through to the SPA's index.html.

import { pagesHandler, type PagesContext } from '../../netlify/functions/lib/router'

export const onRequest = (ctx: PagesContext): Promise<Response> => pagesHandler(ctx)
